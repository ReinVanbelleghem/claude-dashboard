import { TASK_COLORS, type TaskColor } from "./tasks.ts";

/**
 * The mark a project wears wherever it is named: a glyph, an uploaded image or
 * the project's initials, on one of the task colours.
 */
export const PROJECT_GLYPHS = [
  "server",
  "window",
  "database",
  "phone",
  "cloud",
  "box",
  "book",
  "wrench",
  "rocket",
  "bolt",
  "globe",
  "chip",
  "flask",
  "shield",
  "chart",
  "truck",
  "code",
  "terminal",
  "layers",
  "bot",
] as const;
export type ProjectGlyph = (typeof PROJECT_GLYPHS)[number];

/** The icon value of a project that wears its own initials rather than following its repository. */
export const INITIALS_ICON = "initials";
export const IMAGE_ICON_PREFIX = "img:";
export const PROJECT_ICON_FILE = /^[a-f0-9]{12}-\d+\.png$/;
export const PROJECT_ICON_MAX_BYTES = 400_000;
/** The side, in pixels, an uploaded image is drawn down to before it is sent. */
export const PROJECT_ICON_SIZE = 128;

export const isProjectGlyph = (v: unknown): v is ProjectGlyph => PROJECT_GLYPHS.includes(v as ProjectGlyph);
export const isMarkColor = (v: unknown): v is TaskColor => typeof v === "string" && v in TASK_COLORS;
export const imageOfIcon = (icon: string | null | undefined): string | null =>
  icon?.startsWith(IMAGE_ICON_PREFIX) ? icon.slice(IMAGE_ICON_PREFIX.length) : null;

const SPREAD: TaskColor[] = ["blue", "green", "orange", "purple", "teal", "red", "yellow"];

/** A colour that stays put for a project until one is picked. */
export function defaultMarkColor(key: string): TaskColor {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return SPREAD[h % SPREAD.length]!;
}

export const markColorValue = (key: string, color: string | null | undefined): string =>
  TASK_COLORS[isMarkColor(color) ? color : defaultMarkColor(key)];

/** "claude-dashboard" reads as "CD", "backend" as "B". */
export function monogram(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts.length === 1 ? parts[0]![0]!.toUpperCase() : (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

/** Mark keys are `repo:<shared .git>` or `project:<id>`; sessions and worktrees carry the bare path. */
export const markKey = (key: string): string => (/^(repo|dir|review|project):/.test(key) ? key : `repo:${key}`);
