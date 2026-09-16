/**
 * Geometry and persistence for the floating session "tiles" — the
 * OS-window-like alternative to the drawer and the full page. Kept free of
 * React so the drag/resize/snap math is plain, testable arithmetic rather
 * than something tangled up in event handlers.
 */

export type TileRect = { x: number; y: number; w: number; h: number };
export type TileState = {
  id: string;
  rect: TileRect;
  z: number;
  minimized?: boolean;
  // Two independent reasons a tile can be sitting minimized without the user
  // having clicked its yellow light: the ⌘⇧M "show desktop" chord, and
  // navigating away from the Desktop tab. Each is tagged separately (rather
  // than one shared flag, or a list of ids kept elsewhere) so restoring one
  // mechanism's set can never step on, or get confused with, the other's —
  // and so re-tagging on a later hide always adds to the set instead of
  // overwriting it, since the flag lives with the tile it describes.
  hiddenByShortcut?: boolean;
  hiddenByTab?: boolean;
};

const TILES_KEY = "dashboard-tiles";
export const TILE_MIN_WIDTH = 360;
export const TILE_MIN_HEIGHT = 260;
const CASCADE_STEP = 32;
const CASCADE_SLOTS = 8;

/** Room reserved at the bottom of the viewport for the floating dock pill —
 * a snapped tile stops just above it rather than sliding underneath. */
const DOCK_CLEARANCE = 72;

/** The mime type a session card's native drag carries its id in. */
export const SESSION_DRAG_MIME = "application/x-claude-session";

/**
 * The one honest way to put a session on a different monitor: a tile is a
 * `<div>` inside this tab, so no amount of drag math lets it cross onto a
 * second screen. A real, separate browser window can — this is the browser
 * doing the placement, not us. The window name is stable per session, so
 * popping the same one out twice re-focuses the existing window instead of
 * spawning a duplicate.
 */
export function popOutSession(id: string) {
  const url = `${window.location.pathname}${window.location.search}#/session/${encodeURIComponent(id)}`;
  window.open(url, `claude-dashboard-session-${id}`, "width=760,height=920,noopener");
}

function viewport() {
  return { w: window.innerWidth, h: window.innerHeight };
}

/**
 * Keeps a tile mostly reachable rather than strictly on screen: a saved
 * position from a bigger monitor, or a window shrunk after the fact, should
 * leave enough of the tile showing to grab and drag back rather than
 * stranding it entirely off-screen with no way to find it again.
 */
export function clampRect(rect: TileRect): TileRect {
  const { w: vw, h: vh } = viewport();
  const w = Math.min(Math.max(rect.w, TILE_MIN_WIDTH), Math.max(vw, TILE_MIN_WIDTH));
  const h = Math.min(Math.max(rect.h, TILE_MIN_HEIGHT), Math.max(vh, TILE_MIN_HEIGHT));
  const minVisible = 120;
  const x = Math.min(Math.max(rect.x, minVisible - w), Math.max(minVisible - w, vw - minVisible));
  const y = Math.min(Math.max(rect.y, 0), Math.max(0, vh - minVisible));
  return { x, y, w, h };
}

/** A fresh tile's starting spot: cascaded so opening several in a row doesn't stack them exactly on top of each other. */
export function defaultRect(index: number): TileRect {
  const { w: vw, h: vh } = viewport();
  const w = Math.round(Math.min(640, vw * 0.55));
  const h = Math.round(Math.min(620, vh * 0.8));
  const slot = index % CASCADE_SLOTS;
  const x = Math.round(vw * 0.08) + slot * CASCADE_STEP;
  const y = Math.round(vh * 0.06) + slot * CASCADE_STEP;
  return clampRect({ x, y, w, h });
}

export function readTiles(): TileState[] {
  try {
    const raw = localStorage.getItem(TILES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (t): t is TileState =>
          !!t && typeof t.id === "string" && typeof t.z === "number" && t.rect,
      )
      .map((t) => ({ ...t, rect: clampRect(t.rect) }));
  } catch {
    return [];
  }
}

