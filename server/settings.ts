import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./paths.ts";
import { DEFAULT_PROVISION, type ProvisionRule } from "./provision.ts";
import type { PrWatchEntry, ReviewAction, ReviewPermissionMode, SavedView } from "../shared/pr.ts";
import {
  DEFAULT_COMPOSE,
  DEFAULT_SERVICE_PATHS,
  normalizeServicePaths,
  type ComposeSettings,
  type Service,
  type ServicePaths,
} from "../shared/services.ts";
import type { Template } from "../shared/templates.ts";
import { importLegacyServices, legacyConfigPath } from "./servicesImport.ts";

/**
 * User-editable preferences, as opposed to config.ts which holds the pricing and
 * budget numbers you tune once. These change from the UI at runtime, so they live
 * in their own file and are written back on every edit.
 */
export type NotifyEventKind =
  | "needsInput"
  | "awaitingPermission"
  | "turnComplete"
  | "sessionError"
  | "prWatch";

/**
 * One session's silence, keyed by its transcript id — or by the agent key while it
 * has no id yet, which is why the notifier checks both.
 *
 * Per session rather than per kind alone because the loudness of a kind depends on
 * what the session is: a /loop finishing its turn every ten minutes is the same
 * `turnComplete` as the refactor you are waiting on, and switching the kind off
 * globally to silence the loop takes the one you wanted with it.
 *
 * The label is stored with the kinds so Settings can list what is muted in words.
 * A mute you cannot find is a mute you cannot undo, and the id alone is unreadable.
 */
export type SessionMute = { kinds: NotifyEventKind[]; label: string };

/**
 * Mirrors src/appearance.ts. The daemon stores it and hands it back; it has no
 * opinion on which hues exist, so adding a swatch in the UI needs nothing here.
 */
export type Appearance = {
  theme: "dark" | "light";
  accent: string;
  favicon: string;
  faviconColor: string;
  motion?: boolean;
  hoverFx?: boolean;
  glassFx?: boolean;
  glassBlur?: { dark: number; light: number };
  glassOpacity?: { dark: number; light: number };
  customAccent?: { dark: string; light: string };
  customIconColor?: { dark: string; light: string };
  /** Per-mode slider sets. Older files hold a single flat set; the UI migrates it. */
  customPalette?: Record<string, unknown>;
  unsafeContrast?: boolean;
};

/**
 * A named appearance the user saved. Stored here rather than in localStorage so a
 * theme built on one machine is there when the dashboard is opened from another.
 */
/**
 * A saved theme covers both modes, so it stores everything except which mode is on.
 * `appearance` is the pre-look shape, still read so older files keep working.
 */
export type SavedTheme = {
  name: string;
  look?: Omit<Appearance, "theme"> & { theme?: never };
  appearance?: Appearance;
};

