import type { Database } from "bun:sqlite";
import type { PrRef, PrSummary, PrWatch, PrWatchChange, PrWatchEntry } from "../shared/pr.ts";
import { GithubError, graphql, viewerLogin } from "./github.ts";
import { listReviewRequests } from "./prs.ts";
import { fireEvent } from "./notify.ts";
import { getSettings, onSettingsChange, updateSettings } from "./settings.ts";

/**
 * Watched pull requests: one poller, a snapshot per PR, and the difference between
 * the two turned into a list of what you have not seen yet.
 *
 * The list of what to watch lives in settings.json; what was last seen lives in
 * SQLite. Splitting them means a reindex or a wiped database forgets nothing you
 * chose, only what it had already told you — which the next poll re-seeds quietly
 * rather than replaying as news.
 *
 * Everything the browser shows comes from here: a row's activity chips, the strip on
 * the PR page and the sidebar badge are all the same `unseen` list, pushed as
 * `pr-watch` whenever it changes, so a reload shows exactly what the daemon holds.
 */
type Row = {
  owner: string;
  repo: string;
  number: number;
  head_sha: string | null;
  review_decision: string | null;
  ci_state: string | null;
  mergeable: string | null;
  state: string | null;
  last_comment_id: string | null;
  last_review_id: string | null;
  last_polled_at: string | null;
  last_seen_at: string | null;
  closed_at: string | null;
  snapshot: string;
};

type Snapshot = { title: string; url: string; unseen: PrWatchChange[]; error: string | null };

type GqlWatch = {
  repository: {
    pullRequest: {
      title: string;
      url: string;
      state: "OPEN" | "MERGED" | "CLOSED";
      headRefOid: string;
      mergeable: PrWatch["mergeable"];
      reviewDecision: PrSummary["reviewDecision"];
      closedAt: string | null;
      mergedAt: string | null;
      mergedBy: { login: string } | null;
      commits: {
        nodes: {
          commit: { oid: string; abbreviatedOid: string; messageHeadline: string; url: string; statusCheckRollup: { state: string } | null };
        }[];
      };
      reviews: { nodes: { databaseId: number; state: string; url: string; author: { login: string } | null }[] };
      comments: { nodes: { databaseId: number; url: string; author: { login: string } | null }[] };
    } | null;
  };
};

const QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    title url state headRefOid mergeable reviewDecision closedAt mergedAt mergedBy { login }
    commits(last: 30) { nodes { commit { oid abbreviatedOid messageHeadline url statusCheckRollup { state } } } }
    reviews(last: 30) { nodes { databaseId state url author { login } } }
    comments(last: 30) { nodes { databaseId url author { login } } }
  } }
}`;

const MAX_BACKOFF_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

let db: Database;
let emit: (event: string, data: unknown) => void = () => {};
let timer: ReturnType<typeof setTimeout> | null = null;
let polling = false;
/** Doubles on each rate-limit answer and resets on the first success. */
let backoffMs = 0;
let backoffUntil = 0;

const keyOf = (pr: PrRef) => `${pr.owner}/${pr.repo}#${pr.number}`;
const sameRef = (a: PrRef, b: PrRef) => a.owner === b.owner && a.repo === b.repo && a.number === b.number;

export function initPrWatch(database: Database, broadcast: (event: string, data: unknown) => void) {
  db = database;
  emit = broadcast;
  let known = new Set(getSettings().reviews.watched.map(keyOf));
  let interval = intervalMs();
  // Only the watch list and the interval matter here; a theme change must not
  // spend a GitHub call. A new entry is seeded at once rather than at the next tick.
  onSettingsChange((s) => {
    const keys = new Set(s.reviews.watched.map(keyOf));
    const added = [...keys].some((k) => !known.has(k));
    known = keys;
    if (added) schedule(0);
    else if (intervalMs() !== interval) schedule();
    interval = intervalMs();
  });
  schedule(0);
}

function intervalMs(): number {
  return Math.max(1, getSettings().reviews.watchIntervalMinutes || 2) * 60_000;
}

/**
 * One timer, re-armed after every pass. A setting change re-arms it at once so a
 * freshly watched PR is seeded within seconds rather than at the next tick, and a
 * shorter interval takes effect without a restart.
 */
