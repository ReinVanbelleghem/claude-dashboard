/**
 * Lane layout for a commit graph, the way VS Code's Git Graph and GitKraken draw it.
 * Pure: no React, no DOM, so it can be unit tested on fixtures.
 *
 * Input is commits newest first in date order (every child above its parents),
 * which is what `git log --date-order` gives. Each commit gets a lane (column), and
 * each gap between two rows gets the segments that cross it.
 *
 * The rules, top to bottom:
 *  - A commit takes the leftmost lane that is waiting for it; a branch tip nobody is
 *    waiting for takes the lowest free lane.
 *  - Any other lane waiting for the same commit bends into it there and is freed
 *    (a "branch-out": that branch forked off at this commit).
 *  - The first parent inherits the commit's lane, so a branch stays straight.
 *  - Every further parent joins a lane already waiting for it, or opens the lowest
 *    free lane (a "merge-in": the merged branch arrives here).
 *  - Lanes are never compacted, only reused once free. Compacting shifts every
 *    lane to the right of a gap sideways, which is what makes graphs unreadable.
 *  - A parent beyond the limit keeps its lane open to the bottom; the last row's
 *    segments are flagged `open` so the renderer can fade them out.
 */

export type LayoutCommit = { hash: string; parents: string[] };

/**
 * straight:   lane continues in the same column.
 * merge-in:   leaves this row's commit and lands in another column below
 *             (a merge's second parent, or a first parent already owned elsewhere).
 * branch-out: leaves another column and lands on the next row's commit
 *             (the branch above forked from that commit).
 */
export type EdgeKind = "straight" | "merge-in" | "branch-out";

export type Edge = {
  /** Column at this row. */
  from: number;
  /** Column at the next row. */
  to: number;
  kind: EdgeKind;
  /** Colour slot, `0..colors-1`. Stable per lane: it is the lane index modulo the palette. */
  color: number;
  /** Only on the last row: the lane continues past the rows we have. */
  open?: boolean;
};

export type LayoutRow = {
  /** Column of this row's commit. */
  lane: number;
  color: number;
  /** Segments between this row and the next one. */
  edges: Edge[];
  /** Columns this row draws into (its node, the segments above and below it). */
  width: number;
  merge: boolean;
};

export type Layout = {
  rows: LayoutRow[];
  /** Widest row, in lanes. */
  lanes: number;
};

export function layoutGraph(commits: LayoutCommit[], opts: { colors?: number } = {}): Layout {
  const colors = Math.max(1, opts.colors ?? 8);
  const colorOf = (lane: number) => lane % colors;

  /** What each lane is waiting for below the current row; null is a free lane. */
  const lanes: (string | null)[] = [];
  /** Per lane, the columns at the row above that feed it (itself, or a commit node). */
  let sources: number[][] = [];
  const rows: LayoutRow[] = [];

  const firstFree = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };

  /** Segments from the previous row into the row whose commit sits at `lane`. */
  const crossing = (hash: string | null, lane: number, open: boolean): Edge[] => {
    const edges: Edge[] = [];
    for (let j = 0; j < lanes.length; j++) {
      if (lanes[j] === null) continue;
      const to = hash !== null && lanes[j] === hash ? lane : j;
      for (const from of sources[j] ?? [j]) {
        // A source other than the lane itself is the commit above feeding this lane.
        const kind: EdgeKind = from === to ? "straight" : from !== j ? "merge-in" : "branch-out";
        edges.push(open ? { from, to, kind, color: colorOf(j), open } : { from, to, kind, color: colorOf(j) });
      }
    }
    return edges;
  };

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    let lane = lanes.indexOf(c.hash);
    if (lane === -1) lane = firstFree();

    if (i > 0) rows[i - 1].edges = crossing(c.hash, lane, false);

    // Every lane starts the next gap fed by itself, unless the commit says otherwise.
    sources = lanes.map((_, j) => [j]);
    for (let j = 0; j < lanes.length; j++) if (lanes[j] === c.hash) lanes[j] = null;

    const [first, ...rest] = c.parents;
    while (lanes.length <= lane) lanes.push(null);
    lanes[lane] = first ?? null;
    sources[lane] = [lane];

    for (const p of rest) {
      if (p === first) continue;
      const k = lanes.indexOf(p);
      if (k !== -1) {
        sources[k] = [...(sources[k] ?? [k]), lane];
      } else {
        const n = firstFree();
        while (lanes.length <= n) lanes.push(null);
        lanes[n] = p;
        sources[n] = [lane];
      }
    }

    // A freed lane at the right edge is gone, not a gap to draw around.
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    sources.length = lanes.length;

    rows.push({ lane, color: colorOf(lane), edges: [], width: 0, merge: c.parents.length > 1 });
  }

  // Whatever is still waiting after the last row lives beyond the limit.
  if (rows.length) {
    const last = rows[rows.length - 1];
    last.edges = crossing(null, -1, true);
  }

  let widest = 0;
  for (let i = 0; i < rows.length; i++) {
    let w = rows[i].lane;
    for (const e of rows[i].edges) w = Math.max(w, e.from, e.to);
    if (i > 0) for (const e of rows[i - 1].edges) w = Math.max(w, e.to);
    rows[i].width = w + 1;
    widest = Math.max(widest, w + 1);
  }

  return { rows, lanes: widest };
}
