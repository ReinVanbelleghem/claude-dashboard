import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { gitApi, type GitGraph as GraphData, type GraphCommit } from "../api.ts";
import { layoutGraph, type Edge, type LayoutRow } from "../gitGraphLayout.ts";
import { DiffView, parsePatch, type FilePatch } from "./DiffView.tsx";
import { watchStatus } from "./useGitRepo.ts";

/**
 * The commit graph for the Git tab: lanes on the left, one dense line of text per
 * commit on the right. Each row draws its own slice of the graph (the lower half of
 * the gap above it and the upper half of the gap below), so rows can be expanded
 * inline without the drawing coming apart, and an off-screen row costs nothing.
 */

const ROW_H = 24;
const MID = ROW_H / 2;
/** Lane colours cycle through this many CSS classes (gg-c0…). */
const COLORS = 6;
const LIMIT = 300;

type Props = {
  cwd: string;
  /** Read the history from somewhere other than a checkout; the branch switch is then hidden. */
  load?: () => Promise<GraphData>;
  /** The commit shown elsewhere on the page. */
  selected?: string | null;
  /** Commits that are context rather than the subject, drawn faded. */
  faded?: (hash: string) => boolean;
  onOpenCommit?: (hash: string) => void;
  /** Show only the history of this branch (picked in the worktree list). */
  branch?: string | null;
  onClearBranch?: () => void;
  /** A branch hovered in the worktree list: its rows light up. */
  hoverBranch?: string | null;
  /** Hovering a worktree branch's pill here lights its worktree row. */
  onHoverBranch?: (branch: string | null) => void;
};

