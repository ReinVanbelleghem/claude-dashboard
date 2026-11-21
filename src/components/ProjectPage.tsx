import { ItemActions, taskActions } from "./ItemActions.tsx";
import { TaskQuickAdd } from "./tasks/TaskQuickAdd.tsx";
import { Workbench } from "./workbench/Workbench.tsx";
import { useRef, useState } from "react";
import { artifactApi, drawingApi, noteApi, prParam, taskApi, workspaceApi, type Artifact, type Project, type Workspace } from "../api.ts";
import { artifactKey } from "../../shared/artifacts.ts";
import { drawingKey } from "../../shared/drawings.ts";
import { noteKey, noteSlug } from "../../shared/notes.ts";
import { useNotes } from "./NotePane.tsx";
import type { ServicesState } from "../../shared/services.ts";
import type { Task } from "../../shared/tasks.ts";
import { DrawingCard, useDrawings } from "./DrawingsView.tsx";
import { EditableTitle } from "./EditableTitle.tsx";
import { ArchiveIcon, ArtifactIcon, CheckIcon, DocIcon, FullPageIcon, PlayIcon, ClaudeMark, FolderIcon, GitIcon, PlusIcon, PullRequestIcon, ServiceIcon, TerminalIcon } from "./Icons.tsx";
import { CiDot, DraftBadge, ReviewBadge } from "./pr/PrBadges.tsx";
import { useGitRepo } from "./useGitRepo.ts";
import { hasOwnMark, OwnProjectMark, ProjectMark, ProjectMarkPicker } from "./ProjectMark.tsx";
import { WorkspaceServices } from "./services/WorkspaceServices.tsx";
import { STATUS_LABEL, type SidebarSession } from "./sidebar/sessions.ts";
import { StackPanel, switchToLayer, useStack } from "./StackPanel.tsx";

type Tab = "overview" | "files" | "services";
const TAB_KEY = "project-tab";
const NO_CHANGES = new Map<string, string>();

const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

function since(at: number): string {
  const gone = Date.now() - at;
  if (gone < 60_000) return "now";
  if (gone < 3_600_000) return `${Math.floor(gone / 60_000)}m`;
  if (gone < 86_400_000) return `${Math.floor(gone / 3_600_000)}h`;
  return `${Math.floor(gone / 86_400_000)}d`;
}

const heading = (w: Workspace, what: string) => (
  <span className="wsp-linked-title">
    <ProjectMark projectKey={w.repoKey} name={w.repoName} />
    {what} · {w.repoName}
    {w.branch ? ` · ${w.branch}` : ""}
  </span>
);

function WorkspaceServicesPanel({ workspace, state, onOpenSettings }: { workspace: Workspace; state: ServicesState | null; onOpenSettings?: () => void }) {
  const { stack, refresh } = useStack(workspace.folder, `${workspace.folder}@${workspace.branch ?? ""}`);
  return (
    <WorkspaceServices
      title={heading(workspace, "Services")}
      state={state}
      folder={workspace.folder}
      projectKey={workspace.repoKey}
      stack={stack}
      onOpenSettings={onOpenSettings}
      onStackChanged={refresh}
    />
  );
}

/**
 * One checkout of the project, with everything about it in one place: where it
 * stands in git and in its stack, what is running from it, and the sessions
 * working in it.
 */
