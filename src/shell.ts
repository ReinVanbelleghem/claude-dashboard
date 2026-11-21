/** A banner the app raises in macOS's notification centre on the page's behalf. */
export type ShellNotice = { key: string; title: string; body: string; href: string };

/** The macOS app around the page (electron/preload.cjs). Undefined in a browser. */
export type Shell = {
  /** Which of the app's windows this is: 1 for the first, counting up. */
  windowSlot: number;
  setDockIcon: (dataUrl: string) => void;
  setBadge: (count: number) => void;
  notify: (notice: ShellNotice) => void;
};

export const shell = (window as Window & { dashboardShell?: Shell }).dashboardShell;
