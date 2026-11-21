import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { isNotePath, noteName, notePathIn, noteRoot, noteSlug, type Note, type NoteContent, type NotesPayload } from "../shared/notes.ts";
import { noteRootDir, noteRoots, notesDir } from "./paths.ts";
import { ensureProjectFolder, projectOfWorkspace } from "./workspaces.ts";

/**
 * Notes, on top of folders.
 *
 * The files are the notes, and they stay exactly where and what they are so
 * that another editor on the same folder keeps working. They live in a
 * project's `notes` folder, or in the one notes folder that belongs to no
 * project. A note in a project's folder is that project's by being there; the
 * table holds what a file does not say, and a copy of each title so the list
 * does not have to open every file.
 *
 * A note is only ever written when someone saves it. Listing and opening read.
 */

const MAX_BYTES = 2_000_000;
const TITLE_BYTES = 4096;
const SKIP_DIRS = new Set(["node_modules", "artifacts"]);
const TRASH = ".trash";

let db: Database;

type Row = {
  path: string;
  title: string;
  workspace_id: number | null;
  project_id: number | null;
  home: number | null;
  home_archived: number | null;
  placed: number;
  modified_ts: number;
  size: number;
  missing: number;
};

export function initNotes(database: Database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      path         TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      workspace_id INTEGER,
      project_id   INTEGER,
      placed       INTEGER NOT NULL DEFAULT 0,
      modified_ts  INTEGER NOT NULL,
      size         INTEGER NOT NULL DEFAULT 0,
      missing      INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS note_writes (
      path       TEXT NOT NULL,
      session_id TEXT NOT NULL,
      ts         INTEGER,
      PRIMARY KEY (path, session_id)
    );
    CREATE TABLE IF NOT EXISTS note_folders (
      folder       TEXT PRIMARY KEY,
      project_id   INTEGER,
      workspace_id INTEGER
    );
  `);
}

type FolderRow = { folder: string; project_id: number | null; workspace_id: number | null; home: number | null; home_archived: number | null };

const folderRows = () =>
  db
    .query<FolderRow, []>(
      `SELECT f.*, COALESCE(w.project_id, f.project_id) AS home,
              (SELECT archived_at FROM projects WHERE id = COALESCE(w.project_id, f.project_id)) AS home_archived
         FROM note_folders f LEFT JOIN workspaces w ON w.id = f.workspace_id`,
    )
    .all();

/** The nearest folder above a note that is tied to a project. */
const folderOf = (path: string, folders: FolderRow[]): FolderRow | null =>
  folders.filter((f) => path.startsWith(`${f.folder}/`)).sort((a, b) => b.folder.length - a.folder.length)[0] ?? null;

/** Tie a folder, and with it every note under it, to a project or a checkout; null for both unties it. */
export function linkFolder(folder: string, link: { projectId: number | null; workspaceId: number | null }): boolean {
  const clean = folder.replace(/^\/+|\/+$/g, "");
  if (!clean || noteRoot(clean).projectId !== null || !isNotePath(`${clean}/x.md`)) return false;
  if (link.projectId === null && link.workspaceId === null) db.query("DELETE FROM note_folders WHERE folder = ?").run(clean);
  else
    db.query(
      `INSERT INTO note_folders (folder, project_id, workspace_id) VALUES (?, ?, ?)
       ON CONFLICT(folder) DO UPDATE SET project_id = excluded.project_id, workspace_id = excluded.workspace_id`,
    ).run(clean, link.workspaceId === null ? link.projectId : null, link.workspaceId);
  return true;
}

const SELECT = `SELECT n.*, COALESCE(w.project_id, n.project_id) AS home,
                       (SELECT archived_at FROM projects WHERE id = COALESCE(w.project_id, n.project_id)) AS home_archived
                  FROM notes n LEFT JOIN workspaces w ON w.id = n.workspace_id`;

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");
/** The folder a note's id is in, and the file itself. A project that has no folder any more has no notes to find. */
const rootDirOf = (path: string) => noteRootDir(noteRoot(path).projectId) ?? join(notesDir(), ".no-such-project");
const fileOf = (path: string) => join(rootDirOf(path), ...noteRoot(path).rel.split("/").filter(Boolean));

const toNote = (r: Row, folders: FolderRow[] = folderRows()): Note => {
  const own = r.home !== null || r.workspace_id !== null;
  const from = own ? null : folderOf(r.path, folders);
  return {
    path: r.path,
    title: r.title,
    projectId: own ? r.home : (from?.home ?? null),
    workspaceId: own ? r.workspace_id : (from?.workspace_id ?? null),
    modifiedAt: r.modified_ts,
    size: r.size,
    archived: (own ? r.home_archived : (from?.home_archived ?? null)) !== null,
    via: from?.folder ?? null,
  };
};

/** The file an agent or an editor would open for this note. */
export const noteFile = (path: string): string => fileOf(path);

const rowOf = (path: string) => db.query<Row, [string]>(`${SELECT} WHERE n.path = ? AND n.missing = 0`).get(path);

/** The absolute file for a note path, once it is known to stay inside the notes folder. */
function locate(path: string): string | null {
  if (!isNotePath(path)) return null;
  const file = fileOf(path);
  try {
    const root = realpathSync(rootDirOf(path));
    const parent = realpathSync(dirname(file));
    return parent === root || parent.startsWith(root + sep) ? file : null;
  } catch {
    return null;
  }
}

function titleOf(file: string, path: string): string {
  try {
    const head = readFileSync(file, "utf8").slice(0, TITLE_BYTES);
    const body = head.startsWith("---\n") ? head.slice(Math.max(0, head.indexOf("\n---", 4)) + 4) : head;
    const m = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
    if (m) return m[1]!.slice(0, 200);
  } catch {
    return noteName(path);
  }
  return noteName(path);
}

function walk(dir: string, rel: string, out: { path: string; file: string }[], dirs?: string[]) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const next = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      dirs?.push(next);
      walk(join(dir, e.name), next, out, dirs);
    } else if (e.isFile() && /\.md$/i.test(e.name)) out.push({ path: next, file: join(dir, e.name) });
  }
}

/**
 * Bring the table in line with the folder, and place notes a session wrote in
 * the workspace that session is filed in. Returns how many rows changed.
 */
export function reconcileNotes(): number {
  const found: { path: string; file: string; projectId: number | null }[] = [];
  for (const root of noteRoots()) {
    const here: { path: string; file: string }[] = [];
    walk(root.dir, "", here);
    for (const n of here) found.push({ path: notePathIn(root.projectId, n.path), file: n.file, projectId: root.projectId });
  }
  const known = new Map(db.query<Row, []>(`${SELECT}`).all().map((r) => [r.path, r]));
  const seen = new Set<string>();
  const own = db.query(
    `UPDATE notes SET project_id = ?1, placed = 1,
            workspace_id = CASE WHEN workspace_id IN (SELECT id FROM workspaces WHERE project_id = ?1) THEN workspace_id ELSE NULL END
      WHERE path = ?2`,
  );
  let changed = 0;
  for (const { path, file, projectId } of found) {
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    seen.add(path);
    const modified = Math.floor(st.mtimeMs);
    const prev = known.get(path);
    if (!prev) {
      db.query("INSERT INTO notes (path, title, modified_ts, size) VALUES (?, ?, ?, ?)").run(path, titleOf(file, path), modified, st.size);
      changed++;
    } else if (prev.modified_ts !== modified || prev.size !== st.size || prev.missing) {
      db.query("UPDATE notes SET title = ?, modified_ts = ?, size = ?, missing = 0 WHERE path = ?").run(titleOf(file, path), modified, st.size, path);
      changed++;
    }
    if (projectId !== null && (!prev || prev.home !== projectId || prev.project_id !== projectId)) {
      own.run(projectId, path);
      changed++;
    }
  }
  for (const [path, row] of known) {
    if (!seen.has(path) && !row.missing) {
      db.query("UPDATE notes SET missing = 1 WHERE path = ?").run(path);
      changed++;
    }
  }
  changed += db
    .query(
      `UPDATE notes SET workspace_id = (
         SELECT ws.workspace_id FROM note_writes nw
           JOIN workspace_sessions ws ON ws.session_id = nw.session_id
          WHERE nw.path = notes.path ORDER BY nw.ts LIMIT 1
       ), placed = 1
       WHERE placed = 0 AND missing = 0 AND workspace_id IS NULL AND project_id IS NULL
         AND EXISTS (
           SELECT 1 FROM note_writes nw JOIN workspace_sessions ws ON ws.session_id = nw.session_id
            WHERE nw.path = notes.path
         )`,
    )
    .run().changes;
  return changed;
}

export function notesPayload(): NotesPayload {
  const rows = db.query<Row, []>(`${SELECT} WHERE n.missing = 0 ORDER BY n.modified_ts DESC`).all();
  const folders = folderRows();
  const dirs: string[] = [];
  for (const root of noteRoots()) {
    if (root.projectId === null) walk(root.dir, "", [], dirs);
    else if (existsSync(root.dir)) {
      const inside: string[] = [];
      walk(root.dir, "", [], inside);
      dirs.push(notePathIn(root.projectId, ""), ...inside.map((d) => notePathIn(root.projectId, d)));
    }
  }
  return {
    notes: rows.map((r) => toNote(r, folders)),
    root: notesDir(),
    dirs,
    folders: folders.map((f) => ({ folder: f.folder, projectId: f.home, workspaceId: f.workspace_id })),
  };
}

export function readNote(path: string): NoteContent | null {
  const file = locate(path);
  if (!file) return null;
  let content: string;
  try {
    if (statSync(file).size > MAX_BYTES) return null;
    content = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (!rowOf(path)) reconcileNotes();
  const row = rowOf(path);
  return row ? { note: toNote(row), content, hash: hashOf(content) } : null;
}

export type NoteSave = { ok: true; hash: string; note: Note } | { ok: false; error: string; conflict?: NoteContent };

/**
 * Write a note. `baseHash` is what the page loaded: when the file moved on
 * since, because another editor or a session rewrote it, the save is refused
 * and the newer text handed back rather than one side overwriting the other.
 */
export function saveNote(path: string, content: string, baseHash?: string): NoteSave {
  const file = locate(path);
  const current = file ? readNote(path) : null;
  if (!file || !current) return { ok: false, error: "no such note" };
  if (content.length > MAX_BYTES) return { ok: false, error: "the note is too large to save" };
  if (baseHash && baseHash !== current.hash) return { ok: false, error: "the note changed on disk", conflict: current };
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
  reconcileNotes();
  return { ok: true, hash: hashOf(content), note: toNote(rowOf(path)!) };
}

/** A free file name for a note in a folder, which may be a project's (`p7@`, `p7@/plans`). */
function freePath(folder: string, slug: string): string {
  const base = slug || "note";
  const { projectId, rel } = noteRoot(folder);
  for (let n = 1; ; n++) {
    const path = notePathIn(projectId, `${rel ? `${rel}/` : ""}${n === 1 ? base : `${base}-${n}`}.md`);
    if (!existsSync(fileOf(path))) return path;
  }
}

/** The project whose folder holds the notes of this project or checkout: null when it keeps none, and the old folder is used. */
function folderProject(projectId: number | null | undefined, workspaceId: number | null | undefined): number | null {
  const project = workspaceId != null ? projectOfWorkspace(workspaceId) : (projectId ?? null);
  if (project === null) return null;
  try {
    return ensureProjectFolder(project) ? project : null;
  } catch {
    return null;
  }
}

/**
 * Make a note. For a project that keeps a folder it is written into that
 * folder's `notes`; `folder` then only counts when it is a folder in there.
 */
export function createNote(opts: {
  title?: string;
  content?: string;
  folder?: string;
  projectId?: number | null;
  workspaceId?: number | null;
}): Note | null {
  const title = opts.title?.trim() || "Untitled";
  const asked = (opts.folder ?? "").replace(/^\/+|\/+$/g, "");
  const within = noteRoot(asked).projectId;
  const home = within ?? folderProject(opts.projectId, opts.workspaceId);
  if (within !== null) folderProject(within, null);
  const folder = home === null || within === home ? asked : notePathIn(home, "");
  const path = freePath(folder, noteSlug(title));
  if (!isNotePath(path) || !noteRootDir(noteRoot(path).projectId)) return null;
  mkdirSync(dirname(fileOf(path)), { recursive: true });
  if (!locate(path)) return null;
  const content = opts.content?.trim() ? opts.content : `# ${title}\n\n`;
  writeFileSync(fileOf(path), content);
  reconcileNotes();
  const workspace = opts.workspaceId != null && (home === null || projectOfWorkspace(opts.workspaceId) === home) ? opts.workspaceId : null;
  db.query("UPDATE notes SET workspace_id = ?, project_id = ?, placed = 1 WHERE path = ?").run(
    workspace,
    home ?? (workspace ? null : (opts.projectId ?? null)),
    path,
  );
  return toNote(rowOf(path)!);
}