function WorkspaceCard({
  workspace,
  sessions,
  services,
  onOpenSession,
  onNewSession,
  onNewTerminal,
}: {
  workspace: Workspace;
  sessions: SidebarSession[];
  services: ServicesState | null;
  onOpenSession: (id: string, opts?: { full?: boolean; option?: boolean }) => void;
  onNewSession: () => void;
  onNewTerminal: () => void;
}) {
  const isRepo = workspace.repoKey.startsWith("repo:");
  const repo = useGitRepo(isRepo ? workspace.folder : "");
  const status = repo.status?.isRepo ? repo.status : null;
  const branch = status ? (status.detached ? `detached ${status.head?.slice(0, 7)}` : status.branch) : workspace.branch;
  const { stack, loading: stackLoading, refresh: refreshStack } = useStack(
    workspace.folder,
    isRepo && status && !status.onBase ? `${status.root}@${status.head}` : null,
  );
  const reading = stack === null && (stackLoading || (isRepo && !repo.status));
  const layers = stack?.layers ?? [];
  const own = layers.find((l) => l.current) ?? null;
  const stacked = layers.length > 1;
  const dirty = status?.files ?? [];
  const added = dirty.reduce((n, f) => n + f.insertions, 0);
  const removed = dirty.reduce((n, f) => n + f.deletions, 0);
  const running = (services?.services ?? []).flatMap((v) =>
    v.checkouts.filter((c) => c.path === workspace.folder).flatMap((c) => (v.sessions.some((x) => x.name === c.session) ? [v.label] : [])),
  );
  const href = `#/workspace/${workspace.id}`;

  return (
    <section className="panel prj-card">
      <header className="prj-card-head">
        <a className="prj-card-title" href={href} title={`Open this workspace: its files, changes and terminals\n${workspace.folder}`}>
          <ProjectMark projectKey={workspace.repoKey} name={workspace.repoName} size={32} />
          <span className="prj-card-name">
            <strong>{workspace.repoName}</strong>
            <span className="prj-card-branch">
              {branch && <GitIcon />}
              {branch ?? home(workspace.folder)}
              {branch && <small>{home(workspace.folder)}</small>}
            </span>
          </span>
        </a>
        <span className="prj-card-actions">
          <button className="icon-btn" onClick={onNewTerminal}>
            <TerminalIcon /> Terminal
          </button>
          <button className="icon-btn primary" onClick={onNewSession}>
            <PlusIcon /> Session
          </button>
          <a className="icon-btn" href={href} title="Open this workspace: its files, changes and terminals">
            <FullPageIcon /> Open
          </a>
        </span>
      </header>

      {reading && (
        <div className="prj-stack-loading" role="status" aria-label="Reading the pull requests of this checkout">
          {[62, 48].map((width) => (
            <div key={width} className="prj-stack-loading-row">
              <span className="prj-stack-loading-dot" />
              <span className="prj-stack-loading-lines">
                <span className="pr-skel" style={{ width: `${width}%` }} />
                <span className="pr-skel" style={{ width: `${width - 22}%` }} />
              </span>
            </div>
          ))}
        </div>
      )}
      {stacked && (
        <StackPanel
          embedded
          stack={stack}
          loading={false}
          shownBranch={null}
          onRefresh={refreshStack}
          onShowLayer={() => {
            window.location.hash = href;
          }}
          onSwitch={async (layer) => {
            const refused = await switchToLayer(workspace.folder, layer);
            if (!refused) {
              repo.refresh();
              refreshStack();
            }
            return refused;
          }}
        />
      )}

      <div className="prj-card-facts">
        {stacked ? null : own?.pr ? (
          <a className="prj-fact link" href={`#/pr/${prParam(own.pr)}`} title={own.pr.title}>
            <PullRequestIcon />
            <b>#{own.pr.number}</b>
            <span className="prj-fact-text">{own.pr.title}</span>
            <DraftBadge isDraft={own.pr.isDraft} />
            <ReviewBadge decision={own.pr.reviewDecision} />
            <CiDot state={own.pr.ciState} />
          </a>
        ) : status && !status.onBase && !reading ? (
          <span className="prj-fact muted">
            <PullRequestIcon /> No pull request yet
          </span>
        ) : null}
        {status && (
          <span
            className={`prj-fact${dirty.length ? "" : " muted"}`}
            title={dirty.length === 0 ? "Every change in this checkout is committed" : "Files changed in this checkout and not committed yet"}
          >
            {dirty.length === 0 ? "Nothing uncommitted" : `${dirty.length} uncommitted file${dirty.length === 1 ? "" : "s"}`}
            {added > 0 && <span className="tok-add">+{added}</span>}
            {removed > 0 && <span className="tok-del">−{removed}</span>}
          </span>
        )}
        {running.length > 0 && (
          <span className="prj-fact" title={running.join(", ")}>
            <i className="svc-dot prj-live" /> {running.length} service{running.length === 1 ? "" : "s"} running
          </span>
        )}
      </div>

      <SessionList sessions={sessions} onOpenSession={onOpenSession} />
    </section>
  );
}

