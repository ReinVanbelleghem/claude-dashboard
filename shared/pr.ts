/**
 * Types shared by the daemon and the browser for the GitHub review pages.
 *
 * Kept outside src/ and server/ so neither side imports the other's runtime: the
 * daemon has no DOM and the browser has no bun:sqlite, but both speak these shapes.
 */
export type PrRef = { owner: string; repo: string; number: number };

export const prKey = (pr: PrRef) => `${pr.owner}/${pr.repo}#${pr.number}`;
export const prParam = (pr: PrRef) => `${pr.owner}/${pr.repo}/${pr.number}`;

export type PrSummary = PrRef & {
  url: string;
  title: string;
  author: string;
  authorName: string | null;
  authorAvatarUrl: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  ciState: "SUCCESS" | "FAILURE" | "PENDING" | "ERROR" | null;
  labels: { name: string; color: string }[];
  reviewRequestedFromMe: boolean;
};

export type PrDetail = PrSummary & { body: string };

// ── watch ─────────────────────────────────────────────────────────────────────
export type PrWatchChangeKind = "commit" | "review" | "comment" | "decision" | "ci" | "conflict" | "merged" | "closed";

/** One thing that happened on a watched PR since it was last looked at. */
export type PrWatchChange = {
  kind: PrWatchChangeKind;
  /** When the poll saw it, not when GitHub recorded it. */
  at: string;
  text: string;
  url: string | null;
  actor?: string;
  state?: string;
  /** Commits that landed in the same poll are one change with a count. */
  count?: number;
};

export type PrWatchEntry = PrRef & { since: string };

/** A watched PR as the daemon holds it: the last snapshot plus what piled up unseen. */
export type PrWatch = PrRef & {
  since: string;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  headSha: string;
  reviewDecision: PrSummary["reviewDecision"];
  ciState: PrSummary["ciState"];
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  unseen: PrWatchChange[];
  lastPolledAt: string | null;
  lastSeenAt: string | null;
  /** The last poll's failure, when it had one; cleared by the next success. */
  error: string | null;
};

export type PrFilter = {
  /** Empty means the tracked repos from settings. */
  repos: string[];
  reviewRequestedFromMe?: boolean;
  hideApproved?: boolean;
  authors?: string[];
  includeDrafts?: boolean;
  query?: string;
};

export type SavedView = { id: string; name: string; filter: PrFilter };

export type Person = { login: string; name: string | null; avatarUrl: string };

// ── files changed ─────────────────────────────────────────────────────────────
export type FileStatus = "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";

export type ReviewFile = {
  path: string;
  previousFilename: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  changes: number;
  /** GitHub's own hunks. Null when it withheld them (very large diff) or the file is binary. */
  patch: string | null;
  patchOmitted: boolean;
  viewed: boolean;
};

export type FilesResponse = { headSha: string; baseSha: string; viewer: string | null; files: ReviewFile[] };

export type PrPerson = { login: string; avatarUrl: string };

export type PrReviewer = PrPerson & {
  /** Their latest review, or "PENDING" when they were asked and have not answered. */
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  isTeam?: boolean;
};

export type PrCheck = { name: string; status: "success" | "failure" | "pending" | "neutral" | "skipped"; url: string | null; detail: string | null };

/** An inline comment a review left on a line, as shown under the review in the overview. */
export type PrInlineComment = {
  id: string;
  path: string;
  line: number | null;
  body: string;
  diffHunk: string | null;
  url: string;
  author: string;
  authorAvatarUrl: string | null;
  createdAt: string;
  /** Set when this answers another inline comment rather than starting a thread. */
  inReplyTo: string | null;
  /** On a thread's first comment: the review thread it opened, for replying and resolving. */
  threadId: string | null;
  resolved: boolean;
};

/** Which GitHub object a comment is: a conversation post or an inline review comment. */
export type CommentKind = "issue" | "review";

/** The comment GitHub created for a reply, so the UI can show it before refetching. */
export type ThreadReply = { id: string; url: string; body: string; createdAt: string; author: string; authorAvatarUrl: string | null };

/** One entry of the conversation: a top-level comment or a review's summary. */
export type PrTimelineItem = {
  id: string;
  kind: "comment" | "review";
  author: string;
  authorAvatarUrl: string | null;
  body: string;
  createdAt: string;
  url: string;
  /** For a review: how it concluded. */
  state?: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  /** For a review: how many inline comments it carried. */
  inlineComments?: number;
  /** For a review: the inline comments themselves. */
  inline?: PrInlineComment[];
};

export type PrOverview = {
  pr: PrDetail;
  /** Who is looking, so the UI knows which comments are theirs to edit. */
  viewer: string | null;
  reviewers: PrReviewer[];
  assignees: PrPerson[];
  milestone: string | null;
  checks: PrCheck[];
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  commits: number;
  timeline: PrTimelineItem[];
};

export type PrCommit = {
  sha: string;
  short: string;
  subject: string;
  body: string;
  author: string;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  date: string;
  url: string;
};

export type DiffSide = "LEFT" | "RIGHT";