export type Settings = {
  notifications: {
    /** Master switch. Off means no channel fires, whatever the per-event flags say. */
    enabled: boolean;
    events: Record<NotifyEventKind, boolean>;
    channels: {
      /** macOS notification centre via terminal-notifier, clickable. Works with no browser open. */
      native: boolean;
      /** Web Notification raised by the dashboard tab. Only fires while a tab is alive. */
      browser: boolean;
      /** Mirrored to a Google Chat space, so alerts reach you away from the desk. */
      googleChat: boolean;
    };
    googleChatWebhook: string;
    /**
     * A state must persist this long before it notifies. Answering a permission
     * prompt within a few seconds should never have interrupted you at all.
     */
    delaySeconds: number;
    /** Minimum gap between two notifications about the same session and event. */
    cooldownSeconds: number;
    /** Skip notifications for the session currently open in a visible tab. */
    suppressWhenFocused: boolean;
    /** Per-session silence, on top of the global `events` flags. Keyed by session. */
    mutes: Record<string, SessionMute>;
    /** Local-time window to stay silent. from may be later than to (crosses midnight). */
    quietHours: { enabled: boolean; from: string; to: string };
    /**
     * Base URL a notification click should open. The dev UI is on 5758 and the
     * built one is served by the daemon on 5757, so this cannot be inferred.
     */
    dashboardUrl: string;
  };
  ui: {
    diffMode: "unified" | "split";
    /** Hide whitespace-only changes in diffs. */
    diffIgnoreWhitespace: boolean;
    /**
     * Collapse tool calls and thinking out of a conversation, leaving the prose.
     * Pending permission requests are always shown — they need an answer.
     */
    hideToolCalls: boolean;
    /**
     * What a plain click, a ⌘/Ctrl-click and an ⌥/Option-click each do with a
     * session. The drawer keeps you on the list; the page gives the transcript,
     * the git panel and the review room to breathe; a tile is a movable,
     * resizable floating window. Three independent settings rather than one,
     * because a click and its modified forms are three different intents
     * ("glance", "commit to it", "keep an eye on it alongside something else")
     * that used to only have two configurable destinations between them.
     */
    /**
     * Where generated HTML artifacts are kept and scanned for. Empty means the
     * built-in default (or CLAUDE_ARTIFACTS_DIR, when that is set), so an unset
     * field keeps following the environment rather than freezing today's value.
     */
    artifactsRoot: string;
    /**
     * Dock pages turned off, by key. Absent means every page is on, so a page added
     * later arrives visible rather than silently hidden by an older settings file.
     */
    hiddenPages: string[];
    /** Dock pages in display order, by key. Empty means the registry order. */
    pageOrder: string[];
    /** The sidebar as an icon rail rather than with labels. */
    sidebarCollapsed: boolean;
    /** What the sidebar, breadcrumb and window title call this app. */
    appName: string;
    clickOpensIn: "drawer" | "page" | "tile";
    cmdClickOpensIn: "drawer" | "page" | "tile";
    optionClickOpensIn: "drawer" | "page" | "tile";
    /**
     * @deprecated Replaced by `clickOpensIn`. Kept only so `loadSettings` can
     * carry an existing choice forward the first time an old settings.json is
     * read; never written after that.
     */
    openSessionsIn?: "drawer" | "page";
    /**
     * Theme, accent hue and tab icon. The daemon only stores it — the browser owns
     * the rendering, and keeps its own localStorage copy so the first paint is
     * already correct rather than flashing the default theme.
     */
    appearance?: Appearance;
    /**
     * Where new worktrees are created. Empty means beside the repository they belong
     * to, which is almost always right: an editor, a terminal and a file browser all
     * have to find them, and a checkout is your work rather than dashboard state.
     */
    worktreeRoot?: string;
    /**
     * Untracked paths carried into a new worktree, so a fresh checkout can actually run.
     * `symlink` for big shared directories (node_modules), `copy` for small per-checkout
     * secrets (.env). A path missing from the source is skipped, never an error.
     */
    worktreeProvision?: ProvisionRule[];
    /**
     * The same, per repository, keyed by the shared `.git`. Layered *onto* the global
     * list rather than replacing it, so a repo that only needs its venvs does not have to
     * restate `.env` — and a rule set to `off` here switches a global one off for this
     * repository alone.
     *
     * Per repository because the global list cannot be right for all of them: a JS repo
     * wants `node_modules`, a Python monorepo wants a venv per project, and the default
     * list guessing wrong is silent until a session tries to run something.
     */
    worktreeProvisionByRepo?: Record<string, ProvisionRule[]>;
    /**
     * Let provisioning add paths to the repository's `.git/info/exclude` when git would
     * otherwise show them as untracked — which is what happens to a `node_modules`
     * symlink against the conventional `node_modules/` pattern, since a trailing slash
     * matches directories only.
     *
     * Off by default because it writes to the repository's own git directory. That file
     * is local and never committed, and in the main checkout the entry changes nothing,
     * but it is still the user's repo and not ours to edit unasked.
     */
    worktreeExclude?: boolean;
    /** Named themes, newest first. Replaced wholesale like appearance is. */
    themes?: SavedTheme[];
    disabledModels?: string[];
    defaultModel?: string;
    customModels?: { value: string; label: string }[];
    /** Repositories (by shared `.git`) shown first on the Worktrees page. */
    pinnedRepos?: string[];
  };
  /**
   * The GitHub review pages. Views and actions are replaced wholesale on save, like
   * appearance is: the UI always sends the complete list.
   */
  reviews: {
    /** `owner/name`, searched when a view names no repositories of its own. */
    repos: string[];
    views: SavedView[];
    actions: ReviewAction[];
    /** Model for explain sessions. Empty means the dashboard's default model. */
    explainModel: string;
    explainPermissionMode: ReviewPermissionMode;
    /** Where PR checkouts for review sessions live. Empty means ~/.claude-dashboard/pr. */
    checkoutRoot: string;
    /** Checkouts kept around after a session ends; older ones are removed. */
    keepCheckouts: number;
    /**
     * Pull requests the poller follows. In settings rather than the database so a
     * reindex keeps them and a second machine sharing the settings file sees them.
     */
    watched: PrWatchEntry[];
    /** Minutes between polls of the watched list. Never below one. */
    watchIntervalMinutes: number;
    /** A merged or closed PR drops off the list this many days later. Zero keeps it. */
    watchUnwatchAfterDays: number;
  };
  /**
   * Local dev services: what the Services page can start, where, and the compose
   * project shown under it. Optionally imported once from a services file.
   */
  /** Session recipes, each optionally on a schedule. Replaced wholesale on save. */
  templates: Template[];
  services: {
    defs: Service[];
    paths: ServicePaths;
    compose: ComposeSettings;
    /** Set by the import so it never runs twice, even if every service is deleted. */
    importedAt: string | null;
  };
};

