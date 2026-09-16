import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { stalledReason, type AgentSummary, type Settings } from "../api.ts";
import {
  clampRect,
  DOCK_DRAG_MIME,
  readDockOrder,
  rectForZone,
  resizeRect,
  snapZoneAt,
  writeDockOrder,
  type ResizeDir,
  type SnapZone,
  type TileRect,
  type TileState,
} from "../tiles.ts";
import { ShowDesktopIcon } from "./Icons.tsx";
import { SessionPanelContent } from "./SessionPanelContent.tsx";

const RESIZE_DIRS: ResizeDir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

const SNAP_LABEL: Record<SnapZone, string> = {
  left: "Left half",
  right: "Right half",
  top: "Top half",
  bottom: "Bottom half",
  "top-left": "Top-left quarter",
  "top-right": "Top-right quarter",
  "bottom-left": "Bottom-left quarter",
  "bottom-right": "Bottom-right quarter",
  "left-third": "Left third",
  "center-third": "Center third",
  "right-third": "Right third",
  "ninth-top-left": "Top-left ninth",
  "ninth-top": "Top ninth",
  "ninth-top-right": "Top-right ninth",
  "ninth-middle-left": "Middle-left ninth",
  "ninth-middle": "Middle ninth",
  "ninth-middle-right": "Middle-right ninth",
  "ninth-bottom-left": "Bottom-left ninth",
  "ninth-bottom": "Bottom ninth",
  "ninth-bottom-right": "Bottom-right ninth",
  maximize: "Maximize",
};

/** A tiny rectangle-within-a-square glyph for each arrangement option, rather
 * than asking someone to tell "top-left" and "bottom-left" apart by label. */
const ZONE_ICON_RECT: Record<SnapZone, { x: number; y: number; w: number; h: number }> = {
  left: { x: 0, y: 0, w: 50, h: 100 },
  right: { x: 50, y: 0, w: 50, h: 100 },
  top: { x: 0, y: 0, w: 100, h: 50 },
  bottom: { x: 0, y: 50, w: 100, h: 50 },
  "top-left": { x: 0, y: 0, w: 50, h: 50 },
  "top-right": { x: 50, y: 0, w: 50, h: 50 },
  "bottom-left": { x: 0, y: 50, w: 50, h: 50 },
  "bottom-right": { x: 50, y: 50, w: 50, h: 50 },
  "left-third": { x: 0, y: 0, w: 33.33, h: 100 },
  "center-third": { x: 33.33, y: 0, w: 33.33, h: 100 },
  "right-third": { x: 66.67, y: 0, w: 33.33, h: 100 },
  "ninth-top-left": { x: 0, y: 0, w: 33.33, h: 33.33 },
  "ninth-top": { x: 33.33, y: 0, w: 33.33, h: 33.33 },
  "ninth-top-right": { x: 66.67, y: 0, w: 33.33, h: 33.33 },
  "ninth-middle-left": { x: 0, y: 33.33, w: 33.33, h: 33.33 },
  "ninth-middle": { x: 33.33, y: 33.33, w: 33.33, h: 33.33 },
  "ninth-middle-right": { x: 66.67, y: 33.33, w: 33.33, h: 33.33 },
  "ninth-bottom-left": { x: 0, y: 66.67, w: 33.33, h: 33.33 },
  "ninth-bottom": { x: 33.33, y: 66.67, w: 33.33, h: 33.33 },
  "ninth-bottom-right": { x: 66.67, y: 66.67, w: 33.33, h: 33.33 },
  maximize: { x: 0, y: 0, w: 100, h: 100 },
};

