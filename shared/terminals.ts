/** A shell in a workspace's folder, kept alive in tmux and listed beside the workspace's sessions. */
export type WorkspaceTerminal = {
  id: number;
  /** The workspace it was opened from, or null for a bare folder. */
  workspaceId: number | null;
  folder: string;
  title: string;
  /** The tmux session that holds the shell. */
  session: string;
  createdAt: number;
};

const PREFIX = "term:";

/** The id a terminal goes by wherever sessions are opened: drawer, tile, page and sidebar. */
export const terminalKey = (id: number) => `${PREFIX}${id}`;
export const isTerminalKey = (key: string | null | undefined): key is string => !!key && key.startsWith(PREFIX);
export const terminalIdOf = (key: string) => Number(key.slice(PREFIX.length));
