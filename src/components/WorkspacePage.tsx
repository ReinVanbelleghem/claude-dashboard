import { useState, type ReactNode } from "react";
import { workspaceApi, type Settings } from "../api.ts";
import { workspaceTitle, type Workspace } from "../../shared/workspaces.ts";
import { SessionArtifacts } from "./ArtifactsView.tsx";
import { EditableTitle } from "./EditableTitle.tsx";
import { GitControls } from "./GitControls.tsx";
import { GitBadge, GitPanel } from "./GitPanel.tsx";
import { ArtifactIcon, ClaudeMark, GitIcon, PanelLeftIcon, PlusIcon, TerminalIcon } from "./Icons.tsx";
import { STATUS_LABEL, type SidebarSession } from "./sidebar/sessions.ts";
import { StatusDot } from "./sidebar/WorkspaceTree.tsx";
import { useGitRepo } from "./useGitRepo.ts";

type View = "changes" | "artifacts";

const SIDE_KEY = "workspace-sidebar";

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
  sessionIds,
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
  /** Every session ever filed here, running or not, for what they left behind. */
  sessionIds: string[];
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
  const driven = sessions.find((s) => s.agentKey)?.agentKey ?? null;

  const [view, setView] = useState<View>("changes");
  const [side, setSide] = useState(() => {
    try {
      return localStorage.getItem(SIDE_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const toggleSide = () => {
    setSide((open) => {
      try {
        localStorage.setItem(SIDE_KEY, open ? "closed" : "open");
      } catch {
        return !open;
      }
      return !open;
    });
  };
  const changed = repo.status?.files.length ?? 0;
  const views: { key: View; label: string; icon: ReactNode; count?: number }[] = [
    { key: "changes", label: "Changes", icon: <GitIcon />, count: changed },
    { key: "artifacts", label: "Artifacts", icon: <ArtifactIcon /> },
  ];

  return (
    <div className="page workspace-page">
      <div className="page-head wsp-head">
        <button className="icon-btn" onClick={onBack}>
          ← Back
        </button>
        <button className="icon-btn square" onClick={toggleSide} title={side ? "Hide the sidebar" : "Show the sidebar"} aria-label={side ? "Hide the sidebar" : "Show the sidebar"} aria-expanded={side}>
          <PanelLeftIcon />
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
        {!side && (
          <div className="wsp-seg" role="tablist">
            {views.map((v) => (
              <button key={v.key} role="tab" aria-selected={view === v.key} className={view === v.key ? "on" : ""} onClick={() => setView(v.key)}>
                {v.label}
                {v.count ? ` ${v.count}` : ""}
              </button>
            ))}
          </div>
        )}
        <GitBadge cwd={workspace.folder} compact />
      </div>

      <div className={`wsp-layout${side ? " with-side" : ""}`}>
        <div className="wsp-side-slot" aria-hidden={!side}>
        <div className="wsp-side">
          <aside className="panel tasks-side wsp-nav">
            {views.map((v) => (
              <button key={v.key} className={`tasks-view ${view === v.key ? "on" : ""}`} aria-current={view === v.key ? "page" : undefined} onClick={() => setView(v.key)}>
                <span className="tasks-view-icon">{v.icon}</span>
                <span className="tasks-view-name">{v.label}</span>
                {v.count ? <span className="tasks-view-count">{v.count}</span> : null}
              </button>
            ))}

            <div className="tasks-side-label wsp-side-label">
              Sessions
              <span className="wsp-side-tools">
                <button className="ws-hover-btn show" title="Open a terminal in this workspace" aria-label="Open a terminal in this workspace" onClick={() => onNewTerminal(workspace.folder, workspace.id)}>
                  <TerminalIcon />
                </button>
                <button className="ws-hover-btn show" title="New session in this workspace" aria-label="New session in this workspace" onClick={() => onNewSession(workspace.folder, workspace.id)}>
                  <PlusIcon />
                </button>
              </span>
            </div>
            {sessions.length === 0 && <p className="wsp-none">None running.</p>}
            {sessions.map((s) => (
              <button
                key={s.id}
                className="wsp-session"
                title={s.terminal ? `${s.title}\nTerminal` : `${s.title}\n${s.why ?? STATUS_LABEL[s.status]}${s.model ? ` · ${s.model}` : ""}`}
                onClick={(e) => onOpenSession(s.id, { full: e.metaKey || e.ctrlKey, option: e.altKey })}
              >
                {s.terminal ? <span className="ws-term-dot" /> : <StatusDot kind={s.status} />}
                {s.terminal ? <TerminalIcon /> : <ClaudeMark />}
                <span className="wsp-session-title">{s.title}</span>
                <time>{since(s.at)}</time>
              </button>
            ))}
          </aside>
          <GitControls repo={repo} agentKey={driven} onOpenWorktree={onOpenWorktree} />
        </div>
        </div>

        <div className="wsp-main">
          {view === "changes" && (
            <GitPanel
              key={workspace.folder}
              repo={repo}
              settings={settings}
              onSettings={onSettings}
              targets={sessions.flatMap((s) => (s.agentKey ? [{ key: s.agentKey, title: s.title }] : []))}
              onOpenSession={(key) => onOpenSession(key)}
            />
          )}
          {view === "artifacts" && (
            <div className="wsp-artifacts">
              <SessionArtifacts sessionIds={sessionIds} />
              <p className="hint wsp-artifacts-none">Pages the sessions in this workspace wrote show up here.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
