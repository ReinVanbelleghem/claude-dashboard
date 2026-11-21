import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import {
  dueEpoch,
  firstOccurrence,
  localDay,
  localTime,
  nextOccurrence,
  parseDue,
  parseQuickAdd,
  type Due,
  type Priority,
  type Recurrence,
} from "../shared/taskDates.ts";
import { COMPLETED_SHOWN_MS, TASK_COLORS, type Task, type TaskAdd, type TaskPatch, type TaskProject, type TasksPayload } from "../shared/tasks.ts";
import { cleanLinks, extractUrls } from "../shared/taskLinks.ts";
import { repoStatus } from "./git.ts";

/**
 * Tasks: a to-do list in the daemon's sqlite.
 *
 * A task has a project, an optional due date and time (local, never epoch:
 * "Friday 9:00" stays Friday 9:00), a priority and, for a repeating one, a
 * recurrence. Completing a repeating task moves its date on instead of closing
 * it. A task can belong to a workspace (`tasks.workspace_id`), and a workspace
 * can hold any number of them.
 *
 * A project can be tied to a repository (`repo_key`), which is how a task added
 * from a session files itself: the folder the request names decides the project.
 */

/** How long after its time a timed task still earns a reminder, so a daemon that was down does not replay the morning. */
const REMINDER_GRACE_MS = 15 * 60_000;

type TaskRow = {
  id: number;
  project_id: number;
  content: string;
  description: string;
  priority: number;
  due_date: string | null;
  due_time: string | null;
  due_string: string | null;
  recurrence: string | null;
  labels: string;
  sort: number;
  completed_at: number | null;
  created_at: number;
  reminded_for: string | null;
  workspace_id: number | null;
  work_project_id: number | null;
  links: string | null;
};

type ProjectRow = { id: number; name: string; color: string | null; sort: number; is_inbox: number; repo_key: string | null };

let db: Database;
let emit: (payload: TasksPayload) => void = () => {};

export function initTasks(database: Database, emitter: (payload: TasksPayload) => void) {
  db = database;
  emit = emitter;
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_projects (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      color       TEXT,
      parent_id   INTEGER,
      sort        REAL NOT NULL DEFAULT 0,
      is_inbox    INTEGER NOT NULL DEFAULT 0,
      archived    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      todoist_id  TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id       INTEGER NOT NULL,
      section_id       INTEGER,
      parent_id        INTEGER,
      content          TEXT NOT NULL,
      description      TEXT NOT NULL DEFAULT '',
      priority         INTEGER NOT NULL DEFAULT 4,
      due_date         TEXT,
      due_time         TEXT,
      due_string       TEXT,
      recurrence       TEXT,
      labels           TEXT NOT NULL DEFAULT '[]',
      sort             REAL NOT NULL DEFAULT 0,
      completed_at     INTEGER,
      session_key      TEXT,
      created_by_kind  TEXT NOT NULL,
      created_by_id    TEXT,
      created_by_label TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      reminded_for     TEXT,
      todoist_id       TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
    CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed_at);
    CREATE TABLE IF NOT EXISTS task_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(task_projects)").all();
  if (!cols.some((c) => c.name === "repo_key")) db.exec("ALTER TABLE task_projects ADD COLUMN repo_key TEXT");
  const taskCols = db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all();
  if (!taskCols.some((c) => c.name === "work_project_id")) db.exec("ALTER TABLE tasks ADD COLUMN work_project_id INTEGER");
  if (!taskCols.some((c) => c.name === "workspace_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN workspace_id INTEGER");
    try {
      db.exec("UPDATE tasks SET workspace_id = (SELECT w.id FROM workspaces w WHERE w.linked_task_id = tasks.id LIMIT 1)");
    } catch {
      // No workspaces table, or one that never had a linked task: nothing to carry over.
    }
  }
  if (!taskCols.some((c) => c.name === "links")) {
    db.exec("ALTER TABLE tasks ADD COLUMN links TEXT");
    const set = db.query("UPDATE tasks SET links = ? WHERE id = ?");
    for (const r of db.query<{ id: number; content: string; description: string }, []>("SELECT id, content, description FROM tasks").all()) {
      const found = cleanLinks([...extractUrls(r.description), ...extractUrls(r.content)]);
      if (found.length > 0) set.run(JSON.stringify(found), r.id);
    }
  }
  if (!db.query("SELECT 1 FROM task_projects WHERE is_inbox = 1").get()) {
    db.query("INSERT INTO task_projects (name, sort, is_inbox, created_at) VALUES ('Inbox', -1, 1, ?)").run(Date.now());
  }
}

