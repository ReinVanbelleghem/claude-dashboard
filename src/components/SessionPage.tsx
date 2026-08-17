import { useEffect, useRef, useState } from "react";
import {
  api,
  fmtDuration,
  fmtTokens,
  type AgentSummary,
  type SessionDetail,
  type Settings,
} from "../api.ts";
import { HBars } from "./Charts.tsx";
import { LiveConversation } from "./Conversation.tsx";
import { GitControls } from "./GitControls.tsx";
import { GitBadge, GitPanel } from "./GitPanel.tsx";
import { useGitRepo } from "./useGitRepo.ts";
import { ExternalNotice, turnsOf } from "./SessionDrawer.tsx";
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
}: {
  id: string;
  /** Set when the dashboard owns this session, which is what makes it writable. */
  agent: AgentSummary | null;
  /** True when a terminal-owned session is still running, so it cannot be resumed yet. */
  live: boolean;
  settings: Settings | null;
  onSettings: (s: Settings) => void;
  onBack: () => void;
  onContinue?: (sessionId: string, cwd: string) => Promise<void>;
}) {
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
   * One repository, two panels: the controls sit in the sidebar and the diff at the
   * bottom of the page, so the state they share is owned here. A commit made in one
   * has to empty the file list in the other.
   */
  const repo = useGitRepo(cwd ?? "");

  return (
    <div className="page">
      <div className="page-head">
        <button className="icon-btn" onClick={onBack}>
          ← Back
        </button>
        <div>
          <h1>{s?.title ?? agent?.title ?? (error ? "Session" : "Loading…")}</h1>
          <p className="page-sub">
            {s?.cwd ?? agent?.cwd ?? ""}
            {s?.model ? ` · ${s.model}` : ""}
          </p>
          {cwd && <GitBadge cwd={cwd} />}
        </div>
        <span style={{ flex: 1 }} />
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
                await onContinue(s.id, s.cwd!);
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

      {/* The tile row is always present, empty before the index catches up: adding
          a sibling above the columns later would shift them and remount the lot. */}
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

      <div className="page-cols">
        <div>
          {priorTurns.length > 0 && (
            <div className="panel transcript-panel">
              <Transcript turns={priorTurns} />
            </div>
          )}
          {/* Mounted once, whatever the index knows: keyed by session so switching
              sessions still gives a clean pane, while a data refresh does not. */}
          {agent && (
            <div className="panel chat-pane page-live">
              <LiveConversation
                key={agent.key}
                agentKey={agent.key}
                settings={settings}
                onSettings={onSettings}
                onGone={onBack}
              />
            </div>
          )}
          {cwd && (
            <GitPanel
              key={cwd}
              repo={repo}
              settings={settings}
              onSettings={onSettings}
              agentKey={agent?.key}
            />
          )}
        </div>

        <div className="page-side">
          {/* First in the sidebar: it is the part you act on, and it should not move
              down the page as the session accumulates statistics. */}
          {cwd && <GitControls repo={repo} agentKey={agent?.key} />}

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
      </div>
    </div>
  );
}
