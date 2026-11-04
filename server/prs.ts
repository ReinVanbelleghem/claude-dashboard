import {
  type PrDetail,
  type PrFilter,
  type PrInlineComment,
  type PrOverview,
  type PrRef,
  type PrReviewer,
  type PrSummary,
  type PrTimelineItem,
  type Person,
} from "../shared/pr.ts";
import { GithubError, graphql, rest, viewerLogin, viewerTeams } from "./github.ts";
import { listThreads } from "./prReview.ts";
import { getSettings } from "./settings.ts";

/**
 * The pull request list: GitHub's search, shaped into rows.
 *
 * Views are saved filters in settings.json. Each filter becomes one or more search
 * strings (one per author, since GitHub's search cannot OR authors), the results are
 * merged, and each PR is marked with whether the viewer — personally or through a
 * team — was asked to review it. Searches are cached for half a minute so switching
 * views back and forth does not spend the rate limit.
 */
/**
 * Searches are kept for ten minutes and served at once; the client asks for a
 * refresh when what it got is older than it likes. Switching views then paints
 * instantly from the cache instead of waiting on GitHub every time.
 */
const SEARCH_CACHE_MS = 10 * 60_000;
const PEOPLE_CACHE_MS = 10 * 60_000;
const TEMPLATE_CACHE_MS = 60 * 60_000;

const PR_FIELDS = `
  number title url isDraft state headRefName baseRefName headRefOid baseRefOid
  createdAt updatedAt additions deletions changedFiles reviewDecision
  author { login avatarUrl ... on User { name } }
  repository { name owner { login } }
  labels(first: 10) { nodes { name color } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewRequests(first: 30) { nodes { requestedReviewer {
    __typename
    ... on User { login avatarUrl }
    ... on Team { slug organization { login } }
  } } }
`;

type GqlPr = {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  state: PrSummary["state"];
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  baseRefOid: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: PrSummary["reviewDecision"];
  body: string;
  author: { login: string; avatarUrl: string; name?: string | null } | null;
  repository: { name: string; owner: { login: string } };
  labels: { nodes: { name: string; color: string }[] };
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
  reviewRequests: {
    nodes: {
      requestedReviewer:
        | { __typename: "User"; login: string; avatarUrl: string }
        | { __typename: "Team"; slug: string; organization: { login: string } }
        | null;
    }[];
  };
};

function toSummary(pr: GqlPr, login: string, teams: Set<string>): PrSummary {
  const requested = pr.reviewRequests.nodes.some((n) => {
    const r = n.requestedReviewer;
    if (!r) return false;
    return r.__typename === "User" ? r.login === login : teams.has(`${r.organization.login}/${r.slug}`);
  });
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup?.state;
  const ciState =
    rollup === "SUCCESS" || rollup === "FAILURE" || rollup === "PENDING" || rollup === "ERROR" ? rollup : rollup ? "PENDING" : null;
  return {
    owner: pr.repository.owner.login,
    repo: pr.repository.name,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    author: pr.author?.login ?? "ghost",
    authorName: pr.author?.name ?? null,
    authorAvatarUrl: pr.author?.avatarUrl ?? "",
    isDraft: pr.isDraft,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    headSha: pr.headRefOid,
    baseSha: pr.baseRefOid,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    reviewDecision: pr.reviewDecision,
    ciState,
    labels: pr.labels.nodes,
    reviewRequestedFromMe: requested,
    state: pr.state,
  };
}

const searchCache = new Map<string, { at: number; value: GqlPr[] }>();
const inflight = new Map<string, Promise<{ at: number; value: GqlPr[] }>>();

/**
 * GitHub gives a GraphQL query ten seconds and answers 502 past that. A hundred
 * closed PRs with their review requests sometimes needs more, so a timeout is
 * retried at half the size rather than shown as a dead page.
 */
