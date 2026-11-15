import type { Task, TaskProject } from "../../api.ts";
import { TASK_COLORS, type TaskColor } from "../../../shared/tasks.ts";

export const projectOf = (projects: TaskProject[], task: Task): TaskProject | undefined => projects.find((p) => p.id === task.projectId);

export const projectColor = (project: TaskProject): string => TASK_COLORS[(project.color ?? "grey") as TaskColor] ?? TASK_COLORS.grey;

export function TaskMark({ task }: { task: Task }) {
  return <i className={`cal-task-mark p${task.priority}`} title={task.priority < 4 ? `Priority ${task.priority}` : undefined} />;
}

export function TaskProjectTag({ projects, task }: { projects: TaskProject[]; task: Task }) {
  const project = projectOf(projects, task);
  if (!project || project.isInbox) return null;
  return (
    <em className="cal-task-project">
      <i style={{ background: projectColor(project) }} />
      {project.name}
    </em>
  );
}
