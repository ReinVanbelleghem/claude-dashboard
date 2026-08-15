import type { Appearance } from "./appearance.ts";

export type LiveSession = {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string | null;
  status: string | null;
  waitingFor: string | null;
  kind: string | null;
  version: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  statusUpdatedAt: number | null;
  alive: boolean;
};

export type LivePayload = {
  sessions: LiveSession[];
  counts: { alive: number; needsInput: number; stale: number };
};

export type Bucket = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Everything summed, cache reads included. */
  total: number;
  /** Uncached input + cache writes + output — what the gauges track. */
  fresh: number;
  costUsd: number;
};

export type UsagePayload = {
  now: number;
  budgets: { fiveHourTokens: number; weeklyTokens: number; dailyCostUsd: number };
  fiveHour: Bucket;
  day: Bucket;
  week: Bucket;
  allTime: Bucket;
  byModel: (Bucket & { model: string })[];
  hourly: { bucket: number; tokens: number }[];
  daily: { day: string; tokens: number; turns: number }[];
  remaining: { fiveHourPct: number; weeklyPct: number; dailyCostPct: number };
};

export type SessionRow = {
  id: string;
  project_slug: string;
  cwd: string | null;
  git_branch: string | null;
  title: string | null;
  first_ts: number | null;
  last_ts: number | null;
  msg_count: number;
  prompt_count: number;
  tool_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  model: string | null;
};

export type SessionDetail = {
  session: SessionRow;
  prompts: { uuid: string; ts: number | null; text: string }[];
  turns: {
    uuid: string;
    ts: number | null;
    text: string;
    role: "user" | "assistant";
    model: string | null;
  }[];
  tools: { name: string; count: number }[];
  prLinks: { pr_url: string; pr_number: number | null; repo: string | null }[];
};

export type Overview = {
  totals: { sessions: number; msgs: number; prompts: number; tools: number };
  projects: { project_slug: string; path: string; sessions: number; last_ts: number | null }[];
  topTools: { name: string; count: number }[];
};

// ── owned (interactive) sessions ───────────────────────────────────────────────
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

export type AgentStatus = "starting" | "idle" | "thinking" | "awaiting-permission" | "ended" | "error";

export type TimelineItem = (
  | {
      kind: "user";
      ts: number;
      text: string;
      queued?: boolean;
      /**
       * Attached images. The bytes went to the model and to disk, not into the
       * timeline; `url` points at the stored copy, and is absent when the daemon
       * could not write it (older items included — they predate the store).
       */
      images?: { label: string; mediaType: string; bytes: number; url?: string }[];
    }
  | { kind: "assistant"; ts: number; text: string }
  | { kind: "thinking"; ts: number; text: string }
  | { kind: "tool"; ts: number; id: string; name: string; input: unknown; result?: string; ok?: boolean }
  | {
      kind: "permission";
      ts: number;
      requestId: string;
      toolName: string;
      title: string | null;
      description: string | null;
      input: unknown;
      decision: "allow" | "allowAlways" | "deny" | null;
    }
  | { kind: "result"; ts: number; costUsd: number | null; durationMs: number | null; error: string | null }
  | { kind: "error"; ts: number; text: string }
) & { agentId?: string };

/** A subagent spawned by the Task tool inside a session. */
export type TaskInfo = {
  taskId: string;
  /** What forwarded subagent messages are tagged with; null until reported. */
  toolUseId: string | null;
  name: string;
  activity: string | null;
  subagentType: string | null;
  status: "running" | "completed" | "failed" | "stopped" | "paused" | "pending";
  /** Final report, once finished. */
  report: string | null;
  lastTool: string | null;
  tokens: number;
  toolUses: number;
  durationMs: number;
};

export type ModelInfo = { value: string; displayName: string; description: string; resolvedModel?: string };

export type AgentSummary = {
  key: string;
  sessionId: string | null;
  cwd: string;
  title: string | null;
  model: string | null;
  permissionMode: PermissionMode;
  status: AgentStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  endedReason: string | null;
  turns: number;
  pending: number;
};

