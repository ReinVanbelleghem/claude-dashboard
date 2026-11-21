/**
 * Projects and workspaces. A project is one piece of work; a workspace is one
 * checkout it is done in, so a change that spans a backend and a frontend is one
 * project with a workspace in each. Sessions run in a workspace.
 * Types shared by the daemon (server/workspaces.ts) and the sidebar.
 */
export type WorkspaceStatus = "active" | "paused" | "archived";

export type Workspace = {
  id: number;
  /** The project this checkout is part of. */
  projectId: number;
  /** `repo:<shared .git>` for a repository, `dir:<folder>` for a plain folder. */
  repoKey: string;
  repoName: string;
  repoRoot: string;
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

/** One piece of work: the workspaces it is done in, and through them its sessions, drawings and pages. */
export type Project = {
  id: number;
  name: string;
  /** A name you typed is never replaced by an automatic one. */
  nameSource: "auto" | "user";
  /**
   * Set on a repository's standing project, which holds the work in its main
   * checkout that belongs to no change in particular: the repository's key.
   */
  generalKey: string | null;
  /** Made by you rather than by the daemon filing a checkout: it shows even while empty. */
  explicit: boolean;
  order: number;
  createdAt: number;
  /** Set while the project is put away: off the sidebar, its notes, drawings and pages out of the lists. */
  archivedAt: number | null;
  /** A glyph or `img:<file>` of the project's own; null leaves its repositories' marks. */
  icon: string | null;
  color: string | null;
  /**
   * The project's own folder, where its worktrees, notes, drawings and artifacts
   * live. Absent on a repository's standing project, and until the first thing
   * needs it on a project made before folders existed.
   */
  folder?: string | null;
};

/** A repository, or a plain folder, that workspaces are checkouts of. It carries the mark they wear. */
export type WorkspaceRepo = {
  key: string;
  name: string;
  root: string;
  order: number;
  /** A glyph name, `img:<file>` for an uploaded image, or null for the project's initials. */
  icon: string | null;
  /** A name from TASK_COLORS, or null until one is picked. */
  color: string | null;
};

export type WorkspacesPayload = {
  projects: Project[];
  repos: WorkspaceRepo[];
  workspaces: Workspace[];
  /** Session id, or agent key until the id lands, to the workspace holding it. */
  sessions: Record<string, number>;
  /** Sessions that run in a project's own folder rather than in one of its checkouts, to that project. */
  projectSessions?: Record<string, number>;
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
  /\/\.claude-dashboard[^/]*\/(scratch|goals)(\/|$)/.test(p);

/** The folder name a project gets, from its name. Fixed once made: renaming the project leaves it alone. */
export const projectSlug = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "") || "project";

export const folderName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/** A goal-less workspace in a worktree goes by its branch: the folder name only repeats it. */
export const namedByBranch = (w: Pick<Workspace, "goal" | "folder" | "repoRoot" | "branch">): boolean =>
  !w.goal.trim() && !!w.branch && w.folder !== w.repoRoot;

/** What a card is called: its goal, else its worktree's branch, else the folder it lives in. */
export function workspaceTitle(
  w: Pick<Workspace, "goal" | "folder" | "repoRoot" | "repoName" | "branch">,
): string {
  const goal = w.goal.trim();
  if (goal) return goal;
  if (namedByBranch(w)) return w.branch!;
  return w.folder === w.repoRoot ? w.repoName : folderName(w.folder);
}

/** The line under the title: the branch, else the folder when the title is not already it. */
export function workspaceSub(w: Pick<Workspace, "goal" | "folder" | "branch">): string | null {
  if (w.branch) return w.branch;
  return w.goal.trim() ? folderName(w.folder) : null;
}