function SessionList({
  sessions,
  onOpenSession,
}: {
  sessions: SidebarSession[];
  onOpenSession: (id: string, opts?: { full?: boolean; option?: boolean }) => void;
}) {
  if (sessions.length === 0) return <p className="prj-none">Nothing running here.</p>;
  return (
    <div className="prj-card-sessions">
      {sessions.map((s) => (
        <button key={s.id} className="wsp-session" onClick={(e) => onOpenSession(s.id, { full: e.metaKey || e.ctrlKey, option: e.altKey })}>
          <span className={`ws-mark${s.service ? ` ws-mark-service svc-${s.health ?? "ok"}` : s.terminal ? "" : ` ws-mark-${s.status}`}`}>{s.service ? <ServiceIcon /> : s.terminal ? <TerminalIcon /> : <ClaudeMark />}</span>
          <span className="wsp-session-text">
            <span className="wsp-session-title">{s.title}</span>
            {s.service && s.why && <span className="wsp-session-why svc-crashed">{s.why}</span>}
            {!s.terminal && <span className="wsp-session-why">{`${s.why ?? STATUS_LABEL[s.status]}${s.model ? ` · ${s.model}` : ""}`}</span>}
          </span>
          <time>{since(s.at)}</time>
        </button>
      ))}
    </div>
  );
}

/** The project's own folder: where it is, and the sessions that run in it rather than in a checkout. */
function ProjectFolderCard({
  project,
  sessions,
  onOpenSession,
  onNewSession,
  onNewTerminal,
}: {
  project: Project;
  sessions: SidebarSession[];
  onOpenSession: (id: string, opts?: { full?: boolean; option?: boolean }) => void;
  onNewSession: () => void;
  onNewTerminal: () => void;
}) {
  return (
    <section className="panel prj-card">
      <header className="prj-card-head">
        <span className="prj-card-title">
          <span className="prj-folder-mark">
            <FolderIcon open />
          </span>
          <span className="prj-card-name">
            <strong>Project folder</strong>
            <span className="prj-card-branch">{project.folder ? home(project.folder) : "Made the first time something needs it"}</span>
          </span>
        </span>
        <span className="prj-card-actions">
          <button className="icon-btn" onClick={onNewTerminal} title="Open a shell in the project's own folder">
            <TerminalIcon /> Terminal
          </button>
          <button className="icon-btn primary" onClick={onNewSession} title="Start a session in the project's own folder, beside its checkouts">
            <PlusIcon /> Session
          </button>
        </span>
      </header>
      <SessionList sessions={sessions} onOpenSession={onOpenSession} />
    </section>
  );
}

/**
 * One project on a page of its own: the checkouts the work is done in and,
 * across all of them, its sessions, tasks, pages and drawings. A project is not
 * tied to a repository, so it may hold checkouts of several or of none.
 */
