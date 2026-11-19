import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { calendarApi, taskApi, type CalendarEvent, type Task, type TaskProject, type TasksPayload, type Workspace } from "../../api.ts";
import { replyOf } from "../../../shared/calendar.ts";
import { addDays, describeRecurrence, localDay, parseQuickAdd, weekdayOf } from "../../../shared/taskDates.ts";
import { cleanLinks, linkInfo, MAX_TASK_LINKS } from "../../../shared/taskLinks.ts";
import { TASK_COLORS, type TaskColor } from "../../../shared/tasks.ts";
import { TitleEditInput } from "../EditableTitle.tsx";
import { FolderPicker } from "../FolderPicker.tsx";
import { useSortable, type Sortable } from "../../useSortable.ts";
import { Popover } from "../Popover.tsx";
import { DatePicker } from "../DatePicker.tsx";
import { ServiceMark } from "./ServiceMark.tsx";
import { TaskModal } from "../calendar/EventModal.tsx";
import { workspaceTitle } from "../../../shared/workspaces.ts";
import {
  CalendarIcon,
  CheckIcon,
  ChevronIcon,
  ClockIcon,
  ExternalIcon,
  GitIcon,
  InboxIcon,
  MoreVerticalIcon,
  PencilIcon,
  PlusIcon,
  RepeatIcon,
  TasksIcon,
  TrashIcon,
  WorktreeIcon,
  XIcon,
} from "../Icons.tsx";

const FOCUS_DELAY_MS = 80;

type View = { kind: "today" } | { kind: "upcoming" } | { kind: "project"; id: number };

const PRIORITY_LABEL = ["", "Priority 1", "Priority 2", "Priority 3", "No priority"];

const COLOR_NAMES = Object.keys(TASK_COLORS) as TaskColor[];
const FALLBACK_COLORS: TaskColor[] = ["blue", "orange", "green", "yellow", "purple", "teal"];
/** The dot's colour: the one picked for the project, else one that stays put for its id. */
const colorOf = (p: Pick<TaskProject, "id" | "color"> | undefined): string => {
  if (!p) return TASK_COLORS.grey;
  const picked = p.color && p.color in TASK_COLORS ? (p.color as TaskColor) : FALLBACK_COLORS[p.id % FALLBACK_COLORS.length]!;
  return TASK_COLORS[picked];
};

/** "repo:/Users/me/src/backend/.git" reads as "backend". */
const repoName = (key: string) => key.replace(/^repo:/, "").replace(/\/\.git$/, "").split("/").pop() ?? key;

const byDue = (a: Task, b: Task) =>
  (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") ||
  (a.dueTime ?? "99").localeCompare(b.dueTime ?? "99") ||
  a.priority - b.priority ||
  a.order - b.order;

function dayLabel(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === addDays(today, 1)) return "Tomorrow";
  if (day === addDays(today, -1)) return "Yesterday";
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y!, m! - 1, d!);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(y !== Number(today.slice(0, 4)) ? { year: "numeric" } : {}),
  });
}

/**
 * The to-do list: what is due today, what is coming, and each project's tasks.
 * One line adds a task, read the way it is typed ("review PR friday 9:00 p1
 * #backend"), with what was understood shown under the field before it is saved.
 */
const DRAFT_KEY = "tasks-add-draft";
const readDraft = () => {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
};