function schedule(delay = intervalMs()) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void pollAll(), Math.max(delay, backoffUntil - Date.now()));
}

async function pollAll() {
  if (polling) return;
  polling = true;
  try {
    const entries = getSettings().reviews.watched;
    const rows = new Map(readRows().map((r) => [keyOf(r), r]));
    let changed = false;
    let me = "";
    try {
      me = entries.length ? await viewerLogin() : "";
    } catch {
      // No token: every PR below fails the same way and records it.
    }
    for (const entry of entries) {
      if (Date.now() < backoffUntil) break;
      changed = (await pollOne(entry, rows.get(keyOf(entry)) ?? null, me)) || changed;
    }
    for (const row of rows.values()) {
      if (!entries.some((e) => sameRef(e, row))) {
        db.query("DELETE FROM pr_watch_state WHERE owner = ? AND repo = ? AND number = ?").run(row.owner, row.repo, row.number);
        changed = true;
      }
    }
    if (changed) emit("pr-watch", { watches: listWatches() });
    expire();
    if (Date.now() >= backoffUntil) await pollRequests();
  } catch (err) {
    console.error("[claude-dashboard] PR watch pass failed:", err);
  } finally {
    polling = false;
    schedule();
  }
}

/** Fetch, diff, store. Returns whether anything the browser shows changed. */
async function pollOne(entry: PrWatchEntry, row: Row | null, me: string): Promise<boolean> {
  const snap = row ? (JSON.parse(row.snapshot) as Snapshot) : { title: `${entry.repo}#${entry.number}`, url: "", unseen: [], error: null };
  let pr: NonNullable<GqlWatch["repository"]["pullRequest"]>;
  try {
    const data = await graphql<GqlWatch>(QUERY, { owner: entry.owner, repo: entry.repo, number: entry.number });
    if (!data.repository?.pullRequest) throw new GithubError(404, "Pull request not found");
    pr = data.repository.pullRequest;
    backoffMs = 0;
  } catch (e) {
    if (e instanceof GithubError && (e.status === 403 || e.status === 429)) {
      backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs ? backoffMs * 2 : intervalMs());
      backoffUntil = Date.now() + backoffMs;
      console.warn(`[claude-dashboard] GitHub rate limit on PR watch; pausing ${Math.round(backoffMs / 1000)}s`);
    }
    const message = e instanceof Error ? e.message : String(e);
    if (snap.error === message) return false;
    writeRow(entry, row, { ...snap, error: message }, null);
    return true;
  }

  const now = new Date().toISOString();
  const rollup = pr.commits.nodes.at(-1)?.commit.statusCheckRollup?.state;
  const ciState = rollup === "SUCCESS" || rollup === "FAILURE" || rollup === "PENDING" || rollup === "ERROR" ? rollup : rollup ? "PENDING" : null;
  const lastReview = Math.max(0, ...pr.reviews.nodes.map((r) => r.databaseId));
  const lastComment = Math.max(0, ...pr.comments.nodes.map((c) => c.databaseId));
  const next = {
    head_sha: pr.headRefOid,
    review_decision: pr.reviewDecision,
    ci_state: ciState,
    mergeable: pr.mergeable,
    state: pr.state,
    last_review_id: String(lastReview),
    last_comment_id: String(lastComment),
    closed_at: pr.closedAt ?? pr.mergedAt,
  };

  // The first poll only learns where things stand; nothing before you watched is news.
  const changes = row ? diff(row, pr, next, me, now) : [];
  const unseen = [...snap.unseen, ...changes];
  writeRow(entry, row, { title: pr.title, url: pr.url, unseen, error: null }, next);

  if (changes.length) {
    const label = `${entry.repo}#${entry.number}`;
    void fireEvent(
      {
        kind: "prWatch",
        key: `prWatch:${keyOf(entry)}`,
        sessionId: null,
        muteIds: [],
        label,
        context: pr.title,
        detail: summarize(changes),
      },
      `#/pr/${entry.owner}/${entry.repo}/${entry.number}`,
    );
  }
  return !row || changes.length > 0 || snap.error !== null || snap.title !== pr.title;
}

