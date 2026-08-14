import { useEffect, useMemo, useRef, useState } from "react";
import { api, type AgentSummary, type Overview, type SessionRow } from "../api.ts";
import { ACCENTS, type Appearance } from "../appearance.ts";

/**
 * ⌘K. One box over everything: jump to a live session, a past one, a project, a
 * tab, or run a command.
 *
 * Two result sources, deliberately different. What the dashboard already holds
 * in memory (live sessions, projects, commands) filters locally and answers on
 * every keystroke; past sessions come from the daemon's full-text index, which
 * is a fetch, so it is debounced and merged in when it lands. Typing never waits
 * on the network.
 */

export type PaletteItem = {
  id: string;
  /** What is matched against, lowercased once at build time. */
  haystack: string;
  group: "Commands" | "Live" | "Sessions" | "Projects";
  label: string;
  hint?: string;
  run: () => void;
};

export function Palette({
  agents,
  projects,
  appearance,
  onClose,
  onOpenSession,
  onTab,
  onNewSession,
  onAppearance,
}: {
  agents: AgentSummary[];
  projects: Overview["projects"];
  appearance: Appearance;
  onClose: () => void;
  onOpenSession: (id: string) => void;
  onTab: (tab: "live" | "history" | "usage" | "settings") => void;
  onNewSession: () => void;
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
    const add = (
      group: PaletteItem["group"],
      id: string,
      label: string,
      hint: string | undefined,
      run: () => void,
    ) => out.push({ id, group, label, hint, haystack: `${label} ${hint ?? ""}`.toLowerCase(), run });

    add("Commands", "cmd:new", "New session", "start one here", onNewSession);
    for (const t of ["live", "history", "usage", "settings"] as const) {
      add("Commands", `cmd:tab:${t}`, `Go to ${t}`, "tab", () => onTab(t));
    }
    add(
      "Commands",
      "cmd:theme",
      appearance.theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      "appearance",
      () => onAppearance({ theme: appearance.theme === "dark" ? "light" : "dark" }),
    );
    for (const c of ACCENTS) {
      add("Commands", `cmd:accent:${c.name}`, `Accent: ${c.label}`, "appearance", () =>
        onAppearance({ accent: c.name }),
      );
    }

    for (const a of agents) {
      const name = a.title ?? a.cwd.split("/").pop() ?? a.key.slice(0, 8);
      add("Live", `live:${a.key}`, name, `${a.status} · ${a.cwd}`, () =>
        onOpenSession(a.sessionId ?? a.key),
      );
    }

    for (const p of projects.slice(0, 40)) {
      add("Projects", `proj:${p.project_slug}`, p.path, `${p.sessions} sessions`, () => {
        onTab("history");
      });
    }

    for (const s of found) {
      add("Sessions", `hist:${s.id}`, s.title ?? s.id.slice(0, 8), s.cwd ?? "", () =>
        onOpenSession(s.id),
      );
    }
    return out;
  }, [agents, projects, found, appearance, onNewSession, onTab, onOpenSession, onAppearance]);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    // Every term must appear somewhere — "dash set" finds "Go to settings" in
    // the dashboard without needing the words adjacent.
    const parts = term.split(/\s+/).filter(Boolean);
    const hits = parts.length
      ? items.filter((i) => parts.every((p) => i.haystack.includes(p)))
      : items.filter((i) => i.group !== "Projects");
    return hits.slice(0, 40);
  }, [items, q]);

  useEffect(() => setActive(0), [q]);

  // Keep the highlighted row on screen when arrowing past the fold.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    item.run();
    onClose();
  };

  return (
    <>
      <div className="scrim palette-scrim" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          className="palette-input"
          autoFocus
          value={q}
          placeholder="Jump to a session, project, or command…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => (a + 1) % Math.max(shown.length, 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a - 1 + shown.length) % Math.max(shown.length, 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(shown[active]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {shown.length === 0 && <div className="empty">Nothing matches.</div>}
          {shown.map((item, i) => {
            const first = i === 0 || shown[i - 1].group !== item.group;
            return (
              <div key={item.id}>
                {first && <div className="palette-group">{item.group}</div>}
                <button
                  data-idx={i}
                  className={`palette-row ${i === active ? "on" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(item)}
                >
                  <span className="palette-label">{item.label}</span>
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </>
  );
}
