import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DRAWING_EXT, isDrawingSlug } from "../shared/drawings.ts";
import { isNotePath, notePathIn } from "../shared/notes.ts";
import { projectFileId } from "../shared/projectFiles.ts";

/** Claude Code's own state. We only ever READ from here. */
export const CLAUDE_HOME = process.env.CLAUDE_HOME ?? join(homedir(), ".claude");
export const SESSIONS_DIR = join(CLAUDE_HOME, "sessions");
export const PROJECTS_DIR = join(CLAUDE_HOME, "projects");

/** Our own state, deliberately outside ~/.claude so we never corrupt Claude Code. */
export const DATA_DIR = process.env.DASHBOARD_HOME ?? join(homedir(), ".claude-dashboard");
export const DB_PATH = join(DATA_DIR, "index.db");

export const PORT = Number(process.env.PORT ?? 5757);

/**
 * The environment for any spawn of the `claude` binary.
 *
 * Sessions are meant to behave like a Claude started in the same terminal, so this
 * is `process.env` as-is apart from `XPC_FLAGS`. With the 0x2 bit set — which some
 * terminals (Supacode) export, while Terminal.app uses 0x0 — the binary fails to
 * read the login out of the macOS Keychain and every turn answers "Not logged in"
 * in ~50ms without an API call. The daemon inherits whatever the launching shell
 * happened to have, so it is pinned here rather than left to how it was started.
 */
export function claudeEnv(extra?: Record<string, string>): Record<string, string | undefined> {
  return { ...process.env, ...extra, XPC_FLAGS: "0x0" };
}

/** ~/.claude/projects dirs are the cwd with / replaced by -; recover a display path. */
export function slugToPath(slug: string): string {
  return slug.replace(/^-/, "/").replace(/-/g, "/");
}

/**
 * Home for sessions started without a project. Empty and outside every checkout,
 * so nothing on disk invites the model into a codebase it was not asked about.
 */
export const SCRATCH_DIR = join(DATA_DIR, "scratch");

/**
 * Files pasted or dropped into a composer.
 *
 * A browser never reveals a file's real path — `File` carries a name and bytes and
 * nothing else — so a path can only be produced by storing the bytes ourselves. That
 * is also the only version that works when the dashboard is open on a different
 * machine from the daemon: the session reads the copy that lives next to it, not one
 * that only ever existed on the laptop that did the pasting.
 */
export const DROPPED_DIR = join(DATA_DIR, "dropped");

/**
 * Where generated HTML artifacts live.
 *
 * Deliberately outside both ~/.claude and the dashboard's own state: an artifact is
 * something you keep and open months later, not cache the dashboard owns. Deleting
 * ~/.claude-dashboard must never take your work with it.
 *
 * Mutable, because Settings can repoint it without a restart. The environment
 * variable, when set, is the starting value rather than a lock — a setting the UI
 * offers but silently ignores is worse than no setting at all.
 */
export const DEFAULT_ARTIFACTS_DIR = process.env.CLAUDE_ARTIFACTS_DIR ?? join(homedir(), "artifacts");

/**
 * Where artifacts were kept before they had a folder of their own. Nothing is
 * read from it any more, but a transcript from then still names it, and a write
 * there is still a write to the artifact of that name.
 */
const FORMER_ARTIFACTS_DIR = join(homedir(), "Notes", "artifacts");

let artifactsDirValue = DEFAULT_ARTIFACTS_DIR;

export function artifactsDir(): string {
  return artifactsDirValue;
}

/** Returns true when the root actually moved, so the caller knows to re-scan. */
export function setArtifactsDir(dir: string): boolean {
  const next = dir.trim() ? resolve(dir.trim().replace(/^~(?=$|\/)/, homedir())) : DEFAULT_ARTIFACTS_DIR;
  if (next === artifactsDirValue) return false;
  artifactsDirValue = next;
  artifactPathRe = buildArtifactPathRe();
  return true;
}

/**
 * Where drawings live: one `.excalidraw` file each, in a folder of your own
 * rather than the dashboard's, so they outlive it and an agent can read and
 * write them like any other file.
 */
export const DEFAULT_DRAWINGS_DIR = process.env.DASHBOARD_DRAWINGS_DIR ?? join(homedir(), "drawings");

let drawingsDirValue = DEFAULT_DRAWINGS_DIR;

export function drawingsDir(): string {
  return drawingsDirValue;
}

