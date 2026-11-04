/**
 * The dock's pages, in the order they appear.
 *
 * One list, read by the dock nav, the command palette and the settings panel that
 * turns them off — a page hidden in settings has to disappear from all three, and
 * three separate lists drifted apart the moment one gained a page.
 */
export type Tab = "desktop" | "live" | "history" | "artifacts" | "worktrees" | "services" | "templates" | "reviews" | "usage" | "settings";

export type PageDef = {
  key: Tab;
  /** Empty for desktop, which the dock renders icon-only. */
  label: string;
  /** What the palette and the settings list say it is for. */
  hint: string;
  /**
   * Settings and live are not hideable: one is the way back from a mistake here,
   * the other is where a tab lands when the page it was on is turned off.
   */
  fixed?: boolean;
};

export const PAGES: PageDef[] = [
  { key: "desktop", label: "", hint: "a blank canvas for arranging tiles" },
  { key: "live", label: "Live", hint: "your sessions", fixed: true },
  { key: "history", label: "History", hint: "past sessions" },
  { key: "artifacts", label: "Artifacts", hint: "generated pages" },
  { key: "worktrees", label: "Worktrees", hint: "checkouts" },
  { key: "services", label: "Services", hint: "local dev stack" },
  { key: "templates", label: "Templates", hint: "session recipes and schedules" },
  { key: "reviews", label: "Reviews", hint: "GitHub pull requests" },
  { key: "usage", label: "Usage", hint: "tokens and cost" },
  { key: "settings", label: "Settings", hint: "preferences", fixed: true },
];

export const HIDEABLE_PAGES = PAGES.filter((p) => !p.fixed);

/** A page is on unless it was deliberately turned off, so a new one arrives visible. */
export const isPageVisible = (key: Tab, hidden: string[] | undefined): boolean =>
  PAGES.find((p) => p.key === key)?.fixed === true || !(hidden ?? []).includes(key);

/** The pages in the user's order; keys not in the order keep their registry position at the end. */
export const orderedPages = (order: string[] | undefined): PageDef[] => {
  if (!order?.length) return PAGES;
  const rank = new Map(order.map((k, i) => [k, i]));
  return [...PAGES].sort((a, b) => (rank.get(a.key) ?? order.length + PAGES.indexOf(a)) - (rank.get(b.key) ?? order.length + PAGES.indexOf(b)));
};

export const visiblePages = (hidden: string[] | undefined, order?: string[]): PageDef[] =>
  orderedPages(order).filter((p) => isPageVisible(p.key, hidden));
