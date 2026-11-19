import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gitApi, taskApi, workspaceApi, type Artifact, type ChangedFile, type Settings } from "../api.ts";
import type { Task } from "../../shared/tasks.ts";
import { artifactKey } from "../../shared/artifacts.ts";
import { workspaceTitle, type Workspace } from "../../shared/workspaces.ts";
import { EditableTitle } from "./EditableTitle.tsx";
import { GitControls } from "./GitControls.tsx";
import { GitGraph } from "./GitGraph.tsx";
import { GitPanel } from "./GitPanel.tsx";
import { ArchiveIcon, ArtifactIcon, CheckIcon, ClaudeMark, GitIcon, MoreVerticalIcon, PlayIcon, PlusIcon, TerminalIcon, TrashIcon } from "./Icons.tsx";
import { Popover } from "./Popover.tsx";
import { DeleteWorkspaceDialog } from "./sidebar/DeleteWorkspaceDialog.tsx";
import { STATUS_LABEL, type SidebarSession } from "./sidebar/sessions.ts";
import { useGitRepo } from "./useGitRepo.ts";


type Tab = "changes" | "sessions" | "git";
const TAB_KEY = "workspace-tab";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function since(at: number): string {
  const gone = Date.now() - at;
  if (gone < MINUTE) return "now";
  if (gone < HOUR) return `${Math.floor(gone / MINUTE)}m`;
  if (gone < DAY) return `${Math.floor(gone / HOUR)}h`;
  return `${Math.floor(gone / DAY)}d`;
}

/**
 * One workspace on a page of its own: the sessions working in it, what they
 * changed on disk, the checkout's git controls and the artifacts they wrote.
 * A session's own page is only the conversation; everything about the work
 * as a whole lives here.
 */
