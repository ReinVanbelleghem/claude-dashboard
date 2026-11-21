import { useSyncExternalStore } from "react";
import type { Project, Workspace } from "../shared/workspaces.ts";

type Known = { projects: Project[]; workspaces: Workspace[] };

let known: Known = { projects: [], workspaces: [] };
const listeners = new Set<() => void>();

/** Called with every workspaces payload, so a panel anywhere can name and pick projects. */
export function setProjectList(projects: Project[], workspaces: Workspace[]) {
  known = { projects, workspaces };
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useProjectList(): Known {
  return useSyncExternalStore(subscribe, () => known);
}