export function TasksView({
  payload,
  workspaces,
  onStartWorkspace,
  onOpenWorkspace,
  focusTaskId = null,
  onFocused,
  calendarHidden,
  onOpenCalendar,
}: {
  /** Calendars switched off in the calendar, left out of today's meetings here too. */
  calendarHidden: string[];
  onOpenCalendar: () => void;
  /** A task to bring into view: its project opens and its row is scrolled to and flashed. */
  focusTaskId?: number | null;
  onFocused?: () => void;
  payload: TasksPayload | null;
  workspaces: Workspace[];
  /** Start a workspace for this task: the dialog opens with the task as its goal. */
  onStartWorkspace: (task: Task) => void;
  onOpenWorkspace: (workspace: Workspace) => void;
}) {
  const [view, setView] = useState<View>({ kind: "upcoming" });
  const focusProjectId = focusTaskId === null ? undefined : payload?.tasks.find((t) => t.id === focusTaskId)?.projectId;

  useEffect(() => {
    if (focusTaskId === null || focusProjectId === undefined) return;
    setView({ kind: "project", id: focusProjectId });
    const timer = window.setTimeout(() => {
      const row = document.querySelector<HTMLElement>(`[data-task-id="${focusTaskId}"]`);
      row?.scrollIntoView({ block: "center" });
      row?.classList.add("flash");
      window.setTimeout(() => row?.classList.remove("flash"), 1800);
      onFocused?.();
    }, FOCUS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [focusTaskId, focusProjectId, onFocused]);
  const [draft, setDraftState] = useState(readDraft);
  const setDraft = (next: string) => {
    setDraftState(next);
    try {
      if (next) localStorage.setItem(DRAFT_KEY, next);
      else localStorage.removeItem(DRAFT_KEY);
    } catch {
      return;
    }
  };
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const openTask = openId === null ? null : (payload?.tasks.find((t) => t.id === openId) ?? null);
  const [showDone, setShowDone] = useState(false);
  const [newProject, setNewProject] = useState<string | null>(null);
  const [addToId, setAddToId] = useState<number | null>(null);
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const namedWorkspaces = workspaces.filter((w) => w.status === "active" && (w.explicit || w.goal.trim() !== ""));
  const addTo = namedWorkspaces.find((w) => w.id === addToId) ?? null;
  const [projectMenu, setProjectMenu] = useState<{ anchor: HTMLElement; project: TaskProject } | null>(null);
  const [renamingProject, setRenamingProject] = useState<number | null>(null);
  const [tying, setTying] = useState<TaskProject | null>(null);

  const today = localDay(new Date());
  const projects = payload?.projects ?? [];
  const tasks = useMemo(
    () => (payload?.tasks ?? []).map((t) => (Array.isArray(t.links) ? t : { ...t, links: [] })),
    [payload],
  );
  const open = useMemo(() => tasks.filter((t) => t.completedAt === null), [tasks]);
  const projectName = (id: number) => projects.find((p) => p.id === id)?.name ?? "";
  const projectColor = (id: number) => colorOf(projects.find((p) => p.id === id));
  const workspaceOf = (t: Task) => workspaces.find((w) => w.id === t.workspaceId) ?? null;
  const dueNow = open.filter((t) => t.dueDate !== null && t.dueDate <= today);
  const currentProject = view.kind === "project" ? (projects.find((p) => p.id === view.id) ?? null) : null;

  const groups: { title: string | null; overdue?: boolean; tasks: Task[] }[] = (() => {
    const late = dueNow.filter((t) => t.dueDate! < today).sort(byDue);
    const now = dueNow.filter((t) => t.dueDate === today).sort(byDue);
    if (view.kind === "today") {
      return [
        ...(late.length ? [{ title: "Overdue", overdue: true, tasks: late }] : []),
        { title: late.length ? "Today" : null, tasks: now },
      ];
    }
    if (view.kind === "upcoming") {
      const later = open.filter((t) => t.dueDate !== null && t.dueDate > today).sort(byDue);
      const days = [...new Set(later.map((t) => t.dueDate!))];
      return [
        ...(late.length ? [{ title: "Overdue", overdue: true, tasks: late }] : []),
        ...(now.length ? [{ title: "Today", tasks: now }] : []),
        ...days.map((day) => ({ title: dayLabel(day, today), tasks: later.filter((t) => t.dueDate === day) })),
      ];
    }
    const mine = open.filter((t) => t.projectId === view.id);
    return [{ title: null, tasks: mine.sort(byDue) }];
  })();
  const shown = groups.reduce((n, g) => n + g.tasks.length, 0);
  const done = tasks
    .filter((t) => t.completedAt !== null && (view.kind !== "project" || t.projectId === view.id))
    .sort((a, b) => b.completedAt! - a.completedAt!);

  const preview = draft.trim() ? parseQuickAdd(draft.trim()) : null;

  const add = async () => {
    const text = draft.trim();
    if (!text) return;
    setError(null);
    try {
      await taskApi.add({
        text,
        ...(currentProject && !preview?.project ? { projectId: currentProject.id } : {}),
        ...(view.kind === "today" && !preview?.due ? { due: "today" } : {}),
        ...(addTo ? { workspaceId: addTo.id } : {}),
      });
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const week = Array.from({ length: 7 }, (_, i) => addDays(today, i + 1)).map((day) => ({
    day,
    tasks: open.filter((t) => t.dueDate === day).sort(byDue),
  }));
  const overdueCount = dueNow.filter((t) => t.dueDate! < today).length;
  const upcomingCount = open.filter((t) => t.dueDate !== null).length;
  const title = view.kind === "today" ? "Today" : view.kind === "upcoming" ? "Upcoming" : (currentProject?.name ?? "Project");
  const subtitle =
    view.kind === "today"
      ? `${new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}${shown ? ` · ${shown} task${shown === 1 ? "" : "s"}` : ""}`
      : view.kind === "upcoming"
        ? shown
          ? `${shown} scheduled task${shown === 1 ? "" : "s"}`
          : "Nothing scheduled"
        : `${shown} open${done.length ? ` · ${done.length} completed this week` : ""}`;
  const emptyState =
    view.kind === "today"
      ? { head: "All clear for today", hint: "Nothing is due. Add a task above, or check Upcoming." }
      : view.kind === "upcoming"
        ? { head: "Nothing scheduled", hint: "Every task with a date shows up here, grouped by day, starting with today." }
        : { head: `No open tasks in ${currentProject?.name ?? "this project"}`, hint: "Add one above. It lands here unless you name another #project." };

  const sortableProjects = projects.filter((p) => !p.isInbox);
  const projectList = useRef<HTMLDivElement>(null);
  const projectDrag = useSortable({
    count: sortableProjects.length,
    listRef: projectList,
    itemSelector: ".tasks-view.sortable",
    onMove: (from, to) => {
      const ids = sortableProjects.map((p) => p.id);
      const [moved] = ids.splice(from, 1);
      ids.splice(to, 0, moved!);
      void taskApi.reorderProjects(ids).catch((err: Error) => setError(err.message));
    },
  });

  const viewButton = (
    v: View,
    label: string,
    count: number,
    key: string,
    icon: React.ReactNode,
    alert = false,
    sort?: { handle: ReturnType<Sortable["handleProps"]>; style: CSSProperties | undefined; dragging: boolean },
    onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void,
  ) => {
    const on = v.kind === view.kind && (v.kind !== "project" || (view.kind === "project" && view.id === v.id));
    return (
      <button
        key={key}
        className={`tasks-view ${on ? "on" : ""}${sort ? " sortable" : ""}${sort?.dragging ? " dragging" : ""}`}
        style={sort?.style}
        aria-current={on ? "page" : undefined}
        onClick={() => setView(v)}
        onContextMenu={onContextMenu}
        {...sort?.handle}
      >
        <span className="tasks-view-icon">{icon}</span>
        <span className="tasks-view-name">{label}</span>
        {count > 0 && <span className={`tasks-view-count${alert ? " alert" : ""}`}>{count}</span>}
      </button>
    );
  };

  return (
    <div className="tasks">
      <aside className="tasks-side panel" aria-label="Task views">
        {viewButton({ kind: "upcoming" }, "Upcoming", upcomingCount, "upcoming", <ClockIcon />, overdueCount > 0)}
        {viewButton({ kind: "today" }, "Today", dueNow.length, "today", <CalendarIcon />, overdueCount > 0)}
        <div className="tasks-side-label">Projects</div>
        {projects
          .filter((p) => p.isInbox)
          .map((p) => viewButton({ kind: "project", id: p.id }, p.name, open.filter((t) => t.projectId === p.id).length, `p${p.id}`, <InboxIcon />))}
        <div className="tasks-projects" ref={projectList}>
          {sortableProjects.map((p, i) =>
            renamingProject === p.id ? (
              <div key={`p${p.id}`} className="tasks-view on sortable renaming">
                <span className="tasks-view-icon">
                  <i className="tasks-dot" style={{ background: colorOf(p) }} />
                </span>
                <span className="tasks-view-name">
                  <TitleEditInput
                    initial={p.name}
                    onCancel={() => setRenamingProject(null)}
                    onCommit={(name) => {
                      setRenamingProject(null);
                      if (name && name !== p.name) void taskApi.updateProject(p.id, { name }).catch((err: Error) => setError(err.message));
                    }}
                  />
                </span>
              </div>
            ) : (
              viewButton(
                { kind: "project", id: p.id },
                p.name,
                open.filter((t) => t.projectId === p.id).length,
                `p${p.id}`,
                <i className="tasks-dot" style={{ background: colorOf(p) }} />,
                false,
                { handle: projectDrag.handleProps(i), style: projectDrag.itemStyle(i), dragging: projectDrag.active === i },
                (e) => {
                  e.preventDefault();
                  setProjectMenu({ anchor: e.currentTarget, project: p });
                },
              )
            ),
          )}
        </div>
        {newProject !== null ? (
          <input
            className="search tasks-new-project"
            autoFocus
            value={newProject}
            placeholder="Project name"
            aria-label="New project name"
            onChange={(e) => setNewProject(e.target.value)}
            onBlur={() => setNewProject(null)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setNewProject(null);
              if (e.key !== "Enter" || !newProject.trim()) return;
              void taskApi
                .addProject(newProject.trim())
                .then((r) => setView({ kind: "project", id: r.project.id }))
                .catch((err: Error) => setError(err.message));
              setNewProject(null);
            }}
          />
        ) : (
          <button className="tasks-view tasks-view-new" onClick={() => setNewProject("")}>
            <span className="tasks-view-icon">
              <PlusIcon />
            </span>
            <span className="tasks-view-name">New project</span>
          </button>
        )}
      </aside>

      <section className="tasks-main panel">
        <header className="tasks-head">
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          {currentProject && !currentProject.isInbox && (
            <button
              className="icon-btn tiny tasks-head-action"
              title="Delete this project. Its open tasks move to the Inbox."
              onClick={() => {
                void taskApi.removeProject(currentProject.id).catch((err: Error) => setError(err.message));
                setView({ kind: "upcoming" });
              }}
            >
              <TrashIcon />
              Delete project
            </button>
          )}
        </header>

        <div className={`tasks-add${draft.trim() ? " filled" : ""}`}>
          <span className="tasks-add-icon">
            <PlusIcon />
          </span>
          <input
            value={draft}
            placeholder="Add a task…  review PR friday 9:00 p1 #backend"
            aria-label="Add a task"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void add()}
          />
          <button
            className={`tasks-add-ws${addTo ? " on" : ""}`}
            title={addTo ? `New tasks go into ${workspaceTitle(addTo)}` : "Put new tasks in a workspace"}
            onClick={(e) => setAddAnchor(e.currentTarget)}
          >
            <WorktreeIcon />
            {addTo && <span>{workspaceTitle(addTo)}</span>}
          </button>
          {draft.trim() ? (
            <button className="icon-btn primary tiny" onClick={() => void add()}>
              Add task
            </button>
          ) : (
            <kbd>↵</kbd>
          )}
        </div>
        {addAnchor && (
          <Popover anchor={addAnchor} onClose={() => setAddAnchor(null)} className="task-menu task-ws-list">
            <div className="svc-menu-heading">New tasks go into</div>
            <button
              className={addTo ? "" : "on"}
              onClick={() => {
                setAddToId(null);
                setAddAnchor(null);
              }}
            >
              <span>No workspace</span>
              {!addTo && <CheckIcon />}
            </button>
            <div className="task-menu-projects">
              {namedWorkspaces.map((w) => (
                <button
                  key={w.id}
                  className={w.id === addTo?.id ? "on" : ""}
                  title={w.folder}
                  onClick={() => {
                    setAddToId(w.id);
                    setAddAnchor(null);
                  }}
                >
                  <span>{workspaceTitle(w)}</span>
                  <small>{w.projectName}</small>
                  {w.id === addTo?.id && <CheckIcon />}
                </button>
              ))}
            </div>
            {namedWorkspaces.length === 0 && <p className="task-ws-none">No named workspaces yet. Start one from a task or the sidebar.</p>}
          </Popover>
        )}
        {preview && (preview.due || preview.priority || preview.project || preview.labels.length > 0) && (
          <div className="tasks-preview">
            <span className="tasks-preview-text">{preview.content || "…"}</span>
            {preview.due && (
              <span className="task-chip due">
                <CalendarIcon />
                {dayLabel(preview.due.date, today)}
                {preview.due.time ? ` ${preview.due.time}` : ""}
              </span>
            )}
            {preview.due?.recurrence && (
              <span className="task-chip">
                <RepeatIcon />
                {describeRecurrence(preview.due.recurrence)}
              </span>
            )}
            {preview.priority && <span className={`task-chip tasks-p${preview.priority}`}>P{preview.priority}</span>}
            {preview.project && <span className="task-chip">#{preview.project}</span>}
            {preview.labels.map((l) => (
              <span key={l} className="task-chip">
                @{l}
              </span>
            ))}
          </div>
        )}
        {error && <div className="chat-error">{error}</div>}

        {openTask && createPortal(
          <TaskModal
            task={openTask}
            projects={projects}
            today={today}
            onClose={() => setOpenId(null)}
            onSave={async (patch) => {
              await taskApi.update(openTask.id, patch);
              setOpenId(null);
            }}
            onComplete={() => {
              void (openTask.completedAt === null ? taskApi.complete(openTask.id) : taskApi.reopen(openTask.id)).catch((e: Error) => setError(e.message));
              setOpenId(null);
            }}
          />,
          document.body,
        )}

        {payload && shown === 0 && (
          <div className="tasks-empty">
            <span className="tasks-empty-icon">
              <TasksIcon />
            </span>
            <strong>{emptyState.head}</strong>
            <span>{emptyState.hint}</span>
          </div>
        )}

        {groups.map(
          (g, i) =>
            g.tasks.length > 0 && (
              <div key={i} className="tasks-group">
                {g.title && (
                  <h3 className={g.overdue ? "overdue" : ""}>
                    {g.title}
                    <span>{g.tasks.length}</span>
                  </h3>
                )}
                {g.tasks.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      today={today}
                      project={view.kind === "project" ? null : { name: projectName(t.projectId), color: projectColor(t.projectId) }}
                      showDate={view.kind !== "upcoming"}
                      workspace={workspaceOf(t)}
                      workspaces={workspaces}
                      projects={projects}
                      onError={setError}
                      onOpen={() => setOpenId(t.id)}
                      onStartWorkspace={() => onStartWorkspace(t)}
                      onOpenWorkspace={onOpenWorkspace}
                    />
                ))}
              </div>
            ),
        )}

        {done.length > 0 && (
          <div className="tasks-group tasks-done">
            <button className="tasks-done-toggle" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
              <span className={`ws-chev${showDone ? " open" : ""}`}>
                <ChevronIcon />
              </span>
              Completed this week
              <span>{done.length}</span>
            </button>
            {showDone &&
              done.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  today={today}
                  project={view.kind === "project" ? null : { name: projectName(t.projectId), color: projectColor(t.projectId) }}
                  showDate={false}
                  workspace={null}
                  workspaces={workspaces}
                  projects={projects}
                  onError={setError}
                  onOpen={() => setOpenId(t.id)}
                  onStartWorkspace={() => {}}
                  onOpenWorkspace={onOpenWorkspace}
                />
              ))}
          </div>
        )}
      </section>

      {projectMenu && (
        <Popover anchor={projectMenu.anchor} onClose={() => setProjectMenu(null)} className="project-menu" align="start">
          <button
            role="menuitem"
            onClick={() => {
              setRenamingProject(projectMenu.project.id);
              setProjectMenu(null);
            }}
          >
            <PencilIcon />
            Rename
          </button>
          <div className="svc-menu-heading">Colour</div>
          <div className="project-menu-colors" role="group" aria-label="Colour">
            {COLOR_NAMES.map((name) => (
              <button
                key={name}
                className={`project-menu-color${colorOf(projectMenu.project) === TASK_COLORS[name] ? " on" : ""}`}
                title={name}
                aria-label={name}
                style={{ background: TASK_COLORS[name] }}
                onClick={() => {
                  void taskApi.updateProject(projectMenu.project.id, { color: name }).catch((err: Error) => setError(err.message));
                  setProjectMenu(null);
                }}
              />
            ))}
          </div>
          <hr />
          <div className="svc-menu-heading">
            {projectMenu.project.repoKey ? `Repository: ${repoName(projectMenu.project.repoKey)}` : "Repository"}
          </div>
          <button
            role="menuitem"
            title="Tasks added from a session in that repository file under this project"
            onClick={() => {
              setTying(projectMenu.project);
              setProjectMenu(null);
            }}
          >
            <GitIcon />
            {projectMenu.project.repoKey ? "Tie to another repository…" : "Tie to a repository…"}
          </button>
          {projectMenu.project.repoKey && (
            <button
              role="menuitem"
              onClick={() => {
                void taskApi.tieProject(projectMenu.project.id, null).catch((err: Error) => setError(err.message));
                setProjectMenu(null);
              }}
            >
              Untie
            </button>
          )}
          <hr />
          <button
            role="menuitem"
            className="danger"
            title="Its open tasks move to the Inbox"
            onClick={() => {
              const id = projectMenu.project.id;
              setProjectMenu(null);
              if (view.kind === "project" && view.id === id) setView({ kind: "upcoming" });
              void taskApi.removeProject(id).catch((err: Error) => setError(err.message));
            }}
          >
            <TrashIcon />
            Delete project
          </button>
        </Popover>
      )}

      {tying && (
        <FolderPicker
          title={`Repository for ${tying.name}`}
          hint="Pick any folder inside the repository. Tasks added from a session there will file under this project."
          initial={tying.repoKey ? tying.repoKey.slice(5).replace(/\/\.git$/, "") : undefined}
          primary="Tie to this repository"
          wantRepo
          onPick={(path) => {
            void taskApi.tieProject(tying.id, path).catch((err: Error) => setError(err.message));
            setTying(null);
          }}
          onClose={() => setTying(null)}
        />
      )}

      {view.kind === "upcoming" && <TodayMeetings today={today} hidden={calendarHidden} onOpenCalendar={onOpenCalendar} />}
      {view.kind !== "upcoming" && (
        <aside className="tasks-week panel" aria-label="Coming up">
          <h3>Coming up</h3>
          <p>The next seven days.</p>
          {week.every((d) => d.tasks.length === 0) && <span className="tasks-week-none">Nothing scheduled.</span>}
          {week.map(
            (d) =>
              d.tasks.length > 0 && (
                <div key={d.day} className="tasks-week-day">
                  <h4>{dayLabel(d.day, today)}</h4>
                  {d.tasks.map((t) => (
                    <button key={t.id} className="tasks-week-item" title="Show in Upcoming" onClick={() => setView({ kind: "upcoming" })}>
                      <i className={`tasks-week-mark tasks-p${t.priority}`} />
                      <span>{t.content}</span>
                      {t.dueTime && <time>{t.dueTime}</time>}
                    </button>
                  ))}
                </div>
              ),
          )}
        </aside>
      )}
    </div>
  );
}