/** Returns true when the root actually moved, so the caller knows to re-scan. */
export function setDrawingsDir(dir: string): boolean {
  const next = dir.trim() ? resolve(dir.trim().replace(/^~(?=$|\/)/, homedir())) : DEFAULT_DRAWINGS_DIR;
  if (next === drawingsDirValue) return false;
  drawingsDirValue = next;
  return true;
}

/** The drawing a path is, or null when it is not an `.excalidraw` file directly in a drawings folder. */
export function drawingSlug(filePath: string): string | null {
  if (!filePath) return null;
  const expanded = filePath.startsWith("~/") ? join(homedir(), filePath.slice(2)) : filePath;
  const abs = resolve(expanded);
  for (const r of drawingRoots()) {
    const root = resolve(r.dir);
    if (!abs.startsWith(root + sep)) continue;
    const name = abs.slice(root.length + 1);
    if (name.includes(sep) || !name.toLowerCase().endsWith(DRAWING_EXT)) return null;
    const slug = name.slice(0, -DRAWING_EXT.length);
    return isDrawingSlug(slug) ? projectFileId(r.projectId, slug) : null;
  }
  return null;
}

/**
 * Where projects live: one folder each, holding the project's worktrees and its
 * notes, drawings and artifacts. A project made before this existed gets its
 * folder the first time something needs one.
 */
export const DEFAULT_PROJECTS_DIR = process.env.DASHBOARD_PROJECTS_DIR ?? join(homedir(), "projects");

let projectsDirValue = DEFAULT_PROJECTS_DIR;

export function projectsDir(): string {
  return projectsDirValue;
}

/** Only new projects follow a move: a project that has a folder keeps it. */
export function setProjectsDir(dir: string): boolean {
  const next = dir.trim() ? resolve(dir.trim().replace(/^~(?=$|\/)/, homedir())) : DEFAULT_PROJECTS_DIR;
  if (next === projectsDirValue) return false;
  projectsDirValue = next;
  return true;
}

/**
 * The projects that have a folder, kept here by workspaces.ts so that a path
 * can be told to be a project's drawing or artifact without the database.
 */
let projectFolders: { id: number; folder: string }[] = [];

export function setProjectFolders(list: { id: number; folder: string }[]) {
  projectFolders = list;
  artifactPathRe = buildArtifactPathRe();
}

/** The project folder a path is in, when it is in one: the only folders outside a repository whose files are browsed and edited. */
export function projectFolderHolding(path: string): string | null {
  const abs = resolve(path);
  return (
    projectFolders
      .map((p) => p.folder)
      .filter((folder) => abs === folder || abs.startsWith(folder + sep))
      .sort((a, b) => b.length - a.length)[0] ?? null
  );
}

export const projectFolderOf = (projectId: number): string | null => projectFolders.find((p) => p.id === projectId)?.folder ?? null;

/** One place files of a kind are kept: the old single folder (no project), or a project's subfolder. */
export type FileRoot = { projectId: number | null; dir: string };

const rootsOf = (old: string, sub: string): FileRoot[] => [
  { projectId: null, dir: old },
  ...projectFolders.map((p) => ({ projectId: p.id, dir: join(p.folder, sub) })),
];

export const artifactRoots = (): FileRoot[] => rootsOf(artifactsDirValue, "artifacts");
/** Every folder a path may name an artifact in: the ones read from, and the former one old transcripts still mention. */
const artifactPathRoots = (): FileRoot[] =>
  artifactsDirValue === FORMER_ARTIFACTS_DIR ? artifactRoots() : [...artifactRoots(), { projectId: null, dir: FORMER_ARTIFACTS_DIR }];
export const drawingRoots = (): FileRoot[] => rootsOf(drawingsDirValue, "drawings");
export const noteRoots = (): FileRoot[] => rootsOf(notesDirValue, "notes");
export const noteRootDir = (projectId: number | null): string | null => noteRoots().find((r) => r.projectId === projectId)?.dir ?? null;
export const artifactRootOf = (projectId: number | null): string | null =>
  artifactRoots().find((r) => r.projectId === projectId)?.dir ?? null;
export const drawingRootOf = (projectId: number | null): string | null =>
  drawingRoots().find((r) => r.projectId === projectId)?.dir ?? null;

/** Where notes live: the Markdown folder Obsidian, or any other editor, works on too. */
export const DEFAULT_NOTES_DIR = process.env.DASHBOARD_NOTES_DIR ?? join(homedir(), "Notes");