export function writeTiles(tiles: TileState[]) {
  try {
    localStorage.setItem(TILES_KEY, JSON.stringify(tiles));
  } catch {
    // Storage full or unavailable — tiles just won't survive a reload.
  }
}

const DOCK_ORDER_KEY = "dashboard-dock-order";

/** The dock's left-to-right order: fixed at opening time (new entries land on
 * the right) rather than drifting with whichever session is most recently
 * active, and overridable by dragging a chip. Persisted so a reload doesn't
 * shuffle it back to whatever order the live list happens to report in. */
export function readDockOrder(): string[] {
  try {
    const raw = localStorage.getItem(DOCK_ORDER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

export function writeDockOrder(order: string[]) {
  try {
    localStorage.setItem(DOCK_ORDER_KEY, JSON.stringify(order));
  } catch {
    // Storage full or unavailable — the dock just re-derives a default order.
  }
}

/** The mime type a dock chip's own drag carries its id in, for reordering. */
export const DOCK_DRAG_MIME = "application/x-claude-dock-order";

export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** Applies a corner/edge drag to a starting rect, anchoring the opposite edge. */
export function resizeRect(start: TileRect, dir: ResizeDir, dx: number, dy: number): TileRect {
  let { x, y, w, h } = start;
  if (dir.includes("e")) w = Math.max(TILE_MIN_WIDTH, start.w + dx);
  if (dir.includes("s")) h = Math.max(TILE_MIN_HEIGHT, start.h + dy);
  if (dir.includes("w")) {
    w = Math.max(TILE_MIN_WIDTH, start.w - dx);
    x = start.x + (start.w - w);
  }
  if (dir.includes("n")) {
    h = Math.max(TILE_MIN_HEIGHT, start.h - dy);
    y = start.y + (start.h - h);
  }
  const { w: vw, h: vh } = viewport();
  w = Math.min(w, vw);
  h = Math.min(h, vh);
  if (dir.includes("n")) y = Math.max(0, y);
  return { x, y, w, h };
}

/** How close a dragged edge has to land next to a neighbor's before it snaps
 * to it exactly, in screen pixels. Loose enough to catch a "roughly lined
 * up" drag, tight enough that closing in on a target rect for its own sake
 * (not near anyone else's edge) doesn't fight you. */
export const EDGE_SNAP_THRESHOLD = 8;

/** True where [aStart, aEnd) and [bStart, bEnd) share any span at all —
 * "these two tiles are at least partly side by side," the condition for one
 * tile's edge to be a meaningful alignment target for the other's. Without
 * it, resizing one tile's right edge could snap to some unrelated tile's
 * left edge two screens away just because the x values happened to match. */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** The candidate value closest to `value`, if any lands within `threshold` — otherwise `value` itself, unsnapped. */
function nearest(value: number, candidates: number[], threshold: number): number {
  let best = value;
  let bestDist = threshold;
  for (const c of candidates) {
    const dist = Math.abs(c - value);
    if (dist <= bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return best;
}

/**
 * Edge-to-edge magnetism: nudges whichever edge `dir` just dragged to line
 * up exactly with a neighboring tile's edge, the same "snap assist" feel as
 * the screen-edge/thirds grid in `snapZoneAt`, just against other tiles
 * instead of the screen. Takes an already-`resizeRect`'d rect and only
 * further adjusts the edge `dir` moved: `resizeRect` already anchored the
 * opposite edge, so preserving that anchor here is what keeps a snap from
 * also silently resizing the fixed side.
 */
export function applyEdgeMagnetism(
  rect: TileRect,
  dir: ResizeDir,
  neighbors: TileRect[],
  threshold = EDGE_SNAP_THRESHOLD,
): TileRect {
  // Overlap eligibility is checked against the rect as it came in, not as
  // this function reshapes it: a corner drag (say "nw") snapping x flush
  // against a neighbor first would otherwise leave x and that neighbor's
  // edge merely touching rather than overlapping by the time the y check
  // runs — failing `overlaps` on a technicality and silently dropping the
  // second axis's snap.
  const { x: x0, y: y0, w: w0, h: h0 } = rect;
  let { x, y, w, h } = rect;

  if (dir.includes("e") || dir.includes("w")) {
    const xCandidates: number[] = [];
    for (const n of neighbors) {
      if (overlaps(y0, y0 + h0, n.y, n.y + n.h)) xCandidates.push(n.x, n.x + n.w);
    }
    if (dir.includes("e")) {
      const right = nearest(x + w, xCandidates, threshold);
      w = Math.max(TILE_MIN_WIDTH, right - x);
    } else if (dir.includes("w")) {
      const left = nearest(x, xCandidates, threshold);
      w = Math.max(TILE_MIN_WIDTH, w + (x - left));
      x = left;
    }
  }

  if (dir.includes("n") || dir.includes("s")) {
    const yCandidates: number[] = [];
    for (const n of neighbors) {
      if (overlaps(x0, x0 + w0, n.x, n.x + n.w)) yCandidates.push(n.y, n.y + n.h);
    }
    if (dir.includes("s")) {
      const bottom = nearest(y + h, yCandidates, threshold);
      h = Math.max(TILE_MIN_HEIGHT, bottom - y);
    } else if (dir.includes("n")) {
      const top = nearest(y, yCandidates, threshold);
      h = Math.max(TILE_MIN_HEIGHT, h + (y - top));
      y = top;
    }
  }

  return { x, y, w, h };
}

export type SnapZone =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "left-third"
  | "center-third"
  | "right-third"
  | "ninth-top-left"
  | "ninth-top"
  | "ninth-top-right"
  | "ninth-middle-left"
  | "ninth-middle"
  | "ninth-middle-right"
  | "ninth-bottom-left"
  | "ninth-bottom"
  | "ninth-bottom-right"
  | "maximize";

const EDGE_MARGIN = 28;

/** What a drag would snap to if released with the pointer at (x, y) — or null for a free drop. */
export function snapZoneAt(x: number, y: number): SnapZone | null {
  const { w: vw, h: vh } = viewport();
  if (y < 6) return "maximize";
  const nearLeft = x < EDGE_MARGIN;
  const nearRight = x > vw - EDGE_MARGIN;
  if (!nearLeft && !nearRight) return null;
  const upper = y < vh * 0.35;
  const lower = y > vh * 0.65;
  if (nearLeft) return upper ? "top-left" : lower ? "bottom-left" : "left";
  return upper ? "top-right" : lower ? "bottom-right" : "right";
}

/** Breathing room between a snapped tile and the screen edges (or the dock,
 * on the bottom), and equally between two tiles sharing a snapped seam —
 * snapped tiles used to butt right up against both. */
const SNAP_EDGE_GAP = 5;

/** `count` equal segments spanning [start, end], with one `gap` between each
 * pair of neighbors (not at the outer edges — those are the caller's `start`
 * and `end`). Shared by every snap zone that's more than one column or row
 * wide, so halves, thirds and ninths all size and space themselves the same
 * way instead of three separate hand-rolled formulas. */
function splitAxis(start: number, end: number, count: number, gap: number): { pos: number; size: number }[] {
  const size = Math.round((end - start - gap * (count - 1)) / count);
  return Array.from({ length: count }, (_, i) => ({ pos: start + i * (size + gap), size }));
}

export function rectForZone(zone: SnapZone): TileRect {
  const { w: vw, h: vh } = viewport();
  const usableH = Math.max(TILE_MIN_HEIGHT, vh - DOCK_CLEARANCE);
  const x0 = SNAP_EDGE_GAP;
  const y0 = SNAP_EDGE_GAP;
  const x1 = vw - SNAP_EDGE_GAP;
  const y1 = usableH - SNAP_EDGE_GAP;
  const areaW = x1 - x0;
  const areaH = y1 - y0;
  const [colHalf0, colHalf1] = splitAxis(x0, x1, 2, SNAP_EDGE_GAP);
  const [rowHalf0, rowHalf1] = splitAxis(y0, y1, 2, SNAP_EDGE_GAP);
  const [colThird0, colThird1, colThird2] = splitAxis(x0, x1, 3, SNAP_EDGE_GAP);
  const [rowThird0, rowThird1, rowThird2] = splitAxis(y0, y1, 3, SNAP_EDGE_GAP);
  switch (zone) {
    case "maximize":
      return { x: x0, y: y0, w: areaW, h: areaH };
    case "left":
      return { x: colHalf0.pos, y: y0, w: colHalf0.size, h: areaH };
    case "right":
      return { x: colHalf1.pos, y: y0, w: colHalf1.size, h: areaH };
    case "top":
      return { x: x0, y: rowHalf0.pos, w: areaW, h: rowHalf0.size };
    case "bottom":
      return { x: x0, y: rowHalf1.pos, w: areaW, h: rowHalf1.size };
    case "top-left":
      return { x: colHalf0.pos, y: rowHalf0.pos, w: colHalf0.size, h: rowHalf0.size };
    case "top-right":
      return { x: colHalf1.pos, y: rowHalf0.pos, w: colHalf1.size, h: rowHalf0.size };
    case "bottom-left":
      return { x: colHalf0.pos, y: rowHalf1.pos, w: colHalf0.size, h: rowHalf1.size };
    case "bottom-right":
      return { x: colHalf1.pos, y: rowHalf1.pos, w: colHalf1.size, h: rowHalf1.size };
    case "left-third":
      return { x: colThird0.pos, y: y0, w: colThird0.size, h: areaH };
    case "center-third":
      return { x: colThird1.pos, y: y0, w: colThird1.size, h: areaH };
    case "right-third":
      return { x: colThird2.pos, y: y0, w: colThird2.size, h: areaH };
    case "ninth-top-left":
      return { x: colThird0.pos, y: rowThird0.pos, w: colThird0.size, h: rowThird0.size };
    case "ninth-top":
      return { x: colThird1.pos, y: rowThird0.pos, w: colThird1.size, h: rowThird0.size };
    case "ninth-top-right":
      return { x: colThird2.pos, y: rowThird0.pos, w: colThird2.size, h: rowThird0.size };
    case "ninth-middle-left":
      return { x: colThird0.pos, y: rowThird1.pos, w: colThird0.size, h: rowThird1.size };
    case "ninth-middle":
      return { x: colThird1.pos, y: rowThird1.pos, w: colThird1.size, h: rowThird1.size };
    case "ninth-middle-right":
      return { x: colThird2.pos, y: rowThird1.pos, w: colThird2.size, h: rowThird1.size };
    case "ninth-bottom-left":
      return { x: colThird0.pos, y: rowThird2.pos, w: colThird0.size, h: rowThird2.size };
    case "ninth-bottom":
      return { x: colThird1.pos, y: rowThird2.pos, w: colThird1.size, h: rowThird2.size };
    case "ninth-bottom-right":
      return { x: colThird2.pos, y: rowThird2.pos, w: colThird2.size, h: rowThird2.size };
  }
}

/** The frontmost tile whose rect contains the point, for "dropped onto" detection. */
export function hitTestTile(tiles: TileState[], point: { x: number; y: number }): TileState | null {
  let best: TileState | null = null;
  for (const t of tiles) {
    const { x, y, w, h } = t.rect;
    if (point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h) {
      if (!best || t.z > best.z) best = t;
    }
  }
  return best;
}
