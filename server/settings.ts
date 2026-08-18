import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./paths.ts";

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
 * Mirrors src/appearance.ts. The daemon stores it and hands it back; it has no
 * opinion on which hues exist, so adding a swatch in the UI needs nothing here.
 */
export type Appearance = {
  theme: "dark" | "light";
  accent: string;
  favicon: string;
  faviconColor: string;
  motion?: boolean;
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
    quietHours: { enabled: false, from: "23:00", to: "08:00" },
    dashboardUrl: "http://localhost:5758",
  },
  ui: {
    diffMode: "unified",
    diffIgnoreWhitespace: false,
    hideToolCalls: false,
    openSessionsIn: "drawer",
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