const toProject = (r: ProjectRow): TaskProject => ({
  id: r.id,
  name: r.name,
  color: r.color,
  isInbox: r.is_inbox === 1,
  order: r.sort,
  repoKey: r.repo_key,
});

const parseJson = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

type WorkspaceRef = { id: number; folder: string; named: boolean; projectId: number | null };

/** The workspaces a task can belong to: the ones that are not archived. Empty before the workspaces table exists. */
function openWorkspaces(): WorkspaceRef[] {
  try {
    return db
      .query<{ id: number; folder: string; goal: string; explicit: number; review_key: string | null; project_id: number | null }, []>(
        "SELECT id, folder, goal, explicit, review_key, project_id FROM workspaces WHERE status != 'archived'",
      )
      .all()
      .map((w) => ({
        id: w.id,
        folder: w.folder,
        named: !w.review_key && (w.explicit === 1 || w.goal.trim() !== ""),
        projectId: w.project_id,
      }));
  } catch {
    return [];
  }
}

const liveWorkspaceIds = () => new Set(openWorkspaces().map((w) => w.id));

type WorkProject = { id: number; folder: string | null; general: boolean };

/** The pieces of work a task can be part of: the sidebar's projects. Empty before that table exists. */
function workProjects(): WorkProject[] {
  try {
    return db
      .query<{ id: number; folder: string | null; general_key: string | null }, []>("SELECT id, folder, general_key FROM projects")
      .all()
      .map((p) => ({ id: p.id, folder: p.folder, general: p.general_key !== null }));
  } catch {
    return [];
  }
}

/** What a task's ties are checked against: each open workspace with its project, and the projects there are. */
type Ties = { workspaces: Map<number, number | null>; projects: Set<number> };
const ties = (): Ties => ({
  workspaces: new Map(openWorkspaces().map((w) => [w.id, w.projectId])),
  projects: new Set(workProjects().map((p) => p.id)),
});

/**
 * The piece of work a folder is part of, for a task added from it that no
 * named workspace takes: the project whose own folder it is in, else the
 * project of the checkout it is in. A repository's standing project is no
 * piece of work, so a task from a main checkout is tied to none.
 */
function workProjectForFolder(cwd: string): number | null {
  const dir = cwd.replace(/\/+$/, "");
  const holds = (folder: string) => dir === folder || dir.startsWith(`${folder}/`);
  const projects = workProjects().filter((p) => !p.general);
  const own = projects.filter((p) => p.folder && holds(p.folder)).sort((a, b) => b.folder!.length - a.folder!.length)[0];
  if (own) return own.id;
  const inside = openWorkspaces()
    .filter((w) => holds(w.folder))
    .sort((a, b) => b.folder.length - a.folder.length)[0];
  return inside && projects.some((p) => p.id === inside.projectId) ? inside.projectId : null;
}

/** The named workspace a folder is part of: the deepest one. Sessions in a plain checkout belong to no piece of work in particular. */
function workspaceForFolder(cwd: string): number | null {
  const dir = cwd.replace(/\/+$/, "");
  const fits = openWorkspaces()
    .filter((w) => w.named && (dir === w.folder || dir.startsWith(`${w.folder}/`)))
    .sort((a, b) => b.folder.length - a.folder.length || b.id - a.id);
  return fits[0]?.id ?? null;
}