/** A past dashboard session that can be resumed with its history intact. */
export type Restorable = {
  sessionId: string;
  cwd: string;
  title: string | null;
  model: string | null;
  lastSeen: number;
};

export type AgentDetail = AgentSummary & {
  timeline: TimelineItem[];
  streaming: string;
  models: ModelInfo[] | null;
  /** Subagents this session has spawned, newest state first reported wins. */
  tasks: TaskInfo[];
  /** Slash commands this session accepts: skills, plugins, prompt-level built-ins. */
  commands: SlashCommand[] | null;
  /** Tail of the child process's stderr — the clue when it dies unasked. */
  stderr: string;
};

export type SlashCommand = { name: string; description: string; argumentHint?: string };

/** The four types the API accepts, base64 as it came off the clipboard. */
export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
export type OutboundImage = { mediaType: ImageMediaType; data: string };

export type DirListing = {
  path: string;
  parent: string | null;
  isRepo: boolean;
  entries: { name: string; path: string; isRepo: boolean }[];
};

export type Favourite = { label: string; path: string };

// ── settings ──────────────────────────────────────────────────────────────────
export type NotifyEventKind =
  | "needsInput"
  | "awaitingPermission"
  | "turnComplete"
  | "sessionError";

export type Settings = {
  notifications: {
    enabled: boolean;
    events: Record<NotifyEventKind, boolean>;
    channels: { native: boolean; browser: boolean; googleChat: boolean };
    googleChatWebhook: string;
    delaySeconds: number;
    cooldownSeconds: number;
    suppressWhenFocused: boolean;
    quietHours: { enabled: boolean; from: string; to: string };
    dashboardUrl: string;
  };
  ui: {
    diffMode: "unified" | "split";
    diffIgnoreWhitespace: boolean;
    /** Hide tool calls and thinking in conversations. */
    hideToolCalls: boolean;
    /** Where a click on a session card lands. */
    openSessionsIn: "drawer" | "page";
    /** Theme, accent hue and tab icon. Mirrored in localStorage for first paint. */
    appearance?: Appearance;

  };
};

/** A patch is merged server-side, so callers send only what changed. */
export type SettingsPatch = {
  notifications?: Partial<Omit<Settings["notifications"], "events" | "channels" | "quietHours">> & {
    events?: Partial<Settings["notifications"]["events"]>;
    channels?: Partial<Settings["notifications"]["channels"]>;
    quietHours?: Partial<Settings["notifications"]["quietHours"]>;
  };
  ui?: Partial<Settings["ui"]>;
};

/** What the server sends when something wants your attention. */
export type NotifyPayload = {
  kind: NotifyEventKind;
  title: string;
  body: string;
  context: string;
  sessionId: string | null;
  key: string;
  url: string;
  at: number;
};

export const settingsApi = {
  get: () => get<{ settings: Settings }>("/api/settings"),
  save: (patch: SettingsPatch) => post<{ settings: Settings }>("/api/settings", patch),
  test: () =>
    post<{
      ok: boolean;
      channels: { native: boolean; browser: boolean; googleChat: boolean };
      notifier: string | null;
    }>("/api/settings/test"),
  /** Tells the daemon which session is on screen, so it stays quiet about it. */
  focus: (sessionId: string | null, visible: boolean) =>
    post("/api/focus", { sessionId, visible }).catch(() => {}),
};

// ── review comments ───────────────────────────────────────────────────────────
export type ReviewComment = {
  id: string;
  repo: string;
  path: string;
  line: number | null;
  side: "old" | "new";
  anchorText: string | null;
  branch: string | null;
  body: string;
  status: "open" | "resolved";
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
};

