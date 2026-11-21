import { useSyncExternalStore } from "react";
import { markKey } from "../shared/projectMarks.ts";
import type { WorkspaceRepo } from "../shared/workspaces.ts";

export type StoredMark = Pick<WorkspaceRepo, "key" | "name" | "icon" | "color">;

let marks = new Map<string, StoredMark>();
let stamp = "";
const listeners = new Set<() => void>();

/** Called with every workspaces payload, so a mark picked in one place shows everywhere. */
export function setProjectMarks(projects: WorkspaceRepo[]) {
  const next = JSON.stringify(projects.map((p) => [p.key, p.name, p.icon, p.color]));
  if (next === stamp) return;
  stamp = next;
  marks = new Map(projects.map((p) => [p.key, { key: p.key, name: p.name, icon: p.icon, color: p.color }]));
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The mark stored for a project key, a bare repository key, or null when the project is not on the sidebar. */
export function useProjectMark(key: string | null | undefined): StoredMark | null {
  return useSyncExternalStore(subscribe, () => (key ? (marks.get(markKey(key)) ?? null) : null));
}
