import { isArtifactKey } from "../../shared/artifacts.ts";
import { isDrawingKey } from "../../shared/drawings.ts";
import { isNoteKey } from "../../shared/notes.ts";
import { isServiceKey } from "../../shared/services.ts";
import { isTerminalKey } from "../../shared/terminals.ts";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentSummary, Settings } from "../api.ts";
import {
  applyEdgeMagnetism,
  applyMoveMagnetism,
  clampRect,
  rectForZone,
  resizeRect,
  resizeTogether,
  seamLinks,
  snapZoneAt,
  type ResizeDir,
  type SeamLink,
  type SnapZone,
  type LayerSize,
  type TileRect,
  type TileState,
} from "../tiles.ts";
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

const desktopTabAt = (x: number, y: number): Element | null =>
  document.elementsFromPoint(x, y).find((el) => el.hasAttribute("data-desktop")) ?? null;

type Drag =
  | { mode: "move"; id: string; startX: number; startY: number; startRect: TileRect }
  | { mode: "resize"; id: string; dir: ResizeDir; startX: number; startY: number; startRect: TileRect; links: SeamLink[] };

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
  agentFor,
  sessionIdFor,
  settings,
  onSettings,
  onClose,
  onFocus,
  onRectChange,
  onLayerSize,
  onOpenFull,
  onMinimize,
  onCopyToDesktop,
}: {
  tiles: TileState[];
  agentFor: (id: string) => AgentSummary | null;
  sessionIdFor: (id: string) => string | null;
  settings: Settings | null;
  onSettings: (s: Settings) => void;
  onClose: (id: string) => void;
  onFocus: (id: string) => void;
  onRectChange: (id: string, rect: TileRect) => void;
  /** The layer's width, on mount and whenever it changes: every desktop's tiles are refitted to it. */
  onLayerSize: (size: LayerSize) => void;
  /** Green light: hand the session to the full page. */
  onOpenFull: (id: string) => void;
  /** Yellow light: put it away, keeping its place and size, until the session is opened as a tile again. */
  onMinimize: (id: string) => void;
  /** A tile let go over another desktop's tab: put the same session there too, with the place it had here. */
  onCopyToDesktop: (id: string, desktopId: string, rect: TileRect) => void;
}) {
  const onCopyRef = useRef(onCopyToDesktop);
  onCopyRef.current = onCopyToDesktop;
  const overTab = useRef<Element | null>(null);
  const drag = useRef<Drag | null>(null);
  const [snapZone, setSnapZone] = useState<SnapZone | null>(null);
  const snapZoneRef = useRef<SnapZone | null>(null);
  const onRectChangeRef = useRef(onRectChange);
  onRectChangeRef.current = onRectChange;
  const onLayerSizeRef = useRef(onLayerSize);
  onLayerSizeRef.current = onLayerSize;
  // Read fresh inside the one-time pointermove effect below, the same reason
  // onRectChangeRef exists: a `[]`-deps effect closes over whatever `tiles`
  // was at mount, and a resize needs this render's neighbor rects, not that
  // one's.
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;
  const layer = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = layer.current;
    if (!el) return;
    const report = () => onLayerSizeRef.current({ w: el.clientWidth, h: el.clientHeight });
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (d.mode === "move") {
        const dragged = clampRect({ ...d.startRect, x: d.startRect.x + dx, y: Math.max(0, d.startRect.y + dy) });
        const tab = desktopTabAt(e.clientX, e.clientY);
        if (tab !== overTab.current) {
          overTab.current?.classList.remove("drop");
          tab?.classList.add("drop");
          overTab.current = tab;
        }
        const zone = tab ? null : snapZoneAt(e.clientX, e.clientY);
        // Near a screen edge, the zone preview (about to replace the whole
        // rect on release) is the snap that matters — magnetizing against a
        // neighbor at the same time would fight it right where both are
        // active. Elsewhere, snap against whatever else is open.
        const rect = zone
          ? dragged
          : applyMoveMagnetism(
              dragged,
              tilesRef.current.filter((t) => t.id !== d.id && !t.minimized).map((t) => t.rect),
            );
        onRectChangeRef.current(d.id, rect);
        snapZoneRef.current = zone;
        setSnapZone(zone);
      } else {
        const resized = resizeRect(d.startRect, d.dir, dx, dy);
        // Snap against every other open tile, minimized ones excluded since
        // they have no on-screen edge to align with right now.
        const neighbors = tilesRef.current
          .filter((t) => t.id !== d.id && !t.minimized && !d.links.some((l) => l.id === t.id))
          .map((t) => t.rect);
        const snapped = applyEdgeMagnetism(resized, d.dir, neighbors);
        const together = resizeTogether(d.startRect, d.dir, snapped, d.links);
        onRectChangeRef.current(d.id, d.links.length ? together.rect : snapped);
        for (const l of together.linked) onRectChangeRef.current(l.id, l.rect);
      }
    }
    function onUp() {
      const d = drag.current;
      if (!d) return;
      const tab = overTab.current;
      overTab.current = null;
      tab?.classList.remove("drop");
      const desktopId = tab?.getAttribute("data-desktop");
      if (d.mode === "move" && desktopId) {
        onRectChangeRef.current(d.id, d.startRect);
        if (tab?.getAttribute("aria-selected") !== "true") onCopyRef.current(d.id, desktopId, d.startRect);
      } else if (d.mode === "move" && snapZoneRef.current) {
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
      const others = tiles.filter((t) => t.id !== id && !t.minimized).map((t) => ({ id: t.id, rect: t.rect }));
      const links = e.altKey ? [] : seamLinks(rect, dir, others);
      drag.current = { mode: "resize", id, dir, startX: e.clientX, startY: e.clientY, startRect: rect, links };
      document.body.style.cursor = `${dir}-resize`;
      document.body.style.userSelect = "none";
    };
  }

  const open = tiles.filter((t) => !t.minimized);
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
    <div className="tile-layer" ref={layer}>
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
  onOpenFull,
}: {
  style: React.CSSProperties;
  onPick: (zone: SnapZone) => void;
  onOpenFull: () => void;
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
      <button className="tile-snap-menu-action" onClick={onOpenFull}>
        Open as full page
      </button>
    </div>
  );
}

const HOVER_MENU_MS = 350;

/**
 * Two lights, not the usual three: every session already gets a permanent
 * dock entry the moment it's live, so "close" and "minimize" collapsed into
 * the same action — closing a tile's window no more removes the session than
 * closing a real app's window quits it. Red does that; green fills the
 * desktop with the tile, or hovering it for a moment opens the arrange
 * menu, which also offers the full page — the same overload macOS itself
 * gives its own green light.
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
        <button className="tile-light tile-light-green" title="Fill the desktop (hover to arrange)" onClick={() => onSnap("maximize")} />
        {menuOpen &&
          menuPos &&
          createPortal(
            <SnapMenu
              style={{ position: "fixed", top: menuPos.top, left: menuPos.left }}
              onPick={(zone) => {
                onSnap(zone);
                setMenuOpen(false);
              }}
              onOpenFull={() => {
                setMenuOpen(false);
                onOpenFull();
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
      <div className={`tile-body ${agent ? "tile-body-live" : ""}${isTerminalKey(sessionId) || isServiceKey(sessionId) || isArtifactKey(sessionId) || isDrawingKey(sessionId) || isNoteKey(sessionId) ? " tile-body-live tile-body-term" : ""}`} ref={body}>
        <SessionPanelContent
          id={sessionId}
          agent={agent}
          settings={settings}
          onSettings={onSettings}
          onClose={onClose}
          scrollRef={body}
          jumpVariant="compact"
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