function diff(row: Row, pr: NonNullable<GqlWatch["repository"]["pullRequest"]>, next: Partial<Row>, me: string, at: string): PrWatchChange[] {
  const out: PrWatchChange[] = [];

  if (row.state === "OPEN" && pr.state === "MERGED") {
    out.push({ kind: "merged", at, text: pr.mergedBy ? `Merged by ${pr.mergedBy.login}` : "Merged", url: pr.url, actor: pr.mergedBy?.login });
  } else if (row.state === "OPEN" && pr.state === "CLOSED") {
    out.push({ kind: "closed", at, text: "Closed without merging", url: pr.url });
  }

  if (row.head_sha && row.head_sha !== pr.headRefOid) {
    const commits = pr.commits.nodes.map((n) => n.commit);
    const known = commits.findIndex((c) => c.oid === row.head_sha);
    const fresh = known >= 0 ? commits.slice(known + 1) : [];
    const head = commits.at(-1);
    if (fresh.length) {
      out.push({
        kind: "commit",
        at,
        count: fresh.length,
        text: fresh.length === 1 ? `New commit: ${fresh[0].messageHeadline}` : `${fresh.length} new commits, latest: ${fresh.at(-1)!.messageHeadline}`,
        url: head?.url ?? null,
      });
    } else {
      out.push({ kind: "commit", at, count: 1, text: `Force-pushed to ${head?.abbreviatedOid ?? pr.headRefOid.slice(0, 7)}`, url: head?.url ?? null });
    }
  }

  // Reviews and comments the viewer wrote themselves are not news to them.
  const lastReview = Number(row.last_review_id ?? 0);
  for (const r of pr.reviews.nodes) {
    if (r.databaseId <= lastReview || r.state === "PENDING" || r.author?.login === me) continue;
    const who = r.author?.login ?? "someone";
    const text =
      r.state === "APPROVED"
        ? `${who} approved`
        : r.state === "CHANGES_REQUESTED"
          ? `${who} requested changes`
          : r.state === "DISMISSED"
            ? `${who}'s review was dismissed`
            : `${who} reviewed`;
    out.push({ kind: "review", at, text, url: r.url, actor: who, state: r.state });
  }
  const lastComment = Number(row.last_comment_id ?? 0);
  for (const c of pr.comments.nodes) {
    if (c.databaseId <= lastComment || c.author?.login === me) continue;
    const who = c.author?.login ?? "someone";
    out.push({ kind: "comment", at, text: `${who} commented`, url: c.url, actor: who });
  }

  if (row.review_decision !== pr.reviewDecision && pr.reviewDecision) {
    const text = pr.reviewDecision === "APPROVED" ? "Approved" : pr.reviewDecision === "CHANGES_REQUESTED" ? "Changes requested" : "Review required again";
    out.push({ kind: "decision", at, text, url: pr.url, state: pr.reviewDecision });
  }

  // Only settled CI states are worth a word; a run starting after a push is implied by the push.
  if (row.ci_state !== next.ci_state && (next.ci_state === "SUCCESS" || next.ci_state === "FAILURE" || next.ci_state === "ERROR")) {
    out.push({ kind: "ci", at, text: next.ci_state === "SUCCESS" ? "CI green" : "CI red", url: pr.commits.nodes.at(-1)?.commit.url ?? null, state: next.ci_state });
  }

  // UNKNOWN is GitHub still computing; only a real verdict is a change.
  if (row.mergeable !== "CONFLICTING" && pr.mergeable === "CONFLICTING") {
    out.push({ kind: "conflict", at, text: "Merge conflict with the base branch", url: pr.url, state: pr.mergeable });
  }
  return out;
}

/** "2 new commits, CI green, alice approved" — one line for the notification. */
function summarize(changes: PrWatchChange[]): string {
  const parts: string[] = [];
  const commits = changes.filter((c) => c.kind === "commit").reduce((n, c) => n + (c.count ?? 1), 0);
  if (commits) parts.push(commits === 1 ? "1 new commit" : `${commits} new commits`);
  for (const c of changes) if (c.kind === "merged" || c.kind === "closed" || c.kind === "conflict" || c.kind === "ci" || c.kind === "review") parts.push(c.text);
  const comments = changes.filter((c) => c.kind === "comment").length;
  if (comments) parts.push(comments === 1 ? "1 new comment" : `${comments} new comments`);
  const decision = changes.find((c) => c.kind === "decision");
  if (decision && !changes.some((c) => c.kind === "review")) parts.push(decision.text);
  return parts.join(", ").slice(0, 160);
}