export function ProjectPage({
  project,
  workspaces,
  sessions,
  sessionHomes,
  artifacts,
  tasks,
  services,
  onBack,
  onOpenSession,
  onNewSession,
  onNewProjectSession,
  onNewProjectTerminal,
  onNewTerminal,
  onNewWorkspace,
  onOpenServiceSettings,
}: {
  project: Project;
  /** The project's checkouts that are not archived. */
  workspaces: Workspace[];
  /** The live sessions in any of them, and those in the project's own folder. */
  sessions: SidebarSession[];
  /** Session id to the workspace holding it. */
  sessionHomes: Record<string, number>;
  artifacts: Artifact[];
  tasks: Task[];
  services: ServicesState | null;
  onBack: () => void;
  onOpenSession: (id: string, opts?: { full?: boolean; option?: boolean }) => void;
  onNewSession: (folder: string, workspaceId: number) => void;
  onNewProjectSession: (projectId: number) => void;
  onNewProjectTerminal: (projectId: number) => void;
  onNewTerminal: (folder: string, workspaceId: number | null) => void;
  onNewWorkspace: (folder: string | undefined, projectId: number) => void;
  onOpenServiceSettings?: () => void;
}) {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY);
      return saved === "services" || saved === "files" ? saved : "overview";
    } catch {
      return "overview";
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
  const markRef = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  const ids = new Set(workspaces.map((w) => w.id));
  const notes = useNotes().notes.filter((n) => n.projectId === project.id);
  const drawings = useDrawings().drawings.filter((d) => d.projectId === project.id || (d.workspaceId !== null && ids.has(d.workspaceId)));
  const repos = [...new Map(workspaces.map((w) => [w.repoKey, w])).values()];
  const inRepo = workspaces.filter((w) => w.repoKey.startsWith("repo:"));
  const homeOf = (s: SidebarSession) => workspaces.find((w) => s.ids.some((id) => sessionHomes[id] === w.id)) ?? null;
  const open = (id: string) => (e: React.MouseEvent) => onOpenSession(id, { full: e.metaKey || e.ctrlKey, option: e.altKey });
  const openTasks = tasks.filter((t) => t.completedAt === null).length;
  const waiting = sessions.filter((s) => s.status === "needs").length;
  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "overview", label: "Overview", count: 0 },
    ...(project.folder ? [{ key: "files" as const, label: "Files", count: 0 }] : []),
    { key: "services", label: "Services", count: 0 },
  ];
  const [fileTabKey, setFileTabKey] = useState("folder");

  return (
    <div className="page workspace-page project-page">
      <div className="page-head wsp-head">
        <button className="icon-btn" onClick={onBack}>
          ← Back
        </button>
        <div className="wsp-head-text">
          {project.generalKey ? (
            <h1>{project.name}</h1>
          ) : (
            <EditableTitle
              as="h1"
              value={project.name}
              placeholder="Project"
              onRename={async (name) => {
                await workspaceApi.renameProject(project.id, name);
              }}
            />
          )}
          <p className="page-sub wsp-project-line">
            <button ref={markRef} className="wsp-project-marks" title="Change the project's icon" onClick={() => setPicking(true)}>
              {hasOwnMark(project) ? (
                <OwnProjectMark project={project} />
              ) : repos.length === 0 ? (
                <FolderIcon />
              ) : (
                repos.map((w) => <ProjectMark key={w.repoKey} projectKey={w.repoKey} name={w.repoName} />)
              )}
            </button>
            {project.generalKey ? "Work in this repository that is part of no project" : "Project"} · {workspaces.length} workspace
            {workspaces.length === 1 ? "" : "s"}
          </p>
          {picking && markRef.current && (
            <ProjectMarkPicker anchor={markRef.current} goal={project} name={project.name} onClose={() => setPicking(false)} />
          )}
        </div>
        {project.archivedAt ? (
          <button className="icon-btn primary prj-archive" onClick={() => void workspaceApi.unarchiveProject(project.id).catch(() => {})}>
            <PlayIcon /> Bring back
          </button>
        ) : (
          <button
            className="icon-btn prj-archive"
            title="Put this project away: its checkouts are archived and its notes, drawings and pages drop out of the lists. Nothing is deleted."
            onClick={() => {
              if (sessions.length > 0 && !window.confirm(`Archive “${project.name}”? Its running sessions will be ended.`)) return;
              void workspaceApi.archiveProject(project.id).then(onBack).catch(() => {});
            }}
          >
            <ArchiveIcon /> Archive
          </button>
        )}
        <dl className="wsp-facts">
          <div>
            <dt>Sessions</dt>
            <dd>
              {sessions.filter((s) => !s.terminal).length || "None"}
              {waiting > 0 && <em className="prj-waiting">{waiting} waiting on you</em>}
            </dd>
          </div>
          <div>
            <dt>Tasks</dt>
            <dd>{openTasks > 0 ? `${openTasks} open` : "None open"}</dd>
          </div>
          <div>
            <dt>Drawings</dt>
            <dd>{drawings.length || "None"}</dd>
          </div>
        </dl>
      </div>

      {project.archivedAt && (
        <p className="prj-archived-note">This project is archived. Its notes, drawings and pages are kept, and left out of the lists until you bring it back.</p>
      )}
      <div className="pr-tabs wsp-tabs" role="tablist">
        {tabs.map((t) => (
          <a key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? "on" : ""} onClick={() => pick(t.key)}>
            {t.label}
            {t.count > 0 && <em>{t.count}</em>}
          </a>
        ))}
      </div>

      {tab === "overview" && (
        <div className="prj-layout">
          <div className="prj-main">
            <div className="prj-section-head">
              <h2>Workspaces</h2>
              <button className="icon-btn" onClick={() => onNewWorkspace(undefined, project.id)}>
                <PlusIcon /> Add a workspace
              </button>
            </div>
            {!project.generalKey && (
              <ProjectFolderCard
                project={project}
                sessions={sessions.filter((s) => homeOf(s) === null)}
                onOpenSession={onOpenSession}
                onNewSession={() => onNewProjectSession(project.id)}
                onNewTerminal={() => onNewProjectTerminal(project.id)}
              />
            )}
            {workspaces.length === 0 && (
              <div className="prj-empty">
                <strong>No checkout yet</strong>
                <span>Add one for each repository this work touches, or keep the project for drawings and notes alone.</span>
              </div>
            )}
            {workspaces.map((w) => (
              <WorkspaceCard
                key={w.id}
                workspace={w}
                sessions={sessions.filter((s) => homeOf(s)?.id === w.id)}
                services={services}
                onOpenSession={onOpenSession}
                onNewSession={() => onNewSession(w.folder, w.id)}
                onNewTerminal={() => onNewTerminal(w.folder, w.id)}
              />
            ))}
          </div>

          <aside className="prj-side">
            <section className="panel prj-box">
              <div className="panel-head">
                <h2>
                  Notes
                  {notes.length > 0 && <em>{notes.length}</em>}
                </h2>
                <button
                  className="icon-btn"
                  onClick={() => {
                    const title = window.prompt("Name the note");
                    if (!title?.trim()) return;
                    void noteApi
                      .create({ title: title.trim(), folder: `projects/${noteSlug(project.name) || "project"}`, projectId: project.id })
                      .then((r) => onOpenSession(noteKey(r.note.path), { full: true }))
                      .catch(() => {});
                  }}
                >
                  <PlusIcon /> New
                </button>
              </div>
              {notes.length === 0 && <p className="prj-none">No notes yet. Link one from the Notes page, or start one here.</p>}
              {notes.map((n) => (
                <div key={n.path} className="prj-item">
                  <button className="wsp-session wsp-artifact" title={n.path} onClick={open(noteKey(n.path))}>
                    <span className="ws-mark">
                      <DocIcon />
                    </span>
                    <span className="wsp-session-title">{n.title}</span>
                  </button>
                  <ItemActions
                    label={`Actions for ${n.title}`}
                    items={[
                      ...(n.via ? [] : [{ label: "Take it out of every project", run: () => noteApi.update(n.path, { projectId: null }) }]),
                      { label: "Move to trash", danger: true, confirm: `Move “${n.title}” to the trash?`, run: () => noteApi.remove(n.path) },
                    ]}
                  />
                </div>
              ))}
            </section>

            <section className="panel prj-box">
              <div className="panel-head">
                <h2>
                  Drawings
                  {drawings.length > 0 && <em>{drawings.length}</em>}
                </h2>
                <button
                  className="icon-btn"
                  onClick={() =>
                    void drawingApi
                      .create({ projectId: project.id })
                      .then((r) => onOpenSession(drawingKey(r.drawing.slug), { full: true }))
                      .catch(() => {})
                  }
                >
                  <PlusIcon /> New
                </button>
              </div>
              {drawings.length === 0 ? (
                <p className="prj-none">No whiteboards yet.</p>
              ) : (
                <div className="drawing-grid compact">
                  {drawings.map((d) => (
                    <div key={d.slug} className="prj-item card">
                      <DrawingCard drawing={d} onOpen={(opts) => onOpenSession(drawingKey(d.slug), opts)} />
                      <ItemActions
                        label={`Actions for ${d.title}`}
                        items={[
                          { label: "Take it out of every project", run: () => drawingApi.update(d.slug, { projectId: null }) },
                          { label: "Delete…", danger: true, confirm: `Delete “${d.title}” for good?`, run: () => drawingApi.remove(d.slug) },
                        ]}
                      />
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="panel prj-box">
              <div className="panel-head">
                <h2>
                  Tasks
                  {openTasks > 0 && <em>{openTasks} open</em>}
                </h2>
              </div>
              <TaskQuickAdd label="Add a task to this project" placeholder="Add a task…  review PR friday 9:00 p1" onAdd={(text) => taskApi.add({ text, workProjectId: project.id })} />
              {tasks.length === 0 && <p className="prj-none">None tied to this project or its workspaces.</p>}
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
                    <ItemActions label={`Actions for ${t.content}`} items={taskActions(taskApi, t, "Take it out of this project")} />
                  </div>
                );
              })}
            </section>

            <section className="panel prj-box">
              <div className="panel-head">
                <h2>
                  Artifacts
                  {artifacts.length > 0 && <em>{artifacts.length}</em>}
                </h2>
              </div>
              {artifacts.length === 0 && <p className="prj-none">Pages its sessions write land here.</p>}
              {artifacts.map((a) => (
                <div key={a.slug} className="prj-item">
                  <button className="wsp-session wsp-artifact" title={a.title} onClick={open(artifactKey(a.slug))}>
                    <span className="ws-mark">
                      <ArtifactIcon />
                    </span>
                    <span className="wsp-session-title">{a.title}</span>
                  </button>
                  <ItemActions
                    label={`Actions for ${a.title}`}
                    items={[
                      { label: "Take it out of every project", run: () => artifactApi.link(a.slug, { projectId: null, workspaceId: null }) },
                      { label: "Hide from the lists", run: () => artifactApi.hide(a.slug, true) },
                      { label: "Delete…", danger: true, confirm: `Delete “${a.title}” and its files for good?`, run: () => artifactApi.remove(a.slug) },
                    ]}
                  />
                </div>
              ))}
            </section>
          </aside>
        </div>
      )}

      {tab === "files" && project.folder && (
        <div className="prj-files">
          <Workbench
            workspaceId={-project.id}
            cwd={project.folder}
            views={[
              {
                key: "folder",
                label: "Folder",
                render: () => (
                  <div className="prj-files-home">
                    <strong>{home(project.folder!)}</strong>
                    <span>
                      The project's own folder: its notes, drawings and artifacts, and a folder for each checkout. Pick a file on the left, or
                      search: that covers the checkouts too, leaving out what their .gitignore leaves out.
                    </span>
                  </div>
                ),
              },
            ]}
            active={fileTabKey}
            onActive={setFileTabKey}
            changed={NO_CHANGES}
            stamp={`${notes.length}:${drawings.length}:${artifacts.length}:${workspaces.length}`}
            terminals={sessions.filter((s) => s.terminal && !s.service && homeOf(s) === null).map((s) => ({ id: s.id, title: s.title }))}
            onNewTerminal={() => onNewProjectTerminal(project.id)}
          />
        </div>
      )}

      {tab === "services" && (
        <div className="wsp-main">
          {inRepo.length === 0 && <p className="hint">This project has no checkout to run services from.</p>}
          {inRepo.map((w) => (
            <WorkspaceServicesPanel key={w.id} workspace={w} state={services} onOpenSettings={onOpenServiceSettings} />
          ))}
        </div>
      )}
    </div>
  );
}
