import { useEffect, useRef, useState } from "react";
import {
  agentApi,
  api,
  fmtDuration,
  fmtTokens,
  type AgentSummary,
  type SessionDetail,
  type Settings,
} from "../api.ts";
import { SessionArtifacts } from "./ArtifactsView.tsx";
import { HBars } from "./Charts.tsx";
import { Receipt } from "./Receipt.tsx";
import { LiveConversation } from "./Conversation.tsx";
import { EditableTitle } from "./EditableTitle.tsx";
import { GitBadge } from "./GitPanel.tsx";
import { FolderIcon } from "./Icons.tsx";
import { workspaceTitle, type Workspace } from "../../shared/workspaces.ts";
import { SessionMenu } from "./SessionMenu.tsx";
import { ExternalNotice, turnsOf } from "./SessionPanelContent.tsx";
import { Transcript } from "./Transcript.tsx";

/**
 * The whole-window view of one session — the same data as the drawer, but with
 * room to read a long transcript. Reached via #/session/<id>, so it survives a
 * reload and can be opened in its own tab.
 */
export function SessionPage({
  id,
  agent,
  live,
  settings,
  onSettings,
  onBack,
  onContinue,
  workspace = null,
  onOpenWorkspace,
}: {
  id: string;
  /** Set when the dashboard owns this session, which is what makes it writable. */
  agent: AgentSummary | null;
  /** True when a terminal-owned session is still running, so it cannot be resumed yet. */
  live: boolean;
  settings: Settings | null;
  onSettings: (s: Settings) => void;
  onBack: () => void;
  onContinue?: (sessionId: string, cwd: string, title: string | null) => Promise<void>;
  /** The workspace this session is filed in, where its changes, git and artifacts are shown. */
  workspace?: Workspace | null;
  onOpenWorkspace?: (workspace: Workspace) => void;
}) {
  const [details, setDetails] = useState(false);
  const [pane, setPane] = useState<"live" | "earlier">("live");
  useEffect(() => setPane("live"), [id]);
  const [data, setData] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [adoptError, setAdoptError] = useState<string | null>(null);

  /**
   * `agent` is a fresh object on every roster update — and the roster updates on
   * every timeline item — so depending on it here re-ran the fetch constantly,
   * blanking `data` and remounting everything below. The session id is the only
   * thing that should trigger a reload; whether an agent exists only decides the
   * wording of the error, so it is read through a ref.
   */
  const owned = useRef(!!agent);
  owned.current = !!agent;

  useEffect(() => {
    let stale = false;
    setData(null);
    setError(null);
    api
      .session(id)
      .then((d) => !stale && setData(d))
      .catch(() => !stale && setError(owned.current ? null : "This session is not indexed yet."));
    return () => {
      stale = true;
    };
  }, [id]);

  const s = data?.session;
  // The agent knows its directory before anything is indexed, so git works from
  // the first second of a session rather than after the first flush.
  const cwd = data?.session.cwd ?? agent?.cwd ?? null;
  const span = s?.first_ts && s?.last_ts ? s.last_ts - s.first_ts : null;
  // Turns from before the dashboard took over. Cutting at the adoption time is
  // what keeps the indexed history and the live timeline from double-printing.
  const priorTurns = agent
    ? turnsOf(data).filter((t) => (t.ts ?? 0) < agent.createdAt)
    : turnsOf(data);

  /**
   * A live session is renamed through its agent so the in-memory label the roster
   * reads moves with the rest; only a session nobody is driving goes straight at the
   * index. The route id is the agent key until a session id exists, which is why the
   * agent is asked first rather than `id` being used for both.
   */
  async function renameTo(title: string) {
    if (agent) await agentApi.rename(agent.key, title);
    else await api.renameSession(id, title);
    setData((d) => (d ? { ...d, session: { ...d.session, title } } : d));
  }

  return (
    <div className="page session-chat">
      <div className="page-head">
        <button className="icon-btn" onClick={onBack}>
          ← Back
        </button>
        <div>
          <EditableTitle
            as="h1"
            value={s?.title ?? agent?.title ?? null}
            placeholder={error ? "Session" : "Loading…"}
            onRename={renameTo}
          />
          <p className="page-sub">
            {s?.cwd ?? agent?.cwd ?? ""}
            {s?.model ? ` · ${s.model}` : ""}
          </p>
          {cwd && <GitBadge cwd={cwd} />}
        </div>
        <span style={{ flex: 1 }} />
        {workspace && onOpenWorkspace && (
          <button
            className="icon-btn"
            title="Changes, git, worktrees and artifacts of this workspace"
            onClick={() => onOpenWorkspace(workspace)}
          >
            <FolderIcon open /> {workspaceTitle(workspace)}
          </button>
        )}
        <button className={`icon-btn${details ? " on" : ""}`} aria-pressed={details} onClick={() => setDetails((v) => !v)}>
          Details
        </button>
        {/* The same ⋮ the drawer and a tile carry, minus "Open full page" — this
            is it. A session's actions should be in one place whichever way it is
            open, so Notify and Restart moved in here with the rest. */}
        <SessionMenu
          id={id}
          agent={agent}
          label={s?.title ?? agent?.title ?? id}
          settings={settings}
          onSettings={onSettings}
          onEnded={onBack}
          fullPage
        />
        {/* Adopting a session that is still running in a terminal would put two
            processes on one transcript, so it is offered only once that one is done. */}
        {onContinue && s?.cwd && !agent && !live && (
          <button
            className="icon-btn primary"
            disabled={adopting}
            title="Resume this conversation as a session the dashboard drives"
            onClick={async () => {
              setAdopting(true);
              setAdoptError(null);
              try {
                await onContinue(s.id, s.cwd!, s.title ?? null);
              } catch (e) {
                setAdoptError(e instanceof Error ? e.message : String(e));
              } finally {
                setAdopting(false);
              }
            }}
          >
            {adopting ? "Resuming…" : "Continue here"}
          </button>
        )}
      </div>
      {adoptError && <div className="chat-error">{adoptError}</div>}

      {error && <div className="empty">{error}</div>}
      {!agent && live && <ExternalNotice />}

      <div className={`session-cols${details ? " with-details" : ""}`}>
        <div className="session-main">
          {agent && priorTurns.length > 0 && (
          <div className="session-tabs" role="tablist" aria-label="Which part of the conversation">
            <button role="tab" aria-selected={pane === "live"} className={pane === "live" ? "on" : ""} onClick={() => setPane("live")}>
              Conversation
            </button>
            <button
              role="tab"
              aria-selected={pane === "earlier"}
              className={pane === "earlier" ? "on" : ""}
              title="What was said before the dashboard took this session over"
              onClick={() => setPane("earlier")}
            >
              Earlier <span>{priorTurns.length}</span>
            </button>
          </div>
        )}
          {priorTurns.length > 0 && (
            <div className="panel transcript-panel" hidden={!!agent && pane !== "earlier"}>
              <Transcript turns={priorTurns} />
            </div>
          )}
          {/* Mounted once, whatever the index knows: keyed by session so switching
              sessions still gives a clean pane, while a data refresh does not. */}
          {agent && (
            <div className="panel chat-pane page-live" hidden={priorTurns.length > 0 && pane === "earlier"}>
              <LiveConversation
                key={agent.key}
                agentKey={agent.key}
                settings={settings}
                onSettings={onSettings}
                onGone={onBack}
              />
            </div>
          )}
        </div>

        {details && (
        <div className="page-side session-details">
          <div className="kpis">
        {data && s && (
          <>
            <div className="tile">
              <div className="label">Output</div>
              <div className="value">{fmtTokens(s.output_tokens)}</div>
            </div>
            <div className="tile">
              <div className="label">Cache read</div>
              <div className="value">{fmtTokens(s.cache_read)}</div>
            </div>
            <div className="tile">
              <div className="label">Prompts</div>
              <div className="value">{s.prompt_count}</div>
            </div>
            <div className="tile">
              <div className="label">Tool calls</div>
              <div className="value">{s.tool_count}</div>
            </div>
            <div className="tile">
              <div className="label">Duration</div>
              <div className="value">{span ? fmtDuration(span) : "—"}</div>
            </div>
          </>
        )}
      </div>

          {data && s && (
            <div className="panel">
              <h2>Session</h2>
              <table>
                <tbody>
                  <tr>
                    <td style={{ color: "var(--text-muted)" }}>Started</td>
                    <td>{s.first_ts ? new Date(s.first_ts).toLocaleString() : "—"}</td>
                  </tr>
                  <tr>
                    <td style={{ color: "var(--text-muted)" }}>Last active</td>
                    <td>{s.last_ts ? new Date(s.last_ts).toLocaleString() : "—"}</td>
                  </tr>
                  <tr>
                    <td style={{ color: "var(--text-muted)" }}>Id</td>
                    <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{s.id}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {data && s && (
            <>
              {data.receipt && <Receipt receipt={data.receipt} />}

              {!workspace && <SessionArtifacts sessionId={id} />}

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
                    rows={data.tools.slice(0, 20).map((t) => ({
                      label: t.name.replace(/^mcp__/, "").replace(/_/g, " "),
                      value: t.count,
                    }))}
                    format={(n) => `${n}`}
                  />
                </div>
              )}
            </>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