function readRows(): Row[] {
  return db.query<Row, []>("SELECT * FROM pr_watch_state").all();
}

function writeRow(entry: PrRef, row: Row | null, snap: Snapshot, next: Partial<Row> | null) {
  const polledAt = new Date().toISOString();
  if (row) {
    db.query(
      `UPDATE pr_watch_state SET head_sha = ?, review_decision = ?, ci_state = ?, mergeable = ?, state = ?,
         last_comment_id = ?, last_review_id = ?, last_polled_at = ?, closed_at = ?, snapshot = ?
       WHERE owner = ? AND repo = ? AND number = ?`,
    ).run(
      next?.head_sha ?? row.head_sha,
      next?.review_decision ?? row.review_decision,
      next?.ci_state ?? row.ci_state,
      next?.mergeable ?? row.mergeable,
      next?.state ?? row.state,
      next?.last_comment_id ?? row.last_comment_id,
      next?.last_review_id ?? row.last_review_id,
      polledAt,
      next ? (next.closed_at ?? null) : row.closed_at,
      JSON.stringify(snap),
      entry.owner,
      entry.repo,
      entry.number,
    );
    return;
  }
  db.query(
    `INSERT INTO pr_watch_state (owner, repo, number, head_sha, review_decision, ci_state, mergeable, state,
       last_comment_id, last_review_id, last_polled_at, last_seen_at, closed_at, snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.owner,
    entry.repo,
    entry.number,
    next?.head_sha ?? null,
    next?.review_decision ?? null,
    next?.ci_state ?? null,
    next?.mergeable ?? null,
    next?.state ?? null,
    next?.last_comment_id ?? null,
    next?.last_review_id ?? null,
    polledAt,
    polledAt,
    next?.closed_at ?? null,
    JSON.stringify(snap),
  );
}

const SEEDED = { owner: "", repo: "", number: 0 };

/**
 * New review requests, announced once each. The first pass only records what is
 * already asked of you; a queue that existed before the feature is not news.
 */
async function pollRequests() {
  const mode = getSettings().reviews.reviewRequests;
  if (mode === "off") return;
  let requests: Awaited<ReturnType<typeof listReviewRequests>>;
  try {
    requests = await listReviewRequests();
  } catch (e) {
    if (e instanceof GithubError && (e.status === 403 || e.status === 429)) backoffUntil = Date.now() + Math.max(backoffMs, intervalMs());
    return;
  }
  const now = new Date().toISOString();
  const seen = new Set(
    db
      .query<{ owner: string; repo: string; number: number }, []>("SELECT owner, repo, number FROM pr_review_requests")
      .all()
      .map(keyOf),
  );
  const seeded = seen.has(keyOf(SEEDED));
  const insert = db.query("INSERT OR IGNORE INTO pr_review_requests (owner, repo, number, seen_at) VALUES (?, ?, ?, ?)");
  if (!seeded) insert.run(SEEDED.owner, SEEDED.repo, SEEDED.number, now);
  let watchedAny = false;
  for (const pr of requests) {
    if (seen.has(keyOf(pr))) continue;
    insert.run(pr.owner, pr.repo, pr.number, now);
    if (!seeded) continue;
    void fireEvent(
      {
        kind: "prReviewRequested",
        key: `prReviewRequested:${keyOf(pr)}`,
        sessionId: null,
        muteIds: [],
        label: `${pr.repo}#${pr.number}`,
        context: pr.title,
        detail: `${pr.authorName ?? pr.author} asked you to review`,
      },
      `#/pr/${pr.owner}/${pr.repo}/${pr.number}`,
    );
    if (mode === "watch" && !isWatched(pr)) {
      updateSettings({ reviews: { watched: [...getSettings().reviews.watched, { owner: pr.owner, repo: pr.repo, number: pr.number, since: now }] } });
      watchedAny = true;
    }
  }
  // A request that is gone (reviewed, withdrawn, PR closed) is forgotten, so being
  // asked again later counts as new.
  const open = new Set(requests.map(keyOf));
  const del = db.query("DELETE FROM pr_review_requests WHERE owner = ? AND repo = ? AND number = ?");
  for (const k of seen) {
    if (k === keyOf(SEEDED) || open.has(k)) continue;
    const m = /^(.+?)\/(.+?)#(\d+)$/.exec(k);
    if (m) del.run(m[1], m[2], Number(m[3]));
  }
  if (watchedAny) emit("settings", getSettings());
}

