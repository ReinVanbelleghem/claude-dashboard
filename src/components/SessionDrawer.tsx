import { useEffect, useRef, useState } from "react";
import {
  agentApi,
  api,
  fmtTokens,
  type AgentSummary,
  type SessionDetail,
  type Settings,
} from "../api.ts";
import { HBars } from "./Charts.tsx";
import { Receipt } from "./Receipt.tsx";
import { LiveConversation } from "./Conversation.tsx";
import { EditableTitle } from "./EditableTitle.tsx";
import { GitBadge } from "./GitPanel.tsx";
import { MuteMenu } from "./MuteMenu.tsx";
import { ScrollJump, useJumpToEnd, useScrollEdges } from "./scroll.tsx";
import { Transcript, type TurnRow } from "./Transcript.tsx";

const DRAWER_WIDTH_KEY = "drawer-width";
const DRAWER_MIN_WIDTH = 420;
// A fraction of the viewport rather than a fixed cap, so an ultrawide monitor
// can actually use the room instead of hitting a desktop-era ceiling.
const DRAWER_MAX_FRACTION = 0.9;

function drawerMaxWidth(): number {
  return Math.round(window.innerWidth * DRAWER_MAX_FRACTION);
}

function defaultDrawerWidth(): number {
  return Math.min(820, drawerMaxWidth());
}

function readDrawerWidth(): number {
  const saved = Number(localStorage.getItem(DRAWER_WIDTH_KEY));
  return Number.isFinite(saved) && saved >= DRAWER_MIN_WIDTH
    ? Math.min(saved, drawerMaxWidth())
    : defaultDrawerWidth();
}

/**
 * How wide a session is worth reading is a preference about your monitor and
 * your eyes, not about any one session, so it is remembered rather than reset
 * every time the drawer opens. A concrete pixel value throughout — rather than
 * "unset, fall back to CSS" — is what lets the floating handle track the
 * drawer's edge without measuring the DOM for it.
 *
 * The value returned is always re-clamped against the *current* viewport
 * (state + a resize listener), not just at the moment it was saved or
 * dragged: a width saved on a wider screen, or a window resized narrower
 * afterwards, would otherwise leave the drawer's CSS `max-width` shrinking
 * the visible panel while this hook kept reporting the old, wider number —
 * putting the handle at the width it no longer actually has, off over the
 * backdrop instead of on the drawer's real edge.
 */
