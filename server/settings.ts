import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./paths.ts";
import { DEFAULT_PROVISION, type ProvisionRule } from "./provision.ts";

/**
 * User-editable preferences, as opposed to config.ts which holds the pricing and
 * budget numbers you tune once. These change from the UI at runtime, so they live
 * in their own file and are written back on every edit.
 */
export type NotifyEventKind =
  | "needsInput"
  | "awaitingPermission"
  | "turnComplete"
  | "sessionError";

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
     * What clicking a session card does. The drawer keeps you on the list; the page
     * gives the transcript, the git panel and the review room to breathe.
     */
    openSessionsIn: "drawer" | "page";
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
  };
};

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
    openSessionsIn: "drawer",
    worktreeRoot: "",
    worktreeProvision: DEFAULT_PROVISION,
    worktreeProvisionByRepo: {},
    worktreeExclude: false,
  },
};

const SETTINGS_PATH = join(DATA_DIR, "settings.json");

let current: Settings = DEFAULTS;
const listeners = new Set<(s: Settings) => void>();

/** Merge a partial payload over the defaults, one level deeper than spread. */
function merge(base: Settings, patch: DeepPartial<Settings>): Settings {
  const n = patch.notifications ?? {};
  const u = patch.ui ?? {};
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
  } catch {
    // A hand-edited file with a syntax error should not stop the daemon booting.
    current = DEFAULTS;
  }
  return current;
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
