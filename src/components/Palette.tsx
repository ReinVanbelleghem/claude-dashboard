import { useEffect, useMemo, useRef, useState } from "react";
import { api, fmtAgo, shortPath, type AgentSummary, type Overview, type SessionRow } from "../api.ts";
import { ACCENTS, type Appearance } from "../appearance.ts";

/**
 * ⌘K. One box over everything: jump to a live session, a past one, a project, a
 * tab, or run a command.
 *
 * Two result sources, deliberately different. What the dashboard already holds
 * in memory (live sessions, recent sessions, projects, commands) filters locally
 * and answers on every keystroke; a full-text search of past sessions comes from
 * the daemon's index, which is a fetch, so it is debounced and merged in when it
 * lands. Typing never waits on the network.
 */

type Group = "Commands" | "Live" | "Sessions" | "Projects";
type Tab = "live" | "history" | "worktrees" | "usage" | "settings";

export type PaletteItem = {
  id: string;
  /** What is matched against, lowercased once at build time. */
  haystack: string;
  group: Group;
  /** Leading glyph. A group is a heading you scroll past; the glyph travels with the row. */
  icon: string;
  label: string;
  hint?: string;
  /** Trailing column: an age, a status, a count. */
  meta?: string;
  /** Status class for the dot on session rows, matching the card pills. */
  state?: "busy" | "attention" | "idle" | "dead";
  /**
   * Ranked above equally-good matches. Live sessions beat a stale transcript with
   * the same name, and the empty state should open with what you are working on.
   */
  boost?: number;
  /** Kept out of the no-query list: long tails (every accent, every project). */
  deep?: boolean;
  /** True when ⌘↵ means something different from ↵ for this row. */
  canFull?: boolean;
  run: (opts?: { full?: boolean }) => void;
};

/**
 * Every term has to appear, and where it appears decides the score: a match at the
 * start of the label beats one at a word boundary, which beats one buried mid-word.
 * Substring-only matching with no ranking meant "set" put "Accent: sunset" above
 * "Go to settings".
 */
function score(item: PaletteItem, parts: string[]): number {
  // A quarter of the boost, not all of it: the full weight is what orders the
  // no-query list, and at full weight a blocked session outranked an exact prefix
  // match on the name you actually typed.
  let total = (item.boost ?? 0) / 4;
  for (const p of parts) {
    const at = item.haystack.indexOf(p);
    if (at < 0) return -1;
    const before = at === 0 ? " " : item.haystack[at - 1];
    total += at === 0 ? 14 : /[\s/:·-]/.test(before) ? 9 : 3;
    total += Math.max(0, 5 - Math.floor(at / 10));
  }
  return total;
}

const STATE_OF: Record<string, PaletteItem["state"]> = {
  thinking: "busy",
  starting: "busy",
  "awaiting-permission": "attention",
  idle: "idle",
  ended: "dead",
  error: "dead",
};

const LIMIT = 40;