export function GitGraph({ cwd, load, selected = null, faded, onOpenCommit, branch = null, onClearBranch, hoverBranch = null, onHoverBranch }: Props) {
  const [all, setAll] = useState(false);
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [width, setWidth] = useState(380);
  const [filter, setFilter] = useState("");
  const [card, setCard] = useState<{ commit: GraphCommit; x: number; y: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (loadRef.current ? loadRef.current() : gitApi.graph(cwd, { limit: LIMIT, all }))
      .then((r) => {
        if (!alive) return;
        setData(r);
        setError(r.ok ? null : r.error || "Could not read the history.");
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [cwd, all, nonce]);

  // A commit, checkout or fetch anywhere on the page changes what this shows.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = watchStatus(() => {
      if (t) clearTimeout(t);
      t = setTimeout(() => setNonce((n) => n + 1), 400);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, []);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const allCommits = data?.commits ?? [];
  /** A branch filter keeps what its tip can reach, laid out again on its own. */
  const commits = useMemo(() => {
    if (!branch) return allCommits;
    const tip = allCommits.find((c) => c.refs.branches.includes(branch));
    if (!tip) return allCommits;
    const by = new Map(allCommits.map((c) => [c.hash, c] as const));
    const keep = new Set<string>();
    const stack = [tip.hash];
    while (stack.length) {
      const h = stack.pop()!;
      if (keep.has(h)) continue;
      const c = by.get(h);
      if (!c) continue;
      keep.add(h);
      stack.push(...c.parents);
    }
    return allCommits.filter((c) => keep.has(c.hash));
  }, [allCommits, branch]);
  const layout = useMemo(() => layoutGraph(commits, { colors: COLORS }), [commits]);
  /** One author: no marker at all. Several: each commit dot is tinted by its author. */
  const authorTint = useMemo(() => {
    const names = [...new Set(commits.map((c) => c.author))];
    return names.length > 1 ? new Map(names.map((n, i) => [n, i % 4])) : null;
  }, [commits]);
  /** Subject, author or a hash prefix; rows that do not match dim, so the lanes stay whole. */
  const needle = filter.trim().toLowerCase();
  const matches = (c: GraphCommit) =>
    !needle || c.hash.startsWith(needle) || c.subject.toLowerCase().includes(needle) || c.author.toLowerCase().includes(needle);
  useEffect(() => {
    if (!needle) return;
    const first = commits.find(matches);
    if (first) bodyRef.current?.querySelector(`[data-hash="${first.hash}"]`)?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle, commits]);

  /**
   * The lane column gets at most ~30% of the panel. Many lanes squeeze the pitch
   * (down to 8px) before anything is clipped, so the subject never disappears.
   */
  const { laneW, graphW } = useMemo(() => {
    const max = Math.max(48, Math.min(180, width * 0.3));
    const lanes = Math.max(1, layout.lanes);
    const w = Math.max(8, Math.min(14, (max - 8) / lanes));
    return { laneW: w, graphW: Math.ceil(Math.min(max, lanes * w + 8)) };
  }, [width, layout.lanes]);

  /** Branches checked out in some other worktree, keyed to that worktree's path. */
  const elsewhere = useMemo(() => {
    const m = new Map<string, string>();
    const here = data?.branch ?? null;
    for (const w of data?.worktrees ?? []) if (w.branch && w.branch !== here) m.set(w.branch, w.path);
    return m;
  }, [data]);

  const toggle = useCallback(
    (hash: string) => {
      if (onOpenCommit) onOpenCommit(hash);
      else setOpen((o) => (o === hash ? null : hash));
    },
    [onOpenCommit],
  );

  return (
    <div className="gg">
      <div className="gg-head">
        {branch ? (
          <span className="gg-branch-filter" title={`Showing the history of ${branch}`}>
            <WorktreeGlyph />
            <span className="gg-branch-name">{branch}</span>
            <button type="button" aria-label="Show every branch" title="Show every branch" onClick={onClearBranch}>
              ×
            </button>
          </span>
        ) : load ? null : (
        <div className="seg" role="group" aria-label="Which history">
          <button type="button" className={all ? "active" : ""} aria-pressed={all} onClick={() => setAll(true)}>
            All branches
          </button>
          <button type="button" className={!all ? "active" : ""} aria-pressed={!all} onClick={() => setAll(false)}>
            Current branch
          </button>
        </div>
        )}
        <span className="gg-count">
          {data?.ok ? `${commits.length}${allCommits.length >= LIMIT ? "+" : ""}` : ""}
        </span>
        <button
          type="button"
          className={`gg-icon${loading ? " spin" : ""}`}
          title="Refresh"
          aria-label="Refresh"
          onClick={() => setNonce((n) => n + 1)}
        >
          <RefreshGlyph />
        </button>
        <input
          className="search gg-filter"
          value={filter}
          placeholder="Filter by subject, author or hash"
          aria-label="Filter commits by subject, author or hash"
          spellCheck={false}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setFilter("");
          }}
        />
      </div>

      <div className="gg-body" ref={bodyRef}>
        {error ? (
          <div className="gg-state">
            <div className="gg-state-title">Could not load history</div>
            <div className="gg-state-detail">{error}</div>
            <button type="button" className="gg-btn" onClick={() => setNonce((n) => n + 1)}>
              Retry
            </button>
          </div>
        ) : !data ? (
          <div className="gg-state">{loading ? "Loading history…" : ""}</div>
        ) : commits.length === 0 ? (
          <div className="gg-state">
            <div className="gg-state-title">No commits yet</div>
            <div className="gg-state-detail">The first commit will show up here.</div>
          </div>
        ) : (
          <div className="gg-list" role="list">
            {commits.map((c, i) => (
              <GraphRow
                key={c.hash}
                commit={c}
                row={layout.rows[i]}
                above={i > 0 ? layout.rows[i - 1].edges : null}
                laneW={laneW}
                graphW={graphW}
                isHead={c.hash === data.head}
                current={data.branch}
                elsewhere={elsewhere}
                expanded={open === c.hash || selected === c.hash}
                onToggle={toggle}
                cwd={cwd}
                dim={!matches(c)}
                context={faded?.(c.hash) ?? false}
                lit={!!hoverBranch && c.refs.branches.includes(hoverBranch)}
                onHoverBranch={onHoverBranch}
                tint={authorTint?.get(c.author) ?? null}
                showHash={width >= 480}
                onHover={(commit, x, y) => setCard(commit ? { commit, x, y } : null)}
              />
            ))}
            {commits.length >= LIMIT && (
              <div className="gg-more" style={{ paddingLeft: graphW }}>
                Showing the newest {LIMIT} commits
              </div>
            )}
          </div>
        )}
      </div>
      {/* Portalled: .gg is a size container, which would anchor a fixed box to itself. */}
      {card && createPortal(
        <div className="gg-card" role="tooltip" style={{ left: Math.min(card.x, window.innerWidth - 340), top: Math.min(card.y, window.innerHeight - 140) }}>
          <div className="gg-card-hash">{card.commit.hash}</div>
          <div className="gg-card-msg">{card.commit.subject}</div>
          <div className="gg-card-meta">
            {card.commit.author} · {new Date(card.commit.at * 1000).toLocaleString()}
          </div>
          <div className="gg-card-keys">⌘C short hash · ⇧⌘C full hash</div>
        </div>,
        document.body,
      )}
    </div>
  );
}

