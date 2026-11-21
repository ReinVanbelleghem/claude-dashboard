import { ItemActions, taskActions } from "./ItemActions.tsx";
import { TaskQuickAdd } from "./tasks/TaskQuickAdd.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { artifactApi, drawingApi, gitApi, taskApi, workspaceApi, type Artifact, type ChangedFile, type Settings } from "../api.ts";
import type { Task } from "../../shared/tasks.ts";
import { artifactKey } from "../../shared/artifacts.ts";
import { drawingKey } from "../../shared/drawings.ts";
import { DrawingCard, useDrawings } from "./DrawingsView.tsx";
import { workspaceTitle, type Project, type Workspace } from "../../shared/workspaces.ts";
import { EditableTitle } from "./EditableTitle.tsx";
import { GitControls } from "./GitControls.tsx";
import { GitGraph } from "./GitGraph.tsx";
import { GitPanel } from "./GitPanel.tsx";
import { ArchiveIcon, ArtifactIcon, CheckIcon, ClaudeMark, FolderIcon, GitIcon, MoreVerticalIcon, PlayIcon, PlusIcon, ServiceIcon, TerminalIcon, TrashIcon } from "./Icons.tsx";
import { Popover } from "./Popover.tsx";
import { ProjectMark } from "./ProjectMark.tsx";
import { DeleteWorkspaceDialog } from "./sidebar/DeleteWorkspaceDialog.tsx";
import { STATUS_LABEL, type SidebarSession } from "./sidebar/sessions.ts";
import { StackPanel, switchToLayer, useStack } from "./StackPanel.tsx";
import { isFileTab, Workbench } from "./workbench/Workbench.tsx";
import { WorkspaceServices } from "./services/WorkspaceServices.tsx";
import type { ServicesState } from "../../shared/services.ts";
import { rangeOfLayer, type StackLayer } from "../../shared/stacks.ts";
import { useGitRepo } from "./useGitRepo.ts";