async function searchPage(q: string, first: number): Promise<GqlPr[]> {
  try {
    const data = await graphql<{ search: { nodes: (GqlPr | Record<string, never>)[] } }>(
      `query($q: String!, $first: Int!) { search(type: ISSUE, query: $q, first: $first) { nodes { ... on PullRequest { ${PR_FIELDS} } } } }`,
      { q, first },
    );
    return data.search.nodes.filter((n): n is GqlPr => "number" in n);
  } catch (e) {
    if (first > 25 && e instanceof GithubError && (e.status === 502 || e.status === 504)) return searchPage(q, Math.floor(first / 2));
    throw e;
  }
}

async function search(q: string, refresh: boolean): Promise<{ at: number; value: GqlPr[] }> {
  const hit = searchCache.get(q);
  if (!refresh && hit && Date.now() - hit.at < SEARCH_CACHE_MS) return hit;
  let pending = inflight.get(q);
  if (!pending) {
    pending = searchPage(q, 100)
      .then((nodes) => {
        const entry = { at: Date.now(), value: nodes };
        searchCache.set(q, entry);
        return entry;
      })
      .finally(() => inflight.delete(q));
    inflight.set(q, pending);
  }
  return pending;
}

export function trackedRepos(): string[] {
  return getSettings().reviews.repos.map((r) => r.trim()).filter(Boolean);
}

const STATE_TERM: Record<NonNullable<PrFilter["state"]>, string | null> = { open: "is:open", closed: "is:closed", merged: "is:merged", all: null };

/**
 * The free query wins over the switches: a qualifier it names (`is:`, `state:`,
 * `draft:`, `review:`) is left out of the generated part, so `state:closed` does not
 * end up beside an implied `is:open` and quietly match nothing.
 */
function searchStrings(filter: PrFilter, login: string): string[] {
  const repos = filter.repos?.length ? filter.repos : trackedRepos();
  const query = filter.query?.trim() ?? "";
  const names = (q: string) => new RegExp(`(^|\\s)-?(${q}):`, "i").test(query);
  const base = ["is:pr", ...repos.map((r) => `repo:${r}`)];
  const state = STATE_TERM[filter.state ?? "open"];
  if (state && !names("is|state")) base.push(state);
  if (filter.reviewRequestedFromMe) base.push("review-requested:@me");
  if (filter.hideApproved && !names("review")) base.push("-review:approved");
  if (!filter.includeDrafts && !names("draft")) base.push("draft:false");
  if (query) base.push(query);
  const authors = [...new Set((filter.authors ?? []).map((a) => (a === "@me" ? login : a)))];
  if (!authors.length) return [[...base, "sort:updated-desc"].join(" ")];
  return authors.map((a) => [...base, `author:${a}`, "sort:updated-desc"].join(" "));
}

/**
 * The watched PRs as list rows, whatever their state. One request with an alias per
 * PR rather than a search, since GitHub's search cannot name pull requests by number
 * and a watched PR that is merged would not match the open-only views anyway.
 */
async function watchedPage(watched: PrRef[], refresh: boolean): Promise<{ at: number; value: GqlPr[] }> {
  if (!watched.length) return { at: Date.now(), value: [] };
  const key = `watched:${watched.map((w) => `${w.owner}/${w.repo}#${w.number}`).join(",")}`;
  const hit = searchCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < SEARCH_CACHE_MS) return hit;
  const parts = watched.map(
    (w, i) =>
      `p${i}: repository(owner: ${JSON.stringify(w.owner)}, name: ${JSON.stringify(w.repo)}) { pullRequest(number: ${w.number}) { ${PR_FIELDS} } }`,
  );
  const data = await graphql<Record<string, { pullRequest: GqlPr | null } | null>>(`{ ${parts.join("\n")} }`);
  const entry = { at: Date.now(), value: Object.values(data).flatMap((r) => (r?.pullRequest ? [r.pullRequest] : [])) };
  searchCache.set(key, entry);
  return entry;
}