let hoverTimer: ReturnType<typeof setTimeout> | null = null;

// ── one row ──────────────────────────────────────────────────────────────────

type RowProps = {
  commit: GraphCommit;
  row: LayoutRow;
  above: Edge[] | null;
  laneW: number;
  graphW: number;
  isHead: boolean;
  current: string | null;
  elsewhere: Map<string, string>;
  expanded: boolean;
  onToggle: (hash: string) => void;
  cwd: string;
  /** Not matching the filter. */
  dim: boolean;
  /** Shown for orientation only: not part of what is being reviewed. */
  context: boolean;
  /** Its branch is hovered in the worktree list. */
  lit: boolean;
  onHoverBranch?: (branch: string | null) => void;
  /** Author tint for the commit dot, when the history has more than one author. */
  tint: number | null;
  showHash: boolean;
  onHover: (commit: GraphCommit | null, x: number, y: number) => void;
};

const GraphRow = memo(function GraphRow(p: RowProps) {
  const { commit: c, row } = p;
  const x = (lane: number) => 4 + lane * p.laneW + p.laneW / 2;

  return (
    <div className={`gg-item${p.expanded ? " open" : ""}${p.dim ? " dim" : ""}${p.context ? " context" : ""}${p.lit ? " lit" : ""}`} role="listitem" data-hash={c.hash}>
      <div
        className="gg-row"
        role="button"
        tabIndex={0}
        aria-expanded={p.expanded}
        aria-label={`${c.subject}, ${c.author}, ${c.hash.slice(0, 7)}`}
        onClick={() => p.onToggle(c.hash)}
        onMouseEnter={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          hoverTimer = setTimeout(() => p.onHover(c, r.left + 24, r.bottom + 4), 450);
        }}
        onMouseLeave={() => {
          if (hoverTimer) clearTimeout(hoverTimer);
          p.onHover(null, 0, 0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            p.onToggle(c.hash);
          }
          // ⌘C the short hash, ⇧⌘C the full one.
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && !window.getSelection()?.toString()) {
            e.preventDefault();
            void navigator.clipboard?.writeText(e.shiftKey ? c.hash : c.hash.slice(0, 7));
          }
        }}
      >
        <svg className="gg-lanes" width={p.graphW} height={ROW_H} aria-hidden="true">
          {/* Lower half of the gap above: branch-outs bend into this row's node here. */}
          {p.above?.map((e, k) => {
            const bx = x(e.kind === "branch-out" ? e.from : e.to);
            const tx = x(e.to);
            const d = bx === tx ? `M${tx} 0V${MID}` : `M${bx} 0C${bx} ${MID} ${bx} ${MID} ${tx} ${MID}`;
            return <path key={`a${k}`} d={d} className={`gg-edge gg-c${e.color}`} />;
          })}
          {/* Upper half of the gap below: merge-ins leave this row's node here. */}
          {row.edges.map((e, k) => {
            const fx = x(e.from);
            const bx = x(e.kind === "branch-out" ? e.from : e.to);
            const d = fx === bx ? `M${fx} ${MID}V${ROW_H}` : `M${fx} ${MID}C${bx} ${MID} ${bx} ${MID} ${bx} ${ROW_H}`;
            return <path key={`b${k}`} d={d} className={`gg-edge gg-c${e.color}${e.open ? " open" : ""}`} />;
          })}
          {p.isHead && <circle cx={x(row.lane)} cy={MID} r={6.5} className={`gg-ring gg-c${row.color}`} />}
          <circle
            cx={x(row.lane)}
            cy={MID}
            r={row.merge ? 3 : 4}
            className={`gg-node gg-c${row.color}${p.tint != null ? ` gg-a${p.tint}` : ""}`}
          />
        </svg>
        <Refs commit={c} isHead={p.isHead} current={p.current} elsewhere={p.elsewhere} onHoverBranch={p.onHoverBranch} />
        <span className={`gg-subject${row.merge ? " merge" : ""}`}>{c.subject}</span>
        <span className="gg-time">{shortAgo(c.at)}</span>
        {p.showHash && <span className="gg-hash">{c.hash.slice(0, 7)}</span>}
      </div>
      {p.expanded && p.cwd && <CommitFiles cwd={p.cwd} commit={c} edges={row.edges} x={x} graphW={p.graphW} />}
    </div>
  );
});

