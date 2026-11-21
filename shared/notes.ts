/**
 * Notes: Markdown files in a folder of your own, the same folder Obsidian or
 * any other editor works on. The dashboard adds only what a file cannot say:
 * which project, and which checkout in it, a note is about.
 * Types shared by the daemon and the page.
 */
const PREFIX = "note:";

/** The id a note goes by wherever sessions are opened: drawer, tile, page and sidebar. */
export const noteKey = (path: string) => `${PREFIX}${path}`;
export const isNoteKey = (key: string | null | undefined): key is string => !!key && key.startsWith(PREFIX);
export const notePathOf = (key: string) => key.slice(PREFIX.length);

const IN_PROJECT = /^p(\d+)@(?:\/([\s\S]*))?$/;

/**
 * Which folder a note path, or a folder path, is in, and where inside it. A
 * note in a project's `notes` folder goes by `p<project>@/<path>`, so the
 * project reads as a folder at the top of the tree; one in the notes folder
 * that belongs to no project goes by its plain path, as it always has.
 */
export function noteRoot(path: string): { projectId: number | null; rel: string } {
  const m = IN_PROJECT.exec(path);
  return m ? { projectId: Number(m[1]), rel: m[2] ?? "" } : { projectId: null, rel: path };
}

export const notePathIn = (projectId: number | null, rel: string): string =>
  projectId === null ? rel : rel ? `p${projectId}@/${rel}` : `p${projectId}@`;

export type Note = {
  /**
   * Its id: where it is inside the notes folder, with forward slashes
   * (`plans/trimble/trimble.md`), or inside a project's own (`p7@/scope.md`).
   */
  path: string;
  /** Its first heading, else its file name. */
  title: string;
  projectId: number | null;
  workspaceId: number | null;
  modifiedAt: number;
  size: number;
  /** Its project is archived, so it is left out of the lists unless asked for. */
  archived: boolean;
  /** The folder its project comes from, when the note has no link of its own. */
  via: string | null;
};

/** A folder tied to a project: every note under it belongs there unless it says otherwise. */
export type NoteFolderLink = { folder: string; projectId: number | null; workspaceId: number | null };

export type NotesPayload = {
  notes: Note[];
  root: string;
  folders: NoteFolderLink[];
  /** Every folder under the root, so one with no note in it yet still shows. */
  dirs: string[];
};

/** A note's text, and a hash to save against. */
export type NoteContent = { note: Note; content: string; hash: string };

export const noteName = (path: string) => (path.split("/").pop() ?? path).replace(/\.md$/i, "");
export const noteFolder = (path: string) => path.split("/").slice(0, -1).join("/");

/** A path inside a notes folder that names a Markdown file: relative, no dot folders, nothing climbing out. */
export const isNotePath = (id: string, path = noteRoot(id).rel): boolean =>
  /\.md$/i.test(path) &&
  !path.startsWith("/") &&
  path.split("/").every((part) => part.length > 0 && part !== ".." && part !== "." && !part.startsWith("."));

/** "Trimble: bucket split!" becomes "trimble-bucket-split". */
export const noteSlug = (title: string): string =>
  title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

const WIKILINK = /\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|[^\]\n]*)?\]\]/g;

/** The notes a text links to with `[[name]]`, each once, in the order they appear. */
export function wikilinksIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(WIKILINK)) out.add(m[1]!.trim());
  return [...out];
}

/**
 * The note a `[[link]]` means, the way Obsidian reads it: a path from the root,
 * else the note whose path ends with what was written, else the one by that
 * name. Notes in the same folder as the one linking, `from`, are tried first,
 * and every other folder after.
 */
export function resolveWikilink(target: string, notes: Pick<Note, "path">[], from?: string): string | null {
  const want = target.replace(/\.md$/i, "").toLowerCase();
  const strip = (p: string) => noteRoot(p).rel.replace(/\.md$/i, "").toLowerCase();
  const among = (list: Pick<Note, "path">[]) =>
    list.find((n) => strip(n.path) === want)?.path ??
    list.find((n) => strip(n.path).endsWith(`/${want}`))?.path ??
    list.find((n) => noteName(n.path).toLowerCase() === (want.split("/").pop() ?? want))?.path ??
    null;
  if (from === undefined) return among(notes);
  const home = noteRoot(from).projectId;
  return among(notes.filter((n) => noteRoot(n.path).projectId === home)) ?? among(notes.filter((n) => noteRoot(n.path).projectId !== home));
}
