import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseProjectFileId, projectFileId } from "../shared/projectFiles.ts";
import {
  DRAWING_EXT,
  EMPTY_SCENE,
  isDrawingSlug,
  slugOfTitle,
  type Drawing,
  type DrawingScene,
  type DrawingsPayload,
} from "../shared/drawings.ts";
import { drawingRootOf, drawingRoots, drawingsDir } from "./paths.ts";
import { ensureProjectFolder, projectOfWorkspace } from "./workspaces.ts";

/**
 * Drawings, on top of folders.
 *
 * The files are the drawings: one `<slug>.excalidraw` each, with an optional
 * `<slug>.svg` preview beside it. They live in a project's `drawings` folder,
 * or in the one drawings folder that belongs to no project. One in a project's
 * folder is that project's because of where it is; the table only adds what a
 * file cannot say, so deleting the dashboard's data never loses a drawing.
 *
 * A drawing belongs to a project, and may also name the one checkout in it that
 * it is about; it then follows that checkout if the checkout changes project.
 * One an agent wrote is tied to the workspace its session is filed in, the first
 * time the two are both known, and stays wherever you move it after that.
 */

const MAX_BYTES = 20_000_000;
const PREVIEW_MAX_BYTES = 4_000_000;

let db: Database;

type Row = {
  slug: string;
  title: string;
  workspace_id: number | null;
  project_id: number | null;
  /** The project in effect: the workspace's own when the drawing names one. */
  home: number | null;
  home_archived: number | null;
  placed: number;
  created_ts: number;
  modified_ts: number;
  size: number;
  missing: number;
};