const CONTEXT_TOOLS = [
  "mcp__claude_ai_Slack__slack_search_public",
  "mcp__claude_ai_Slack__slack_search_public_and_private",
  "mcp__claude_ai_Slack__slack_read_channel",
  "mcp__claude_ai_Slack__slack_read_thread",
  "mcp__claude_ai_Notion__notion-fetch",
  "mcp__claude_ai_Notion__notion-search",
  "mcp__claude_ai_Notion__notion-get-comments",
];

/** The one action every install starts with. Editable in Settings → Reviews. */
export const DEFAULT_REVIEW_ACTIONS: ReviewAction[] = [
  {
    id: "review",
    name: "Review",
    promptTemplate:
      "Review this pull request: {{pr_url}} ({{title}}, {{head_ref}} → {{base_ref}}).\n" +
      "You are in a checkout of the head commit. See what changed with `git diff {{base_sha}}` and read the surrounding code before judging it.\n" +
      "Look for bugs, behaviour changes the description does not mention, missing error handling and anything a careful reviewer would flag. Do not comment on style.",
    allowedTools: ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", ...CONTEXT_TOOLS],
    permissionMode: "default",
    model: "",
    checkout: "head",
    structuredFindings: true,
  },
];

const DEFAULTS: Settings = {
  notifications: {
    enabled: true,
    events: {
      needsInput: true,
      awaitingPermission: true,
      // Off by default: the most useful signal, but also the loudest, so it is
      // an opt-in rather than something that surprises you on first run.
      turnComplete: false,
      sessionError: true,
      prWatch: true,
    },
    channels: { native: true, browser: true, googleChat: false },
    googleChatWebhook: "",
    delaySeconds: 10,
    cooldownSeconds: 120,
    suppressWhenFocused: true,
    mutes: {},
    quietHours: { enabled: false, from: "23:00", to: "08:00" },
    dashboardUrl: "http://localhost:5758",
  },
  ui: {
    diffMode: "unified",
    diffIgnoreWhitespace: false,
    hideToolCalls: false,
    // Match the old hardcoded behavior exactly, so nobody's click behavior
    // changes just because these settings now exist.
    artifactsRoot: "",
    hiddenPages: [],
    pageOrder: [],
    sidebarCollapsed: false,
    appName: "Claude Dashboard",
    clickOpensIn: "drawer",
    cmdClickOpensIn: "page",
    optionClickOpensIn: "tile",
    worktreeRoot: "",
    worktreeProvision: DEFAULT_PROVISION,
    worktreeProvisionByRepo: {},
    worktreeExclude: false,
  },
  reviews: {
    repos: [],
    views: [
      { id: "review-requested", name: "Review requested", filter: { repos: [], reviewRequestedFromMe: true, hideApproved: true } },
      { id: "my-prs", name: "My PRs", filter: { repos: [], authors: ["@me"], includeDrafts: true } },
    ],
    actions: DEFAULT_REVIEW_ACTIONS,
    explainModel: "",
    explainPermissionMode: "default",
    checkoutRoot: "",
    keepCheckouts: 6,
    watched: [],
    watchIntervalMinutes: 2,
    watchUnwatchAfterDays: 7,
  },
  services: { defs: [], paths: DEFAULT_SERVICE_PATHS, compose: DEFAULT_COMPOSE, importedAt: null },
  templates: [],
};

const SETTINGS_PATH = join(DATA_DIR, "settings.json");

let current: Settings = DEFAULTS;
const listeners = new Set<(s: Settings) => void>();

