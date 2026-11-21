import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { WorkspaceTerminal } from "../shared/terminals.ts";
import { tmux } from "./services.ts";

/**
 * tmux sessions the dashboard opened as workspace terminals carry this prefix.
 * It follows DASHBOARD_TMUX_PREFIX, so a second dashboard on the same machine
 * names its terminals apart from the first one's.
 */
export const TERMINAL_SESSION_PREFIX = `${process.env.DASHBOARD_TMUX_PREFIX ?? "dash"}term-`;
const SYNC_MS = 5_000;

type Row = { id: number; workspace_id: number | null; folder: string; title: string; session: string; created_at: number };

let db: Database;
let emit: (terminals: WorkspaceTerminal[]) => void = () => {};

const toTerminal = (r: Row): WorkspaceTerminal => ({
  id: r.id,
  workspaceId: r.workspace_id,
  folder: r.folder,
  title: r.title,
  session: r.session,
  createdAt: r.created_at,
});

export const listTerminals = (): WorkspaceTerminal[] => db.query<Row, []>("SELECT * FROM terminals ORDER BY created_at, id").all().map(toTerminal);

const changed = () => emit(listTerminals());

/** Drops every terminal whose shell has exited, so the list matches what tmux still holds. */
async function sync(): Promise<void> {
  const rows = listTerminals();
  if (rows.length === 0) return;
  const res = await tmux("list-sessions", "-F", "#{session_name}");
  const alive = new Set(res.ok ? res.out.split("\n") : []);
  if (!res.ok && !/no server running|no sessions/i.test(res.err)) return;
  const gone = rows.filter((t) => !alive.has(t.session));
  if (gone.length === 0) return;
  for (const t of gone) db.query("DELETE FROM terminals WHERE id = ?").run(t.id);
  changed();
}

export function initTerminals(database: Database, onChange: (terminals: WorkspaceTerminal[]) => void) {
  db = database;
  emit = onChange;
  db.exec(`
    CREATE TABLE IF NOT EXISTS terminals (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER,
      folder       TEXT NOT NULL,
      title        TEXT NOT NULL,
      session      TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    );
  `);
  void sync();
  setInterval(() => void sync().catch((err) => console.error("[claude-dashboard] terminal sync failed:", err)), SYNC_MS);
}

/** Opens a shell in `folder`, inside a tmux session of its own so it outlives the page that shows it. */
export async function createTerminal(opts: { folder: string; workspaceId: number | null; title?: string }): Promise<WorkspaceTerminal | { error: string }> {
  const folder = opts.folder.trim();
  if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) return { error: "that folder does not exist" };
  const taken = listTerminals().filter((t) => t.folder === folder).length;
  const title = opts.title?.trim() || (taken === 0 ? "Terminal" : `Terminal ${taken + 1}`);
  const now = Date.now();
  const id = Number(
    db.query("INSERT INTO terminals (workspace_id, folder, title, session, created_at) VALUES (?, ?, ?, '', ?)").run(opts.workspaceId, folder, title, now).lastInsertRowid,
  );
  const session = `${TERMINAL_SESSION_PREFIX}${id}`;
  const made = await tmux("new-session", "-d", "-s", session, "-c", folder, "-n", basename(folder) || "shell");
  if (!made.ok) {
    db.query("DELETE FROM terminals WHERE id = ?").run(id);
    return { error: made.err.trim() || "tmux could not start a session" };
  }
  await tmux("set-option", "-t", session, "status", "off");
  db.query("UPDATE terminals SET session = ? WHERE id = ?").run(session, id);
  changed();
  return listTerminals().find((t) => t.id === id)!;
}

export function renameTerminal(id: number, title: string): boolean {
  const next = title.trim();
  if (!next) return false;
  const done = db.query("UPDATE terminals SET title = ? WHERE id = ?").run(next, id).changes > 0;
  if (done) changed();
  return done;
}

/** Ends the shell and everything running in it. */
export async function closeTerminal(id: number): Promise<boolean> {
  const row = listTerminals().find((t) => t.id === id);
  if (!row) return false;
  await tmux("kill-session", "-t", `=${row.session}`);
  db.query("DELETE FROM terminals WHERE id = ?").run(id);
  changed();
  return true;
}