/** `fetchedAt` is the age of the oldest search behind the list, so the client can decide to refresh. */
export async function listPrs(filter: PrFilter, refresh = false): Promise<{ prs: PrSummary[]; fetchedAt: number }> {
  const login = await viewerLogin();
  if (filter.watched) {
    const [teams, page] = await Promise.all([viewerTeams(), watchedPage(getSettings().reviews.watched, refresh)]);
    return { prs: page.value.map((pr) => toSummary(pr, login, teams)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), fetchedAt: page.at };
  }
  const [teams, results] = await Promise.all([
    viewerTeams(),
    Promise.all(searchStrings(filter, login).map((q) => search(q, refresh))),
  ]);
  const byUrl = new Map<string, GqlPr>();
  for (const pr of results.flatMap((r) => r.value)) byUrl.set(pr.url, pr);
  return {
    prs: [...byUrl.values()]
      .map((pr) => toSummary(pr, login, teams))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    fetchedAt: Math.min(...results.map((r) => r.at)),
  };
}

export async function getPr(owner: string, repo: string, number: number): Promise<PrDetail> {
  const [login, teams, data] = await Promise.all([
    viewerLogin(),
    viewerTeams(),
    graphql<{ repository: { pullRequest: GqlPr } }>(
      `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) { pullRequest(number: $number) { ${PR_FIELDS} body } }
      }`,
      { owner, repo, number },
    ),
  ]);
  const pr = data.repository.pullRequest;
  return { ...toSummary(pr, login, teams), body: pr.body ?? "" };
}

const templateCache = new Map<string, { at: number; body: string }>();

/** The repository's PR template, so its boilerplate links are not mistaken for context. */
export async function prTemplate(owner: string, repo: string): Promise<string> {
  const key = `${owner}/${repo}`;
  const hit = templateCache.get(key);
  if (hit && Date.now() - hit.at < TEMPLATE_CACHE_MS) return hit.body;
  let body = "";
  try {
    body = await rest.getRaw(`/repos/${owner}/${repo}/contents/.github/pull_request_template.md`);
  } catch {
    // No template is the common case.
  }
  templateCache.set(key, { at: Date.now(), body });
  return body;
}

const people = new Map<string, { at: number; value: Person[] }>();

/**
 * Everyone who can be assigned in these repos — the author picker's options. The
 * tracked repos plus whatever the list on screen came from, so the picker has names
 * even before any repository is configured.
 */
