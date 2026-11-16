import type { CSSProperties } from "react";
import type { Task, TaskProject } from "../../api.ts";
import { TASK_COLORS, type TaskColor } from "../../../shared/tasks.ts";

export const projectOf = (projects: TaskProject[], task: Task): TaskProject | undefined => projects.find((p) => p.id === task.projectId);

export const projectColor = (project: TaskProject): string => TASK_COLORS[(project.color ?? "grey") as TaskColor] ?? TASK_COLORS.grey;

export function TaskMark({ task }: { task: Task }) {
  const done = task.completedAt !== null;
  return <i className={`cal-task-mark p${task.priority} ${done ? "done" : ""}`} title={done ? "Done" : task.priority < 4 ? `Priority ${task.priority}` : undefined} />;
}

const named = (projects: TaskProject[], task: Task): TaskProject | null => {
  const project = projectOf(projects, task);
  return project && !project.isInbox ? project : null;
};

/** The project colour a task's pill is tinted with; an Inbox task and a finished one keep the neutral one. */
export const taskTint = (projects: TaskProject[], task: Task): CSSProperties => {
  const project = task.completedAt === null ? named(projects, task) : null;
  return project ? ({ "--ev": projectColor(project) } as CSSProperties) : {};
};

export const taskTitle = (projects: TaskProject[], task: Task): string => {
  const project = named(projects, task);
  return project ? `${task.content} · ${project.name}` : task.content;
};

/** Ids kept beside the hidden calendars: a task project switched off in the calendar, and finished tasks switched off. */
export const taskProjectKey = (projectId: number): string => `tasks:project:${projectId}`;
export const TASKS_DONE_KEY = "tasks:completed";

export const tasksShown = (tasks: Task[], hidden: string[]): Task[] =>
  tasks.filter((t) => !hidden.includes(taskProjectKey(t.projectId)) && (t.completedAt === null || !hidden.includes(TASKS_DONE_KEY)));