export function WorkspacePage({
  workspace,
  sessions,
  artifacts,
  tasks,
  shared,
  settings,
  onSettings,
  onBack,
  onOpenSession,
  onNewSession,
  onNewTerminal,
  onOpenWorktree,
}: {
  workspace: Workspace;
  /** The live sessions filed in this workspace. */
  sessions: SidebarSession[];
  /** The pages this workspace's sessions wrote, newest first. */
  artifacts: Artifact[];
  /** The tasks tied to this workspace: the open ones, then those completed in the last week. */
  tasks: Task[];
  /** Other workspaces living in the same folder. */
  shared: number;
  settings: Settings | null;
  onSettings: (s: Settings) => void;
  onBack: () => void;
  /** Open a session the way the click settings say; the modifier keys choose as they do in the sidebar. */
  onOpenSession: (id: string, opts?: { full?: boolean; option?: boolean }) => void;
  onNewSession: (folder: string, workspaceId: number) => void;
  onNewTerminal: (folder: string, workspaceId: number | null) => void;
  onOpenWorktree?: (path: string) => void;
}) {
  const repo = useGitRepo(workspace.folder);
  const status = repo.status?.isRepo ? repo.status : null;
  const [branchFiles, setBranchFiles] = useState<ChangedFile[]>([]);
  const branchKey = status && !status.onBase && status.base ? `${status.root}@${status.head}` : null;
  useEffect(() => {
    if (!branchKey) return setBranchFiles([]);
    let alive = true;
    gitApi
      .branchFiles(workspace.folder)
      .then((r) => alive && setBranchFiles(r.files))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [branchKey, workspace.folder]);
  const uncommitted = status?.files ?? [];
  const sum = (list: ChangedFile[]) => list.reduce((t, f) => ({ add: t.add + f.insertions, del: t.del + f.deletions }), { add: 0, del: 0 });
  const branchTotal = sum(branchFiles);
  const dirtyTotal = sum(uncommitted);

  const driven = sessions.find((s) => s.agentKey)?.agentKey ?? null;
  const targetsKey = JSON.stringify(sessions.flatMap((s) => (s.agentKey ? [[s.agentKey, s.title]] : [])));
  const targets = useMemo(() => (JSON.parse(targetsKey) as [string, string][]).map(([key, title]) => ({ key, title })), [targetsKey]);
  const openSessionRef = useRef(onOpenSession);
  openSessionRef.current = onOpenSession;
  const openTarget = useCallback((key: string) => openSessionRef.current(key), []);

  const [tab, setTab] = useState<Tab>(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY);
      return saved === "sessions" || saved === "git" ? saved : "changes";
    } catch {
      return "changes";
    }
  });
  const pick = (next: Tab) => {
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      return;
    }
  };
  const [deleting, setDeleting] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const chats = sessions.filter((s) => !s.terminal);
  const shells = sessions.filter((s) => s.terminal);
  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "changes", label: "Code changes", count: uncommitted.length },
    { key: "sessions", label: "Overview", count: 0 },
    { key: "git", label: "Git", count: status?.ahead ?? 0 },
  ];

  return (
    <div className="page workspace-page">
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)}>
          {workspace.status === "active" ? (
            <button
              role="menuitem"
              onClick={() => {
                setMenu(null);
                void workspaceApi.archive(workspace.id).then(onBack).catch(() => {});
              }}
            >
              <ArchiveIcon />
              <span className="ws-menu-label">{sessions.length > 0 ? "Archive and end its sessions" : "Archive"}</span>
            </button>
          ) : (
            <button
              role="menuitem"
              onClick={() => {
                setMenu(null);
                void workspaceApi.resume(workspace.id).catch(() => {});
              }}
            >
              <PlayIcon />
              <span className="ws-menu-label">Reopen</span>
            </button>
          )}
          <hr />
          <button
            role="menuitem"
            className="danger"
            onClick={() => {
              setMenu(null);
              setDeleting(true);
            }}
          >
            <TrashIcon />
            <span className="ws-menu-label">Delete…</span>
          </button>
        </Popover>
      )}
      {deleting && <DeleteWorkspaceDialog workspace={workspace} sessions={sessions.length} shared={shared} onClose={() => setDeleting(false)} />}
      <div className="page-head wsp-head">
        <button className="icon-btn" onClick={onBack}>
          ← Back
        </button>
        <div className="wsp-head-text">
          <EditableTitle
            as="h1"
            value={workspaceTitle(workspace)}
            placeholder="Workspace"
            onRename={async (goal) => {
              await workspaceApi.rename(workspace.id, goal);
            }}
          />
          <p className="page-sub">
            {workspace.projectName} · {workspace.folder.replace(/^\/Users\/[^/]+/, "~")}
          </p>
        </div>
        {status && (
          <dl className="wsp-facts">
            <div title={status.base && !status.onBase ? `${status.branch ?? "detached"} is compared with ${status.base}` : undefined}>
              <dt>Branch</dt>
              <dd>
                <GitIcon />
                {status.detached ? `detached ${status.head?.slice(0, 7)}` : status.branch}
                {status.base && !status.onBase && <em>→ {status.base}</em>}
              </dd>
            </div>
            {status.base && !status.onBase && (
              <div>
                <dt>On this branch</dt>
                <dd>
                  {status.aheadOfBase} commit{status.aheadOfBase === 1 ? "" : "s"}
                  {branchFiles.length > 0 && <em>{branchFiles.length} file{branchFiles.length === 1 ? "" : "s"}</em>}
                  {branchTotal.add > 0 && <span className="tok-add">+{branchTotal.add}</span>}
                  {branchTotal.del > 0 && <span className="tok-del">−{branchTotal.del}</span>}
                </dd>
              </div>
            )}
            <div>
              <dt>Uncommitted</dt>
              <dd>
                {uncommitted.length === 0 ? "Clean" : `${uncommitted.length} file${uncommitted.length === 1 ? "" : "s"}`}
                {dirtyTotal.add > 0 && <span className="tok-add">+{dirtyTotal.add}</span>}
                {dirtyTotal.del > 0 && <span className="tok-del">−{dirtyTotal.del}</span>}
              </dd>
            </div>
            {status.upstream && (
              <div title={`Compared with ${status.upstream}`}>
                <dt>Remote</dt>
                <dd>{status.ahead === 0 && status.behind === 0 ? "In sync" : `↑${status.ahead} ↓${status.behind}`}</dd>
              </div>
            )}
          </dl>
        )}
        <button className="icon-btn square wsp-more" title="Workspace actions" aria-label="Workspace actions" onClick={(e) => setMenu(e.currentTarget)}>
          <MoreVerticalIcon />
        </button>
      </div>

      <div className="pr-tabs wsp-tabs" role="tablist">
        {tabs.map((t) => (
          <a key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? "on" : ""} onClick={() => pick(t.key)}>
            {t.label}
            {t.count > 0 && <em>{t.count}</em>}
          </a>
        ))}
      </div>

      {tab === "changes" && (
        <div className="wsp-main">
          <GitPanel key={workspace.folder} repo={repo} settings={settings} onSettings={onSettings} targets={targets} onOpenSession={openTarget} />
        </div>
      )}

      {tab === "sessions" && (
        <div className="wsp-sessions">
          <div className="wsp-col">
            <section className="panel">
              <div className="panel-head">
                <h2>Sessions & Terminals</h2>
                <span className="wsp-panel-actions">
                  <button className="icon-btn" onClick={() => onNewTerminal(workspace.folder, workspace.id)}>
                    <PlusIcon /> New terminal
                  </button>
                  <button className="icon-btn primary" onClick={() => onNewSession(workspace.folder, workspace.id)}>
                    <PlusIcon /> New session
                  </button>
                </span>
              </div>
              {sessions.length === 0 && <p className="wsp-none">None running.</p>}
              {chats.map((s) => (
                <button key={s.id} className="wsp-session" onClick={(e) => onOpenSession(s.id, { full: e.metaKey || e.ctrlKey, option: e.altKey })}>
                  <span className={`ws-mark ws-mark-${s.status}`}>
                    <ClaudeMark />
                  </span>
                  <span className="wsp-session-text">
                    <span className="wsp-session-title">{s.title}</span>
                    <span className="wsp-session-why">{`${s.why ?? STATUS_LABEL[s.status]}${s.model ? ` · ${s.model}` : ""}`}</span>
                  </span>
                  <time>{since(s.at)}</time>
                </button>
              ))}
              {shells.map((s) => (
                <button key={s.id} className="wsp-session" onClick={(e) => onOpenSession(s.id, { full: e.metaKey || e.ctrlKey, option: e.altKey })}>
                  <span className="ws-mark">
                    <TerminalIcon />
                  </span>
                  <span className="wsp-session-title">{s.title}</span>
                  <time>{since(s.at)}</time>
                </button>
              ))}
            </section>
          </div>
          <div className="wsp-col">
            <section className="panel">
              <div className="panel-head">
                <h2>Tasks</h2>
              </div>
              {tasks.length === 0 && <p className="wsp-none">Tasks tied to this workspace show up here.</p>}
              {tasks.map((t) => {
                const done = t.completedAt !== null;
                return (
                  <div key={t.id} className={`task-row wsp-task${done ? " done" : ""}`}>
                    <button
                      className={`task-check tasks-p${t.priority}`}
                      title={done ? "Reopen" : "Mark done"}
                      aria-label={done ? `Reopen ${t.content}` : `Complete ${t.content}`}
                      onClick={() => void (done ? taskApi.reopen(t.id) : taskApi.complete(t.id)).catch(() => {})}
                    >
                      {done && <CheckIcon />}
                    </button>
                    <span className="task-content">{t.content}</span>
                  </div>
                );
              })}
            </section>
          </div>
          <div className="wsp-col">
            <section className="panel">
              <div className="panel-head">
                <h2>Artifacts</h2>
              </div>
              {artifacts.length === 0 && <p className="wsp-none">Pages the sessions in this workspace write show up here.</p>}
              {artifacts.map((a) => (
                <button key={a.slug} className="wsp-session wsp-artifact" title={a.title} onClick={(e) => onOpenSession(artifactKey(a.slug), { full: e.metaKey || e.ctrlKey, option: e.altKey })}>
                  <span className="ws-mark">
                    <ArtifactIcon />
                  </span>
                  <span className="wsp-session-title">{a.title}</span>
                </button>
              ))}
            </section>
          </div>
        </div>
      )}

      {tab === "git" && (
        <div className="wsp-git">
          <GitControls repo={repo} agentKey={driven} onOpenWorktree={onOpenWorktree} />
          <div className="panel wsp-graph">
            <GitGraph cwd={workspace.folder} />
          </div>
        </div>
      )}
    </div>
  );
}