const MEETINGS_REFRESH_MS = 5 * 60_000;
const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

/** Today's meetings beside the task list, so tasks are planned around them. Nothing shows when the calendar is off. */
function TodayMeetings({ today, hidden, onOpenCalendar }: { today: string; hidden: string[]; onOpenCalendar: () => void }) {
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    const from = new Date(`${today}T00:00:00`).getTime();
    const to = new Date(`${addDays(today, 1)}T00:00:00`).getTime();
    const load = () => {
      setNow(Date.now());
      calendarApi
        .events(from, to)
        .then((reply) => live && setEvents(reply.events))
        .catch(() => live && setEvents(null));
    };
    load();
    const timer = window.setInterval(load, MEETINGS_REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [today]);

  if (events === null) return null;
  const shown = events.filter((e) => !hidden.includes(e.calendarId) && replyOf(e) !== "declined").sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start);
  const next = shown.find((e) => !e.allDay && e.end > now);
  return (
    <aside className="tasks-week panel" aria-label="Today's meetings">
      <h3>Today's meetings</h3>
      <p>{shown.length === 0 ? "Nothing on the calendar." : next ? (next.start <= now ? `Now: ${next.title}` : `Next at ${clock(next.start)}`) : "No more meetings today."}</p>
      {shown.map((e) => (
        <button
          key={e.key}
          className={`tasks-week-item tasks-meeting${!e.allDay && e.end <= now ? " past" : ""}${e === next && e.start <= now ? " now" : ""}`}
          title={e.location ? `${e.title} · ${e.location}` : e.title}
          onClick={onOpenCalendar}
        >
          <time>{e.allDay ? "all day" : clock(e.start)}</time>
          <i className="tasks-week-mark" style={{ background: e.color ?? "var(--accent)" }} />
          <span>{e.title}</span>
        </button>
      ))}
    </aside>
  );
}