/** Make a folder inside a notes folder. Returns its path, or null when it would fall outside. */
export function createFolder(path: string): string | null {
  const { projectId, rel } = noteRoot(path.trim());
  const clean = rel
    .split("/")
    .map((part) => part.trim().replace(/[\\:*?"<>|]+/g, " ").trim())
    .filter(Boolean)
    .join("/");
  const base = noteRootDir(projectId);
  if (!clean || !base || !isNotePath("", `${clean}/x.md`)) return null;
  const dir = join(base, ...clean.split("/"));
  mkdirSync(dir, { recursive: true });
  try {
    const root = realpathSync(base);
    return realpathSync(dir).startsWith(root + sep) ? notePathIn(projectId, clean) : null;
  } catch {
    return null;
  }
}

/** Give a note's row, and what sessions wrote it, a new id after its file moved. */
function rekey(from: string, to: string) {
  db.query("DELETE FROM notes WHERE path = ?").run(to);
  db.query("UPDATE notes SET path = ? WHERE path = ?").run(to, from);
  db.query("UPDATE OR REPLACE note_writes SET path = ? WHERE path = ?").run(to, from);
}

/**
 * Move a note's file into a project's `notes` folder, or with null into the
 * notes folder that belongs to no project. Returns its new id.
 */
function moveNote(path: string, toProject: number | null): string {
  const from = locate(path);
  if (!from || noteRoot(path).projectId === toProject || !noteRootDir(toProject)) return path;
  const next = freePath(notePathIn(toProject, ""), noteName(path));
  mkdirSync(dirname(fileOf(next)), { recursive: true });
  try {
    renameSync(from, fileOf(next));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    cpSync(from, fileOf(next));
    rmSync(from, { force: true });
  }
  rekey(path, next);
  return next;
}

/**
 * Say whose a note is: a project, one checkout in it, or nobody. Giving it to a
 * project that keeps a folder moves the file into that folder's `notes`, and
 * taking it out of every project moves it back to the notes folder, so the
 * note may come back under a new id. A project with no folder of its own, a
 * repository's standing one, is only noted.
 */
export function linkNote(path: string, link: { projectId?: number | null; workspaceId?: number | null }): Note | null {
  if (!rowOf(path)) return null;
  let id = path;
  if (link.workspaceId != null) {
    const home = folderProject(null, link.workspaceId);
    if (home !== null || noteRoot(id).projectId !== null) id = moveNote(id, home);
    db.query("UPDATE notes SET workspace_id = ?, project_id = ?, placed = 1 WHERE path = ?").run(link.workspaceId, home, id);
  } else if (link.projectId !== undefined || link.workspaceId === null) {
    const wanted = link.projectId !== undefined ? link.projectId : rowOf(id)!.home;
    const home = folderProject(wanted, null);
    if (home !== null || noteRoot(id).projectId !== null) id = moveNote(id, home);
    db.query("UPDATE notes SET project_id = ?, workspace_id = NULL, placed = 1 WHERE path = ?").run(wanted, id);
  }
  return toNote(rowOf(id)!);
}

/** Give a note another file name, in the folder it is already in. Its links to a project come along. */
export function renameNote(path: string, name: string): Note | null {
  const from = locate(path);
  const clean = name.trim().replace(/\.md$/i, "").replace(/[\\/:*?"<>|]+/g, " ").trim();
  if (!from || !rowOf(path) || !clean) return null;
  const { projectId, rel } = noteRoot(path);
  const folder = rel.split("/").slice(0, -1).join("/");
  const next = notePathIn(projectId, `${folder ? `${folder}/` : ""}${clean}.md`);
  if (next === path) return toNote(rowOf(path)!);
  if (!isNotePath(next) || existsSync(fileOf(next))) return null;
  renameSync(from, fileOf(next));
  rekey(path, next);
  reconcileNotes();
  return toNote(rowOf(next)!);
}

/** Move a note to the folder's `.trash`, where Obsidian puts deleted notes too: it can be taken back out. */
export function trashNote(path: string): boolean {
  const from = locate(path);
  if (!from || !rowOf(path)) return false;
  const bin = join(rootDirOf(path), TRASH);
  mkdirSync(bin, { recursive: true });
  const name = path.split("/").pop()!;
  const to = existsSync(join(bin, name)) ? join(bin, `${Date.now()}-${name}`) : join(bin, name);
  renameSync(from, to);
  db.query("DELETE FROM notes WHERE path = ?").run(path);
  db.query("DELETE FROM note_writes WHERE path = ?").run(path);
  return true;
}

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

/** An image inside the notes folder, for a note that shows one. */
export function noteAsset(path: string): { file: string; type: string } | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const type = IMAGE_TYPES[ext];
  const inside = noteRoot(path).rel;
  if (!type || inside.startsWith("/") || inside.split("/").some((part) => !part || part === ".." || part.startsWith("."))) return null;
  const file = fileOf(path);
  try {
    const root = realpathSync(rootDirOf(path));
    const real = realpathSync(file);
    return real.startsWith(root + sep) ? { file: real, type } : null;
  } catch {
    return null;
  }
}

/** Called when a workspace is deleted: its notes stay in the project it was part of. */
export function unplaceNotesOf(workspaceId: number) {
  db.query(
    `UPDATE note_folders SET project_id = (SELECT project_id FROM workspaces WHERE id = note_folders.workspace_id), workspace_id = NULL
      WHERE workspace_id = ?`,
  ).run(workspaceId);
  db.query(
    `UPDATE notes SET project_id = (SELECT project_id FROM workspaces WHERE id = notes.workspace_id), workspace_id = NULL
      WHERE workspace_id = ?`,
  ).run(workspaceId);
}

/** Called when a project is deleted: its notes stay on disk, belonging to none. */
export function unplaceNotesOfProject(projectId: number) {
  db.query("UPDATE notes SET project_id = NULL WHERE project_id = ?").run(projectId);
  db.query("DELETE FROM note_folders WHERE project_id = ?").run(projectId);
}
