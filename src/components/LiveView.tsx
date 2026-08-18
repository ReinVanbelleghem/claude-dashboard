import {
  agentApi,
  fmtAgo,
  fmtDuration,
  shortPath,
  type AgentSummary,
  type LivePayload,
  type LiveSession,
  type Restorable,
  type SessionRow,
} from "../api.ts";
import { GitBadge } from "./GitPanel.tsx";
import { MODE_LABEL } from "./Conversation.tsx";
import { FolderIcon, PlusIcon } from "./Icons.tsx";

/** Always opens the full page, whatever the click preference is set to. */
function PageLink({ id }: { id: string }) {
  return (
    <a
      className="card-open"
      href={`#/session/${encodeURIComponent(id)}`}
      title="Open the full page"
      onClick={(e) => e.stopPropagation()}
    >
      ↗
    </a>
  );
}

/** Registry status → visual class. Anything unrecognised falls through to idle. */
function statusClass(s: LiveSession): string {
  if (!s.alive) return "dead";
  if (needsInput(s)) return "attention";
  if (s.status === "busy" || s.status === "running" || s.status === "thinking") return "busy";
  return "idle";
}

function needsInput(s: LiveSession): boolean {
  return s.alive && (s.status === "needs_input" || s.status === "waiting" || !!s.waitingFor);
}

function statusLabel(s: LiveSession): string {
  if (!s.alive) return "exited";
  if (s.waitingFor) return `waiting: ${s.waitingFor}`;
  return s.status ?? "unknown";
}

