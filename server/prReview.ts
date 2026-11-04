import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { CommentKind, DiffSide, DraftComment, FilesResponse, NewDraft, PrCommit, PrRef, ReviewEvent, ReviewThread, SubmitResult, ThreadReply } from "../shared/pr.ts";
import { graphql, rest, viewerLogin } from "./github.ts";
import { commitPatch, fileDiff, readFileAt } from "./prRepos.ts";

/**
 * The "Files changed" tab: GitHub's view of a PR's diff, its review threads, and the
 * comments you are collecting locally before submitting them as one review.
 *
 * Drafts live in the index database rather than as a pending review on GitHub, so
 * nothing is visible to anyone until you press Approve, Comment or Request changes.
 * If a pending GitHub review already exists — started in the browser, say — the
 * drafts are added to it and the whole thing is submitted together, since GitHub
 * allows one pending review per person per PR.
 */
let db: Database;
export function initReview(database: Database) {
  db = database;
}

const repoPath = (pr: PrRef) => `/repos/${pr.owner}/${pr.repo}`;

// ── files ─────────────────────────────────────────────────────────────────────
type GhFile = {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

async function viewedPaths(pr: PrRef): Promise<Set<string>> {
  const viewed = new Set<string>();
  let after: string | null = null;
  for (;;) {
    const data: {
      repository: {
        pullRequest: {
          files: { nodes: { path: string; viewerViewedState: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
        };
      };
    } = await graphql(
      `query ($owner: String!, $repo: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
          files(first: 100, after: $after) { nodes { path viewerViewedState } pageInfo { hasNextPage endCursor } }
        } }
      }`,
      { ...pr, after },
    );
    const files = data.repository.pullRequest.files;
    for (const f of files.nodes) if (f.viewerViewedState === "VIEWED") viewed.add(f.path);
    if (!files.pageInfo.hasNextPage) return viewed;
    after = files.pageInfo.endCursor;
  }
}

export async function listFiles(pr: PrRef): Promise<FilesResponse> {
  const [detail, files, viewed, viewer] = await Promise.all([
    rest.get<{ head: { sha: string }; base: { sha: string } }>(`${repoPath(pr)}/pulls/${pr.number}`),
    rest.paginate<GhFile>(`${repoPath(pr)}/pulls/${pr.number}/files`),
    viewedPaths(pr).catch(() => new Set<string>()),
    viewerLogin().catch(() => null),
  ]);
  /**
   * The diff GitHub shows is against the merge base, not the base branch's tip — the
   * same three-dot diff `git diff base...head` means — so that is the base we report.
   */
  const compare = await rest.get<{ merge_base_commit: { sha: string } }>(
    `${repoPath(pr)}/compare/${detail.base.sha}...${detail.head.sha}?per_page=1`,
  );
  return {
    headSha: detail.head.sha,
    baseSha: compare.merge_base_commit.sha,
    viewer,
    files: files.map((f) => ({
      path: f.filename,
      previousFilename: f.previous_filename ?? null,
      status: f.status as FilesResponse["files"][number]["status"],
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      patch: f.patch ?? null,
      patchOmitted: f.patch == null && f.changes > 0,
      viewed: viewed.has(f.filename),
    })),
  };
}

export const fileContent = (pr: PrRef, sha: string, path: string) => readFileAt(pr.owner, pr.repo, sha, path);

// ── commits ───────────────────────────────────────────────────────────────────
type GhCommit = {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name: string; date: string } | null };
  author: { login: string; avatar_url: string } | null;
};

/** The PR's commits, oldest first, as GitHub lists them. */
export async function listCommits(pr: PrRef): Promise<PrCommit[]> {
  const commits = await rest.paginate<GhCommit>(`${repoPath(pr)}/pulls/${pr.number}/commits`);
  return commits.map((c) => {
    const [subject, ...rest] = c.commit.message.split("\n");
    return {
      sha: c.sha,
      short: c.sha.slice(0, 7),
      subject,
      body: rest.join("\n").trim(),
      author: c.commit.author?.name ?? c.author?.login ?? "unknown",
      authorLogin: c.author?.login ?? null,
      authorAvatarUrl: c.author?.avatar_url ?? null,
      date: c.commit.author?.date ?? "",
      url: c.html_url,
    };
  });
}

type GhCommitDetail = { files?: { filename: string; previous_filename?: string; status: string; patch?: string }[] };

/**
 * The diff one commit introduced. From the local clone when it is there, because
 * that gives the whole patch with real headers; otherwise stitched from GitHub's
 * per-file patches, which it withholds for very large files.
 */
export async function commitDiff(pr: PrRef, sha: string, context: number): Promise<{ patch: string; source: "clone" | "github" }> {
  try {
    return { patch: await commitPatch(pr.owner, pr.repo, sha, context), source: "clone" };
  } catch {
    const detail = await rest.get<GhCommitDetail>(`${repoPath(pr)}/commits/${sha}`);
    const patch = (detail.files ?? [])
      .map((f) => {
        const from = f.previous_filename ?? f.filename;
        const head = `diff --git a/${from} b/${f.filename}\n${f.status === "added" ? "new file mode 100644\n" : f.status === "removed" ? "deleted file mode 100644\n" : ""}${
          f.previous_filename ? `rename from ${from}\nrename to ${f.filename}\n` : ""
        }--- a/${from}\n+++ b/${f.filename}\n`;
        return f.patch ? `${head}${f.patch}\n` : head;
      })
      .join("");
    return { patch, source: "github" };
  }
}

export const expandedDiff = (pr: PrRef, base: string, head: string, path: string, previous: string | null, context: number) =>
  fileDiff(pr.owner, pr.repo, base, head, path, previous, context);

async function prNodeId(pr: PrRef): Promise<string> {
  const data = await graphql<{ repository: { pullRequest: { id: string } } }>(
    `query ($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id } } }`,
    { ...pr },
  );
  return data.repository.pullRequest.id;
}

export async function setViewed(pr: PrRef, path: string, viewed: boolean) {
  const pullRequestId = await prNodeId(pr);
  const mutation = viewed ? "markFileAsViewed" : "unmarkFileAsViewed";
  await graphql(
    `mutation ($input: ${viewed ? "MarkFileAsViewedInput" : "UnmarkFileAsViewedInput"}!) { ${mutation}(input: $input) { clientMutationId } }`,
    { input: { pullRequestId, path } },
  );
}

// ── threads ───────────────────────────────────────────────────────────────────
type GqlThread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  originalStartLine: number | null;
  diffSide: DiffSide;
  firstComment: { nodes: { diffHunk: string }[] };
  comments: {
    nodes: { id: string; databaseId: number; author: { login: string; avatarUrl: string } | null; body: string; createdAt: string; url: string }[];
  };
};