const HALVES: SnapZone[] = ["left", "right", "top", "bottom"];
const QUARTERS: SnapZone[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
const THIRDS: SnapZone[] = ["left-third", "center-third", "right-third"];
const NINTHS: SnapZone[] = [
  "ninth-top-left",
  "ninth-top",
  "ninth-top-right",
  "ninth-middle-left",
  "ninth-middle",
  "ninth-middle-right",
  "ninth-bottom-left",
  "ninth-bottom",
  "ninth-bottom-right",
];

type Drag =
  | { mode: "move"; id: string; startX: number; startY: number; startRect: TileRect }
  | { mode: "resize"; id: string; dir: ResizeDir; startX: number; startY: number; startRect: TileRect };

/**
 * The floating-window layer: sessions open as OS-style tiles that live behind
 * the drawer (so a session opened in the drawer is never lost under one) but
 * in front of the page content. Owns drag-to-move, drag-to-resize, edge/corner
 * snapping and stacking order; the session content itself is the same
 * `SessionPanelContent` the drawer renders, with its header doubling as the
 * drag handle.
 *
 * All pointer tracking lives in one effect mounted once, reading the current
 * drag (and the zone the pointer is hovering for a snap) from refs rather
 * than state — state only exists here to re-render the ghost preview box,
 * and closing over it directly in the effect would mean acting on whatever
 * `snapZone` was at mount time, not at drop time.
 */
export function TileLayer({
  tiles,
  agents,
  dismissedLive,
  agentFor,
  sessionIdFor,
  settings,
  onSettings,
  onClose,
  onFocus,
  onRectChange,
  onOpenFull,
  onMinimize,
  onOpen,
  onToggleMinimizeAll,
  dockLeading,
  dockNav,
  dockTrailing,
}: {
  tiles: TileState[];
  /** Every live session gets a permanent dock entry, tiled or not — see the dock below. */
  agents: AgentSummary[];
  /** Live sessions explicitly closed (red light) rather than minimized — held
   * out of the dock until reopened, the same way quitting an app drops its
   * Dock icon instead of leaving it parked there while it's still running. */
  dismissedLive: Set<string>;
  agentFor: (id: string) => AgentSummary | null;
  sessionIdFor: (id: string) => string | null;
  settings: Settings | null;
  onSettings: (s: Settings) => void;
  onClose: (id: string) => void;
  onFocus: (id: string) => void;
  onRectChange: (id: string, rect: TileRect) => void;
  /** Green light: hand the session to the full page. */
  onOpenFull: (id: string) => void;
  /** Yellow light: drop to the dock, keeping its place and size for later. */
  onMinimize: (id: string) => void;
  /** A dock chip: open it as a tile if it isn't one yet, or bring it back where it was, in front. */
  onOpen: (id: string) => void;
  /** The tray-arrow button: same "show desktop" toggle as ⌘⇧M. */
  onToggleMinimizeAll: () => void;
  /** Brand mark and connection status — the dock is the one bar on screen, so it
   * carries what the header used to. */
  dockLeading: React.ReactNode;
  /** Page switcher, rendered as icon buttons alongside the session chips. */
  dockNav: React.ReactNode;
  /** Theme toggle, pinned to the dock's far end. */
  dockTrailing: React.ReactNode;
}) {
  const drag = useRef<Drag | null>(null);
  const [snapZone, setSnapZone] = useState<SnapZone | null>(null);
  const snapZoneRef = useRef<SnapZone | null>(null);
  const onRectChangeRef = useRef(onRectChange);
  onRectChangeRef.current = onRectChange;
  const [dockOrder, setDockOrder] = useState<string[]>(readDockOrder);
  useEffect(() => writeDockOrder(dockOrder), [dockOrder]);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (d.mode === "move") {
        const rect = clampRect({ ...d.startRect, x: d.startRect.x + dx, y: Math.max(0, d.startRect.y + dy) });
        onRectChangeRef.current(d.id, rect);
        const zone = snapZoneAt(e.clientX, e.clientY);
        snapZoneRef.current = zone;
        setSnapZone(zone);
      } else {
        onRectChangeRef.current(d.id, resizeRect(d.startRect, d.dir, dx, dy));
      }
    }
    function onUp() {
      const d = drag.current;
      if (!d) return;
      if (d.mode === "move" && snapZoneRef.current) {
        onRectChangeRef.current(d.id, rectForZone(snapZoneRef.current));
      }
      drag.current = null;
      snapZoneRef.current = null;
      setSnapZone(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  function startMove(id: string, rect: TileRect) {
    return (e: React.PointerEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("button, a, input, textarea, [contenteditable]")) return;
      e.preventDefault();
      onFocus(id);
      drag.current = { mode: "move", id, startX: e.clientX, startY: e.clientY, startRect: rect };
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
    };
  }

  function startResize(id: string, rect: TileRect, dir: ResizeDir) {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onFocus(id);
      drag.current = { mode: "resize", id, dir, startX: e.clientX, startY: e.clientY, startRect: rect };
      document.body.style.cursor = `${dir}-resize`;
      document.body.style.userSelect = "none";
    };
  }

  const open = tiles.filter((t) => !t.minimized);
  // Every live session, tiled or not — mirroring a real OS dock, where an
  // app's icon sits there the whole time it's running, whether or not any
  // of its windows are currently open. A minimized tile for a session that
  // *isn't* live (a historical one someone tucked away) also earns a spot,
  // since that's the only place left to reach it from. One explicitly closed
  // (red light) rather than minimized is the exception — it stays off the
  // dock, still live or not, until reopened.
  const liveIds = new Set(
    agents
      .filter((a) => a.status !== "ended" && a.status !== "error")
      .map((a) => a.sessionId ?? a.key)
      .filter((id) => !dismissedLive.has(id)),
  );
  const dockMembers = new Set([...liveIds, ...tiles.filter((t) => t.minimized).map((t) => t.id)]);
  // Membership can shuffle order for free reasons (agents re-sorted by
  // activity, a tile minimized out of turn) — the dock itself shouldn't.
  // Keep whatever order was last settled on, drop anything no longer a
  // member, and land brand-new arrivals on the right, exactly once.
  const dockIds = [
    ...dockOrder.filter((id) => dockMembers.has(id)),
    ...Array.from(dockMembers).filter((id) => !dockOrder.includes(id)),
  ];
  useEffect(() => {
    setDockOrder((prev) => {
      if (prev.length === dockIds.length && prev.every((id, i) => id === dockIds[i])) return prev;
      return dockIds;
    });
  }, [dockIds.join("")]);
  const tileById = new Map(tiles.map((t) => [t.id, t]));
  // Rank only decides the z-index *value* — `open` itself is mapped in its
  // own, otherwise-untouched order below, so focusing a tile never moves its
  // DOM node to a new position among its siblings. It used to: rendering a
  // copy sorted by z meant the tile with focus jumped to the end of the
  // array on every click, and React reconciling that as a reordered keyed
  // list moves the actual DOM node — which is what was resetting each
  // tile's own scroll position on focus, not anything about focus itself.
  const rank = new Map([...open].sort((a, b) => a.z - b.z).map((t, i) => [t.id, i]));
  const preview = snapZone ? rectForZone(snapZone) : null;

  return (
    <div className="tile-layer">
      {preview && (
        <div
          className="tile-snap-preview"
          style={{ left: preview.x, top: preview.y, width: preview.w, height: preview.h }}
        >
          {SNAP_LABEL[snapZone!]}
        </div>
      )}
      {open.map((t) => (
        <TileWindow
          key={t.id}
          tile={t}
          // Capped rather than a straight 10+rank: with enough tiles open, an
          // uncapped count would eventually reach the scrim (20) and drawer
          // (21), breaking the one rule tiles are supposed to follow.
          z={Math.min(19, 10 + (rank.get(t.id) ?? 0))}
          agent={agentFor(t.id)}
          sessionId={sessionIdFor(t.id) ?? t.id}
          settings={settings}
          onSettings={onSettings}
          onClose={() => onClose(t.id)}
          onFocus={() => onFocus(t.id)}
          onOpenFull={() => onOpenFull(t.id)}
          onMinimize={() => onMinimize(t.id)}
          onSnap={(zone) => onRectChange(t.id, rectForZone(zone))}
          onMoveStart={startMove(t.id, t.rect)}
          onResizeStart={(dir) => startResize(t.id, t.rect, dir)}
        />
      ))}
      <TileDock
        ids={dockIds}
        agentFor={agentFor}
        isLive={(id) => liveIds.has(id)}
        isOpen={(id) => {
          const t = tileById.get(id);
          return !!t && !t.minimized;
        }}
        onOpen={onOpen}
        onMinimize={onMinimize}
        onClose={onClose}
        onToggleMinimizeAll={onToggleMinimizeAll}
        onReorder={(draggedId, beforeId) => {
          setDockOrder((prev) => {
            const without = prev.filter((id) => id !== draggedId);
            const at = without.indexOf(beforeId);
            if (at === -1) return prev;
            const next = [...without];
            next.splice(at, 0, draggedId);
            return next;
          });
        }}
        leading={dockLeading}
        nav={dockNav}
        trailing={dockTrailing}
      />
    </div>
  );
}

