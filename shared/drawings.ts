/**
 * Drawings: Excalidraw scenes kept as `.excalidraw` files, each tied to the
 * project it was drawn for. Types shared by the daemon and the page.
 */
export const DRAWING_EXT = ".excalidraw";

const PREFIX = "draw:";

/** The id a drawing goes by wherever sessions are opened: drawer, tile, page and sidebar. */
export const drawingKey = (slug: string) => `${PREFIX}${slug}`;
export const isDrawingKey = (key: string | null | undefined): key is string => !!key && key.startsWith(PREFIX);
export const drawingSlugOf = (key: string) => key.slice(PREFIX.length);

/** A file name without its extension: no path separators, no leading dot or underscore. */
export const isDrawingSlug = (slug: string): boolean => /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/.test(slug) && !slug.endsWith(".");

/** "Trimble: bucket split!" becomes "trimble-bucket-split". */
export const slugOfTitle = (title: string): string =>
  title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

export type Drawing = {
  slug: string;
  title: string;
  /** The project it belongs to, or null when it belongs to none. */
  projectId: number | null;
  /** The checkout within that project it is about, when it is about one in particular. */
  workspaceId: number | null;
  createdAt: number;
  modifiedAt: number;
  size: number;
  /** A preview image was saved beside it. */
  hasPreview: boolean;
  /** Its project is archived, so it is left out of the lists unless asked for. */
  archived: boolean;
};

export type DrawingsPayload = { drawings: Drawing[]; root: string };

/** A drawing's contents: the scene as Excalidraw's own JSON text, and a hash to save against. */
export type DrawingScene = { drawing: Drawing; scene: string; hash: string };

export const EMPTY_SCENE = JSON.stringify(
  { type: "excalidraw", version: 2, source: "claude-dashboard", elements: [], appState: { gridSize: null, viewBackgroundColor: "#ffffff" }, files: {} },
  null,
  2,
);