/**
 * Pills for what points at this commit. A local branch and its remote on the same
 * commit fold into one pill, which is what keeps a narrow panel readable.
 */
function Refs({
  commit,
  isHead,
  current,
  elsewhere,
  onHoverBranch,
}: {
  commit: GraphCommit;
  isHead: boolean;
  current: string | null;
  elsewhere: Map<string, string>;
  onHoverBranch?: (branch: string | null) => void;
}) {
  const { branches, remotes, tags } = commit.refs;
  if (!branches.length && !remotes.length && !tags.length && !(isHead && !current)) return null;

  const folded = new Set<string>();
  const local = branches
    .slice()
    .sort((a, b) => (a === current ? -1 : b === current ? 1 : 0))
    .map((b) => {
      const tracking = remotes.filter((r) => r.slice(r.indexOf("/") + 1) === b);
      tracking.forEach((r) => folded.add(r));
      return { name: b, remotes: tracking.map((r) => r.slice(0, r.indexOf("/"))) };
    });
  const loose = remotes.filter((r) => !folded.has(r));

  const pills: { key: string; node: ReactNode; label: string }[] = [];
  if (isHead && !current)
    pills.push({
      key: "HEAD",
      label: "HEAD (detached)",
      node: (
        <span className="gg-pill head" title="Detached HEAD">
          HEAD
        </span>
      ),
    });
  for (const b of local) {
    const isCurrent = isHead && b.name === current;
    const wt = elsewhere.get(b.name);
    pills.push({
      key: `b:${b.name}`,
      label: b.name,
      node: (
        <span
          className={`gg-pill branch${isCurrent ? " current" : ""}${wt ? " wt" : ""}`}
          onMouseEnter={wt && onHoverBranch ? () => onHoverBranch(b.name) : undefined}
          onMouseLeave={wt && onHoverBranch ? () => onHoverBranch(null) : undefined}
          title={
            (isCurrent ? `HEAD → ${b.name}` : b.name) +
            (b.remotes.length ? `\nin sync with ${b.remotes.map((r) => `${r}/${b.name}`).join(", ")}` : "") +
            (wt ? `\nchecked out in worktree ${wt}` : "")
          }
        >
          {wt && <WorktreeGlyph />}
          <span className="gg-pill-name">{b.name}</span>
          {b.remotes.length > 0 && <span className="gg-pill-remote">{b.remotes.join(" ")}</span>}
        </span>
      ),
    });
  }
  for (const t of tags)
    pills.push({
      key: `t:${t}`,
      label: `tag ${t}`,
      node: (
        <span className="gg-pill tag" title={`tag ${t}`}>
          <span className="gg-pill-name">{t}</span>
        </span>
      ),
    });
  for (const r of loose)
    pills.push({
      key: `r:${r}`,
      label: r,
      node: (
        <span className="gg-pill remote" title={`remote branch ${r}`}>
          <span className="gg-pill-name">{r}</span>
        </span>
      ),
    });

  // One pill and a count: the subject is what a row is for.
  const shown = pills.slice(0, 1);
  const rest = pills.slice(shown.length);
  return (
    <span className="gg-refs">
      {shown.map((p) => (
        <Fragment key={p.key}>{p.node}</Fragment>
      ))}
      {rest.length > 0 && (
        <span className="gg-pill more" title={rest.map((p) => p.label).join("\n")}>
          +{rest.length}
        </span>
      )}
    </span>
  );
}

// ── inline expansion: the commit's files ────────────────────────────────────