/** Drop merged and closed PRs once they have been that way for the configured number of days. */
function expire() {
  const days = getSettings().reviews.watchUnwatchAfterDays;
  if (!days || days <= 0) return;
  const cutoff = Date.now() - days * DAY_MS;
  const stale = readRows().filter((r) => r.state !== "OPEN" && r.closed_at && new Date(r.closed_at).getTime() < cutoff);
  if (!stale.length) return;
  const watched = getSettings().reviews.watched.filter((e) => !stale.some((r) => sameRef(r, e)));
  for (const r of stale) db.query("DELETE FROM pr_watch_state WHERE owner = ? AND repo = ? AND number = ?").run(r.owner, r.repo, r.number);
  emit("settings", updateSettings({ reviews: { watched } }));
  emit("pr-watch", { watches: listWatches() });
}

export function listWatches(): PrWatch[] {
  const rows = new Map(readRows().map((r) => [keyOf(r), r]));
  return getSettings().reviews.watched.map((entry): PrWatch => {
    const row = rows.get(keyOf(entry));
    const snap = row ? (JSON.parse(row.snapshot) as Snapshot) : null;
    return {
      ...entry,
      title: snap?.title ?? `${entry.repo}#${entry.number}`,
      url: snap?.url ?? `https://github.com/${entry.owner}/${entry.repo}/pull/${entry.number}`,
      state: (row?.state as PrWatch["state"]) ?? "OPEN",
      headSha: row?.head_sha ?? "",
      reviewDecision: (row?.review_decision as PrWatch["reviewDecision"]) ?? null,
      ciState: (row?.ci_state as PrWatch["ciState"]) ?? null,
      mergeable: (row?.mergeable as PrWatch["mergeable"]) ?? "UNKNOWN",
      unseen: snap?.unseen ?? [],
      lastPolledAt: row?.last_polled_at ?? null,
      lastSeenAt: row?.last_seen_at ?? null,
      error: snap?.error ?? null,
    };
  });
}

export function isWatched(pr: PrRef): boolean {
  return getSettings().reviews.watched.some((e) => sameRef(e, pr));
}

/** Add to the list; the next pass (re-armed by the settings change) seeds the snapshot. */
export function watch(pr: PrRef): PrWatch[] {
  if (!isWatched(pr)) {
    const entry: PrWatchEntry = { owner: pr.owner, repo: pr.repo, number: pr.number, since: new Date().toISOString() };
    emit("settings", updateSettings({ reviews: { watched: [...getSettings().reviews.watched, entry] } }));
  }
  const watches = listWatches();
  emit("pr-watch", { watches });
  return watches;
}

export function unwatch(pr: PrRef): PrWatch[] {
  if (isWatched(pr)) {
    emit("settings", updateSettings({ reviews: { watched: getSettings().reviews.watched.filter((e) => !sameRef(e, pr)) } }));
    db.query("DELETE FROM pr_watch_state WHERE owner = ? AND repo = ? AND number = ?").run(pr.owner, pr.repo, pr.number);
  }
  const watches = listWatches();
  emit("pr-watch", { watches });
  return watches;
}

export function markSeen(pr: PrRef): PrWatch[] {
  const row = db
    .query<Row, [string, string, number]>("SELECT * FROM pr_watch_state WHERE owner = ? AND repo = ? AND number = ?")
    .get(pr.owner, pr.repo, pr.number);
  if (row) {
    const snap = JSON.parse(row.snapshot) as Snapshot;
    if (snap.unseen.length || !row.last_seen_at) {
      db.query("UPDATE pr_watch_state SET snapshot = ?, last_seen_at = ? WHERE owner = ? AND repo = ? AND number = ?").run(
        JSON.stringify({ ...snap, unseen: [] }),
        new Date().toISOString(),
        pr.owner,
        pr.repo,
        pr.number,
      );
    }
  }
  const watches = listWatches();
  emit("pr-watch", { watches });
  return watches;
}