/** Merge a partial payload over the defaults, one level deeper than spread. */
function merge(base: Settings, patch: DeepPartial<Settings>): Settings {
  const n = patch.notifications ?? {};
  const u = patch.ui ?? {};
  const r = patch.reviews ?? {};
  return {
    notifications: {
      ...base.notifications,
      ...n,
      events: { ...base.notifications.events, ...(n.events ?? {}) },
      channels: { ...base.notifications.channels, ...(n.channels ?? {}) },
      quietHours: { ...base.notifications.quietHours, ...(n.quietHours ?? {}) },
      // Merged per session, so a Settings-page patch that carries no mutes cannot
      // silently drop the ones another tab set.
      mutes: {
        ...base.notifications.mutes,
        ...((n.mutes ?? {}) as Settings["notifications"]["mutes"]),
      },
    },
    // Appearance is replaced wholesale rather than merged: the UI always sends the
    // complete object, and half-applied themes are worse than none.
    ui: { ...base.ui, ...(u as Partial<Settings["ui"]>) },
    reviews: { ...base.reviews, ...(r as Partial<Settings["reviews"]>) },
    // Service definitions are replaced wholesale: the editor always sends the full
    // list, and a merged half-list would resurrect services the user just deleted.
    templates: Array.isArray(patch.templates) ? (patch.templates as Template[]) : base.templates,
    services: {
      ...base.services,
      ...((patch.services ?? {}) as Partial<Settings["services"]>),
      compose: { ...base.services.compose, ...((patch.services?.compose ?? {}) as Partial<ComposeSettings>) },
    },
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function loadSettings(): Settings {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(SETTINGS_PATH)) {
    current = DEFAULTS;
    persist();
    return current;
  }
  try {
    const user = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as DeepPartial<Settings>;
    current = merge(DEFAULTS, user);
    if (user.services?.paths) {
      current = {
        ...current,
        services: { ...current.services, paths: normalizeServicePaths(user.services.paths) },
      };
    }
    // An older layout name, from before the layouts were generic.
    current = {
      ...current,
      services: {
        ...current.services,
        defs: current.services.defs.map((d) => ((d.layout as string) === "tms-split" ? { ...d, layout: "split" } : d)),
      },
    };
    // One-time carry-forward: a settings.json from before `clickOpensIn` existed
    // has the old two-value `openSessionsIn` instead. Respect it rather than
    // silently reverting an existing choice back to the "drawer" default.
    if (user.ui?.openSessionsIn && !user.ui?.clickOpensIn) {
      current = { ...current, ui: { ...current.ui, clickOpensIn: user.ui.openSessionsIn } };
    }
  } catch {
    // A hand-edited file with a syntax error should not stop the daemon booting.
    current = DEFAULTS;
  }
  importServicesOnce();
  return current;
}

/**
 * Adopt services from a launcher's config file, once, when asked to.
 *
 * `importedAt` is the guard rather than an empty list: someone who deletes every
 * service means it, and should not find them all back on the next boot.
 */
function importServicesOnce(): void {
  if (current.services.importedAt) return;
  const imported = importLegacyServices();
  const stamp = new Date().toISOString();
  current = {
    ...current,
    services: imported
      ? { ...current.services, defs: imported.services, paths: imported.paths, importedAt: stamp }
      : { ...current.services, importedAt: stamp },
  };
  if (imported) console.log(`imported ${imported.services.length} services from ${legacyConfigPath}`);
  persist();
}

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: DeepPartial<Settings>): Settings {
  current = merge(current, patch);
  persist();
  for (const fn of listeners) fn(current);
  return current;
}

/**
 * Silence some kinds for one session, or clear it.
 *
 * Its own writer rather than a settings patch: the map is keyed by session id, and a
 * patch carrying the whole map would replace every other session's entry with
 * whatever that tab last read. An empty list of kinds is an absence rather than a
 * value — leaving the key behind would mean "this session is muted" forever, and read
 * as one in settings.json.
 */
export function setSessionMute(id: string, kinds: NotifyEventKind[], label: string): Settings {
  const mutes = { ...current.notifications.mutes };
  if (kinds.length > 0) mutes[id] = { kinds, label };
  else delete mutes[id];
  current = { ...current, notifications: { ...current.notifications, mutes } };
  persist();
  for (const fn of listeners) fn(current);
  return current;
}

export function onSettingsChange(fn: (s: Settings) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function persist() {
  try {
    writeFileSync(SETTINGS_PATH, JSON.stringify(current, null, 2));
  } catch (err) {
    console.error("[claude-dashboard] could not write settings.json:", err);
  }
}

/**
 * True when now falls inside the configured quiet window. The window is allowed
 * to wrap midnight, which is the normal case for "don't wake me up".
 */
export function inQuietHours(s: Settings, now: Date): boolean {
  const q = s.notifications.quietHours;
  if (!q.enabled) return false;
  const mins = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const from = mins(q.from);
  const to = mins(q.to);
  const nowMins = now.getHours() * 60 + now.getMinutes();
  return from <= to ? nowMins >= from && nowMins < to : nowMins >= from || nowMins < to;
}