export function LiveView({
  live,
  agents,
  restorable,
  titles,
  onOpen,
  onOpenAgent,
  onNew,
  onManageFolders,
}: {
  live: LivePayload | null;
  agents: AgentSummary[];
  restorable: Restorable[];
  titles: Map<string, SessionRow>;
  onOpen: (id: string) => void;
  onOpenAgent: (a: AgentSummary) => void;
  onNew: () => void;
  onManageFolders: () => void;
}) {
  const attention = live?.sessions.filter(needsInput) ?? [];
  const active = live?.sessions.filter((s) => s.alive && !needsInput(s)) ?? [];
  const stale = live?.sessions.filter((s) => !s.alive) ?? [];
  const open = agents
    .filter((a) => a.status !== "ended" && a.status !== "error")
    .sort((a, b) => a.createdAt - b.createdAt);
  const closed = agents.filter((a) => a.status === "ended" || a.status === "error");

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>Your sessions ({open.length})</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="icon-btn" onClick={onManageFolders} title="Manage working directories">
              <FolderIcon /> Folders
            </button>
            <button className="icon-btn primary" onClick={onNew} title="Start a session here">
              <PlusIcon /> New session
            </button>
          </div>
        </div>
        <p className="hint">
          Started from the dashboard, so you can chat with them, answer permission prompts and switch
          model or mode from the session view.
        </p>
        {open.length === 0 ? (
          <div className="empty">
            None yet — <button className="link-btn inline" onClick={onNew}>start one</button> to chat here.
          </div>
        ) : (
          <AgentCards agents={open} onOpen={onOpenAgent} />
        )}
      </div>

      {!live && <div className="empty">Connecting to the daemon…</div>}

      {attention.length > 0 && (
        <div className="panel">
          <h2>Waiting on you</h2>
          <p className="hint">
            These external sessions reported a blocked status — a permission prompt or a question.
            Answer them where they were started.
          </p>
          <Cards sessions={attention} titles={titles} onOpen={onOpen} />
        </div>
      )}

      {/* Hidden entirely when nothing is running externally, like every other panel
          here: an empty panel explaining a registry you are not using is a paragraph
          of chrome between you and your own sessions. */}
      {active.length > 0 && (
        <div className="panel">
          <h2>Running externally ({active.length})</h2>
          <p className="hint">
            Started outside the dashboard, read from the session registry on disk. Read-only here —
            their input belongs to whatever launched them.
          </p>
          <Cards sessions={active} titles={titles} onOpen={onOpen} />
        </div>
      )}

      {closed.length > 0 && (
        <div className="panel">
          <h2>Finished here ({closed.length})</h2>
          <p className="hint">Ended dashboard sessions. Their transcripts stay searchable.</p>
          <AgentCards agents={closed} onOpen={onOpenAgent} />
        </div>
      )}

      {restorable.length > 0 && (
        <div className="panel">
          <h2>Resumable ({restorable.length})</h2>
          <p className="hint">
            Sessions this dashboard ran before. A session is a child of the daemon, so restarting
            the daemon ends it — resuming starts a fresh process on the same conversation, history
            intact.
          </p>
          <div className="cards">
            {restorable.map((r) => (
              <div key={r.sessionId} className="card dead">
                <div className="card-head">
                  <span className="card-name">{r.title ?? shortPath(r.cwd, 1)}</span>
                  <span className="spacer" style={{ flex: 1 }} />
                  <PageLink id={r.sessionId} />
                </div>
                <div className="card-body">
                  <div title={r.cwd}>{shortPath(r.cwd)}</div>
                </div>
                <div className="card-meta">
                  <span>{fmtAgo(r.lastSeen)}</span>
                  {r.model && <span>{r.model.replace(/\[.*\]$/, "")}</span>}
                </div>
                <div className="card-actions">
                  <button
                    className="icon-btn primary"
                    onClick={() => agentApi.restore(r.sessionId).catch(() => {})}
                  >
                    Resume
                  </button>
                  <a className="icon-btn" href={`#/session/${encodeURIComponent(r.sessionId)}`}>
                    Transcript
                  </a>
                  <button
                    className="icon-btn"
                    title="Remove from this list; the transcript is untouched"
                    onClick={() => agentApi.forget(r.sessionId).catch(() => {})}
                  >
                    Forget
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {stale.length > 0 && (
        <div className="panel">
          <h2>Stale registry entries ({stale.length})</h2>
          <p className="hint">
            The pid is gone but the file remains — these sessions crashed or were killed.
          </p>
          <Cards sessions={stale} titles={titles} onOpen={onOpen} />
        </div>
      )}
    </>
  );
}

/** Cards for sessions the dashboard drives. */
/** Aliases and full model ids both land here; the family is the useful part. */
function modelLabel(model: string | null): string {
  if (!model || model === "default") return "default model";
  const m = model.toLowerCase();
  for (const family of ["opus", "sonnet", "haiku"]) {
    if (m.includes(family)) return family[0].toUpperCase() + family.slice(1);
  }
  return model;
}

function AgentCards({
  agents,
  onOpen,
}: {
  agents: AgentSummary[];
  onOpen: (a: AgentSummary) => void;
}) {
  return (
    <div className="cards">
      {agents.map((a) => {
        const ended = a.status === "ended" || a.status === "error";
        const cls =
          a.status === "awaiting-permission"
            ? "attention"
            : a.status === "thinking" || a.status === "starting"
              ? "busy"
              : a.status === "idle"
                ? "idle"
                : "dead";
        return (
          <div key={a.key} className={`card ${cls}`} onClick={() => onOpen(a)} style={{ cursor: "pointer" }}>
            <div className="card-head">
              <span className="card-name">{a.title ?? shortPath(a.cwd, 1)}</span>
              <span className="spacer" style={{ flex: 1 }} />
              <PageLink id={a.sessionId ?? a.key} />
              <span className={`pill ${cls}`}>
                <i className="dot" />
                {a.status === "awaiting-permission" ? "needs you" : a.status}
              </span>
            </div>
            <div className="card-body">
              <div title={a.cwd}>{shortPath(a.cwd)}</div>
              <GitBadge cwd={a.cwd} compact />
            </div>
            <div className="card-meta">
              {/* The real permission mode. This chip used to read "interactive" for
                  every live session, which meant a card in plan mode and one applying
                  edits unasked looked identical. */}
              <span className="chip">
                {ended ? "ended" : (MODE_LABEL[a.permissionMode] ?? a.permissionMode)}
              </span>
              <span>
                {a.turns} turn{a.turns === 1 ? "" : "s"}
              </span>
              <span>{fmtAgo(a.updatedAt)}</span>
              {a.pending > 0 && <span className="chip queued">{a.pending} queued</span>}
            </div>
            {/* Revealed by a container query once the card is wide enough to hold it,
                so this is keyed to the card rather than the viewport — the same card
                renders narrow in the drawer and wide on a big Live grid. */}
            <div className="card-extra">
              <span>{modelLabel(a.model)}</span>
              <span>started {fmtAgo(a.createdAt)}</span>
            </div>
            {/* Outside the collapsible row on purpose: why a session died is the one
                thing that must not disappear because the card got narrow. */}
            {a.error && <div className="card-why card-error">{a.error}</div>}
            {/* An ended session is only a transcript; resuming starts a fresh
                process on the same conversation. */}
            {ended && a.sessionId && (
              <div className="card-actions">
                <button
                  className="icon-btn primary"
                  onClick={(e) => {
                    e.stopPropagation();
                    void agentApi
                      .start({
                        cwd: a.cwd,
                        resume: a.sessionId!,
                        title: a.title ?? undefined,
                        model: a.model ?? undefined,
                      })
                      .catch(() => {});
                  }}
                >
                  Resume
                </button>
                {a.endedReason && <span className="card-why">{a.endedReason}</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Cards({
  sessions,
  titles,
  onOpen,
}: {
  sessions: LiveSession[];
  titles: Map<string, SessionRow>;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="cards">
      {sessions.map((s) => {
        const cls = statusClass(s);
        const row = titles.get(s.sessionId);
        return (
          <div
            key={s.pid}
            className={`card ${cls}`}
            onClick={() => onOpen(s.sessionId)}
            style={{ cursor: "pointer" }}
          >
            <div className="card-head">
              <span className="card-name">{s.name ?? s.sessionId.slice(0, 8)}</span>
              <span className="spacer" style={{ flex: 1 }} />
              <PageLink id={s.sessionId} />
              <span className={`pill ${cls}`}>
                <i className="dot" />
                {statusLabel(s)}
              </span>
            </div>
            <div className="card-body">
              {row?.title && <div className="card-title">{row.title}</div>}
              <div title={s.cwd}>{shortPath(s.cwd)}</div>
            </div>
            <div className="card-meta">
              <span className="chip muted">read-only</span>
              <span>pid {s.pid}</span>
              {s.startedAt && <span>up {fmtDuration(Date.now() - s.startedAt)}</span>}
              <span>{fmtAgo(s.statusUpdatedAt ?? s.updatedAt)}</span>
              {row?.git_branch && <span>{row.git_branch}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