function CommitFiles({
  cwd,
  commit,
  edges,
  x,
  graphW,
}: {
  cwd: string;
  commit: GraphCommit;
  edges: Edge[];
  x: (lane: number) => number;
  graphW: number;
}) {
  const [files, setFiles] = useState<FilePatch[] | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actError, setActError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  useEffect(() => {
    let alive = true;
    gitApi
      .commit(cwd, commit.hash)
      .then((r) => {
        if (!alive) return;
        if (!r.ok) setError(r.error || "Could not read this commit.");
        else {
          setPatch(r.patch);
          setFiles(parsePatch(r.patch));
        }
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [cwd, commit.hash]);

  // The lanes keep running past the expansion, at the column they bend at.
  const through = Array.from(new Set(edges.map((e) => `${e.kind === "branch-out" ? e.from : e.to}:${e.color}`)));
  const shown = files?.slice(0, 40) ?? [];

  return (
    <div className="gg-detail">
      <svg className="gg-lanes fill" width={graphW} aria-hidden="true" preserveAspectRatio="none">
        {through.map((k) => {
          const [lane, color] = k.split(":").map(Number);
          return <line key={k} x1={x(lane)} x2={x(lane)} y1="0" y2="100%" className={`gg-edge gg-c${color}`} />;
        })}
      </svg>
      <div className="gg-detail-body" style={{ marginLeft: graphW }}>
        <div className="gg-detail-meta">
          <span className="gg-mono">{commit.hash.slice(0, 12)}</span>
          <span>{commit.author}</span>
          <span>{new Date(commit.at * 1000).toLocaleString()}</span>
          {commit.parents.length > 1 && <span>merge of {commit.parents.length}</span>}
        </div>
        <div className="gg-detail-acts">
          <button type="button" className="gg-btn" onClick={() => void navigator.clipboard?.writeText(commit.hash)}>
            Copy
          </button>
          <button
            type="button"
            className="gg-btn"
            title="Check out this commit (detached HEAD)"
            onClick={() => {
              setActError(null);
              void gitApi
                .checkout(cwd, commit.hash)
                .then((r) => {
                  if (!r.ok) setActError(r.error || "Checkout refused");
                })
                .catch((e: unknown) => setActError(e instanceof Error ? e.message : String(e)));
            }}
          >
            Checkout
          </button>
          <button type="button" className="gg-btn" aria-pressed={showDiff} onClick={() => setShowDiff((d) => !d)}>
            {showDiff ? "Hide diff" : "Open diff"}
          </button>
          {actError && <span className="gg-detail-error">{actError}</span>}
        </div>
        {showDiff && patch != null && (
          <div className="gg-diff">
            <DiffView patch={patch} mode="unified" />
          </div>
        )}
        {error ? (
          <div className="gg-detail-error">{error}</div>
        ) : !files ? (
          <div className="gg-detail-muted">Loading files…</div>
        ) : files.length === 0 ? (
          <div className="gg-detail-muted">
            {commit.parents.length > 1 ? "No changes beyond the merged parents." : "No file changes."}
          </div>
        ) : (
          <ul className="gg-files">
            {shown.map((f) => (
              <li key={f.path} title={f.from && f.from !== f.path ? `${f.from} → ${f.path}` : f.path}>
                <span className="gg-file">
                  <span className="gg-file-ltr">
                    <span className="gg-file-dir">{dirOf(f.path)}</span>
                    {baseOf(f.path)}
                  </span>
                </span>
                {f.binary ? (
                  <span className="gg-detail-muted">bin</span>
                ) : (
                  <span className="gg-stat">
                    {f.insertions > 0 && <span className="add">+{f.insertions}</span>}
                    {f.deletions > 0 && <span className="del">−{f.deletions}</span>}
                  </span>
                )}
              </li>
            ))}
            {files.length > shown.length && (
              <li className="gg-detail-muted">and {files.length - shown.length} more</li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── small helpers ────────────────────────────────────────────────────────────


/** "now", "5m", "3h", "2d", "4w", "3mo", "2y": the column is four characters wide. */
function shortAgo(atSec: number): string {
  const s = Math.max(0, Date.now() / 1000 - atSec);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 86_400 * 14) return `${Math.floor(s / 86_400)}d`;
  if (s < 86_400 * 60) return `${Math.floor(s / (86_400 * 7))}w`;
  if (s < 86_400 * 365) return `${Math.floor(s / (86_400 * 30))}mo`;
  return `${Math.floor(s / (86_400 * 365))}y`;
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

function RefreshGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

function WorktreeGlyph() {
  return (
    <svg className="gg-wt" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-label="worktree">
      <circle cx="12" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
      <path d="M12 12v3" />
    </svg>
  );
}
