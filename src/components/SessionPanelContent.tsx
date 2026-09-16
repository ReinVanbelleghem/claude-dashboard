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

/**
 * The body shared by the drawer and a floating tile: the title row, the
 * path/branch line, and either the live conversation or the read-only
 * transcript and stat panels. Factored out because a tile is just a
 * differently-chromed, differently-scrolled host for exactly this content —
 * duplicating it would mean every future change here happening twice.
 */
export function SessionPanelContent({
  id,
  agent,
  settings,
  onSettings,
  onClose,
  scrollRef,
  jumpVariant = "fixed",
  onHeadPointerDown,
  headStart,
  chrome = "full",
  titleEditable = true,
}: {
  id: string;
  agent: AgentSummary | null;
  settings: Settings | null;
  onSettings: (s: Settings) => void;
  onClose: () => void;
  /** The element that actually scrolls — an `<aside>` for the drawer, a plain `<div>` for a tile. */
  scrollRef: React.RefObject<HTMLElement | null>;
  jumpVariant?: "fixed" | "compact";
  /**
   * Lets a tile turn its whole header into a drag handle without stopping its
   * buttons and links from working — the caller is expected to bail out of
   * its own handler when the pointer landed on one of those.
   */
  onHeadPointerDown?: (e: React.PointerEvent) => void;
  /** Content prepended to the header, before the title — a tile's traffic lights. */
  headStart?: React.ReactNode;
  /**
   * "minimal" drops the "Open full page" link and "Close" button: a tile
   * already offers both as its own green/red traffic lights, and showing
   * both forms of the same two actions in a window this small reads as
   * clutter rather than choice.
   */
  chrome?: "full" | "minimal";
  /**
   * A tile's header doubles as a drag handle, so the click-to-rename
   * affordance — a full-width hover box practically inviting a click right
   * where you'd grab the window — fights the thing the header is mostly
   * there for. Off by default only for that reason, not because renaming
   * from here would be wrong.
   */
  titleEditable?: boolean;
}) {
  const [data, setData] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The drawer/tile itself is the scroll container for a read-only session, so
  // opening one lands on the latest exchange rather than the top of the history.
  useJumpToEnd(scrollRef, !agent && !!data, id);
  const edges = useScrollEdges(scrollRef, data?.turns?.length);

  // Keyed on the id alone: `agent` is a new object on every roster update, and
  // depending on it here reloaded the panel continuously mid-turn.
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
      .catch(() => !stale && setError(owned.current ? null : "This session is not indexed yet."));
    return () => {
      stale = true;
    };
  }, [id]);

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
      {/* Title and actions share one flex row instead of the title sitting in normal
          flow with the actions absolutely positioned over it — that hack assumed a
          fixed title height, so a longer name (wrapping or just wider) drifted out
          of line with the buttons instead of staying level with them. */}
      <div className="drawer-head" onPointerDown={onHeadPointerDown}>
        {headStart}
        {titleEditable ? (
          <EditableTitle as="h3" value={title} onRename={renameTo} />
        ) : (
          <h3>{title}</h3>
        )}
        <div className="drawer-actions">
          <MuteMenu
            id={agent?.sessionId ?? agent?.key ?? id}
            label={title}
            settings={settings}
            onSettings={onSettings}
          />
          {chrome === "full" && (
            <>
              <a className="icon-btn" href={`#/session/${encodeURIComponent(id)}`}>
                Open full page
              </a>
              <button className="icon-btn" onClick={onClose}>
                Close
              </button>
            </>
          )}
          {/* The tile already has the green light for "send this elsewhere" (full
              page, or arranged onto the screen); a pop-out button here was a second,
              redundant way to do roughly the same thing. Ending the session — the one
              thing that otherwise means scrolling down to the composer's own Stop/End —
              is the more useful thing to reach from the header. Only an owned, still-
              running agent has anything here to end. */}
          {chrome === "minimal" && agent && agent.status !== "ended" && agent.status !== "error" && (
            <button
              className="icon-btn"
              title={agent.status === "thinking" || agent.status === "starting" ? "Stop the current turn" : "End this session"}
              onClick={() => {
                if (agent.status === "thinking" || agent.status === "starting") {
                  agentApi.interrupt(agent.key).catch(() => {});
                } else {
                  agentApi.stop(agent.key).catch(() => {});
                }
              }}
            >
              {agent.status === "thinking" || agent.status === "starting" ? "Stop" : "End"}
            </button>
          )}
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
          <LiveConversation
            agentKey={agent.key}
            settings={settings}
            onSettings={onSettings}
            onGone={onClose}
            scrollJumpVariant={jumpVariant === "compact" ? "compact" : "float"}
          />
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
      {!agent && <ScrollJump target={scrollRef} {...edges} label="newest" variant={jumpVariant} />}
    </>
  );
}
