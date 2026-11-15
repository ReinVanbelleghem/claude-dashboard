import type { Priority, Recurrence } from "./taskDates.ts";

/**
 * Tasks: the dashboard's own to-do list. Types shared by the daemon
 * (server/tasks.ts) and the Tasks page.
 */
/** The colours a project's dot can take, by name; the stylesheet's own tokens, so they follow the theme. */
export const TASK_COLORS = {
  red: "var(--critical)",
  orange: "var(--series-2)",
  yellow: "var(--series-4)",
  green: "var(--series-3)",
  teal: "var(--syn-type)",
  blue: "var(--series-1)",
  purple: "var(--syn-kw)",
  grey: "var(--text-muted)",
} as const;
export type TaskColor = keyof typeof TASK_COLORS;

export type TaskProject = {
  id: number;
  name: string;
  /** A name from TASK_COLORS, or null until one is picked. */
  color: string | null;
  /** The one project a task lands in when nothing says where it belongs. */
  isInbox: boolean;
  order: number;
  /** The repository this project's tasks are about, so a task added from a session there files itself. */
  repoKey: string | null;
};

export type Task = {
  id: number;
  projectId: number;
  content: string;
  description: string;
  /** 1 = P1 (most urgent) … 4 = none. */
  priority: Priority;
  /** Local calendar day YYYY-MM-DD, and local time HH:MM for a timed task. */
  dueDate: string | null;
  dueTime: string | null;
  /** What was typed for the due date, kept for display and editing. */
  dueString: string | null;
  recurrence: Recurrence | null;
  labels: string[];
  /** Where the work lives: a pull request, a thread, a page. Shown as the service's mark. */
  links: string[];
  order: number;
  completedAt: number | null;
  createdAt: number;
  /** The workspace it belongs to. A workspace can hold any number of tasks. */
  workspaceId: number | null;
};

export type TasksPayload = {
  projects: TaskProject[];
  /** Every open task, plus the ones completed in the last week. */
  tasks: Task[];
};

export type TaskAdd = {
  /** A quick-add line: "review PR tomorrow 9:00 p1 #backend". Parsed for date, priority and project. */
  text?: string;
  content?: string;
  description?: string;
  projectId?: number;
  /** A project by name; created when no project has it. */
  project?: string;
  priority?: Priority;
  /** A due string, parsed like the quick-add line: "friday 14:00", "every monday". */
  due?: string;
  /**
   * The folder the request comes from. Its repository decides the project when none
   * is named, and a named workspace living there takes the task when none is given.
   */
  cwd?: string;
  /** The workspace the task belongs to. */
  workspaceId?: number;
  /** Addresses the task is about. Any found in the text or the description are added too. */
  links?: string[];
  /** "agent" when a session added it on your behalf. */
  by?: "user" | "agent";
};

export type TaskPatch = {
  content?: string;
  description?: string;
  projectId?: number;
  priority?: Priority;
  /** A new due string; empty clears the date. */
  due?: string;
  /** A picked date (YYYY-MM-DD) or null for none. Unlike `due`, it keeps a repeating task repeating. */
  dueDate?: string | null;
  /** A picked time (HH:MM) or null for an all-day task. */
  dueTime?: string | null;
  /** The task's links, replacing the ones it had. */
  links?: string[];
};

export const COMPLETED_SHOWN_MS = 7 * 86_400_000;