function TaskRow({
  task: t,
  today,
  project,
  showDate,
  workspace,
  workspaces,
  projects,
  onError,
  onOpen,
  onStartWorkspace,
  onOpenWorkspace,
}: {
  task: Task;
  today: string;
  /** The project, where the list mixes projects; null inside one. */
  project: { name: string; color: string } | null;
  showDate: boolean;
  workspace: Workspace | null;
  /** Every workspace, for moving the task into one. */
  workspaces: Workspace[];
  projects: TaskProject[];
  onError: (message: string | null) => void;
  onOpen: () => void;
  onStartWorkspace: () => void;
  onOpenWorkspace: (w: Workspace) => void;
}) {
  const [dueAnchor, setDueAnchor] = useState<HTMLElement | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [dueFlyout, setDueFlyout] = useState<{ left: boolean } | null>(null);
  const [wsFlyout, setWsFlyout] = useState<{ left: boolean } | null>(null);
  const [linksFlyout, setLinksFlyout] = useState<{ left: boolean } | null>(null);
  const choices = workspaces.filter((w) => w.status === "active" && (w.explicit || w.goal.trim() !== "" || w.id === t.workspaceId));
  const closeMenu = () => {
    setMenuAnchor(null);
    setDueFlyout(null);
    setWsFlyout(null);
    setLinksFlyout(null);
  };
  const [renaming, setRenaming] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const done = t.completedAt !== null;
  const overdue = !done && t.dueDate !== null && t.dueDate < today;
  const when = t.dueDate
    ? `${showDate || overdue || !t.dueTime ? dayLabel(t.dueDate, today) : ""}${t.dueTime ? ` ${t.dueTime}` : ""}`.trim()
    : "";
  return (
    <div
      data-task-id={t.id}
      className={`task-row${done ? " done" : ""}${menuAnchor || dueAnchor ? " active" : ""}`}
      onContextMenu={(e) => {
        if (done || renaming) return;
        e.preventDefault();
        setMenuAnchor(body.current);
      }}
    >
      <button
        className={`task-check tasks-p${t.priority}`}
        title={done ? "Reopen" : t.recurrence ? "Done for this time; it comes back on its next date" : "Mark done"}
        aria-label={done ? `Reopen ${t.content}` : `Complete ${t.content}`}
        onClick={() => void (done ? taskApi.reopen(t.id) : taskApi.complete(t.id)).catch(() => {})}
      >
        {done && <CheckIcon />}
      </button>
      <div className="task-body" ref={body}>
        {renaming ? (
          <span className="task-content">
            <TitleEditInput
              initial={t.content}
              onCancel={() => setRenaming(false)}
              onCommit={(content) => {
                setRenaming(false);
                if (content && content !== t.content) void taskApi.update(t.id, { content }).catch((e: Error) => onError(e.message));
              }}
            />
          </span>
        ) : (
          <button className="task-content task-open" title="Open this task" onClick={onOpen}>
            {t.content}
          </button>
        )}
        {(when || t.recurrence || project || t.labels.length > 0 || t.links.length > 0 || !done) && (
          <span className="task-meta">
            {when && (
              <button
                className={`task-chip due${overdue ? " overdue" : t.dueDate === today ? " today" : ""}`}
                disabled={done}
                title="Change when this is due"
                onClick={(e) => setDueAnchor(e.currentTarget)}
              >
                <CalendarIcon />
                {when}
              </button>
            )}
            {t.recurrence && (
              <span className="task-chip">
                <RepeatIcon />
                {describeRecurrence(t.recurrence)}
              </span>
            )}
            {project && (
              <span className="task-chip plain">
                <i className="tasks-dot" style={{ background: project.color }} />
                {project.name}
              </span>
            )}
            {t.labels.map((l) => (
              <span key={l} className="task-chip">
                @{l}
              </span>
            ))}
            {t.links.map((url) => {
              const info = linkInfo(url);
              return (
                <a
                  key={url}
                  className={`task-chip task-link svc-${info.service}`}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  title={`${info.kind}\n${url}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <ServiceMark service={info.service} />
                  {info.label}
                </a>
              );
            })}
            {!when && !done && (
              <button className="task-chip due add" title="Set when this is due" onClick={(e) => setDueAnchor(e.currentTarget)}>
                <CalendarIcon />
                Add date
              </button>
            )}
          </span>
        )}
      </div>
      {dueAnchor && (
        <DuePicker
          task={t}
          today={today}
          anchor={dueAnchor}
          align={dueAnchor.classList.contains("task-chip") ? "start" : "end"}
          onClose={() => setDueAnchor(null)}
        />
      )}
      {!done &&
        (workspace ? (
          <button className="task-ws linked" title={`In workspace: ${workspaceTitle(workspace)}. Click to open it.`} onClick={() => onOpenWorkspace(workspace)}>
            <WorktreeIcon />
            <span>{workspaceTitle(workspace)}</span>
          </button>
        ) : (
          <button className="task-ws start" title="Start a workspace with this task as its goal" onClick={onStartWorkspace}>
            <WorktreeIcon />
            Start workspace
          </button>
        ))}
      {!done && (
        <button
          className="task-delete"
          title="Task actions"
          aria-label={`Actions for ${t.content}`}
          onClick={(e) => setMenuAnchor(e.currentTarget)}
        >
          <MoreVerticalIcon />
        </button>
      )}
      {done && (
        <button
          className="task-delete"
          title="Delete this task"
          aria-label={`Delete ${t.content}`}
          onClick={() => void taskApi.remove(t.id).catch(() => {})}
        >
          <TrashIcon />
        </button>
      )}
      {menuAnchor && (
        <Popover
          anchor={menuAnchor}
          onClose={closeMenu}
          className="task-menu"
          align={menuAnchor === body.current ? "start" : "end"}
        >
          <button
            role="menuitem"
            onClick={() => {
              closeMenu();
              setRenaming(true);
            }}
          >
            <PencilIcon />
            Rename
          </button>
          <div className={`task-sub-row${dueFlyout ? " open" : ""}`}>
            <button
              role="menuitem"
              aria-haspopup="dialog"
              aria-expanded={!!dueFlyout}
              onClick={(e) => {
                setWsFlyout(null);
                setLinksFlyout(null);
                if (dueFlyout) return setDueFlyout(null);
                const r = e.currentTarget.getBoundingClientRect();
                setDueFlyout({ left: r.right + 270 > window.innerWidth });
              }}
            >
              <CalendarIcon />
              <span>Due date</span>
              <small>{when || (t.dueDate ? dayLabel(t.dueDate, today) : "none")}</small>
              <span className="task-sub-caret" aria-hidden>
                ›
              </span>
            </button>
            {dueFlyout && (
              <DueFlyout left={dueFlyout.left}>
                <DueFields task={t} today={today} onClose={closeMenu} />
              </DueFlyout>
            )}
          </div>
          <div className={`task-sub-row${wsFlyout ? " open" : ""}`}>
            <button
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={!!wsFlyout}
              onClick={(e) => {
                setDueFlyout(null);
                setLinksFlyout(null);
                if (wsFlyout) return setWsFlyout(null);
                const r = e.currentTarget.getBoundingClientRect();
                setWsFlyout({ left: r.right + 290 > window.innerWidth });
              }}
            >
              <WorktreeIcon />
              <span>Workspace</span>
              <small>{workspace ? workspaceTitle(workspace) : "none"}</small>
              <span className="task-sub-caret" aria-hidden>
                ›
              </span>
            </button>
            {wsFlyout && (
              <DueFlyout left={wsFlyout.left} className="task-ws-list">
                {workspace && (
                  <button
                    onClick={() => {
                      closeMenu();
                      onOpenWorkspace(workspace);
                    }}
                  >
                    Open {workspaceTitle(workspace)}
                  </button>
                )}
                <button
                  onClick={() => {
                    closeMenu();
                    onStartWorkspace();
                  }}
                >
                  <PlusIcon />
                  Start a new workspace…
                </button>
                {choices.length > 0 && <hr />}
                <div className="task-menu-projects">
                  {choices.map((w) => (
                    <button
                      key={w.id}
                      className={w.id === t.workspaceId ? "on" : ""}
                      title={w.folder}
                      onClick={() => {
                        closeMenu();
                        if (w.id !== t.workspaceId) void taskApi.link(t.id, w.id).catch((e: Error) => onError(e.message));
                      }}
                    >
                      <span>{workspaceTitle(w)}</span>
                      <small>{w.projectName}</small>
                      {w.id === t.workspaceId && <CheckIcon />}
                    </button>
                  ))}
                </div>
                {workspace && (
                  <>
                    <hr />
                    <button
                      onClick={() => {
                        closeMenu();
                        void taskApi.link(t.id, null).catch((e: Error) => onError(e.message));
                      }}
                    >
                      Take it out of its workspace
                    </button>
                  </>
                )}
              </DueFlyout>
            )}
          </div>
          <div className={`task-sub-row${linksFlyout ? " open" : ""}`}>
            <button
              role="menuitem"
              aria-haspopup="dialog"
              aria-expanded={!!linksFlyout}
              onClick={(e) => {
                setDueFlyout(null);
                setWsFlyout(null);
                if (linksFlyout) return setLinksFlyout(null);
                const r = e.currentTarget.getBoundingClientRect();
                setLinksFlyout({ left: r.right + 320 > window.innerWidth });
              }}
            >
              <ExternalIcon />
              <span>Links</span>
              <small>{t.links.length || "none"}</small>
              <span className="task-sub-caret" aria-hidden>
                ›
              </span>
            </button>
            {linksFlyout && (
              <DueFlyout left={linksFlyout.left} className="task-links">
                <LinkFields task={t} onError={onError} />
              </DueFlyout>
            )}
          </div>
          <hr />
          <div className="svc-menu-heading">Priority</div>
          <div className="task-menu-prio" role="group" aria-label="Priority">
            {([1, 2, 3, 4] as const).map((p) => (
              <button
                key={p}
                className={`tasks-p${p}${t.priority === p ? " on" : ""}`}
                title={PRIORITY_LABEL[p]}
                onClick={() => {
                  closeMenu();
                  void taskApi.update(t.id, { priority: p }).catch((e: Error) => onError(e.message));
                }}
              >
                {p === 4 ? "None" : `P${p}`}
              </button>
            ))}
          </div>
          <div className="svc-menu-heading">Project</div>
          <div className="task-menu-projects">
            {projects.map((p) => (
              <button
                key={p.id}
                role="menuitem"
                className={p.id === t.projectId ? "on" : ""}
                onClick={() => {
                  closeMenu();
                  if (p.id !== t.projectId) void taskApi.update(t.id, { projectId: p.id }).catch((e: Error) => onError(e.message));
                }}
              >
                <i className="tasks-dot" style={{ background: p.isInbox ? "var(--text-muted)" : colorOf(p) }} />
                <span>{p.name}</span>
                {p.id === t.projectId && <CheckIcon />}
              </button>
            ))}
          </div>
          <hr />
          <button
            role="menuitem"
            className="danger"
            onClick={() => {
              closeMenu();
              void taskApi.remove(t.id).catch(() => {});
            }}
          >
            <TrashIcon />
            Delete task
          </button>
        </Popover>
      )}
    </div>
  );
}

/**
 * When a task is due    </div>
  );
}

/**
 * When a task is due, changed without retyping it: a few usual days, any date,
 * and a time. Each choice saves at once. A repeating task keeps repeating.
 */
function DuePicker({
  task,
  today,
  anchor,
  align,
  onClose,
}: {
  task: Task;
  today: string;
  anchor: HTMLElement;
  align: "start" | "end";
  onClose: () => void;
}) {
  return (
    <Popover anchor={anchor} onClose={onClose} className="due-picker" role="dialog" align={align}>
      <DueFields task={task} today={today} onClose={onClose} />
    </Popover>
  );
}

/** A task's links: each opens, each can be removed, and a pasted address adds one. */
function LinkFields({ task: t, onError }: { task: Task; onError: (message: string | null) => void }) {
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const save = (links: string[]) => void taskApi.update(t.id, { links }).catch((e: Error) => onError(e.message));
  const add = () => {
    const [url] = cleanLinks([draft.trim().replace(/^(?!https?:\/\/)/, "https://")]);
    if (!url) return setNote("That does not look like a web address.");
    if (t.links.includes(url)) return setNote("That link is already on the task.");
    if (t.links.length >= MAX_TASK_LINKS) return setNote(`A task holds up to ${MAX_TASK_LINKS} links.`);
    setNote(null);
    setDraft("");
    save([...t.links, url]);
  };
  return (
    <>
      {t.links.length === 0 && <p className="task-links-none">No links yet. Paste a pull request, a Slack thread or a page.</p>}
      {t.links.map((url) => {
        const info = linkInfo(url);
        return (
          <div key={url} className="task-links-row">
            <a href={url} target="_blank" rel="noreferrer" title={url}>
              <ServiceMark service={info.service} />
              <span>{info.label}</span>
              <small>{info.kind}</small>
            </a>
            <button title="Remove this link" aria-label={`Remove ${info.label}`} onClick={() => save(t.links.filter((l) => l !== url))}>
              <XIcon />
            </button>
          </div>
        );
      })}
      <label className="due-picker-field typed">
        <span>Add a link</span>
        <input
          value={draft}
          placeholder="https://github.com/…"
          onChange={(e) => {
            setDraft(e.target.value);
            setNote(null);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !draft.trim()) return;
            e.preventDefault();
            add();
          }}
        />
      </label>
      {note && <p className="due-picker-error">{note}</p>}
    </>
  );
}

/**
 * A date or time field that saves once you are done with it, not on every key.
 *
 * A browser's time field reports a full value after the first digit ("1" is
 * already 01:00). Saving that straight away re-rendered the field from the
 * server's answer and dropped the second digit, so 13 could not be typed. The
 * field keeps what you type and saves when typing pauses or the field is left.
 */
function SettledInput({ type, value, onSettle }: { type: "time"; value: string; onSettle: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const saved = useRef(value);
  const timer = useRef<number | null>(null);
  const editing = useRef(false);

  useEffect(() => {
    if (editing.current) return;
    saved.current = value;
    setDraft(value);
  }, [value]);
  useEffect(() => () => void (timer.current !== null && window.clearTimeout(timer.current)), []);

  const settle = (next: string) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (next === saved.current) return;
    saved.current = next;
    onSettle(next);
  };

  return (
    <input
      type={type}
      value={draft}
      onFocus={() => (editing.current = true)}
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => settle(next), 900);
      }}
      onBlur={() => {
        editing.current = false;
        settle(draft);
      }}
      onKeyDown={(e) => e.key === "Enter" && settle(draft)}
    />
  );
}

/** The panel that flies out beside a menu row, nudged up just far enough to stay inside the window. */
function DueFlyout({ left, className = "due-picker", children }: { left: boolean; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const natural = r.top - shift;
    const over = natural + r.height - (window.innerHeight - 8);
    setShift(over > 0 ? -Math.min(over, Math.max(0, natural - 8)) : 0);
  }, [shift]);
  return (
    <div
      ref={ref}
      className={`svc-menu ${className} task-sub${left ? " left" : ""}`}
      role="dialog"
      style={shift ? { transform: `translateY(${shift}px)` } : undefined}
    >
      {children}
    </div>
  );
}

/** The date picker's contents, shared by the popover on a task's date chip and the flyout in its menu. */
function DueFields({ task: t, today, onClose }: { task: Task; today: string; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const save = (patch: { dueDate?: string | null; dueTime?: string | null; due?: string }, close = true) => {
    setError(null);
    void taskApi
      .update(t.id, patch)
      .then(() => close && onClose())
      .catch((e: Error) => setError(e.message));
  };
  const nextMonday = addDays(today, (8 - weekdayOf(today)) % 7 || 7);
  const saturday = addDays(today, (6 - weekdayOf(today) + 7) % 7 || 7);
  const quick = (
    [
      ["Today", today],
      ["Tomorrow", addDays(today, 1)],
      ["Saturday", saturday],
      ["Next Monday", nextMonday],
    ] as [string, string][]
  ).filter(([, day], i, all) => all.findIndex(([, d]) => d === day) === i);
  return (
    <>
      {quick.map(([label, day]) => (
        <button key={label} className={t.dueDate === day ? "on" : ""} onClick={() => save({ dueDate: day })}>
          <span>{label}</span>
          <small>{dayLabel(day, today) === label ? "" : dayLabel(day, today)}</small>
        </button>
      ))}
      <hr />
      <div className="due-picker-field">
        <span>Date</span>
        <DatePicker ariaLabel="Date" value={t.dueDate ?? ""} onChange={(v) => save({ dueDate: v }, false)} />
      </div>
      <label className="due-picker-field">
        <span>Time</span>
        <SettledInput type="time" value={t.dueTime ?? ""} onSettle={(v) => save({ dueTime: v || null }, false)} />
      </label>
      <label className="due-picker-field typed">
        <span>Or type</span>
        <input
          value={typed}
          placeholder={t.recurrence ? describeRecurrence(t.recurrence) : "every monday 9:00"}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !typed.trim()) return;
            e.preventDefault();
            save({ due: typed.trim() });
          }}
        />
      </label>
      {(t.dueDate || t.dueTime) && (
        <>
          <hr />
          {t.dueTime && <button onClick={() => save({ dueTime: null })}>Remove the time</button>}
          {t.dueDate && (
            <button className="danger" onClick={() => save({ dueDate: null })}>
              No date
            </button>
          )}
        </>
      )}
      {error && <p className="due-picker-error">{error}</p>}
    </>
  );
}