/** The layer whose changes are on screen: one you picked, the whole branch (null), or the checkout's own (undefined). */
type Picked = StackLayer | null | undefined;
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
  services,
  onOpenServiceSettings,
  project,
  siblings,
}: {
  /** The project this checkout is part of. */
  project: Project | null;
  /** How many other checkouts that project has. */
  siblings: number;
  /** The dev services and what is running of them, for the ones this workspace's repository has. */
  services: ServicesState | null;
  onOpenServiceSettings?: () => void;
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
  const { stack, loading: stackLoading, refresh: refreshStack } = useStack(workspace.folder, branchKey);
  const layers = stack?.layers ?? [];
  const ownLayer = layers.find((l) => l.current) ?? null;
  /** Mid-stack, the checkout's own changes are those over the layer below, not over trunk. */
  const ownRange = ownLayer && ownLayer.baseRef && ownLayer.baseRef !== status?.base ? rangeOfLayer(ownLayer) : null;
  const [picked, setPicked] = useState<Picked>(undefined);
  useEffect(() => setPicked(undefined), [workspace.id]);
  const shownLayer = picked === undefined ? (ownRange ? ownLayer : null) : picked;
  const shownRange = useMemo(() => {
    const between = shownLayer ? rangeOfLayer(shownLayer) : null;
    if (!between || !shownLayer) return null;
    return { ...between, label: shownLayer.pr ? `#${shownLayer.pr.number}` : shownLayer.current ? "This layer" : shownLayer.branch };
  }, [shownLayer?.branch, shownLayer?.ref, shownLayer?.baseRef, shownLayer?.pr?.number, shownLayer?.current]);
  const clearRange = useCallback(() => setPicked(null), []);
  const ownBase = ownRange?.base ?? null;
  const ownHead = ownRange?.head ?? null;
  useEffect(() => {
    if (!branchKey) return setBranchFiles([]);
    let alive = true;
    gitApi
      .branchFiles(workspace.folder, ownBase && ownHead ? { base: ownBase, head: ownHead } : null)
      .then((r) => alive && setBranchFiles(r.files))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [branchKey, workspace.folder, ownBase, ownHead]);
  const onBranch = ownRange ? ownLayer!.commits : (status?.aheadOfBase ?? 0);
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

  const [tab, setTab] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY);
      if (saved === "stack") return "git";
      return saved && (isFileTab(saved) || ["sessions", "git", "services"].includes(saved)) ? saved : "changes";
    } catch {
      return "changes";
    }
  });
  const [codeTab, setCodeTab] = useState<string>(() => (isFileTab(tab) ? tab : "changes"));
  const pick = useCallback((next: string) => {
    setTab(next);
    if (next === "changes" || isFileTab(next)) setCodeTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      return;
    }
  }, []);
  const changedPaths = useMemo(
    () => new Map((repo.status?.files ?? []).map((f) => [f.path, f.untracked ? "?" : f.status])),
    [repo.status?.files],
  );
  const drawings = useDrawings().drawings.filter((d) => d.workspaceId === workspace.id);
  const [deleting, setDeleting] = useState(false);

  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const servicesRunning = (services?.sessions ?? []).filter((x) =>
    (services?.services ?? []).some((v) => v.checkouts.some((c) => c.path === workspace.folder && c.session === x.name)),
  ).length;
  const chats = sessions.filter((s) => !s.terminal);
  const shells = sessions.filter((s) => s.terminal && !s.service);
  const running = sessions.filter((s) => s.service);
  const inCode = tab === "changes" || isFileTab(tab);
  const inCodeRef = useRef(inCode);
  inCodeRef.current = inCode;
  const pickCode = useCallback((next: string) => (inCodeRef.current ? pick(next) : setCodeTab(next)), [pick]);
  const tabs: { key: string; label: string; count: number; on: boolean }[] = [
    { key: "sessions", label: "Overview", count: 0, on: tab === "sessions" },
    { key: codeTab, label: "Code", count: uncommitted.length, on: inCode },
    { key: "git", label: "Git", count: status?.ahead ?? 0, on: tab === "git" },
    { key: "services", label: "Services", count: servicesRunning, on: tab === "services" },
  ];

  const changes = (
    <div className="wsp-main">
      <GitPanel
        key={workspace.folder}
        repo={repo}
        settings={settings}
        onSettings={onSettings}
        targets={targets}
        onOpenSession={openTarget}
        range={shownRange}
        onClearRange={clearRange}
      />
    </div>
  );
  const body = (
    <>
      {tab === "services" && (
        <div className="wsp-main">
          <WorkspaceServices
            state={services}
            folder={workspace.folder}
            projectKey={workspace.repoKey}
            stack={stack}
            onOpenSettings={onOpenServiceSettings}
            onStackChanged={refreshStack}
          />
        </div>
      )}

      {tab === "sessions" && (
        <div className="prj-layout">
          <div className="prj-main">
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
              {[...shells, ...running].map((s) => (
                <button key={s.id} className="wsp-session" onClick={(e) => onOpenSession(s.id, { full: e.metaKey || e.ctrlKey, option: e.altKey })}>
                  <span className={`ws-mark${s.service ? ` ws-mark-service svc-${s.health ?? "ok"}` : ""}`}>{s.service ? <ServiceIcon /> : <TerminalIcon />}</span>
                  <span className="wsp-session-text">
                    <span className="wsp-session-title">{s.title}</span>
                    {s.service && s.why && <span className="wsp-session-why svc-crashed">{s.why}</span>}
                  </span>
                  <time>{since(s.at)}</time>
                </button>
              ))}
            </section>
            {layers.length > 0 && (
              <StackPanel
                stack={stack}
                loading={stackLoading}
                shownBranch={null}
                onRefresh={refreshStack}
                onShowLayer={(layer) => {
                  setPicked(layer);
                  pick("changes");
                }}
                onOpenCheckout={onOpenWorktree}
                onSwitch={async (layer) => {
                  const refused = await switchToLayer(workspace.folder, layer);
                  if (refused) return refused;
                  setPicked(undefined);
                  repo.refresh();
                  refreshStack();
                  return null;
                }}
              />
            )}
            {servicesRunning > 0 && (
              <button className="prj-fact wsp-running" onClick={() => pick("services")}>
                <i className="svc-dot prj-live" /> {servicesRunning} service{servicesRunning === 1 ? "" : "s"} running
                {running.some((r) => r.health && r.health !== "ok") && (
                  <em className="svc-crashed-note">{running.filter((r) => r.health && r.health !== "ok").length} crashed</em>
                )}
              </button>
            )}
          </div>
          <aside className="prj-side">
            <section className="panel">
              <div className="panel-head">
                <h2>Tasks</h2>
              </div>
              <TaskQuickAdd label="Add a task to this workspace" placeholder="Add a task…  review PR friday 9:00 p1" onAdd={(text) => taskApi.add({ text, workspaceId: workspace.id })} />
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
                    <ItemActions label={`Actions for ${t.content}`} items={taskActions(taskApi, t, "Take it out of this workspace")} />
                  </div>
                );
              })}
            </section>
            <section className="panel">
              <div className="panel-head">
                <h2>Artifacts</h2>
              </div>
              {artifacts.length === 0 && <p className="wsp-none">Pages the sessions in this workspace write show up here.</p>}
              {artifacts.map((a) => (
                <div key={a.slug} className="prj-item">
                  <button className="wsp-session wsp-artifact" title={a.title} onClick={(e) => onOpenSession(artifactKey(a.slug), { full: e.metaKey || e.ctrlKey, option: e.altKey })}>
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
            <section className="panel">
              <div className="panel-head">
                <h2>Drawings</h2>
                <span className="wsp-panel-actions">
                  <button
                    className="icon-btn"
                    onClick={() =>
                      void drawingApi
                        .create({ workspaceId: workspace.id })
                        .then((r) => onOpenSession(drawingKey(r.drawing.slug), { full: true }))
                        .catch(() => {})
                    }
                  >
                    <PlusIcon /> New drawing
                  </button>
                </span>
              </div>
              {drawings.length === 0 && <p className="wsp-none">Whiteboards for this workspace. A session can write one too.</p>}
              {drawings.length > 0 && (
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
          </aside>
        </div>
      )}

      {tab === "git" && (
        <div className="wsp-git">
          <GitControls repo={repo} agentKey={driven} onOpenWorktree={onOpenWorktree} />
          {layers.length > 0 && (
            <StackPanel
              stack={stack}
              loading={stackLoading}
              shownBranch={shownLayer?.branch ?? null}
              onRefresh={refreshStack}
              onShowLayer={(layer) => {
                setPicked(layer);
                pick("changes");
              }}
              onOpenCheckout={onOpenWorktree}
              onSwitch={async (layer) => {
                const refused = await switchToLayer(workspace.folder, layer);
                if (refused) return refused;
                setPicked(undefined);
                repo.refresh();
                refreshStack();
                return null;
              }}
            />
          )}
          <div className="panel wsp-graph">
            <GitGraph cwd={workspace.folder} />
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="page workspace-page wb-page">
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
          <p className="page-sub wsp-project-line">
            <ProjectMark projectKey={workspace.repoKey} name={workspace.repoName} />
            {workspace.repoName} · {workspace.folder.replace(/^\/Users\/[^/]+/, "~")}
          </p>
          {project && (
            <div className="wsp-links">
              <a className="wsp-link-add" href={`#/project/${project.id}`} title="Everything this project holds, across its checkouts">
                <FolderIcon /> {project.name}
                {siblings > 0 && <em>+{siblings} more workspace{siblings === 1 ? "" : "s"}</em>}
              </a>
            </div>
          )}
        </div>
        {status && (
          <dl className="wsp-facts">
            <div title={status.base && !status.onBase ? `${status.branch ?? "detached"} is compared with ${status.base}` : undefined}>
              <dt>Branch</dt>
              <dd>
                <GitIcon />
                {status.detached ? `detached ${status.head?.slice(0, 7)}` : status.branch}
                {status.base && !status.onBase && <em>→ {ownRange ? ownLayer!.baseBranch : status.base}</em>}
              </dd>
            </div>
            {status.base && !status.onBase && (
              <div>
                <dt>On this branch</dt>
                <dd>
                  {onBranch} commit{onBranch === 1 ? "" : "s"}
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
          <a key={t.label} role="tab" aria-selected={t.on} className={t.on ? "on" : ""} onClick={() => pick(t.key)}>
            {t.label}
            {t.count > 0 && <em>{t.count}</em>}
          </a>
        ))}
      </div>

      <div className="wsp-code" style={{ display: inCode ? "contents" : "none" }}>
        <Workbench
          workspaceId={workspace.id}
          cwd={workspace.folder}
          views={[{ key: "changes", label: "Changes", count: uncommitted.length, render: () => changes }]}
          active={codeTab}
          onActive={pickCode}
          changed={changedPaths}
          stamp={`${status?.head ?? ""}|${uncommitted.map((f) => `${f.path}:${f.status}`).join(",")}`}
          terminals={shells.map((t) => ({ id: t.id, title: t.title }))}
          onNewTerminal={() => onNewTerminal(workspace.folder, workspace.id)}
        />
      </div>
      {!inCode && <div className="wb-view wsp-view">{body}</div>}
    </div>
  );
}