const toTask = (r: TaskRow, known: Ties): Task => ({
  id: r.id,
  projectId: r.project_id,
  content: r.content,
  description: r.description,
  priority: (r.priority >= 1 && r.priority <= 4 ? r.priority : 4) as Priority,
  dueDate: r.due_date,
  dueTime: r.due_time,
  dueString: r.due_string,
  recurrence: parseJson<Recurrence | null>(r.recurrence, null),
  labels: parseJson<string[]>(r.labels, []),
  links: parseJson<string[]>(r.links, []),
  order: r.sort,
  completedAt: r.completed_at,
  createdAt: r.created_at,
  workspaceId: r.workspace_id !== null && known.workspaces.has(r.workspace_id) ? r.workspace_id : null,
  workProjectId:
    r.workspace_id !== null && known.workspaces.has(r.workspace_id)
      ? (known.workspaces.get(r.workspace_id) ?? null)
      : r.work_project_id !== null && known.projects.has(r.work_project_id)
        ? r.work_project_id
        : null,
});

const projectRows = () =>
  db
    .query<ProjectRow, []>("SELECT id, name, color, sort, is_inbox, repo_key FROM task_projects WHERE archived = 0 ORDER BY is_inbox DESC, sort, id")
    .all();

const taskRow = (id: number) => db.query<TaskRow, [number]>("SELECT * FROM tasks WHERE id = ?").get(id);

export function tasksPayload(now = Date.now()): TasksPayload {
  const live = ties();
  const rows = db
    .query<TaskRow, [number]>("SELECT * FROM tasks WHERE completed_at IS NULL OR completed_at > ? ORDER BY sort, id")
    .all(now - COMPLETED_SHOWN_MS);
  return { projects: projectRows().map(toProject), tasks: rows.map((r) => toTask(r, live)) };
}

export function getTask(id: number): Task | null {
  const r = taskRow(id);
  return r ? toTask(r, ties()) : null;
}

/** Tell every page the list changed. Also called when a workspace link changes, which this module does not write. */
export const tasksChanged = () => emit(tasksPayload());

const inbox = () => projectRows().find((p) => p.is_inbox === 1)!;

function projectByName(name: string, create: boolean): ProjectRow | null {
  const wanted = name.trim();
  if (!wanted) return null;
  const found = projectRows().find((p) => p.name.toLowerCase() === wanted.toLowerCase());
  if (found || !create) return found ?? null;
  const id = insertProject(wanted, null);
  return projectRows().find((p) => p.id === id)!;
}

function insertProject(name: string, repoKey: string | null): number {
  const next = (db.query<{ n: number | null }, []>("SELECT MAX(sort) AS n FROM task_projects").get()?.n ?? 0) + 1;
  return db
    .query<{ id: number }, [string, number, number, string | null]>(
      "INSERT INTO task_projects (name, sort, created_at, repo_key) VALUES (?, ?, ?, ?) RETURNING id",
    )
    .get(name, next, Date.now(), repoKey)!.id;
}

/** The project for work in this folder: the one tied to its repository, else one of the same name, else a new one. */
async function projectForFolder(cwd: string): Promise<ProjectRow | null> {
  const st = await repoStatus(cwd).catch(() => null);
  if (!st?.isRepo || !st.commonDir) return null;
  const key = `repo:${st.commonDir}`;
  const name = basename(st.mainRoot ?? st.root ?? cwd);
  const all = projectRows();
  const tied = all.find((p) => p.repo_key === key);
  if (tied) return tied;
  const named = all.find((p) => p.is_inbox === 0 && p.name.toLowerCase() === name.toLowerCase());
  if (named) {
    db.query("UPDATE task_projects SET repo_key = ? WHERE id = ?").run(key, named.id);
    return { ...named, repo_key: key };
  }
  const id = insertProject(name, key);
  return projectRows().find((p) => p.id === id)!;
}

const dueColumns = (due: Due | null) => ({
  due_date: due?.date ?? null,
  due_time: due?.time ?? null,
  due_string: due?.string ?? null,
  recurrence: due?.recurrence ? JSON.stringify(due.recurrence) : null,
});