/**
 * The same read every live card already gives you — awaiting your input,
 * thinking, idle, stalled, or done — so a minimized session doesn't hide
 * that behind a plain label the moment it drops to the dock. A session with
 * no agent (an external or historical one) has nothing live to report.
 */
function dockStatus(agent: AgentSummary | null): { cls: string; label: string } | null {
  if (!agent) return null;
  if (agent.status === "awaiting-permission") return { cls: "attention", label: "needs you" };
  if (agent.status === "thinking" || agent.status === "starting") return { cls: "busy", label: "working" };
  if (agent.status === "idle") {
    const stalled = stalledReason(agent);
    return stalled ? { cls: "stalled", label: stalled } : { cls: "idle", label: "idle" };
  }
  return { cls: "dead", label: agent.status === "error" ? "error" : "ended" };
}

/**
 * A shelf for every live session plus anything minimized, mounted once at the
 * top level rather than per tab — TileLayer already renders unconditionally
 * regardless of which tab is active, so a session docked while looking at
 * Live is still one click away from History or Settings without any extra
 * plumbing to make that true.
 *
 * A live entry has no × — there's nothing to remove while the session is
 * still running, the same way you can't drag a running app off a real dock
 * without quitting it first, and quitting isn't a decision this button
 * should make for you. Ended up here anyway (not live, just parked) is the
 * one case actually worth an explicit remove.
 *
 * Clicking one already open minimizes it back rather than just re-focusing
 * it — the dock icon doubles as an on/off switch for that window the same
 * way clicking a running app's Dock icon can send it back down.
 */
