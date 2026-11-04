import type { ComponentType } from "react";
import type { Appearance } from "../appearance.ts";
import type { PageDef, Tab } from "../pages.ts";
import { BrandMark } from "./BrandMark.tsx";

/**
 * Navigation, out of the dock and into a sidebar.
 *
 * The dock is for what is running; the pages are the places you go. Collapsed,
 * the sidebar is an icon rail with the labels in tooltips, so a narrow window or
 * a tile-heavy desktop keeps the whole width for content.
 */
export function Sidebar({
  pages,
  tab,
  onSelect,
  iconFor,
  collapsed,
  appearance,
  blocked,
  thinking,
  liveCount,
  reviewsUnseen,
  connected,
  name,
  onHome,
}: {
  pages: PageDef[];
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
  connected: boolean;
  name: string;
  onHome: () => void;
}) {
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

      <div className="sidebar-label">Navigate</div>
      <nav className="sidebar-nav">
        {pages.map((p) => {
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
            </button>
          );
        })}
      </nav>

      <div className="sidebar-foot">
        <div className={`sidebar-status ${connected ? "" : "off"}`} title={connected ? "Streaming from the daemon" : "Reconnecting to the daemon"}>
          <i className="dot" />
          <span className="sidebar-item-label">
            {liveCount} live · {connected ? "connected" : "reconnecting"}
          </span>
        </div>
      </div>
    </aside>
  );
}