function useDrawerWidth() {
  const [width, setWidth] = useState<number>(readDrawerWidth);
  const [maxWidth, setMaxWidth] = useState<number>(drawerMaxWidth);
  const dragging = useRef(false);

  useEffect(() => {
    function onResize() {
      setMaxWidth(drawerMaxWidth());
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!dragging.current) return;
      const next = Math.min(
        drawerMaxWidth(),
        Math.max(DRAWER_MIN_WIDTH, window.innerWidth - e.clientX),
      );
      setWidth(next);
    }
    function onUp() {
      if (!dragging.current) return;
      dragging.current = false;
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

  useEffect(() => {
    localStorage.setItem(DRAWER_WIDTH_KEY, String(width));
  }, [width]);

  const clampedWidth = Math.min(width, maxWidth);

  function startDrag(e: React.PointerEvent) {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  return { width: clampedWidth, startDrag };
}

/** Older indexes predate `turns`; fall back to the prompt list. */
export function turnsOf(data: SessionDetail | null): TurnRow[] {
  return (
    data?.turns ?? (data?.prompts ?? []).map((p) => ({ ...p, role: "user" as const, model: null }))
  );
}

/**
 * Banner for a session the dashboard cannot type into: its stdin is a terminal
 * we have no access to, so the transcript is all we get.
 */
export function ExternalNotice({ canAdopt }: { canAdopt?: boolean }) {
  return (
    <div className="external-note">
      <strong>Running externally</strong> — started outside the dashboard, so this view is
      read-only; its input belongs to whatever launched it.
      {canAdopt
        ? " Use “Continue here” to resume it under the dashboard and take over the conversation."
        : " Once it has finished you can resume it here from the full page view."}
    </div>
  );
}

export function SessionDrawer({
  id,
  agent,
  settings,
  onSettings,
  onClose,
}: {
  id: string;
  agent: AgentSummary | null;
  settings: Settings | null;
  onSettings: (s: Settings) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const aside = useRef<HTMLElement | null>(null);
  const { width, startDrag } = useDrawerWidth();
  // The drawer itself is the scroll container for a read-only session, so opening
  // one lands on the latest exchange rather than the top of the history.
  useJumpToEnd(aside, !agent && !!data, id);
  const edges = useScrollEdges(aside, data?.turns?.length);

  // Keyed on the id alone: `agent` is a new object on every roster update, and
  // depending on it here reloaded the drawer continuously mid-turn.
  const owned = useRef(!!agent);
  owned.current = !!agent;

  useEffect(() => {
    let stale = false;
    setData(null);
    setError(null);
    api
      .session(id)
      .then((d) => !stale && setData(d))
      // A session started here has nothing indexed until its first flush, which
      // is normal rather than an error worth showing.
      .catch(() => !stale && setError(owned.current ? null : "This session is not indexed yet."))
    return () => {
      stale = true;
    };
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // A session started here has no indexed rows until its first flush, so the
  // agent's own state is what the header falls back to.
  const title = data?.session.title ?? agent?.title ?? "Untitled session";

  // Live sessions rename through their agent, so the roster label moves too; the rest
  // go at the index directly. See SessionPage.renameTo.
  async function renameTo(next: string) {
    if (agent) await agentApi.rename(agent.key, next);
    else await api.renameSession(id, next);
    setData((d) => (d ? { ...d, session: { ...d.session, title: next } } : d));
  }
  const cwd = data?.session.cwd ?? agent?.cwd ?? null;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      {/* A fixed sibling rather than a child of the drawer: the drawer scrolls
          (overflow-y: auto), and a scrolling container clips anything of its
          children that pokes outside its box — which is the whole point of a
          handle meant to float past the drawer's own edge. */}
      <div className="drawer-resize-handle" style={{ right: width }} onPointerDown={startDrag} title="Drag to resize">
        <span className="drawer-resize-grip" />
      </div>
      <aside className={`drawer ${agent ? "drawer-live" : ""}`} ref={aside} style={{ width }}>
        {/* Title and actions share one flex row instead of the title sitting in normal
            flow with the actions absolutely positioned over it — that hack assumed a
            fixed title height, so a longer name (wrapping or just wider) drifted out
            of line with the buttons instead of staying level with them. */}
        <div className="drawer-head">
          <EditableTitle as="h3" value={title} onRename={renameTo} />
          <div className="drawer-actions">
            <MuteMenu
              id={agent?.sessionId ?? agent?.key ?? id}
              label={title}
              settings={settings}
              onSettings={onSettings}
            />
            <a className="icon-btn" href={`#/session/${encodeURIComponent(id)}`}>
              Open full page
            </a>
            <button className="icon-btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {/* Path and branch are both "where this session lives" — one line, not two.
            Live from git rather than the indexed value, which is only as fresh as
            the last transcript flush. */}
        <div className="drawer-meta">
          <p className="drawer-sub">{cwd ?? id}</p>
          {cwd && <GitBadge cwd={cwd} compact />}
        </div>

        {agent ? (
          <>
            {agent.turns === 0 && data && turnsOf(data).length > 0 && (
              <p className="hint">Earlier turns from before the dashboard took over are on the full page.</p>
            )}
            <LiveConversation agentKey={agent.key} settings={settings} onSettings={onSettings} onGone={onClose} />
          </>
        ) : (
          <>
            <ExternalNotice />
            {error && <div className="empty">{error}</div>}
            {!data && !error && <div className="empty">Loading…</div>}

            {data && (
              <>
                <div className="kpis" style={{ marginBottom: 18 }}>
                  <div className="tile">
                    <div className="label">Output</div>
                    <div className="value">{fmtTokens(data.session.output_tokens)}</div>
                  </div>
                  <div className="tile">
                    <div className="label">Cache read</div>
                    <div className="value">{fmtTokens(data.session.cache_read)}</div>
                  </div>
                  <div className="tile">
                    <div className="label">Prompts</div>
                    <div className="value">{data.session.prompt_count}</div>
                  </div>
                  <div className="tile">
                    <div className="label">Tool calls</div>
                    <div className="value">{data.session.tool_count}</div>
                  </div>
                </div>

                <div className="panel">
                  <h2>Context</h2>
                  <table>
                    <tbody>
                      <tr>
                        <td style={{ color: "var(--text-muted)" }}>Branch</td>
                        <td>{data.session.git_branch ?? "—"}</td>
                      </tr>
                      <tr>
                        <td style={{ color: "var(--text-muted)" }}>Model</td>
                        <td>{data.session.model ?? "—"}</td>
                      </tr>
                      <tr>
                        <td style={{ color: "var(--text-muted)" }}>Id</td>
                        <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{data.session.id}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {data.receipt && <Receipt receipt={data.receipt} />}

                {data.prLinks.length > 0 && (
                  <div className="panel">
                    <h2>Pull requests</h2>
                    {data.prLinks.map((pr) => (
                      <div key={pr.pr_url} style={{ marginBottom: 6 }}>
                        <a href={pr.pr_url} target="_blank" rel="noreferrer">
                          {pr.repo ?? "PR"} #{pr.pr_number}
                        </a>
                      </div>
                    ))}
                  </div>
                )}

                {data.tools.length > 0 && (
                  <div className="panel">
                    <h2>Tools used</h2>
                    <HBars
                      rows={data.tools.slice(0, 12).map((t) => ({
                        label: t.name.replace(/^mcp__/, "").replace(/_/g, " "),
                        value: t.count,
                      }))}
                      format={(n) => `${n}`}
                    />
                  </div>
                )}

                <div className="panel">
                  <Transcript turns={turnsOf(data)} />
                </div>
              </>
            )}
          </>
        )}
        {!agent && <ScrollJump target={aside} {...edges} label="newest" variant="fixed" />}
      </aside>
    </>
  );
}