export type ThreadComment = {
  id: string;
  databaseId: number;
  author: string | null;
  authorAvatarUrl: string | null;
  body: string;
  createdAt: string;
  url: string;
};

export type ReviewThread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  diffSide: DiffSide;
  diffHunk: string | null;
  comments: ThreadComment[];
};

export type DraftComment = {
  id: string;
  pr: PrRef;
  path: string;
  side: DiffSide;
  line: number;
  startLine: number | null;
  body: string;
  createdAt: string;
};

export type NewDraft = { path: string; side: DiffSide; line: number; startLine: number | null; body: string };

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export type SubmitResult = {
  ok: boolean;
  reviewUrl: string | null;
  submittedDrafts: number;
  mergedGithubComments?: number;
  error: string | null;
};

// ── actions and runs ──────────────────────────────────────────────────────────
/** The same modes the session composer offers; "default" is the CLI's "ask me". */
export type ReviewPermissionMode = "default" | "acceptEdits" | "plan" | "dontAsk" | "auto" | "bypassPermissions";

export type ReviewAction = {
  id: string;
  name: string;
  promptTemplate: string;
  allowedTools: string[];
  permissionMode: ReviewPermissionMode;
  /** Empty means the dashboard's default model. */
  model: string;
  /** `head` checks the PR out in a worktree; `none` runs in an empty scratch directory. */
  checkout: "head" | "none";
  structuredFindings: boolean;
};

export type FindingSeverity = "high" | "medium" | "low";

export type Finding = {
  id: string;
  severity: FindingSeverity;
  title: string;
  file?: string;
  line?: number;
  background?: string;
  body: string;
  suggestion?: string;
  previousSeverity?: FindingSeverity;
  change?: string;
  isNew?: boolean;
};

export type DroppedFinding = Finding & { reason: string };

export type Findings = { summary: string; findings: Finding[]; dropped?: DroppedFinding[] };

export type PostedFinding = { kind: "draft" | "comment"; url?: string };

export type FindingTarget = { mode: "draft" | "comment"; reason?: string };

export type RunStatus = "starting" | "running" | "succeeded" | "failed" | "ended";

export type PrRun = {
  id: string;
  actionId: string | null;
  actionName: string;
  pr: PrRef;
  title: string;
  status: RunStatus;
  /** The dashboard session driving this run, while the daemon still has it. */
  agentKey: string | null;
  sessionId: string | null;
  cwd: string | null;
  prompt: string;
  /** Plain-text replies, one per finished turn, for runs without structured findings. */
  replies: string[];
  costUsd: number | null;
  findings: Findings | null;
  checkedFindings: string[];
  postedFindings: Record<string, PostedFinding>;
  createdAt: string;
  finishedAt: string | null;
};

// ── explain ───────────────────────────────────────────────────────────────────
export type ExplainStatus = "queued" | "running" | "done" | "failed";

export type ExplainPart = { title: string; explanation: string; path?: string; startLine?: number; endLine?: number };

export type ExplainResult = { summary: string; parts: ExplainPart[] };

export type Explanation = PrRef & {
  id: string;
  /** The root explanation this one belongs to; roots point at themselves. */
  rootId: string;
  parentId: string | null;
  drillPartIndex: number | null;
  drillText: string | null;
  side: "base" | "head";
  sha: string;
  path: string;
  startLine: number;
  endLine: number;
  code: string;
  question: string | null;
  status: ExplainStatus;
  result: ExplainResult | null;
  error: string | null;
  agentKey: string | null;
  sessionId: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type ExplainTarget = { side: "base" | "head"; path: string; startLine: number; endLine: number; code: string };

// ── context links ─────────────────────────────────────────────────────────────
export type ContextLink = { kind: "notion" | "slack"; url: string };

const URL_PATTERN = /https?:\/\/[^\s)>\]"'`]+/g;

export function classifyLink(url: string): ContextLink["kind"] | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (host === "notion.so" || host.endsWith(".notion.so") || host === "notion.com" || host.endsWith(".notion.com")) return "notion";
  if (host.endsWith(".slack.com")) return "slack";
  return null;
}

export function notionPageId(url: string): string | null {
  const path = url.split(/[?#]/)[0].replace(/\/+$/, "");
  const match = path.slice(path.lastIndexOf("/") + 1).replace(/-/g, "").match(/([0-9a-f]{32})$/i);
  return match ? match[1].toLowerCase() : null;
}

export function contextLinks(body: string): ContextLink[] {
  const seen = new Set<string>();
  const links: ContextLink[] = [];
  for (const match of body.match(URL_PATTERN) ?? []) {
    const url = match.replace(/[.,;:!?]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    const kind = classifyLink(url);
    if (kind) links.push({ kind, url });
  }
  return links;
}

const linkKey = (link: ContextLink) => (link.kind === "notion" && notionPageId(link.url)) || link.url;

/** Links in a PR body that are not boilerplate from the repository's PR template. */
export function linksBeyondTemplate(body: string, template: string): ContextLink[] {
  const boilerplate = new Set(contextLinks(template).map(linkKey));
  return contextLinks(body).filter((link) => !boilerplate.has(linkKey(link)));
}