export function initDrawings(database: Database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS drawings (
      slug         TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      workspace_id INTEGER,
      placed       INTEGER NOT NULL DEFAULT 0,
      created_ts   INTEGER NOT NULL,
      modified_ts  INTEGER NOT NULL,
      size         INTEGER NOT NULL DEFAULT 0,
      missing      INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS drawing_writes (
      slug       TEXT NOT NULL,
      session_id TEXT NOT NULL,
      ts         INTEGER,
      PRIMARY KEY (slug, session_id)
    );
  `);
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(drawings)").all();
  if (!cols.some((c) => c.name === "project_id")) db.exec("ALTER TABLE drawings ADD COLUMN project_id INTEGER");
}

const SELECT = `SELECT d.*, COALESCE(w.project_id, d.project_id) AS home,
                       (SELECT archived_at FROM projects WHERE id = COALESCE(w.project_id, d.project_id)) AS home_archived
                  FROM drawings d LEFT JOIN workspaces w ON w.id = d.workspace_id`;

type Place = { projectId: number | null; name: string; file: string; preview: string };

/** Where a drawing's files are, from its id; null when the id names no file a drawing could be. */
function placeOf(id: string): Place | null {
  const { projectId, name } = parseProjectFileId(id);
  const root = drawingRootOf(projectId);
  if (!root || !isDrawingSlug(name)) return null;
  return { projectId, name, file: join(root, `${name}${DRAWING_EXT}`), preview: join(root, `${name}.svg`) };
}

/** The file an agent or an editor would open for this drawing. */
export const drawingFile = (id: string): string | null => placeOf(id)?.file ?? null;
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");
const titleOfSlug = (slug: string) => slug.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());

const toDrawing = (r: Row): Drawing => ({
  slug: r.slug,
  title: r.title,
  projectId: r.home,
  workspaceId: r.workspace_id,
  createdAt: r.created_ts,
  modifiedAt: r.modified_ts,
  size: r.size,
  hasPreview: existsSync(placeOf(r.slug)?.preview ?? ""),
  archived: r.home_archived !== null,
});

const rowOf = (slug: string) => db.query<Row, [string]>(`${SELECT} WHERE d.slug = ? AND d.missing = 0`).get(slug);

export function drawingsPayload(): DrawingsPayload {
  const rows = db.query<Row, []>(`${SELECT} WHERE d.missing = 0 ORDER BY d.modified_ts DESC`).all();
  return { drawings: rows.map(toDrawing), root: drawingsDir() };
}

/**
 * Bring the table in line with the folder, and place drawings an agent wrote.
 * Returns how many rows changed, so the caller knows whether to tell the page.
 */
export function reconcileDrawings(): number {
  let changed = 0;
  const seen = new Set<string>();
  const known = new Map(db.query<Row, []>(`${SELECT}`).all().map((r) => [r.slug, r]));
  const own = db.query(
    `UPDATE drawings SET project_id = ?1, placed = 1,
            workspace_id = CASE WHEN workspace_id IN (SELECT id FROM workspaces WHERE project_id = ?1) THEN workspace_id ELSE NULL END
      WHERE slug = ?2`,
  );
  for (const root of drawingRoots()) {
    let names: string[] = [];
    try {
      names = readdirSync(root.dir).filter((n) => n.toLowerCase().endsWith(DRAWING_EXT));
    } catch {
      names = [];
    }
    for (const name of names) {
      const bare = name.slice(0, -DRAWING_EXT.length);
      if (!isDrawingSlug(bare)) continue;
      let st;
      try {
        st = statSync(join(root.dir, name));
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const slug = projectFileId(root.projectId, bare);
      seen.add(slug);
      const modified = Math.floor(st.mtimeMs);
      const prev = known.get(slug);
      if (!prev) {
        db.query("INSERT INTO drawings (slug, title, created_ts, modified_ts, size) VALUES (?, ?, ?, ?, ?)").run(
          slug,
          titleOfSlug(bare),
          Math.floor(st.birthtimeMs || st.mtimeMs),
          modified,
          st.size,
        );
        changed++;
      } else if (prev.modified_ts !== modified || prev.size !== st.size || prev.missing) {
        db.query("UPDATE drawings SET modified_ts = ?, size = ?, missing = 0 WHERE slug = ?").run(modified, st.size, slug);
        changed++;
      }
      if (root.projectId !== null && (!prev || prev.home !== root.projectId || prev.project_id !== root.projectId)) {
        own.run(root.projectId, slug);
        changed++;
      }
    }
  }
  for (const [slug, row] of known) {
    if (!seen.has(slug) && !row.missing) {
      db.query("UPDATE drawings SET missing = 1 WHERE slug = ?").run(slug);
      changed++;
    }
  }
  changed += db
    .query(
      `UPDATE drawings SET workspace_id = (
         SELECT ws.workspace_id FROM drawing_writes dw
           JOIN workspace_sessions ws ON ws.session_id = dw.session_id
          WHERE dw.slug = drawings.slug ORDER BY dw.ts LIMIT 1
       ), placed = 1
       WHERE placed = 0 AND missing = 0 AND workspace_id IS NULL
         AND EXISTS (
           SELECT 1 FROM drawing_writes dw JOIN workspace_sessions ws ON ws.session_id = dw.session_id
            WHERE dw.slug = drawings.slug
         )`,
    )
    .run().changes;
  return changed;
}

function freeSlug(wanted: string, projectId: number | null): string {
  const base = isDrawingSlug(wanted) ? wanted : "drawing";
  const root = drawingRootOf(projectId) ?? drawingsDir();
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const taken = db.query("SELECT 1 FROM drawings WHERE slug = ? AND missing = 0").get(projectFileId(projectId, name));
    if (!existsSync(join(root, `${name}${DRAWING_EXT}`)) && !taken) return name;
  }
}

/** The project whose folder a drawing for this project or checkout is kept in: null when it has none, and the old folder is used. */
function folderProject(projectId: number | null | undefined, workspaceId: number | null | undefined): number | null {
  const project = workspaceId != null ? projectOfWorkspace(workspaceId) : (projectId ?? null);
  if (project === null) return null;
  try {
    return ensureProjectFolder(project) ? project : null;
  } catch {
    return null;
  }
}

export function createDrawing(opts: { title?: string; workspaceId?: number | null; projectId?: number | null }): Drawing {
  const home = folderProject(opts.projectId, opts.workspaceId);
  const title = opts.title?.trim() || "Untitled drawing";
  const slug = projectFileId(home, freeSlug(slugOfTitle(title), home));
  const place = placeOf(slug)!;
  mkdirSync(drawingRootOf(home)!, { recursive: true });
  writeFileSync(place.file, EMPTY_SCENE);
  const now = Date.now();
  db.query(
    `INSERT INTO drawings (slug, title, workspace_id, project_id, placed, created_ts, modified_ts, size) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET title = excluded.title, workspace_id = excluded.workspace_id, project_id = excluded.project_id,
       placed = 1, created_ts = excluded.created_ts, modified_ts = excluded.modified_ts, size = excluded.size, missing = 0`,
  ).run(slug, title, opts.workspaceId ?? null, home ?? opts.projectId ?? null, now, now, EMPTY_SCENE.length);
  return toDrawing(rowOf(slug)!);
}

function moveFile(from: string, to: string) {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Move a drawing's files into a project's folder, or with null into the folder
 * that belongs to no project. Its id changes with it; what was known about it
 * follows. Returns the new id.
 */
function moveDrawing(id: string, toProject: number | null): string {
  const from = placeOf(id)!;
  if (from.projectId === toProject) return id;
  const root = drawingRootOf(toProject)!;
  mkdirSync(root, { recursive: true });
  const next = projectFileId(toProject, freeSlug(from.name, toProject));
  const to = placeOf(next)!;
  moveFile(from.file, to.file);
  if (existsSync(from.preview)) moveFile(from.preview, to.preview);
  db.query("DELETE FROM drawings WHERE slug = ?").run(next);
  db.query("UPDATE drawings SET slug = ? WHERE slug = ?").run(next, id);
  db.query("UPDATE OR REPLACE drawing_writes SET slug = ? WHERE slug = ?").run(next, id);
  return next;
}

export function readDrawing(slug: string): DrawingScene | null {
  const place = placeOf(slug);
  if (!place) return null;
  reconcileDrawings();
  const row = rowOf(slug);
  if (!row) return null;
  let scene: string;
  try {
    scene = readFileSync(place.file, "utf8");
  } catch {
    return null;
  }
  return { drawing: toDrawing(row), scene, hash: hashOf(scene) };
}

export type SaveResult = { ok: true; hash: string; drawing: Drawing } | { ok: false; error: string; conflict?: DrawingScene };

/**
 * Write a scene. `baseHash` is what the page loaded: when the file moved on
 * since, because an agent rewrote it, the save is refused and the newer scene
 * handed back rather than one side silently overwriting the other.
 */
export function saveDrawing(slug: string, scene: string, opts: { baseHash?: string; preview?: string } = {}): SaveResult {
  const current = readDrawing(slug);
  if (!current) return { ok: false, error: "no such drawing" };
  if (scene.length > MAX_BYTES) return { ok: false, error: "the drawing is too large to save" };
  try {
    const parsed = JSON.parse(scene) as { type?: unknown; elements?: unknown };
    if (parsed?.type !== "excalidraw" || !Array.isArray(parsed.elements)) return { ok: false, error: "not an Excalidraw scene" };
  } catch {
    return { ok: false, error: "not an Excalidraw scene" };
  }
  if (opts.baseHash && opts.baseHash !== current.hash) return { ok: false, error: "the drawing changed on disk", conflict: current };
  const place = placeOf(slug)!;
  const tmp = `${place.file}.tmp-${process.pid}`;
  writeFileSync(tmp, scene);
  renameSync(tmp, place.file);
  if (opts.preview && opts.preview.length <= PREVIEW_MAX_BYTES && /^\s*<svg[\s>]/.test(opts.preview)) writeFileSync(place.preview, opts.preview);
  reconcileDrawings();
  return { ok: true, hash: hashOf(scene), drawing: toDrawing(rowOf(slug)!) };
}

/**
 * Rename a drawing, or say whose it is. Giving it to a project that keeps a
 * folder moves the file there, and taking it out of every project moves it to
 * the folder that belongs to none, so its id may come back changed. A project
 * without a folder of its own, a repository's standing one, is only noted.
 */
export function updateDrawing(
  slug: string,
  patch: { title?: string; workspaceId?: number | null; projectId?: number | null },
): Drawing | null {
  if (!placeOf(slug) || !rowOf(slug)) return null;
  if (typeof patch.title === "string" && patch.title.trim()) {
    db.query("UPDATE drawings SET title = ? WHERE slug = ?").run(patch.title.trim(), slug);
  }
  let id = slug;
  if (patch.workspaceId != null) {
    const home = folderProject(null, patch.workspaceId);
    id = moveDrawing(id, home);
    db.query("UPDATE drawings SET workspace_id = ?, project_id = ?, placed = 1 WHERE slug = ?").run(patch.workspaceId, home, id);
  } else if (patch.projectId !== undefined || patch.workspaceId === null) {
    const wanted = patch.projectId !== undefined ? patch.projectId : rowOf(id)!.home;
    const home = folderProject(wanted, null);
    id = moveDrawing(id, home);
    db.query("UPDATE drawings SET project_id = ?, workspace_id = NULL, placed = 1 WHERE slug = ?").run(wanted, id);
  }
  return toDrawing(rowOf(id)!);
}

export function deleteDrawing(slug: string): boolean {
  const place = placeOf(slug);
  if (!place || !rowOf(slug)) return false;
  rmSync(place.file, { force: true });
  rmSync(place.preview, { force: true });
  db.query("DELETE FROM drawings WHERE slug = ?").run(slug);
  db.query("DELETE FROM drawing_writes WHERE slug = ?").run(slug);
  return true;
}

export function drawingPreviewPath(slug: string): string | null {
  const path = placeOf(slug)?.preview;
  return path && existsSync(path) ? path : null;
}

/** Called when a workspace is deleted: its drawings stay in the project it was part of. */
export function unplaceDrawingsOf(workspaceId: number) {
  db.query(
    `UPDATE drawings SET project_id = (SELECT project_id FROM workspaces WHERE id = drawings.workspace_id), workspace_id = NULL
      WHERE workspace_id = ?`,
  ).run(workspaceId);
}

/** Called when a project is deleted: its drawings stay on disk, belonging to none. */
export function unplaceDrawingsOfProject(projectId: number) {
  db.query("UPDATE drawings SET project_id = NULL WHERE project_id = ?").run(projectId);
}