export const commentApi = {
  list: (repo: string) =>
    get<{ comments: ReviewComment[] }>(`/api/comments?repo=${encodeURIComponent(repo)}`),
  add: (input: {
    repo: string;
    path?: string;
    line?: number | null;
    side?: "old" | "new";
    anchorText?: string | null;
    branch?: string | null;
    body: string;
  }) => post<{ comment: ReviewComment }>("/api/comments", input),
  update: (id: string, patch: { body?: string; status?: "open" | "resolved" }) =>
    post<{ comment: ReviewComment }>(`/api/comments/${id}`, patch),
  remove: (id: string) => fetch(`/api/comments/${id}`, { method: "DELETE" }),
  prompt: (repo: string, branch: string | null) =>
    get<{ text: string; ids: string[] }>(
      `/api/comments/prompt?repo=${encodeURIComponent(repo)}` +
        (branch ? `&branch=${encodeURIComponent(branch)}` : ""),
    ),
  markSent: (ids: string[]) => post("/api/comments/sent", { ids }),
  clearResolved: (repo: string) => post<{ removed: number }>("/api/comments/clear-resolved", { repo }),
};

// ── git (read-only) ───────────────────────────────────────────────────────────
export type ChangedFile = {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  from: string | null;
  insertions: number;
  deletions: number;
};

export type RepoStatus = {
  isRepo: boolean;
  root: string | null;
  name: string | null;
  branch: string | null;
  detached: boolean;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  base: string | null;
  onBase: boolean;
  files: ChangedFile[];
  counts: { staged: number; unstaged: number; untracked: number };
  aheadOfBase: number;
  error: string | null;
};

export type Commit = {
  sha: string;
  short: string;
  author: string;
  ts: number;
  subject: string;
  insertions: number;
  deletions: number;
  files: number;
};

export type DiffScope = "worktree" | "branch";

export type Branch = {
  /** "feat/x" for a local branch, "origin/feat/x" for a remote-tracking one. */
  name: string;
  remote: string | null;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  ts: number;
  head: string;
  subject: string;
  /** Remote branches only: a local branch of the same name already exists. */
  hasLocal: boolean;
};

export type BranchList = {
  ok: boolean;
  current: string | null;
  detached: boolean;
  /** One page: locals first, then remotes, most recent first. */
  branches: Branch[];
  /** How many exist in the repo, before query and limit. */
  total: { local: number; remote: number };
  /** How many matched the query, which can exceed what was returned. */
  matched: number;
  /**
   * The branch whose name is exactly the query, reported separately because paging
   * can push it out of `branches` — and it is what decides whether a typed name is
   * an existing branch or a new one.
   */
  exact: Branch | null;
  error: string | null;
};

/** Result of a git operation that changes the repo. */
export type GitWriteResult = {
  ok: boolean;
  /** State after the attempt, whether or not it succeeded. */
  status: RepoStatus | null;
  /** git's own message. Multi-line, and worth showing verbatim. */
  error: string | null;
  /** Advice git doesn't give itself. */
  hint: string | null;
  /** What a successful write actually did, when a tick alone would be ambiguous. */
  note?: string | null;
};