let notesDirValue = DEFAULT_NOTES_DIR;

export function notesDir(): string {
  return notesDirValue;
}

/** Returns true when the root actually moved, so the caller knows to re-scan. */
export function setNotesDir(dir: string): boolean {
  const next = dir.trim() ? resolve(dir.trim().replace(/^~(?=$|\/)/, homedir())) : DEFAULT_NOTES_DIR;
  if (next === notesDirValue) return false;
  notesDirValue = next;
  return true;
}

/** The note a path is, by its id, or null when it is not a Markdown file a note could be. */
export function notePath(filePath: string): string | null {
  if (!filePath) return null;
  const expanded = filePath.startsWith("~/") ? join(homedir(), filePath.slice(2)) : filePath;
  const abs = resolve(expanded);
  const roots = noteRoots();
  for (const r of [...roots.slice(1), roots[0]!]) {
    const root = resolve(r.dir);
    if (!abs.startsWith(root + sep)) continue;
    const rel = abs.slice(root.length + 1).split(sep).join("/");
    return isNotePath("", rel) && !rel.startsWith("artifacts/") ? notePathIn(r.projectId, rel) : null;
  }
  return null;
}

/**
 * Artifacts get their own port, and therefore their own origin.
 *
 * Artifact HTML is model-written and runs with whatever scripts it pleases. Served
 * from the API port it would be same-origin with a daemon that can start Claude
 * sessions with real file access; served from here it is cross-origin, so the
 * browser refuses both the read and (with the Origin check in index.ts) the write.
 */
export const ARTIFACT_PORT = Number(process.env.ARTIFACT_PORT ?? 5759);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Absolute-looking references to the artifact root inside a shell command. Not a
 * parser — it only has to be good enough to attribute a heredoc write to a session,
 * and the reconciler finds the folder either way.
 */
function buildArtifactPathRe(): RegExp {
  const alts: string[] = [];
  for (const { dir } of artifactPathRoots()) {
    alts.push(escapeRe(dir));
    if (dir.startsWith(homedir() + sep)) {
      const tail = dir.slice(homedir().length);
      alts.push(`~${escapeRe(tail)}`, `\\$HOME${escapeRe(tail)}`);
    }
  }
  return new RegExp(`(?:${alts.join("|")})[^\\s'"\`;|&)>]*`, "g");
}

let artifactPathRe = buildArtifactPathRe();

/**
 * The artifact a path belongs to, or null if it is not under the artifact root.
 *
 * One folder is one artifact, so every asset inside it maps to the same slug. A
 * bare `.html` file sitting at the root counts too — an artifact does not have to
 * have been given a folder to be real.
 */
/**
 * Folders the artifact root holds but which are not themselves artifacts.
 *
 * A leading underscore marks scaffolding — `_template/` is the house style every
 * report is copied FROM, so a session that cites it is a reader, not its author.
 * Dotfiles are never artifacts either, and a path still carrying a glob came out
 * of an `ls`, not a write.
 */
export function isArtifactName(name: string): boolean {
  if (!name || name.startsWith("_") || name.startsWith(".")) return false;
  return !/[*?\[\]{}]/.test(name);
}

export function artifactSlug(filePath: string): string | null {
  if (!filePath) return null;
  const expanded = filePath.startsWith("~/") ? join(homedir(), filePath.slice(2)) : filePath;
  const abs = resolve(expanded);
  for (const r of artifactPathRoots()) {
    const root = resolve(r.dir);
    if (!abs.startsWith(root + sep)) continue;
    const parts = abs.slice(root.length + 1).split(sep).filter(Boolean);
    if (parts.length === 0) return null;
    const first = parts[0]!;
    if (!isArtifactName(first)) return null;
    // A loose file at the root is only an artifact if it is the page itself.
    if (parts.length === 1) return first.toLowerCase().endsWith(".html") ? projectFileId(r.projectId, first.slice(0, -5)) : null;
    return projectFileId(r.projectId, first);
  }
  return null;
}

/** Every artifact slug a shell command appears to touch. */
export function artifactSlugsInCommand(command: string): string[] {
  const out = new Set<string>();
  for (const m of command.matchAll(artifactPathRe)) {
    const slug = artifactSlug(m[0].replace(/^\$HOME/, homedir()));
    if (slug) out.add(slug);
  }
  return [...out];
}
