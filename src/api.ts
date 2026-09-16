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

/** `resetsInMs` is -1 when no reset is known and the window is a rolling one. */
export type UsageWindow = { start: number; end: number; resetsInMs: number };

export type UsagePayload = {
  now: number;
  budgets: {
    sessionTokens: number;
    weeklyTokens: number;
    weeklyFableTokens: number;
    dailyCostUsd: number;
  };
  /** True while a promotional uplift is inflating the weekly budgets. */
  boostActive: boolean;
  session: Bucket;
  sessionWindow: UsageWindow;
  weeklyWindow: UsageWindow;
  day: Bucket;
  week: Bucket;
  weekFable: Bucket;
  allTime: Bucket;
  byModel: (Bucket & { model: string })[];
  /** Priciest sessions of the last 7 days — which session spent the week's budget. */
  topSessions: {
    id: string;
    title: string | null;
    cwd: string | null;
    costUsd: number;
    fresh: number;
    requests: number;
  }[];
  hourly: { bucket: number; tokens: number }[];
  daily: { day: string; tokens: number; turns: number }[];
  remaining: {
    sessionPct: number;
    weeklyPct: number;
    weeklyFablePct: number;
    dailyCostPct: number;
  };
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

/** Which text a search looks at. Both is the default, and what a bad value falls to. */
export type SearchScope = "prompts" | "replies" | "both";

/**
 * Where a session matched and the text around the hit, marked up by SQLite's own
 * snippet(). Without it a reply match is invisible: nothing in the row you see
 * contains the words you typed.
 */
export type SearchHit = { source: "prompt" | "reply"; snippet: string };

/**
 * What a single session cost. `cachedPct` is the share of the prompt served from
 * cache, which is why a long session can bill less than its token count implies.
 */
export type SessionReceipt = Bucket & {
  requests: number;
  cachedPct: number;
  firstTs: number | null;
  lastTs: number | null;
  byModel: (Bucket & { model: string; requests: number })[];
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
  /** Null when the session has no priced usage events — not the same as zero. */
  receipt: SessionReceipt | null;
};

export type Overview = {
  totals: { sessions: number; msgs: number; prompts: number; tools: number };
  projects: {
    project_slug: string;
    path: string;
    sessions: number;
    last_ts: number | null;
    /** Shared `.git` of the repository this cwd belongs to. Empty when not in one. */
    repo_key?: string | null;
    worktree_root?: string | null;
  }[];
  /**
   * Repositories with more than one checkout, so worktrees of one codebase read as one
   * repository rather than as unrelated projects. Every entry also appears in
   * `projects`; this only adds the grouping.
   */
  repos: {
    repoKey: string;
    name: string;
    sessions: number;
    last_ts: number | null;
    /** One per real checkout — the worktree root, not each cwd a session used. */
    checkouts: { path: string; sessions: number; last_ts: number | null }[];
  }[];
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
  /** How the timeline ends. Null before the first item lands. */
  lastKind: TimelineItem["kind"] | null;
  /** Text of the failure, when the last thing that happened was one. */
  lastError: string | null;
  /** Messages typed mid-turn that have not been picked up yet. */
  queued: number;
};

/**
 * Why a live session is sitting still, or null when it is simply done.
 *
 * `idle` covers two opposite situations — a session that finished its turn and one
 * that stopped without finishing — and they were previously indistinguishable on the
 * grid. Both look calm; only one is.
 */
export function stalledReason(a: AgentSummary): string | null {
  if (a.status !== "idle") return null;
  if (a.lastError) return a.lastError;
  // The last thing in the timeline is your own message: it was accepted and then
  // nothing came back, which is a dropped turn rather than a finished one.
  if (a.lastKind === "user") return "your message got no reply";
  if (a.queued > 0) return `${a.queued} message${a.queued === 1 ? "" : "s"} never started`;
  return null;
}

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

/** What one session has been silenced about, and what to call it in Settings. */
export type SessionMute = { kinds: NotifyEventKind[]; label: string };

export type Settings = {
  notifications: {
    enabled: boolean;
    events: Record<NotifyEventKind, boolean>;
    channels: { native: boolean; browser: boolean; googleChat: boolean };
    googleChatWebhook: string;
    delaySeconds: number;
    cooldownSeconds: number;
    suppressWhenFocused: boolean;
    /** Per-session silence, keyed by session id or agent key. */
    mutes: Record<string, SessionMute>;
    quietHours: { enabled: boolean; from: string; to: string };
    dashboardUrl: string;
  };
  ui: {
    diffMode: "unified" | "split";
    diffIgnoreWhitespace: boolean;
    /** Hide tool calls and thinking in conversations. */
    hideToolCalls: boolean;
    /** Where a plain click on a session card lands. */
    clickOpensIn: "drawer" | "page" | "tile";
    /** Where ⌘/Ctrl-click lands. */
    cmdClickOpensIn: "drawer" | "page" | "tile";
    /** Where ⌥/Option-click lands. */
    optionClickOpensIn: "drawer" | "page" | "tile";
    /** Theme, accent hue and tab icon. Mirrored in localStorage for first paint. */
    appearance?: Appearance;
    /** Named looks the user saved, newest first. Each covers both dark and light. */
    themes?: { name: string; look?: Partial<Appearance>; appearance?: Partial<Appearance> }[];
    /** Where new worktrees go. Empty means beside the repository. */
    worktreeRoot?: string;
    /** Untracked paths carried into a new worktree, when git ignores them. */
    worktreeProvision?: ProvisionRule[];
    /**
     * Per-repository additions to that list, keyed by the shared `.git`. Edited through
     * /api/git/provision-rules rather than a settings patch, so two tabs editing two
     * repositories cannot overwrite each other's entry.
     */
    worktreeProvisionByRepo?: Record<string, ProvisionRule[]>;
    /** Allow provisioning to add those paths to .git/info/exclude. Off by default. */
    worktreeExclude?: boolean;

  };
};

/** A patch is merged server-side, so callers send only what changed. */
export type SettingsPatch = {
  notifications?: Partial<
    Omit<Settings["notifications"], "events" | "channels" | "quietHours" | "mutes">
  > & {
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
  /** Blocked on you — the banner should wait rather than auto-dismiss. */
  urgent?: boolean;
  sessionId: string | null;
  key: string;
  url: string;
  at: number;
};

export type McpStatus = "connected" | "needs-auth" | "failed" | "pending" | "disabled";

export type McpServer = {
  name: string;
  target: string;
  transport: string | null;
  status: McpStatus;
  detail: string | null;
  origin: "claudeai" | "plugin" | "local";
};

/** An OAuth run in progress, or the wreckage of one that failed. */
export type McpLogin = {
  name: string;
  startedAt: number;
  output: string;
  done: boolean;
  ok: boolean;
  error: string | null;
};

export type McpPayload = {
  servers: McpServer[];
  /** 0 before the first health check has ever run. */
  checkedAt: number;
  error: string | null;
  /** A health check is running right now; the list is the previous one until it lands. */
  checking: boolean;
  logins: McpLogin[];
};

export const mcpApi = {
  /** Always the cache — a health check is started separately and watched via `checking`. */
  list: () => get<McpPayload>("/api/mcp"),
  /** Returns immediately; the check itself can take minutes on a cold CLI. */
  refresh: () => post<McpPayload>("/api/mcp/refresh"),
  /** Returns as soon as the browser has been opened — the run is followed by polling. */
  login: (name: string) =>
    postResult<{ ok: boolean; error: string | null; logins: McpLogin[] }>("/api/mcp/login", { name }),
  dismiss: (name: string) =>
    postResult<{ ok: boolean; error: string | null; logins: McpLogin[] }>("/api/mcp/login", {
      name,
      dismiss: true,
    }),
};

export const settingsApi = {
  get: () => get<{ settings: Settings }>("/api/settings"),
  save: (patch: SettingsPatch) => post<{ settings: Settings }>("/api/settings", patch),
  /**
   * Silence one session, per kind. An empty `kinds` clears it. Its own endpoint
   * because the map is keyed by session and a patch carrying it whole would let two
   * tabs overwrite each other's mutes.
   */
  mute: (id: string, kinds: NotifyEventKind[], label: string) =>
    post<{ settings: Settings }>("/api/settings/mute", { id, kinds, label }),
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

/**
 * How a branch is put on the wire.
 *
 * `undefined` sends nothing and means the whole repo; `null` sends an empty value
 * and means a detached HEAD. The server tells them apart by whether the parameter
 * arrived at all, so this must not collapse the two into an omitted key.
 */
function branchParam(branch: string | null | undefined): string {
  if (branch === undefined) return "";
  return `&branch=${encodeURIComponent(branch ?? "")}`;
}

export const commentApi = {
  /**
   * Comments for a repo, scoped to a branch unless `branch` is omitted. `offBranch`
   * counts the open ones this scope deliberately left out.
   */
  /**
   * `repoKey` is the repository's shared `.git`. Passing it is what makes a review
   * follow the branch across worktrees rather than being pinned to one checkout.
   */
  list: (repo: string, branch?: string | null, repoKey?: string | null) =>
    get<{ comments: ReviewComment[]; offBranch: number }>(
      `/api/comments?repo=${encodeURIComponent(repo)}${branchParam(branch)}${
        repoKey ? `&repoKey=${encodeURIComponent(repoKey)}` : ""
      }`,
    ),
  add: (input: {
    repo: string;
    repoKey?: string | null;
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
      `/api/comments/prompt?repo=${encodeURIComponent(repo)}${branchParam(branch)}`,
    ),
  markSent: (ids: string[]) => post("/api/comments/sent", { ids }),
  /** Deletes every comment on the branch, open included. The UI confirms first. */
  clearAll: (repo: string, branch: string | null) =>
    post<{ removed: number }>("/api/comments/clear-all", { repo, branch }),
  clearResolved: (repo: string, branch: string | null) =>
    post<{ removed: number }>("/api/comments/clear-resolved", { repo, branch }),
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
  /** This checkout. Differs from `commonDir`'s repo whenever it is a linked worktree. */
  root: string | null;
  /** The shared `.git`, identifying the repository rather than the checkout. */
  commonDir: string | null;
  mainRoot: string | null;
  isLinkedWorktree: boolean;
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

export type DiffScope = "uncommitted" | "branch";

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
  /**
   * The worktree holding this branch, if any. Git refuses to check a branch out
   * twice, so a non-null value means "open that checkout", not "switch to it here".
   */
  worktreePath: string | null;
};

export type WorktreeWriteResult = GitWriteResult & {
  /** The checkout created or removed, when it succeeded. */
  path: string | null;
  /** Every checkout of the repo after the attempt, successful or not. */
  worktrees: Worktree[];
};

/** What a provisioning rule did against one path in one checkout. */
export type ProvisionOutcome = {
  path: string;
  mode: "symlink" | "copy" | "off";
  result: "linked" | "copied" | "skipped-exists" | "skipped-missing" | "skipped-tracked" | "failed";
  error?: string;
};

export type WorktreeReprovisionResult = GitWriteResult & {
  worktrees: Worktree[];
  /** Provisioning outcomes, keyed by the path of each checkout touched. */
  results: Record<string, ProvisionOutcome[]>;
};

export type Worktree = {
  path: string;
  name: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  bare: boolean;
  isMain: boolean;
  /** git's lock reason; an empty string still means locked. */
  locked: string | null;
  /** Set when the directory is gone and only the admin record survives. */
  prunable: string | null;
};

/**
 * A provisioning rule. `path` may be a pattern — `projects/*` and the like — expanded
 * against the main checkout when a worktree is created. `off` only ever appears in a
 * repository's own list, where it switches a global rule off for that repository.
 */
export type ProvisionMode = "symlink" | "copy" | "off";
export type ProvisionRule = { path: string; mode: ProvisionMode };

/** One literal path the rules resolve to, with git's verdict on it. */
export type ProvisionPath = {
  path: string;
  mode: ProvisionMode;
  /** Which list it came from, so an override is visible as one. */
  source: "global" | "repo";
  /** The rule that produced it — differs from `path` when the rule is a pattern. */
  rule: string;
  /** git ignores it. False means it would be left behind rather than carried over. */
  ignored: boolean;
};

/** What a new worktree of one repository would be given, before creating one. */
export type ProvisionPlan = {
  ok: boolean;
  error: string | null;
  repoKey: string | null;
  mainRoot: string | null;
  name: string | null;
  global: ProvisionRule[];
  repo: ProvisionRule[];
  paths: ProvisionPath[];
};

export type WorktreeRepo = {
  /** The shared `.git`: two checkouts of one repository carry the same key. */
  repoKey: string;
  name: string;
  /** A checkout that exists, to address this repository's reads and writes to. */
  root: string;
  mainRoot: string | null;
  /** This repository's checkouts, so the list paints without a second request. */
  worktrees: Worktree[];
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
  /** Every repository worth listing worktrees for, across all of session history. */
  repos: () => get<{ repos: WorktreeRepo[] }>("/api/git/repos"),
  /** Changed-file counts for several checkouts in one request. */
  dirty: (paths: string[]) =>
    get<{ dirty: Record<string, number> }>(
      `/api/git/dirty?${paths.map((p) => `path=${encodeURIComponent(p)}`).join("&")}`,
    ),
  worktrees: (cwd: string) =>
    get<{ ok: boolean; worktrees: Worktree[]; error: string | null }>(
      `/api/git/worktrees?${q({ cwd })}`,
    ),
  /**
   * Adding and removing checkouts. Refusals are answers here, not exceptions — a
   * dirty worktree or a branch already open elsewhere both come back as `ok: false`
   * with git's own wording, so these go through postResult like the other writes.
   */
  worktreeAdd: (cwd: string, branch: string, opts: { create?: boolean; from?: string; path?: string } = {}) =>
    postResult<WorktreeWriteResult>("/api/git/worktree-add", { cwd, branch, ...opts }),
  worktreeRemove: (cwd: string, path: string) =>
    postResult<WorktreeWriteResult>("/api/git/worktree-remove", { cwd, path }),
  worktreePrune: (cwd: string) =>
    postResult<WorktreeWriteResult>("/api/git/worktree-prune", { cwd }),
  /**
   * Re-run provisioning against checkout(s) that already exist, so a rule added after
   * a worktree was created (a new dependency, a config file that did not exist yet)
   * still reaches it. `provision()` never overwrites, so this only ever fills gaps.
   */
  worktreeReprovision: (cwd: string, opts: { path?: string; all?: boolean }) =>
    postResult<WorktreeReprovisionResult>("/api/git/worktree-reprovision", { cwd, ...opts }),
  /**
   * Provisioning, as three questions about one repository: what would a new worktree
   * get, what is this repo carrying that the rules miss, and here is the new list.
   */
  provision: (cwd: string) => get<ProvisionPlan>(`/api/git/provision?${q({ cwd })}`),
  provisionScan: (cwd: string) =>
    get<{ ok: boolean; error: string | null; suggestions: ProvisionRule[] }>(
      `/api/git/provision-scan?${q({ cwd })}`,
    ),
  provisionSave: (cwd: string, rules: ProvisionRule[]) =>
    post<{ ok: boolean; plan: ProvisionPlan }>("/api/git/provision-rules", { cwd, rules }),
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
    /** Omitted for a research session: the daemon supplies its scratch directory. */
    cwd?: string;
    research?: boolean;
    model?: string;
    permissionMode?: PermissionMode;
    resume?: string;
    prompt?: string;
    title?: string;
  }) => post<{ key: string }>("/api/agents", opts),
  message: (key: string, text: string, images: OutboundImage[] = []) =>
    post(`/api/agents/${key}/message`, { text, ...(images.length ? { images } : {}) }),
  /** `answers` is only meaningful for AskUserQuestion — see answerPermission. */
  permission: (
    key: string,
    requestId: string,
    behavior: "allow" | "allowAlways" | "deny",
    answers?: Record<string, string>,
  ) => post(`/api/agents/${key}/permission`, { requestId, behavior, answers }),
  interrupt: (key: string) => post(`/api/agents/${key}/interrupt`),
  model: (key: string, model: string) => post(`/api/agents/${key}/model`, { model }),
  mode: (key: string, permissionMode: PermissionMode) => post(`/api/agents/${key}/mode`, { permissionMode }),
  rename: (key: string, title: string) => post(`/api/agents/${key}/rename`, { title }),
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
  /** One page of history. `total` is the size of the whole result set, for the pager. */
  sessions: (q: string, limit = 200, offset = 0, scope: SearchScope = "both") =>
    get<{ sessions: SessionRow[]; total: number; hits: Record<string, SearchHit> }>(
      `/api/sessions?limit=${limit}&offset=${offset}&scope=${scope}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
    ),
  session: (id: string) => get<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
  /**
   * Hand a pasted file to the daemon and get back the path it now lives at.
   *
   * The browser cannot tell us where the file came from — `File` is a name and some
   * bytes — so the only way to produce a path a session can actually read is to
   * store the bytes daemon-side and use that path instead.
   */
  stashFile: async (file: File): Promise<{ path: string; bytes: number }> => {
    const res = await fetch(`/api/files/stash?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      body: file,
    });
    const body = (await res.json().catch(() => ({}))) as { path?: string; bytes?: number; error?: string };
    if (body.error) throw new Error(body.error);
    // A 200 with no path means the route did not match and the SPA's own index came
    // back instead — i.e. the daemon predates this endpoint. Saying so beats
    // reporting a status code that looks like success.
    if (!body.path) throw new Error("this daemon is too old for file paste — restart it");
    return { path: body.path, bytes: body.bytes ?? file.size };
  },
  /**
   * Retitle by session id. Works whether or not the session is running here — the
   * daemon routes a live one through its agent so the roster label moves too.
   */
  renameSession: (id: string, title: string) =>
    post(`/api/sessions/${encodeURIComponent(id)}/rename`, { title }),
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

/**
 * Countdown to a window reset, worded the way `claude /usage` words it. A negative
 * input means the window is rolling and has no known reset.
 */
export function fmtResets(ms: number): string {
  if (ms < 0) return "rolling window";
  return `Resets in ${fmtDuration(Math.max(0, ms))}`;
}

/** Trim a long absolute path to its trailing segments, for card subtitles. */
export function shortPath(p: string | null, segments = 2): string {
  if (!p) return "—";
  const parts = p.replace(/\/$/, "").split("/").filter(Boolean);
  return parts.length <= segments ? p : `…/${parts.slice(-segments).join("/")}`;
}
