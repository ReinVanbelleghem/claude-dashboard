import type { ComponentType, ReactNode } from "react";
import type { Appearance } from "../appearance.ts";
import { footerPagesOf, type PageDef, type Tab } from "../pages.ts";
import { BrandMark } from "./BrandMark.tsx";
import { ChevronIcon } from "./Icons.tsx";
import { sidebarPrefs, useSidebarPrefs } from "./sidebar/prefs.ts";

/**
 * Navigation, out of the dock and into a sidebar.
 *
 * The dock is for what is running; the pages are the places you go. Collapsed,
 * the sidebar is an icon rail with the labels in tooltips, so a narrow window or
 * a tile-heavy desktop keeps the whole width for content.
 */
export function Sidebar({
  pages,
  footerPages,
  tab,
  onSelect,
  iconFor,
  collapsed,
  appearance,
  blocked,
  thinking,
  liveCount,
  reviewsUnseen,
  tasksDue,
  connected,
  name,
  onHome,
  children,
}: {
  pages: PageDef[];
  /** Keys of the pages that sit in the bottom bar as icons instead of in the main list. */
  footerPages: string[] | undefined;
  /** The current page, or null while a full-page view (session, PR) owns the screen. */
  tab: Tab | null;
  onSelect: (tab: Tab) => void;
  iconFor: (tab: Tab) => ComponentType;
  collapsed: boolean;
  appearance: Appearance;
  blocked: number;
  thinking: number;
  liveCount: number;
  /** Watched pull requests with changes not yet looked at. */
  reviewsUnseen: number;
  /** Open tasks due today or overdue. */
  tasksDue: number;
  connected: boolean;
  name: string;
  onHome: () => void;
  /** The workspace tree and its collapsed stand-in; the stylesheet shows whichever fits the sidebar's width. */
  children?: ReactNode;
}) {
  const navFolded = useSidebarPrefs().folds.nav === true && !collapsed;
  const inFooter = footerPagesOf(footerPages);
  const mainPages = pages.filter((p) => !inFooter.has(p.key));
  const footPages = pages.filter((p) => inFooter.has(p.key) && p.key !== "settings");
  const settingsPage = pages.find((p) => p.key === "settings" && inFooter.has(p.key));
  const footButton = (p: PageDef) => {
    const Icon = iconFor(p.key);
    const label = p.label || "Desktop";
    const on = tab === p.key;
    return (
      <button
        key={p.key}
        className={`sidebar-foot-btn ${on ? "on" : ""}`}
        aria-current={on ? "page" : undefined}
        aria-label={label}
        title={`${label} — ${p.hint}`}
        onClick={() => onSelect(p.key)}
      >
        <Icon />
        {p.key === "live" && blocked > 0 && <i className="sidebar-foot-dot" />}
        {p.key === "reviews" && reviewsUnseen > 0 && <i className="sidebar-foot-dot soft" />}
        {p.key === "tasks" && tasksDue > 0 && <i className="sidebar-foot-dot soft" />}
      </button>
    );
  };
  const status = `${liveCount} live · ${connected ? "connected" : "reconnecting"}`;
  // "Claude Dashboard" reads as a wordmark over a subtitle; a one-word name is just the wordmark.
  const [head, ...tail] = name.trim().split(/\s+/);
  const rest = tail.join(" ");
  return (
    <aside className={`sidebar ${collapsed ? "rail" : ""}`} aria-label="Pages">
      <div className="sidebar-head">
        <button className="sidebar-brand" onClick={onHome} title={`${name} — back to Live`} aria-label="Back to Live">
          <BrandMark appearance={appearance} blocked={blocked} thinking={thinking} />
          <span className="sidebar-brand-text">
            <strong>{head}</strong>
            {rest && <small>{rest}</small>}
          </span>
        </button>
      </div>

      <button
        className="sidebar-label sidebar-label-btn"
        aria-expanded={!navFolded}
        title={navFolded ? "Show the pages" : "Hide the pages"}
        onClick={() => sidebarPrefs.fold("nav", !navFolded)}
      >
        Navigate
        <span className={`ws-chev${navFolded ? "" : " open"}`}>
          <ChevronIcon />
        </span>
      </button>
      <nav className="sidebar-nav">
        {(navFolded ? mainPages.filter((p) => p.key === tab) : mainPages).map((p) => {
          const Icon = iconFor(p.key);
          const label = p.label || "Desktop";
          const on = tab === p.key;
          return (
            <button
              key={p.key}
              className={`sidebar-item ${on ? "on" : ""}`}
              aria-current={on ? "page" : undefined}
              title={collapsed ? `${label} — ${p.hint}` : p.hint}
              onClick={() => onSelect(p.key)}
            >
              <span className="sidebar-item-icon">
                <Icon />
              </span>
              <span className="sidebar-item-label">{label}</span>
              {p.key === "live" && blocked > 0 && <span className="badge">{blocked}</span>}
              {p.key === "reviews" && reviewsUnseen > 0 && <span className="badge soft">{reviewsUnseen}</span>}
              {p.key === "tasks" && tasksDue > 0 && <span className="badge soft">{tasksDue}</span>}
            </button>
          );
        })}
      </nav>

      {children}

      {footPages.length > 0 || settingsPage ? (
        <div className="sidebar-foot strip">
          <span className={`sidebar-status ${connected ? "" : "off"}`} title={status} role="img" aria-label={status}>
            <i className="dot" />
          </span>
          <nav className="sidebar-foot-pages" aria-label="More pages">
            {footPages.map(footButton)}
          </nav>
          {settingsPage && footButton(settingsPage)}
        </div>
      ) : (
        <div className="sidebar-foot">
          <div className={`sidebar-status ${connected ? "" : "off"}`} title={connected ? "Streaming from the daemon" : "Reconnecting to the daemon"}>
            <i className="dot" />
            <span className="sidebar-item-label">{status}</span>
          </div>
        </div>
      )}
    </aside>
  );
}
