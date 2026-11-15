/**
 * Workspaces: one goal inside a project, holding the sessions that work on it.
 * Types shared by the daemon (server/workspaces.ts) and the sidebar.
 */
export type WorkspaceStatus = "active" | "paused" | "archived";

export type Workspace = {
  id: number;
  /** `repo:<shared .git>` for a repository, `dir:<folder>` for a plain folder. */
  projectKey: string;
  projectName: string;
  projectRoot: string;
  /** One line. Empty until someone types one or the automatic one lands. */
  goal: string;
  /** A typed goal is never overwritten by the automatic one. */
  goalSource: "auto" | "user";
  /** Made by you in the dialog, rather than by the daemon filing a session: it shows even while empty. */
  explicit: boolean;
  /** Where its sessions run: a checkout root or a folder. */
  folder: string;
  branch: string | null;
  status: WorkspaceStatus;
  createdAt: number;
  lastActivityAt: number;
  archivedAt: number | null;
  order: number;
};

/** A project in the sidebar. It stays, in the place you gave it, until you delete it: empty or not. */
export type WorkspaceProject = { key: string; name: string; root: string; order: number };

export type WorkspacesPayload = {
  projects: WorkspaceProject[];
  workspaces: Workspace[];
  /** Session id, or agent key until the id lands, to the workspace holding it. */
  sessions: Record<string, number>;
  /** The place you dragged a session to within its workspace. Sessions without one follow, oldest first. */
  sessionOrder: Record<string, number>;
};

/**
 * Folders whose sessions are chats rather than work on a project: the home
 * folder, temp directories and the dashboard's own scratch space. They belong
 * to no workspace.
 */
export const isChatPath = (p: string): boolean =>
  /^\/(Users|home)\/[^/]+\/?$/.test(p) ||
  /^\/(private\/)?(tmp|var\/folders|var\/tmp)(\/|$)/.test(p) ||
  /\/\.claude-dashboard\/(scratch|goals)(\/|$)/.test(p);

export const folderName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/** A goal-less workspace in a worktree goes by its branch: the folder name only repeats it. */
export const namedByBranch = (w: Pick<Workspace, "goal" | "folder" | "projectRoot" | "branch">): boolean =>
  !w.goal.trim() && !!w.branch && w.folder !== w.projectRoot;

/** What a card is called: its goal, else its worktree's branch, else the folder it lives in. */
export function workspaceTitle(
  w: Pick<Workspace, "goal" | "folder" | "projectRoot" | "projectName" | "branch">,
): string {
  const goal = w.goal.trim();
  if (goal) return goal;
  if (namedByBranch(w)) return w.branch!;
  return w.folder === w.projectRoot ? w.projectName : folderName(w.folder);
}

/** The line under the title: the branch, else the folder when the title is not already it. */
export function workspaceSub(w: Pick<Workspace, "goal" | "folder" | "branch">): string | null {
  if (w.branch) return w.branch;
  return w.goal.trim() ? folderName(w.folder) : null;
}
