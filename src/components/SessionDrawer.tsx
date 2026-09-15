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
      <aside className={`drawer ${agent ? "drawer-live" : ""}`} ref={aside}>
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