function TileDock({
  ids,
  agentFor,
  isLive,
  isOpen,
  onOpen,
  onMinimize,
  onClose,
  onToggleMinimizeAll,
  onReorder,
  leading,
  nav,
  trailing,
}: {
  ids: string[];
  agentFor: (id: string) => AgentSummary | null;
  isLive: (id: string) => boolean;
  isOpen: (id: string) => boolean;
  onOpen: (id: string) => void;
  onMinimize: (id: string) => void;
  onClose: (id: string) => void;
  onToggleMinimizeAll: () => void;
  /** A chip was dropped onto another — put it just before the drop target. */
  onReorder: (draggedId: string, beforeId: string) => void;
  leading: React.ReactNode;
  nav: React.ReactNode;
  trailing: React.ReactNode;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  return (
    <div className="tile-dock">
      {leading}
      <div className="tile-dock-sep" aria-hidden />
      {nav}
      <div className="tile-dock-sep" aria-hidden />
      <button
        className="tile-dock-all"
        title="Minimize or restore every open tile (⌘⇧M)"
        onClick={onToggleMinimizeAll}
      >
        <ShowDesktopIcon />
      </button>
      <div className="dock-chips">
        {ids.map((id) => {
          const agent = agentFor(id);
          const label = agent?.title ?? id.slice(0, 8);
          const status = dockStatus(agent);
          const live = isLive(id);
          const openNow = isOpen(id);
          return (
            <div
              key={id}
              className={`tile-dock-chip ${openNow ? "open" : ""} ${status ? status.cls : ""} ${
                draggingId === id ? "dragging" : ""
              } ${overId === id && draggingId && draggingId !== id ? "drag-over" : ""}`}
              onClick={() => (openNow ? onMinimize(id) : onOpen(id))}
              title={`${openNow ? "Minimize" : live ? "Open" : "Restore"} ${label}${status ? ` — ${status.label}` : ""}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DOCK_DRAG_MIME, id);
                e.dataTransfer.effectAllowed = "move";
                setDraggingId(id);
              }}
              onDragEnd={() => {
                setDraggingId(null);
                setOverId(null);
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(DOCK_DRAG_MIME)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (overId !== id) setOverId(id);
              }}
              onDragLeave={() => setOverId((prev) => (prev === id ? null : prev))}
              onDrop={(e) => {
                e.preventDefault();
                const draggedId = e.dataTransfer.getData(DOCK_DRAG_MIME);
                setOverId(null);
                if (!draggedId || draggedId === id) return;
                onReorder(draggedId, id);
              }}
            >
              <i className="dot" />
              <span className="tile-dock-chip-label">{label}</span>
              {!live && (
                <button
                  className="tile-dock-chip-close"
                  title="Remove from the dock"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(id);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="tile-dock-sep" aria-hidden />
      {trailing}
    </div>
  );
}

function ZoneIcon({ zone }: { zone: SnapZone }) {
  const r = ZONE_ICON_RECT[zone];
  return (
    <span className="snap-icon" aria-hidden>
      <span
        className="snap-icon-fill"
        style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}
      />
    </span>
  );
}

function SnapMenu({
  style,
  onPick,
}: {
  style: React.CSSProperties;
  onPick: (zone: SnapZone) => void;
}) {
  return (
    <div className="tile-snap-menu" style={style} onPointerDown={(e) => e.stopPropagation()}>
      <div className="tile-snap-menu-label">Move &amp; Resize</div>
      <div className="tile-snap-menu-row">
        {HALVES.map((z) => (
          <button key={z} className="tile-snap-menu-btn" title={SNAP_LABEL[z]} onClick={() => onPick(z)}>
            <ZoneIcon zone={z} />
          </button>
        ))}
      </div>
      <div className="tile-snap-menu-label">Quarters</div>
      <div className="tile-snap-menu-row">
        {QUARTERS.map((z) => (
          <button key={z} className="tile-snap-menu-btn" title={SNAP_LABEL[z]} onClick={() => onPick(z)}>
            <ZoneIcon zone={z} />
          </button>
        ))}
      </div>
      <div className="tile-snap-menu-label">Thirds</div>
      <div className="tile-snap-menu-row thirds">
        {THIRDS.map((z) => (
          <button key={z} className="tile-snap-menu-btn" title={SNAP_LABEL[z]} onClick={() => onPick(z)}>
            <ZoneIcon zone={z} />
          </button>
        ))}
      </div>
      <div className="tile-snap-menu-label">Ninths</div>
      <div className="tile-snap-menu-row thirds">
        {NINTHS.map((z) => (
          <button key={z} className="tile-snap-menu-btn" title={SNAP_LABEL[z]} onClick={() => onPick(z)}>
            <ZoneIcon zone={z} />
          </button>
        ))}
      </div>
    </div>
  );
}

const HOVER_MENU_MS = 350;

/**
 * Two lights, not the usual three: every session already gets a permanent
 * dock entry the moment it's live, so "close" and "minimize" collapsed into
 * the same action — closing a tile's window no more removes the session than
 * closing a real app's window quits it. Red does that; green hands the
 * session to the full page, or hovering it for a moment opens the arrange
 * menu — the same overload macOS itself gives its own green light.
 */
function TileLights({
  onClose,
  onMinimize,
  onOpenFull,
  onSnap,
}: {
  onClose: () => void;
  onMinimize: () => void;
  onOpenFull: () => void;
  onSnap: (zone: SnapZone) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const wrap = useRef<HTMLSpanElement | null>(null);
  const hoverTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onDocDown(e: PointerEvent) {
      if (!wrap.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    window.addEventListener("pointerdown", onDocDown);
    return () => window.removeEventListener("pointerdown", onDocDown);
  }, [menuOpen]);

  // Portaled to <body> rather than left nested in the tile: a tile is its own
  // stacking context (it carries its own z-index for window ordering), so a
  // CSS z-index on the menu only ever won against its siblings *inside* that
  // tile — a plain tile stacked above this one in the pile still painted over
  // the menu. Rendering it at the document root and positioning it in fixed
  // coordinates off the green light's own on-screen rect sidesteps that
  // entirely: the menu's z-index now competes at the top level, above every
  // tile regardless of which one it was opened from.
  useEffect(() => {
    if (!menuOpen) return;
    const rect = wrap.current?.getBoundingClientRect();
    if (rect) setMenuPos({ top: rect.bottom + 6, left: rect.left - 8 });
  }, [menuOpen]);

  function armHover() {
    hoverTimer.current = window.setTimeout(() => setMenuOpen(true), HOVER_MENU_MS);
  }
  function disarmHover() {
    if (hoverTimer.current != null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }

  return (
    <div className="tile-lights">
      <button className="tile-light tile-light-red" title="Close (removes from the dock — reopen from Live)" onClick={onClose} />
      <button className="tile-light tile-light-yellow" title="Minimize (drops to the dock)" onClick={onMinimize} />
      <span
        className="tile-light-green-wrap"
        ref={wrap}
        onMouseEnter={armHover}
        onMouseLeave={disarmHover}
      >
        <button className="tile-light tile-light-green" title="Open full page (hover to arrange)" onClick={onOpenFull} />
        {menuOpen &&
          menuPos &&
          createPortal(
            <SnapMenu
              style={{ position: "fixed", top: menuPos.top, left: menuPos.left }}
              onPick={(zone) => {
                onSnap(zone);
                setMenuOpen(false);
              }}
            />,
            document.body,
          )}
      </span>
    </div>
  );
}

function TileWindow({
  tile,
  z,
  agent,
  sessionId,
  settings,
  onSettings,
  onClose,
  onFocus,
  onOpenFull,
  onMinimize,
  onSnap,
  onMoveStart,
  onResizeStart,
}: {
  tile: TileState;
  z: number;
  agent: AgentSummary | null;
  sessionId: string;
  settings: Settings | null;
  onSettings: (s: Settings) => void;
  onClose: () => void;
  onFocus: () => void;
  onOpenFull: () => void;
  onMinimize: () => void;
  onSnap: (zone: SnapZone) => void;
  onMoveStart: (e: React.PointerEvent) => void;
  onResizeStart: (dir: ResizeDir) => (e: React.PointerEvent) => void;
}) {
  const body = useRef<HTMLDivElement | null>(null);

  return (
    <div
      className="tile-window"
      style={{
        left: tile.rect.x,
        top: tile.rect.y,
        width: tile.rect.w,
        height: tile.rect.h,
        zIndex: z,
      }}
      onPointerDownCapture={onFocus}
    >
      <div className={`tile-body ${agent ? "tile-body-live" : ""}`} ref={body}>
        <SessionPanelContent
          id={sessionId}
          agent={agent}
          settings={settings}
          onSettings={onSettings}
          onClose={onClose}
          scrollRef={body}
          jumpVariant="compact"
          chrome="minimal"
          titleEditable={false}
          onHeadPointerDown={onMoveStart}
          headStart={<TileLights onClose={onClose} onMinimize={onMinimize} onOpenFull={onOpenFull} onSnap={onSnap} />}
        />
      </div>
      {RESIZE_DIRS.map((dir) => (
        <div
          key={dir}
          className={`tile-resize tile-resize-${dir}`}
          onPointerDown={onResizeStart(dir)}
          title="Drag to resize"
        />
      ))}
    </div>
  );
}
