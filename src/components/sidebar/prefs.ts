import { useSyncExternalStore } from "react";

/** What the sidebar remembers in this browser: folded headings, the filter, and when you last looked at a session. */
export type SidebarPrefs = {
  folds: Record<string, boolean>;
  seen: Record<string, number>;
  onlyNeeds: boolean;
};

const KEY = "sidebar-tree";
const SEEN_CAP = 500;
const DEFAULTS: SidebarPrefs = { folds: {}, seen: {}, onlyNeeds: false };

function read(): SidebarPrefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<SidebarPrefs> | null) };
  } catch {
    return DEFAULTS;
  }
}

let state = read();
const listeners = new Set<() => void>();

function set(patch: Partial<SidebarPrefs>) {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    state = { ...state };
  }
  for (const l of listeners) l();
}

export const sidebarPrefs = {
  get: () => state,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  fold: (key: string, folded: boolean) => set({ folds: { ...state.folds, [key]: folded } }),
  setOnlyNeeds: (onlyNeeds: boolean) => set({ onlyNeeds }),
  markSeen(ids: string[], at = Date.now()) {
    if (ids.length === 0) return;
    const seen = { ...state.seen };
    for (const id of ids) seen[id] = at;
    const entries = Object.entries(seen);
    set({
      seen:
        entries.length > SEEN_CAP
          ? Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, SEEN_CAP))
          : seen,
    });
  },
};

export const useSidebarPrefs = () => useSyncExternalStore(sidebarPrefs.subscribe, sidebarPrefs.get, sidebarPrefs.get);