export async function addTask(input: TaskAdd, now = new Date()): Promise<Task | { error: string }> {
  const quick = input.text?.trim() ? parseQuickAdd(input.text.trim(), now) : null;
  const typed = (input.content ?? quick?.content ?? "").trim();
  const links = cleanLinks([...(input.links ?? []), ...extractUrls(typed), ...extractUrls(input.description)]);
  const bare = extractUrls(typed)
    .reduce((text, url) => text.replace(url, " "), typed)
    .replace(/\s+/g, " ")
    .trim();
  const content = bare || typed;
  if (!content) return { error: "a task needs some text" };
  const due = input.due?.trim() ? parseDue(input.due.trim(), now) : (quick?.due ?? null);
  if (input.due?.trim() && !due) return { error: `could not read "${input.due}" as a date` };

  const named = input.project ?? quick?.project ?? null;
  const project =
    (input.projectId != null ? projectRows().find((p) => p.id === input.projectId) : null) ??
    (named ? projectByName(named, true) : null) ??
    (input.cwd ? await projectForFolder(input.cwd) : null) ??
    inbox();

  const workspaceId =
    input.workspaceId != null
      ? liveWorkspaceIds().has(input.workspaceId)
        ? input.workspaceId
        : null
      : input.cwd
        ? workspaceForFolder(input.cwd)
        : null;
  const workProjectId =
    workspaceId !== null
      ? null
      : input.workProjectId != null
        ? workProjects().some((p) => p.id === input.workProjectId)
          ? input.workProjectId
          : null
        : input.cwd
          ? workProjectForFolder(input.cwd)
          : null;
  const at = now.getTime();
  const sort = (db.query<{ n: number | null }, [number]>("SELECT MAX(sort) AS n FROM tasks WHERE project_id = ?").get(project.id)?.n ?? 0) + 1;
  const d = dueColumns(due);
  const id = db
    .query<{ id: number }, [number, string, string, number, string | null, string | null, string | null, string | null, string, number, string, number, number, number | null, number | null, string]>(
      `INSERT INTO tasks (project_id, content, description, priority, due_date, due_time, due_string, recurrence, labels, sort, created_by_kind, created_at, updated_at, workspace_id, work_project_id, links)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      project.id,
      content.slice(0, 500),
      (input.description ?? "").slice(0, 5000),
      input.priority ?? quick?.priority ?? 4,
      d.due_date,
      d.due_time,
      d.due_string,
      d.recurrence,
      JSON.stringify(quick?.labels ?? []),
      sort,
      input.by === "agent" ? "agent" : "user",
      at,
      at,
      workspaceId,
      workProjectId,
      JSON.stringify(links),
    )!.id;
  tasksChanged();
  return getTask(id)!;
}

export function updateTask(id: number, patch: TaskPatch, now = new Date()): Task | { error: string } | null {
  const row = taskRow(id);
  if (!row) return null;
  const set: Record<string, string | number | null> = { updated_at: now.getTime() };
  if (patch.content !== undefined) {
    const content = patch.content.trim();
    if (!content) return { error: "a task needs some text" };
    set.content = content.slice(0, 500);
  }
  if (patch.description !== undefined) set.description = patch.description.slice(0, 5000);
  if (patch.priority !== undefined) set.priority = patch.priority;
  if (patch.projectId !== undefined) {
    if (!projectRows().some((p) => p.id === patch.projectId)) return { error: "no such project" };
    set.project_id = patch.projectId;
  }
  if (patch.due !== undefined) {
    const text = patch.due.trim();
    const due = text ? parseDue(text, now) : null;
    if (text && !due) return { error: `could not read "${text}" as a date` };
    Object.assign(set, dueColumns(due), { reminded_for: null });
  }
  if (patch.links !== undefined) set.links = JSON.stringify(cleanLinks(patch.links));
  if (patch.dueDate !== undefined) {
    if (patch.dueDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(patch.dueDate)) return { error: "a date looks like 2026-11-20" };
    Object.assign(set, { due_date: patch.dueDate, due_string: null, reminded_for: null });
    if (patch.dueDate === null) Object.assign(set, { due_time: null, recurrence: null });
  }
  if (patch.dueTime !== undefined) {
    if (patch.dueTime !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.dueTime)) return { error: "a time looks like 14:30" };
    if (patch.dueTime !== null && (set.due_date ?? row.due_date) == null) set.due_date = localDay(now);
    Object.assign(set, { due_time: patch.dueTime, due_string: null, reminded_for: null });
  }
  const keys = Object.keys(set);
  db.query(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(set), id);
  tasksChanged();
  return getTask(id);
}

/** Done. A repeating task is not closed: its date moves to the next occurrence. */
export function completeTask(id: number, now = new Date()): Task | null {
  const row = taskRow(id);
  if (!row) return null;
  const recurrence = parseJson<Recurrence | null>(row.recurrence, null);
  const today = localDay(now);
  if (recurrence && row.completed_at === null) {
    const next = row.due_date ? nextOccurrence(recurrence, row.due_date, today) : firstOccurrence(recurrence, today);
    db.query("UPDATE tasks SET due_date = ?, reminded_for = NULL, updated_at = ? WHERE id = ?").run(next, now.getTime(), id);
  } else {
    db.query("UPDATE tasks SET completed_at = ?, updated_at = ? WHERE id = ?").run(now.getTime(), now.getTime(), id);
  }
  tasksChanged();
  return getTask(id);
}

export function reopenTask(id: number): Task | null {
  if (!taskRow(id)) return null;
  db.query("UPDATE tasks SET completed_at = NULL, updated_at = ? WHERE id = ?").run(Date.now(), id);
  tasksChanged();
  return getTask(id);
}

export function deleteTask(id: number): boolean {
  const had = db.query("DELETE FROM tasks WHERE id = ?").run(id).changes > 0;
  if (had) tasksChanged();
  return had;
}

/** Put a task in a workspace, or take it out with null. */
export function setTaskWorkspace(id: number, workspaceId: number | null): Task | { error: string } | null {
  if (!taskRow(id)) return null;
  if (workspaceId !== null && !liveWorkspaceIds().has(workspaceId)) return { error: "no such workspace" };
  db.query("UPDATE tasks SET workspace_id = ?, work_project_id = NULL, updated_at = ? WHERE id = ?").run(workspaceId, Date.now(), id);
  tasksChanged();
  return getTask(id);
}

/** Tie a task to a piece of work as a whole, a project from the sidebar, rather than to one workspace in it. */
export function setTaskWorkProject(id: number, projectId: number): Task | { error: string } | null {
  if (!taskRow(id)) return null;
  if (!workProjects().some((p) => p.id === projectId)) return { error: "no such project" };
  db.query("UPDATE tasks SET work_project_id = ?, workspace_id = NULL, updated_at = ? WHERE id = ?").run(projectId, Date.now(), id);
  tasksChanged();
  return getTask(id);
}

/** Complete every open task a workspace holds: what "archive and complete its tasks" does. */
export function completeWorkspaceTasks(workspaceId: number, now = new Date()): number {
  const open = db
    .query<{ id: number }, [number]>("SELECT id FROM tasks WHERE workspace_id = ? AND completed_at IS NULL")
    .all(workspaceId);
  for (const t of open) completeTask(t.id, now);
  return open.length;
}

export function addTaskProject(name: string): TaskProject | { error: string } {
  const wanted = name.trim().slice(0, 80);
  if (!wanted) return { error: "a project needs a name" };
  const existing = projectByName(wanted, false);
  if (existing) return { error: `there is already a project called ${existing.name}` };
  const id = insertProject(wanted, null);
  tasksChanged();
  return toProject(projectRows().find((p) => p.id === id)!);
}

export function updateTaskProject(id: number, patch: { name?: string; color?: string | null }): TaskProject | { error: string } | null {
  const p = projectRows().find((x) => x.id === id);
  if (!p) return null;
  if (patch.name !== undefined) {
    const wanted = patch.name.trim().slice(0, 80);
    if (!wanted) return { error: "a project needs a name" };
    const clash = projectByName(wanted, false);
    if (clash && clash.id !== id) return { error: `there is already a project called ${clash.name}` };
    db.query("UPDATE task_projects SET name = ? WHERE id = ?").run(wanted, id);
  }
  if (patch.color !== undefined) {
    if (patch.color !== null && !(patch.color in TASK_COLORS)) return { error: "no such colour" };
    db.query("UPDATE task_projects SET color = ? WHERE id = ?").run(patch.color, id);
  }
  tasksChanged();
  return toProject(projectRows().find((x) => x.id === id)!);
}

/**
 * Tie a project to the repository a folder belongs to, or untie it with null.
 * A repository has one project: tying it here takes it from whichever had it.
 */
export async function tieTaskProject(id: number, folder: string | null): Promise<TaskProject | { error: string } | null> {
  if (!projectRows().some((x) => x.id === id && x.is_inbox === 0)) return null;
  let key: string | null = null;
  if (folder !== null) {
    const st = await repoStatus(folder).catch(() => null);
    if (!st?.isRepo || !st.commonDir) return { error: "that folder is not inside a git repository" };
    key = `repo:${st.commonDir}`;
    db.query("UPDATE task_projects SET repo_key = NULL WHERE repo_key = ?").run(key);
  }
  db.query("UPDATE task_projects SET repo_key = ? WHERE id = ?").run(key, id);
  tasksChanged();
  return toProject(projectRows().find((x) => x.id === id)!);
}

/** Put the projects in this order. The Inbox is not part of it: it always comes first. */
export function reorderTaskProjects(ids: number[]) {
  const set = db.query("UPDATE task_projects SET sort = ? WHERE id = ? AND is_inbox = 0");
  ids.forEach((id, i) => set.run(i + 1, id));
  tasksChanged();
}

/** Remove a project. Its open tasks move to the Inbox rather than vanish; the Inbox itself stays. */
export function deleteTaskProject(id: number): boolean | { error: string } {
  const p = projectRows().find((x) => x.id === id);
  if (!p) return false;
  if (p.is_inbox === 1) return { error: "the Inbox cannot be deleted" };
  db.query("UPDATE tasks SET project_id = ? WHERE project_id = ? AND completed_at IS NULL").run(inbox().id, id);
  db.query("DELETE FROM tasks WHERE project_id = ?").run(id);
  db.query("DELETE FROM task_projects WHERE id = ?").run(id);
  tasksChanged();
  return true;
}

export type TaskReminder = { key: string; title: string; context: string; detail: string };

const meta = {
  get: (key: string) => db.query<{ value: string }, [string]>("SELECT value FROM task_meta WHERE key = ?").get(key)?.value ?? null,
  set: (key: string, value: string) =>
    db.query("INSERT INTO task_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value),
};

/**
 * What is worth a banner right now: each timed task whose time has just come,
 * once per occurrence, and once a day (from `digestAt` on) a count of what is
 * due or overdue.
 */
export function dueReminders(now = new Date(), digestAt: string | null = "09:00"): TaskReminder[] {
  const out: TaskReminder[] = [];
  const today = localDay(now);
  const names = new Map(projectRows().map((p) => [p.id, p.name]));
  const open = db
    .query<TaskRow, [string]>("SELECT * FROM tasks WHERE completed_at IS NULL AND due_date IS NOT NULL AND due_date <= ?")
    .all(today);

  for (const t of open) {
    if (!t.due_time || t.due_date !== today) continue;
    const stamp = `${t.due_date} ${t.due_time}`;
    const late = now.getTime() - dueEpoch(t.due_date, t.due_time);
    if (t.reminded_for === stamp || late < 0 || late > REMINDER_GRACE_MS) continue;
    db.query("UPDATE tasks SET reminded_for = ? WHERE id = ?").run(stamp, t.id);
    out.push({ key: `task:${t.id}:${stamp}`, title: t.content, context: names.get(t.project_id) ?? "Tasks", detail: `Due now · ${t.due_time}` });
  }

  if (digestAt && localTime(now) >= digestAt && meta.get("digest_day") !== today) {
    meta.set("digest_day", today);
    if (open.length > 0) {
      const overdue = open.filter((t) => t.due_date! < today).length;
      const first = open
        .slice(0, 3)
        .map((t) => t.content)
        .join(" · ");
      out.push({
        key: `tasks:digest:${today}`,
        title: `${open.length} task${open.length === 1 ? "" : "s"} for today`,
        context: overdue > 0 ? `${overdue} overdue` : "Tasks",
        detail: first + (open.length > 3 ? ` · and ${open.length - 3} more` : ""),
      });
    }
  }
  return out;
}
