/**
 * Local dev services: a service definition is a recipe, a session is one running
 * instance of it.
 *
 * The recipes live in the dashboard's settings. Everything about what is *running*
 * lives in tmux itself — session and pane options carry the service, the checkout,
 * the command and the timestamps — so this server keeps no runtime state of its own
 * and a restart loses nothing.
 */

/**
 * A repository a service can start in: its main checkout plus every worktree of
 * it. Worktrees are directories under `worktreesDir` named `<key>-<branch>`.
 */
export type ServiceRepo = {
  key: string;
  label: string;
  path: string;
  worktreesDir: string;
};

/** One command in its own tmux pane. */
export type ServicePane = { title: string; cmd: string };

/**
 * Restart this pane when its output matches. A null pane means any pane of the
 * service; the pattern is matched case-insensitively against the detected error.
 */
export type RestartRule = { pane: string | null; pattern: string };

export const DEFAULT_RESTART_MAX = 3;
export const RESTART_WINDOW_MS = 10 * 60 * 1000;

export type Service = {
  key: string;
  label: string;
  /** One line under the name in the table — what this service actually is. */
  description: string;
  /** Key of the ServiceRepo this starts in. */
  repo: string;
  /** Where in the checkout the panes run, relative to its root. */
  subdir: string;
  /** Shell run before every pane's command — venv activation, env files. */
  setup: string;
  layout: "tiled" | "split";
  /**
   * Other service keys whose panes make up this one. A service with includes has
   * no panes of its own; each included service keeps its own subdir and setup.
   */
  includes: string[];
  /** Kept in the list but not startable, and hidden from the table by default. */
  disabled: boolean;
  panes: ServicePane[];
  restartOn: RestartRule[];
  restartMax: number;
};

export type ServicePaths = { repos: ServiceRepo[] };

export const DEFAULT_WORKTREES_DIR = "~/src/worktrees";

export const DEFAULT_SERVICE_PATHS: ServicePaths = { repos: [] };

export const blankRepo = (key: string): ServiceRepo => ({
  key,
  label: key,
  path: "",
  worktreesDir: DEFAULT_WORKTREES_DIR,
});

/**
 * Accept the shape paths were first stored in — one backend, one frontend and a
 * shared worktrees directory — as well as the current list of repositories.
 */
export function normalizeServicePaths(raw: unknown): ServicePaths {
  const r = (raw ?? {}) as Partial<ServicePaths> & {
    backendMain?: string;
    frontendMain?: string;
    worktreesDir?: string;
  };
  if (Array.isArray(r.repos)) {
    return {
      repos: r.repos
        .filter((x): x is ServiceRepo => !!x && typeof x === "object" && typeof x.key === "string")
        .map((x) => ({ ...blankRepo(x.key), ...x })),
    };
  }
  const worktreesDir = r.worktreesDir || DEFAULT_WORKTREES_DIR;
  const repos: ServiceRepo[] = [];
  if (r.backendMain) repos.push({ key: "backend", label: "Backend", path: r.backendMain, worktreesDir });
  if (r.frontendMain) repos.push({ key: "frontend", label: "Frontend", path: r.frontendMain, worktreesDir });
  return { repos };
}

// ── docker compose ────────────────────────────────────────────────────────────
/** Which compose project to show, and how: the deploy folder inside a repository. */
export type ComposeSettings = {
  repo: string;
  subdir: string;
  /** Compose services hidden from the table unless the eye toggle is on. */
  hidden: string[];
  /** Display order; services not listed follow, by name. */
  order: string[];
};

export const DEFAULT_COMPOSE: ComposeSettings = {
  repo: "",
  subdir: "",
  hidden: [],
  order: [],
};

export type Container = {
  /** Compose service name, which is also the container name in our compose file. */
  service: string;
  /** docker's state: running, exited, created… — empty when never created. */
  state: string;
  /** docker's own line, "Up 3 days (healthy)". */
  status: string;
  health: string;
  ports: number[];
  image: string;
  createdAt: string;
  running: boolean;
  hidden: boolean;
};

export const containerTone = (c: Container): Tone =>
  c.running ? (c.health && c.health !== "healthy" ? "warn" : "ok") : c.state === "" ? "idle" : "bad";

// ── runtime ───────────────────────────────────────────────────────────────────
export type PaneError = { text: string; count: number };

export type PaneState = {
  /** tmux pane id, e.g. %12 — stable for the life of the pane. */
  id: string;
  index: number;
  title: string;
  /** What was sent to the pane, so a restart can send it again. */
  command: string;
  /**
   * False when the pane's foreground process is a bare shell: the command exited
   * and dropped back to the prompt, which is what a crash looks like from here.
   */
  alive: boolean;
  startedAt: number | null;
  crashedAt: number | null;
  error: PaneError | null;
  ports: number[];
  autoRestarts: number;
  autoRestartExhausted: boolean;
};

/** "ok" every pane alive, "down" none, "partial" some. */
export type SessionHealth = "ok" | "partial" | "down";

export type ServiceSession = {
  /** tmux session name, <prefix>-<checkout>-<service>. */
  name: string;
  serviceKey: string;
  serviceLabel: string;
  checkout: string;
  attached: boolean;
  createdAt: number;
  panes: PaneState[];
  health: SessionHealth;
};

export type Checkout = {
  /** Used for the tmux session name: "<repo> (main)" or the worktree's folder suffix. */
  label: string;
  path: string;
  /** The canonical checkout rather than a worktree. */
  main: boolean;
  /** The branch checked out there right now; null when detached or unreadable. */
  branch: string | null;
};

export type CheckoutView = Checkout & {
  /** The session name this checkout would get, running or not. */
  session: string;
  running: boolean;
  /** Directories a pane needs that are not there — the service cannot start. */
  missing: string[];
};

export type ServiceView = Service & {
  startable: boolean;
  paneCount: number;
  /** Ports parsed out of the pane commands, for the table's Ports column. */
  ports: number[];
  checkouts: CheckoutView[];
  /** Every running session of this service, usually none or one. */
  sessions: ServiceSession[];
};

export type ServicesState = {
  tmuxUp: boolean;
  services: ServiceView[];
  sessions: ServiceSession[];
  paths: ServicePaths;
  containers: Container[];
  /** Null when the compose folder is not there, so the section can say so. */
  composeDir: string | null;
};

export type StartResult = {
  ok: boolean;
  session?: string;
  error?: string;
  missing?: string[];
  /** It was already running, so nothing was started. */
  already?: boolean;
};

export type SearchAction = "find" | "next" | "previous" | "cancel";

/** Status tone, the same six used across the table, pills and pane tabs. */
export type Tone = "idle" | "info" | "ok" | "warn" | "attention" | "bad";

export const sessionTone = (s: ServiceSession): Tone =>
  s.health === "ok" ? (s.panes.some((p) => p.error) ? "warn" : "ok") : s.health === "partial" ? "warn" : "bad";

export const paneTone = (p: PaneState): Tone => (!p.alive ? "bad" : p.error ? "warn" : "ok");

export const blankService = (key: string): Service => ({
  key,
  label: key,
  description: "",
  repo: "",
  subdir: "",
  setup: "",
  layout: "tiled",
  includes: [],
  disabled: false,
  panes: [],
  restartOn: [],
  restartMax: DEFAULT_RESTART_MAX,
});