export function Palette({
  agents,
  projects,
  recent,
  appearance,
  onClose,
  onOpenSession,
  onTab,
  onNewSession,
  onNewIn,
  onManageFolders,
  onFind,
  onAppearance,
}: {
  agents: AgentSummary[];
  projects: Overview["projects"];
  recent: SessionRow[];
  appearance: Appearance;
  onClose: () => void;
  onOpenSession: (id: string, opts?: { full?: boolean }) => void;
  onTab: (tab: Tab) => void;
  onNewSession: () => void;
  onNewIn: (cwd: string) => void;
  onManageFolders: () => void;
  onFind: () => void;
  onAppearance: (patch: Partial<Appearance>) => void;
}) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<SessionRow[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Search is the only thing here that touches the network, so it is the only
  // thing that is debounced — the same 180ms the history view uses.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setFound([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .sessions(term, 8)
        .then((r) => setFound(r.sessions))
        .catch(() => {});
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    const add = (item: Omit<PaletteItem, "haystack">) =>
      out.push({
        ...item,
        haystack: `${item.label} ${item.hint ?? ""} ${item.meta ?? ""}`.toLowerCase(),
      });

    for (const a of agents) {
      const name = a.title ?? a.cwd.split("/").pop() ?? a.key.slice(0, 8);
      const live = a.status !== "ended" && a.status !== "error";
      add({
        id: `live:${a.key}`,
        group: "Live",
        icon: "◆",
        label: name,
        hint: shortPath(a.cwd, 2),
        meta: a.status === "awaiting-permission" ? "needs you" : a.status,
        state: STATE_OF[a.status] ?? "idle",
        // Sessions blocked on you are the reason the dashboard exists, so they sort
        // to the top of the empty state; ended ones sink below past transcripts.
        boost: a.status === "awaiting-permission" ? 60 : live ? 40 : 4,
        canFull: true,
        run: (opts) => onOpenSession(a.sessionId ?? a.key, opts),
      });
    }

    // The recent list is already in memory for the card titles, so the empty state
    // can offer somewhere to go instead of only offering commands.
    const liveIds = new Set(agents.map((a) => a.sessionId).filter(Boolean));
    const seen = new Set<string>();
    for (const s of [...recent.slice(0, 12), ...found]) {
      if (liveIds.has(s.id) || seen.has(s.id)) continue;
      seen.add(s.id);
      add({
        id: `hist:${s.id}`,
        group: "Sessions",
        icon: "▤",
        label: s.title ?? s.id.slice(0, 8),
        hint: shortPath(s.cwd, 2),
        meta: fmtAgo(s.last_ts),
        // Above the command list in the no-query state: where you were is a better
        // default offer than the tab you can already see in the header.
        boost: 24,
        canFull: true,
        run: (opts) => onOpenSession(s.id, opts),
      });
    }

    add({
      id: "cmd:new",
      group: "Commands",
      icon: "＋",
      label: "New session",
      hint: "start one here",
      boost: 20,
      run: onNewSession,
    });
    const TABS: [Tab, string][] = [
      ["live", "your sessions"],
      ["history", "past sessions"],
      ["worktrees", "checkouts"],
      ["usage", "tokens and cost"],
      ["settings", "preferences"],
    ];
    for (const [t, hint] of TABS) {
      add({
        id: `cmd:tab:${t}`,
        group: "Commands",
        icon: "→",
        label: `Go to ${t}`,
        hint,
        boost: 8,
        run: () => onTab(t),
      });
    }
    add({
      id: "cmd:folders",
      group: "Commands",
      icon: "▤",
      label: "Manage working directories",
      hint: "folders",
      run: onManageFolders,
    });
    add({
      id: "cmd:find",
      group: "Commands",
      icon: "⌕",
      label: "Find in page",
      hint: "search this view",
      meta: "⌘F",
      run: onFind,
    });
    add({
      id: "cmd:theme",
      group: "Commands",
      icon: "◐",
      label: appearance.theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      hint: "appearance",
      run: () => onAppearance({ theme: appearance.theme === "dark" ? "light" : "dark" }),
    });
    add({
      id: "cmd:motion",
      group: "Commands",
      icon: "◍",
      label: appearance.motion ? "Stop animating the icon" : "Animate the icon while working",
      hint: "appearance",
      deep: true,
      run: () => onAppearance({ motion: !appearance.motion }),
    });
    for (const c of ACCENTS) {
      add({
        id: `cmd:accent:${c.name}`,
        group: "Commands",
        icon: "●",
        label: `Accent: ${c.label}`,
        hint: "appearance",
        deep: true,
        run: () => onAppearance({ accent: c.name }),
      });
    }

    for (const p of projects.slice(0, 40)) {
      add({
        id: `proj:${p.project_slug}`,
        group: "Projects",
        icon: "▸",
        label: shortPath(p.path, 2),
        hint: "start a session here",
        meta: `${p.sessions} session${p.sessions === 1 ? "" : "s"}`,
        deep: true,
        // Was a row that switched to the History tab and dropped the project on the
        // floor, which read as broken. A folder's useful verb is "work here".
        run: () => onNewIn(p.path),
      });
    }
    return out;
  }, [
    agents,
    projects,
    recent,
    found,
    appearance,
    onNewSession,
    onTab,
    onOpenSession,
    onNewIn,
    onManageFolders,
    onFind,
    onAppearance,
  ]);

  const { shown, more } = useMemo(() => {
    const parts = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hits = parts.length
      ? items
          .map((i) => ({ i, s: score(i, parts) }))
          .filter((r) => r.s >= 0)
          .sort((a, b) => b.s - a.s)
          .map((r) => r.i)
      : items.filter((i) => !i.deep).sort((a, b) => (b.boost ?? 0) - (a.boost ?? 0));
    // Group headings only make sense if the rows are contiguous, and ranking
    // interleaves them — so order the groups by their best hit and keep each block
    // together, rather than letting a heading repeat down the list.
    const rank = new Map<Group, number>();
    hits.forEach((i, n) => rank.has(i.group) || rank.set(i.group, n));
    const sorted = hits
      .map((i, n) => ({ i, n }))
      .sort((a, b) => (rank.get(a.i.group)! - rank.get(b.i.group)!) || a.n - b.n)
      .map((r) => r.i);
    return { shown: sorted.slice(0, LIMIT), more: Math.max(0, sorted.length - LIMIT) };
  }, [items, q]);

  useEffect(() => setActive(0), [q]);

  // Keep the highlighted row on screen when arrowing past the fold.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (item: PaletteItem | undefined, full = false) => {
    if (!item) return;
    item.run(full ? { full: true } : undefined);
    onClose();
  };

  /**
   * Escape and the arrows live on the window, not the input: the rows are real
   * buttons, so clicking or tabbing into the list used to take focus off the input
   * and Escape silently stopped closing the palette.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % Math.max(shown.length, 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + shown.length) % Math.max(shown.length, 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        choose(shown[active], e.metaKey || e.ctrlKey);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, active, onClose]);

  const activeItem = shown[active];
  return (
    <>
      <div className="scrim palette-scrim" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-bar">
          <span className="palette-search" aria-hidden="true">
            ⌕
          </span>
          <input
            className="palette-input"
            autoFocus
            value={q}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={activeItem ? `palette-row-${active}` : undefined}
            aria-label="Search sessions, projects and commands"
            placeholder="Jump to a session, project, or command…"
            onChange={(e) => setQ(e.target.value)}
          />
          {q && (
            <button className="palette-clear" aria-label="Clear the search" onClick={() => setQ("")}>
              ×
            </button>
          )}
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {shown.length === 0 && (
            <div className="empty">
              Nothing matches <strong>{q.trim()}</strong>.
            </div>
          )}
          {shown.map((item, i) => {
            const first = i === 0 || shown[i - 1].group !== item.group;
            const count = shown.filter((s) => s.group === item.group).length;
            return (
              <div key={item.id}>
                {first && (
                  <div className="palette-group">
                    {item.group}
                    <span className="palette-count">{count}</span>
                  </div>
                )}
                <button
                  data-idx={i}
                  id={`palette-row-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={`palette-row ${i === active ? "on" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={(e) => choose(item, e.metaKey || e.ctrlKey)}
                >
                  <span className={`palette-icon ${item.state ?? ""}`} aria-hidden="true">
                    {item.icon}
                  </span>
                  <span className="palette-label">{item.label}</span>
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                  {item.meta && (
                    <span className={`palette-meta ${item.state ?? ""}`}>{item.meta}</span>
                  )}
                  <span className="palette-enter" aria-hidden="true">
                    ↵
                  </span>
                </button>
              </div>
            );
          })}
          {more > 0 && <div className="palette-more">{more} more — keep typing to narrow.</div>}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          {/* Only advertised when the highlighted row can actually do it, so the
              footer never promises something the row will ignore. */}
          {activeItem?.canFull && (
            <span>
              <kbd>⌘↵</kbd> full view
            </span>
          )}
          <span>
            <kbd>esc</kbd> close
          </span>
          <span className="spacer" style={{ flex: 1 }} />
          <span>
            {shown.length + more} result{shown.length + more === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </>
  );
}