const q = (params: Record<string, string | number | boolean | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

export const gitApi = {
  status: (cwd: string, force = false) =>
    get<RepoStatus>(`/api/git/status?${q({ cwd, force: force ? 1 : undefined })}`),
  diff: (opts: {
    cwd: string;
    scope: DiffScope;
    path?: string;
    ignoreWhitespace?: boolean;
    context?: number;
  }) =>
    get<{ ok: boolean; patch: string; error: string | null }>(
      `/api/git/diff?${q({
        cwd: opts.cwd,
        scope: opts.scope,
        path: opts.path,
        ws: opts.ignoreWhitespace ? "ignore" : undefined,
        context: opts.context,
      })}`,
    ),
  log: (cwd: string, limit = 50) =>
    get<{ commits: Commit[]; range: string }>(`/api/git/log?${q({ cwd, limit })}`),
  branchFiles: (cwd: string) => get<{ files: ChangedFile[] }>(`/api/git/branch-files?${q({ cwd })}`),
  commit: (cwd: string, sha: string, ignoreWhitespace = false) =>
    get<{ ok: boolean; commit: Commit | null; patch: string; error: string | null }>(
      `/api/git/commit?${q({ cwd, sha, ws: ignoreWhitespace ? "ignore" : undefined })}`,
    ),
  /**
   * Filtered server-side: a long-lived repo has thousands of remote branches, so
   * the query goes down rather than the branch list coming up.
   */
  branches: (cwd: string, opts: { q?: string; limit?: number } = {}) =>
    get<BranchList>(`/api/git/branches?${q({ cwd, q: opts.q, limit: opts.limit })}`),
  /**
   * Switch branch, or create one and switch to it. Rejects with git's own message
   * when the switch is refused, which is the case worth showing the user.
   */
  checkout: (cwd: string, branch: string, opts: { create?: boolean; from?: string } = {}) =>
    postResult<GitWriteResult>("/api/git/checkout", { cwd, branch, ...opts }),
  fetch: (cwd: string) => postResult<GitWriteResult>("/api/git/fetch", { cwd }),
  /**
   * Fast-forward this branch onto its upstream. Refuses on divergence rather than
   * merging or rebasing — see the note on `pull` in server/git.ts.
   */
  pull: (cwd: string) => postResult<GitWriteResult>("/api/git/pull", { cwd }),
  /** Add paths to the index, or everything with `{ all: true }`. */
  stage: (cwd: string, opts: { paths?: string[]; all?: boolean }) =>
    postResult<GitWriteResult>("/api/git/stage", { cwd, ...opts }),
  /** Take paths back out of the index; the working tree is left untouched. */
  unstage: (cwd: string, opts: { paths?: string[]; all?: boolean }) =>
    postResult<GitWriteResult>("/api/git/unstage", { cwd, ...opts }),
  /**
   * Commit what is staged. Named apart from `commit` above, which reads one back.
   * Only staged changes are included — never everything in the tree.
   */
  createCommit: (cwd: string, message: string, opts: { noVerify?: boolean } = {}) =>
    postResult<GitWriteResult>("/api/git/commit", { cwd, message, ...opts }),
  /** Publish this branch, setting an upstream if it doesn't have one. Never forced. */
  push: (cwd: string) => postResult<GitWriteResult>("/api/git/push", { cwd }),
  /**
   * Throw away the uncommitted changes in these files — tracked ones go back to
   * HEAD, untracked ones are deleted. Named paths only: there is no "discard
   * everything", and unstaged work exists in no git object, so this cannot be undone.
   */
  discard: (cwd: string, paths: string[]) =>
    postResult<GitWriteResult>("/api/git/discard", { cwd, paths }),
};

export type FileRead = {
  ok: boolean;
  path: string;
  content: string;
  /** Hash of what was read. Hand it back on save so a concurrent write is caught. */
  hash: string;
  error: string | null;
};

export type FileWrite = {
  ok: boolean;
  hash: string | null;
  error: string | null;
  hint: string | null;
};

export type BrowseEntry = { name: string; path: string; dir: boolean };

export type Browse = {
  ok: boolean;
  root: string | null;
  /** Repo-relative folder being listed; "" is the repo root. */
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
  /** A search matched more than the daemon is willing to send. */
  truncated: boolean;
  error: string | null;
};

/**
 * One file inside a session's repository. Paths are repo-relative and the daemon
 * pins them to the repo root, so this can only ever reach a file the diff could
 * already show you.
 */
export const fileApi = {
  read: (cwd: string, path: string) => get<FileRead>(`/api/file?${q({ cwd, path })}`),
  /**
   * List a folder in the repo, or search the whole repo with `q`. Searching goes
   * through git, so it sees tracked and untracked files but nothing gitignored.
   */
  browse: (cwd: string, opts: { path?: string; q?: string } = {}) =>
    get<Browse>(`/api/files/browse?${q({ cwd, path: opts.path, q: opts.q })}`),
  save: (cwd: string, path: string, content: string, baseHash: string) =>
    postResult<FileWrite>("/api/file", { cwd, path, content, baseHash }),
};

/** Models the CLI offers, cached by the daemon from the last session that ran. */
export const modelApi = {
  list: () => get<{ models: ModelInfo[] }>("/api/models"),
};

export const dirApi = {
  list: (path?: string) =>
    get<DirListing>(`/api/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  favourites: () => get<{ favourites: Favourite[] }>("/api/favourites"),
  save: (label: string, path: string) =>
    post<{ favourites: Favourite[] }>("/api/favourites", { label, path }),
  remove: (path: string) =>
    post<{ favourites: Favourite[] }>("/api/favourites", { path, remove: true }),
};

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${path} → ${res.status}`);
  return data as T;
}

/**
 * POST where a refusal is an expected answer rather than a fault. A rejected
 * checkout returns 409 with git's explanation and the unchanged repo state — all of
 * which the caller wants — so throwing it away as an exception loses the useful part.
 */
async function postResult<T extends { ok: boolean; error: string | null }>(
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<T>;
  if (typeof data.ok === "boolean") return data as T;
  return { ok: false, error: data.error ?? `${path} → ${res.status}` } as T;
}

export const agentApi = {
  list: () => get<{ agents: AgentSummary[]; restorable: Restorable[] }>("/api/agents"),
  restore: (sessionId: string) => post<{ key: string }>("/api/agents/restore", { sessionId }),
  forget: (sessionId: string) => post("/api/agents/forget", { sessionId }),
  get: (key: string) => get<AgentDetail>(`/api/agents/${key}`),
  start: (opts: {
    cwd: string;
    model?: string;
    permissionMode?: PermissionMode;
    resume?: string;
    prompt?: string;
    title?: string;
  }) => post<{ key: string }>("/api/agents", opts),
  message: (key: string, text: string, images: OutboundImage[] = []) =>
    post(`/api/agents/${key}/message`, { text, ...(images.length ? { images } : {}) }),
  permission: (key: string, requestId: string, behavior: "allow" | "allowAlways" | "deny") =>
    post(`/api/agents/${key}/permission`, { requestId, behavior }),
  interrupt: (key: string) => post(`/api/agents/${key}/interrupt`),
  model: (key: string, model: string) => post(`/api/agents/${key}/model`, { model }),
  mode: (key: string, permissionMode: PermissionMode) => post(`/api/agents/${key}/mode`, { permissionMode }),
  stop: (key: string) => fetch(`/api/agents/${key}`, { method: "DELETE" }),
};

/**
 * Agent stream events arrive on the one SSE connection App owns, but they are
 * consumed by whichever chat pane is open. A tiny bus keeps that from turning
 * into prop-drilling through every view.
 */
type AgentBusEvent =
  | { type: "agents"; agents: AgentSummary[]; restorable: Restorable[] }
  | { type: "agent-item"; key: string; item: TimelineItem; replace?: boolean }
  | { type: "agent-delta"; key: string; text: string }
  | { type: "agent-models"; key: string; models: ModelInfo[] }
  | { type: "agent-commands"; key: string; commands: SlashCommand[] }
  | { type: "agent-tasks"; key: string; tasks: TaskInfo[] };

const busSubscribers = new Set<(e: AgentBusEvent) => void>();

export const agentBus = {
  publish(e: AgentBusEvent) {
    for (const fn of busSubscribers) fn(e);
  },
  subscribe(fn: (e: AgentBusEvent) => void) {
    busSubscribers.add(fn);
    return () => busSubscribers.delete(fn);
  },
};

/** A readable one-liner for a tool call or permission request. */
export function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const first =
    (i.command as string) ??
    (i.file_path as string) ??
    (i.path as string) ??
    (i.pattern as string) ??
    (i.prompt as string) ??
    (i.url as string) ??
    "";
  const text = String(first).replace(/\s+/g, " ").trim();
  return text ? `${name} · ${text.slice(0, 120)}` : name;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  live: () => get<LivePayload>("/api/live"),
  usage: () => get<UsagePayload>("/api/usage"),
  overview: () => get<Overview>("/api/overview"),
  sessions: (q: string, limit = 200) =>
    get<{ sessions: SessionRow[] }>(
      `/api/sessions?limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
    ),
  session: (id: string) => get<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
};

// ── formatting ────────────────────────────────────────────────────────────────
export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function fmtUsd(n: number): string {
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}

export function fmtAgo(ms: number | null): string {
  if (!ms) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function fmtDuration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Trim a long absolute path to its trailing segments, for card subtitles. */
export function shortPath(p: string | null, segments = 2): string {
  if (!p) return "—";
  const parts = p.replace(/\/$/, "").split("/").filter(Boolean);
  return parts.length <= segments ? p : `…/${parts.slice(-segments).join("/")}`;
}