export async function listThreads(pr: PrRef): Promise<ReviewThread[]> {
  const threads: ReviewThread[] = [];
  let after: string | null = null;
  for (;;) {
    const data: {
      repository: { pullRequest: { reviewThreads: { nodes: GqlThread[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } };
    } = await graphql(
      `query ($owner: String!, $repo: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
          reviewThreads(first: 50, after: $after) {
            nodes {
              id isResolved isOutdated path line originalLine startLine originalStartLine diffSide
              firstComment: comments(first: 1) { nodes { diffHunk } }
              comments(first: 100) { nodes { id databaseId author { login avatarUrl } body createdAt url } }
            }
            pageInfo { hasNextPage endCursor }
          }
        } }
      }`,
      { ...pr, after },
    );
    const page = data.repository.pullRequest.reviewThreads;
    for (const t of page.nodes) {
      threads.push({
        id: t.id,
        isResolved: t.isResolved,
        isOutdated: t.isOutdated,
        path: t.path,
        line: t.line,
        originalLine: t.originalLine,
        startLine: t.startLine ?? t.originalStartLine,
        diffSide: t.diffSide,
        diffHunk: t.firstComment.nodes[0]?.diffHunk ?? null,
        comments: t.comments.nodes.map((c) => ({
          id: c.id,
          databaseId: c.databaseId,
          author: c.author?.login ?? null,
          authorAvatarUrl: c.author?.avatarUrl ?? null,
          body: c.body,
          createdAt: c.createdAt,
          url: c.url,
        })),
      });
    }
    if (!page.pageInfo.hasNextPage) return threads;
    after = page.pageInfo.endCursor;
  }
}

export async function replyToThread(threadId: string, body: string): Promise<ThreadReply> {
  const data = await graphql<{
    addPullRequestReviewThreadReply: { comment: { id: string; url: string; body: string; createdAt: string; author: { login: string; avatarUrl: string } | null } };
  }>(
    `mutation ($input: AddPullRequestReviewThreadReplyInput!) {
      addPullRequestReviewThreadReply(input: $input) { comment { id url body createdAt author { login avatarUrl } } }
    }`,
    { input: { pullRequestReviewThreadId: threadId, body } },
  );
  const c = data.addPullRequestReviewThreadReply.comment;
  return { id: c.id, url: c.url, body: c.body, createdAt: c.createdAt, author: c.author?.login ?? "ghost", authorAvatarUrl: c.author?.avatarUrl ?? null };
}

const COMMENT_MUTATIONS = {
  issue: {
    update: `mutation ($id: ID!, $body: String!) { updateIssueComment(input: { id: $id, body: $body }) { issueComment { id } } }`,
    remove: `mutation ($id: ID!) { deleteIssueComment(input: { id: $id }) { clientMutationId } }`,
  },
  review: {
    update: `mutation ($id: ID!, $body: String!) { updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $id, body: $body }) { pullRequestReviewComment { id } } }`,
    remove: `mutation ($id: ID!) { deletePullRequestReviewComment(input: { id: $id }) { clientMutationId } }`,
  },
} as const;

export async function updateComment(id: string, kind: CommentKind, body: string) {
  await graphql(COMMENT_MUTATIONS[kind].update, { id, body });
}

export async function deleteComment(id: string, kind: CommentKind) {
  await graphql(COMMENT_MUTATIONS[kind].remove, { id });
}

/** Asks for a review from each login; GitHub treats an existing reviewer as a re-request. */
export async function requestReviewers(pr: PrRef, logins: string[], teams: string[]) {
  await rest.post(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/requested_reviewers`, { reviewers: logins, team_reviewers: teams });
}

export async function removeReviewers(pr: PrRef, logins: string[], teams: string[]) {
  await rest.del(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/requested_reviewers`, { reviewers: logins, team_reviewers: teams });
}

export async function setThreadResolved(threadId: string, resolved: boolean) {
  const mutation = resolved ? "resolveReviewThread" : "unresolveReviewThread";
  await graphql(
    `mutation ($input: ${resolved ? "ResolveReviewThreadInput" : "UnresolveReviewThreadInput"}!) { ${mutation}(input: $input) { thread { id isResolved } } }`,
    { input: { threadId } },
  );
}

// ── drafts ────────────────────────────────────────────────────────────────────
type DraftRow = {
  id: string;
  owner: string;
  repo: string;
  number: number;
  path: string;
  side: DiffSide;
  line: number;
  start_line: number | null;
  body: string;
  created_at: string;
};

const toDraft = (r: DraftRow): DraftComment => ({
  id: r.id,
  pr: { owner: r.owner, repo: r.repo, number: r.number },
  path: r.path,
  side: r.side,
  line: r.line,
  startLine: r.start_line,
  body: r.body,
  createdAt: r.created_at,
});

export function listDrafts(pr: PrRef): DraftComment[] {
  return db
    .query<DraftRow, [string, string, number]>(
      "SELECT * FROM pr_drafts WHERE owner = ? AND repo = ? AND number = ? ORDER BY created_at, rowid",
    )
    .all(pr.owner, pr.repo, pr.number)
    .map(toDraft);
}

export function addDraft(pr: PrRef, d: NewDraft): DraftComment {
  const id = randomUUID();
  const startLine = d.startLine != null && d.startLine !== d.line ? d.startLine : null;
  const createdAt = new Date().toISOString();
  db.query(
    `INSERT INTO pr_drafts (id, owner, repo, number, path, side, line, start_line, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, pr.owner, pr.repo, pr.number, d.path, d.side, d.line, startLine, d.body, createdAt);
  return { id, pr, path: d.path, side: d.side, line: d.line, startLine, body: d.body, createdAt };
}

export function updateDraft(pr: PrRef, id: string, body: string): DraftComment | null {
  db.query("UPDATE pr_drafts SET body = ? WHERE id = ? AND owner = ? AND repo = ? AND number = ?").run(
    body,
    id,
    pr.owner,
    pr.repo,
    pr.number,
  );
  const row = db.query<DraftRow, [string]>("SELECT * FROM pr_drafts WHERE id = ?").get(id);
  return row ? toDraft(row) : null;
}

export function deleteDraft(pr: PrRef, id: string) {
  db.query("DELETE FROM pr_drafts WHERE id = ? AND owner = ? AND repo = ? AND number = ?").run(id, pr.owner, pr.repo, pr.number);
}

// ── submitting ────────────────────────────────────────────────────────────────
type GhReview = { id: number; node_id: string; state: string; user: { login: string } | null };

/** A review the viewer started on GitHub and never submitted. */
export async function pendingGithubReview(pr: PrRef): Promise<{ nodeId: string; comments: number } | null> {
  const login = await viewerLogin();
  const reviews = await rest.paginate<GhReview>(`${repoPath(pr)}/pulls/${pr.number}/reviews`);
  const pending = reviews.find((r) => r.state === "PENDING" && r.user?.login === login);
  if (!pending) return null;
  const comments = await rest.paginate<unknown>(`${repoPath(pr)}/pulls/${pr.number}/reviews/${pending.id}/comments`);
  return { nodeId: pending.node_id, comments: comments.length };
}

/**
 * Submit the drafts as one review. Each draft is deleted only after GitHub has
 * accepted it, so a failure half-way leaves the rest where you can still see them.
 */
export async function submitReview(pr: PrRef, event: ReviewEvent, body: string): Promise<SubmitResult> {
  const drafts = listDrafts(pr);
  const summary = body.trim() || undefined;
  const pending = await pendingGithubReview(pr);
  if (pending) {
    for (const d of drafts) {
      await graphql(
        `mutation ($input: AddPullRequestReviewThreadInput!) { addPullRequestReviewThread(input: $input) { thread { id } } }`,
        {
          input: {
            pullRequestReviewId: pending.nodeId,
            path: d.path,
            line: d.line,
            side: d.side,
            body: d.body,
            ...(d.startLine != null && d.startLine !== d.line ? { startLine: d.startLine, startSide: d.side } : {}),
          },
        },
      );
      deleteDraft(pr, d.id);
    }
    const submitted = await graphql<{ submitPullRequestReview: { pullRequestReview: { url: string } } }>(
      `mutation ($input: SubmitPullRequestReviewInput!) { submitPullRequestReview(input: $input) { pullRequestReview { url } } }`,
      { input: { pullRequestReviewId: pending.nodeId, event, body: summary } },
    );
    return {
      ok: true,
      reviewUrl: submitted.submitPullRequestReview.pullRequestReview.url,
      submittedDrafts: drafts.length,
      mergedGithubComments: pending.comments,
      error: null,
    };
  }
  const detail = await rest.get<{ head: { sha: string } }>(`${repoPath(pr)}/pulls/${pr.number}`);
  const review = await rest.post<{ html_url: string }>(`${repoPath(pr)}/pulls/${pr.number}/reviews`, {
    commit_id: detail.head.sha,
    event,
    body: summary,
    comments: drafts.map((d) => ({
      path: d.path,
      line: d.line,
      side: d.side,
      body: d.body,
      ...(d.startLine != null && d.startLine !== d.line ? { start_line: d.startLine, start_side: d.side } : {}),
    })),
  });
  for (const d of drafts) deleteDraft(pr, d.id);
  return { ok: true, reviewUrl: review.html_url, submittedDrafts: drafts.length, error: null };
}

/** A plain comment in the PR conversation, outside any review. */
export async function postIssueComment(pr: PrRef, body: string): Promise<string> {
  const data = await rest.post<{ html_url: string }>(`${repoPath(pr)}/issues/${pr.number}/comments`, { body });
  return data.html_url;
}

/** Which right-side lines of each file GitHub will accept an inline comment on. */
export async function commentableLines(pr: PrRef): Promise<Map<string, Set<number>>> {
  const files = await rest.paginate<GhFile>(`${repoPath(pr)}/pulls/${pr.number}/files`);
  const out = new Map<string, Set<number>>();
  for (const f of files) {
    const lines = new Set<number>();
    let next = 0;
    for (const row of (f.patch ?? "").split("\n")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
      if (hunk) next = Number(hunk[1]);
      else if (row.startsWith("+") || row.startsWith(" ")) lines.add(next++);
    }
    out.set(f.filename, lines);
  }
  return out;
}