export async function listPeople(q: string, extraRepos: string[]): Promise<Person[]> {
  const repos = [...new Set([...trackedRepos(), ...extraRepos.filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r))])].sort();
  const key = repos.join(",");
  let entry = people.get(key);
  if (!entry || Date.now() - entry.at > PEOPLE_CACHE_MS) {
    const seen = new Map<string, Person>();
    for (const full of repos) {
      const [owner, name] = full.split("/");
      let after: string | null = null;
      for (let page = 0; page < 5; page++) {
        const data: {
          repository: { assignableUsers: { nodes: Person[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } | null;
        } = await graphql(
          `query($owner: String!, $name: String!, $after: String) {
            repository(owner: $owner, name: $name) {
              assignableUsers(first: 100, after: $after) { nodes { login name avatarUrl } pageInfo { hasNextPage endCursor } }
            }
          }`,
          { owner, name, after },
        );
        if (!data.repository) break;
        for (const u of data.repository.assignableUsers.nodes) seen.set(u.login, u);
        if (!data.repository.assignableUsers.pageInfo.hasNextPage) break;
        after = data.repository.assignableUsers.pageInfo.endCursor;
      }
    }
    entry = { at: Date.now(), value: [...seen.values()].sort((a, b) => (a.name ?? a.login).localeCompare(b.name ?? b.login)) };
    people.set(key, entry);
  }
  const needle = q.toLowerCase();
  return entry.value
    .filter((p) => !needle || p.login.toLowerCase().includes(needle) || p.name?.toLowerCase().includes(needle))
    .slice(0, 20);
}

type GqlOverview = {
  repository: {
    pullRequest: GqlPr & {
      mergeable: PrOverview["mergeable"];
      milestone: { title: string } | null;
      assignees: { nodes: { login: string; avatarUrl: string }[] };
      latestReviews: { nodes: { state: PrReviewer["state"]; author: { login: string; avatarUrl: string } | null }[] };
      commits: {
        totalCount: number;
        nodes: {
          commit: {
            statusCheckRollup: {
              state: string;
              contexts: {
                nodes: (
                  | { __typename: "CheckRun"; name: string; status: string; conclusion: string | null; detailsUrl: string | null; title: string | null }
                  | { __typename: "StatusContext"; context: string; state: string; targetUrl: string | null; description: string | null }
                )[];
              };
            } | null;
          };
        }[];
      };
    };
  };
};

type GhIssueComment = { node_id: string; body: string | null; created_at: string; html_url: string; user: { login: string; avatar_url: string } | null };
type GhReview = {
  node_id: string;
  body: string | null;
  state: string;
  submitted_at: string | null;
  html_url: string;
  user: { login: string; avatar_url: string } | null;
};
type GhReviewComment = {
  id: number;
  node_id: string;
  pull_request_review_id: number | null;
  path: string;
  line: number | null;
  original_line: number | null;
  body: string;
  diff_hunk: string | null;
  html_url: string;
  created_at: string;
  in_reply_to_id?: number;
  user: { login: string; avatar_url: string } | null;
};

/** The conversation page's worth of a PR: description, sidebar facts, and the top-level discussion. */
export async function prOverview(owner: string, repo: string, number: number): Promise<PrOverview> {
  const base = `/repos/${owner}/${repo}`;
  const [login, teams, data, comments, reviews, inline, threads] = await Promise.all([
    viewerLogin(),
    viewerTeams(),
    graphql<GqlOverview>(
      `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
          ${PR_FIELDS} body mergeable
          milestone { title }
          assignees(first: 10) { nodes { login avatarUrl } }
          latestReviews(first: 30) { nodes { state author { login avatarUrl } } }
          commits(last: 1) { totalCount nodes { commit { statusCheckRollup { state contexts(first: 50) { nodes {
            __typename
            ... on CheckRun { name status conclusion detailsUrl title }
            ... on StatusContext { context state targetUrl description }
          } } } } } }
        } }
      }`,
      { owner, repo, number },
    ),
    rest.paginate<GhIssueComment>(`${base}/issues/${number}/comments`),
    rest.paginate<GhReview>(`${base}/pulls/${number}/reviews`),
    rest.paginate<GhReviewComment>(`${base}/pulls/${number}/comments`),
    listThreads({ owner, repo, number }),
  ]);
  const pr = data.repository.pullRequest;
  const summary = toSummary(pr, login, teams);

  const reviewers = new Map<string, PrReviewer>();
  for (const r of pr.latestReviews.nodes) {
    if (!r.author || r.state === "PENDING") continue;
    reviewers.set(r.author.login, { login: r.author.login, avatarUrl: r.author.avatarUrl, state: r.state });
  }
  for (const n of pr.reviewRequests.nodes) {
    const r = n.requestedReviewer;
    if (!r) continue;
    if (r.__typename === "User") {
      if (!reviewers.has(r.login)) reviewers.set(r.login, { login: r.login, avatarUrl: r.avatarUrl, state: "PENDING" });
    } else {
      reviewers.set(`${r.organization.login}/${r.slug}`, { login: `${r.organization.login}/${r.slug}`, avatarUrl: "", state: "PENDING", isTeam: true });
    }
  }

  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;
  const checks = (rollup?.contexts.nodes ?? []).map((c): PrOverview["checks"][number] => {
    if (c.__typename === "CheckRun") {
      const done = c.status === "COMPLETED";
      const status = !done
        ? "pending"
        : c.conclusion === "SUCCESS"
          ? "success"
          : c.conclusion === "SKIPPED"
            ? "skipped"
            : c.conclusion === "NEUTRAL"
              ? "neutral"
              : "failure";
      return { name: c.name, status, url: c.detailsUrl, detail: c.title };
    }
    const status = c.state === "SUCCESS" ? "success" : c.state === "PENDING" || c.state === "EXPECTED" ? "pending" : "failure";
    return { name: c.context, status, url: c.targetUrl, detail: c.description };
  });

  const byId = new Map(inline.map((c) => [c.id, c]));
  const rootOf = (c: GhReviewComment): GhReviewComment => {
    let cur = c;
    while (cur.in_reply_to_id != null && byId.has(cur.in_reply_to_id)) cur = byId.get(cur.in_reply_to_id)!;
    return cur;
  };
  const threadOrder = (c: GhReviewComment) => {
    const root = rootOf(c);
    return `${root.created_at}\u0000${root.id === c.id ? "" : c.created_at}`;
  };
  const threadByRoot = new Map(threads.flatMap((t) => (t.comments[0] ? [[t.comments[0].id, t] as const] : [])));
  const inlineByReview = new Map<number, PrInlineComment[]>();
  for (const c of [...inline].sort((a, b) => threadOrder(a).localeCompare(threadOrder(b)))) {
    const reviewId = rootOf(c).pull_request_review_id ?? c.pull_request_review_id;
    if (reviewId == null) continue;
    const list = inlineByReview.get(reviewId) ?? [];
    list.push({
      id: c.node_id,
      path: c.path,
      line: c.line ?? c.original_line,
      body: c.body,
      diffHunk: c.diff_hunk,
      url: c.html_url,
      author: c.user?.login ?? "ghost",
      authorAvatarUrl: c.user?.avatar_url ?? null,
      createdAt: c.created_at,
      inReplyTo: c.in_reply_to_id != null ? (byId.get(c.in_reply_to_id)?.node_id ?? null) : null,
      threadId: threadByRoot.get(c.node_id)?.id ?? null,
      resolved: threadByRoot.get(c.node_id)?.isResolved ?? false,
    });
    inlineByReview.set(reviewId, list);
  }
  const reviewIds = await rest.paginate<{ id: number; node_id: string }>(`${base}/pulls/${number}/reviews`);
  const dbIdByNode = new Map(reviewIds.map((r) => [r.node_id, r.id]));

  const timeline: PrTimelineItem[] = [
    ...comments.map((c): PrTimelineItem => ({
      id: c.node_id,
      kind: "comment",
      author: c.user?.login ?? "ghost",
      authorAvatarUrl: c.user?.avatar_url ?? null,
      body: c.body ?? "",
      createdAt: c.created_at,
      url: c.html_url,
    })),
    ...reviews
      .filter((r) => r.state !== "PENDING" && r.submitted_at)
      .map((r): PrTimelineItem => ({
        id: r.node_id,
        kind: "review",
        author: r.user?.login ?? "ghost",
        authorAvatarUrl: r.user?.avatar_url ?? null,
        body: r.body ?? "",
        createdAt: r.submitted_at!,
        url: r.html_url,
        state: r.state as PrTimelineItem["state"],
        inlineComments: inlineByReview.get(dbIdByNode.get(r.node_id) ?? -1)?.length ?? 0,
        inline: inlineByReview.get(dbIdByNode.get(r.node_id) ?? -1) ?? [],
      }))
      // A review with no summary and no inline comments is an empty "commented" event GitHub itself hides.
      .filter((r) => r.body.trim() || r.inlineComments || r.state !== "COMMENTED"),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    pr: { ...summary, body: pr.body ?? "" },
    viewer: login,
    reviewers: [...reviewers.values()],
    assignees: pr.assignees.nodes,
    milestone: pr.milestone?.title ?? null,
    checks,
    mergeable: pr.mergeable,
    commits: pr.commits.totalCount,
    timeline,
  };
}
