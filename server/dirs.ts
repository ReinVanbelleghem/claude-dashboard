import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DATA_DIR } from "./paths.ts";

/**
 * Directory picking for the new-session dialog.
 *
 * A browser cannot hand us a real filesystem path — the folder picker yields an
 * opaque handle, and only in some browsers — so the daemon does the walking and
 * the UI just navigates what it returns. Saved favourites cover the common case
 * of jumping straight to "Backend" or "Frontend".
 */

const SKIP = new Set(["node_modules", "dist", "build", "target", "venv", "__pycache__"]);

export type DirEntry = { name: string; path: string; isRepo: boolean };

export function listDirs(input?: string): {
  path: string;
  parent: string | null;
  isRepo: boolean;
  entries: DirEntry[];
} {
  const base = resolve(expand(input?.trim() || homedir()));
  const parent = dirname(base);
  let entries: DirEntry[] = [];
  try {
    entries = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name))
      .map((e) => {
        const path = join(base, e.name);
        return { name: e.name, path, isRepo: existsSync(join(path, ".git")) };
      })
      // Repositories first: in a folder of 40 checkouts they are what you want.
      .sort((a, b) => Number(b.isRepo) - Number(a.isRepo) || a.name.localeCompare(b.name));
  } catch {
    // An unreadable directory still returns its own path so the UI can show it.
  }
  return {
    path: base,
    parent: parent === base ? null : parent,
    isRepo: existsSync(join(base, ".git")),
    entries,
  };
}

/** `~` and `$HOME` are what people type; resolve() alone would not expand them. */
function expand(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p.replace(/^\$HOME(?=\/|$)/, homedir());
}

// ── favourites ────────────────────────────────────────────────────────────────
export type Favourite = { label: string; path: string };

const FAV_PATH = join(DATA_DIR, "favourites.json");

export function listFavourites(): Favourite[] {
  try {
    const rows = JSON.parse(readFileSync(FAV_PATH, "utf8")) as Favourite[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function writeFavourites(rows: Favourite[]) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FAV_PATH, JSON.stringify(rows, null, 2));
}

/** Add or relabel a favourite. Path is the identity, so re-adding renames. */
export function saveFavourite(label: string, path: string): Favourite[] {
  const full = resolve(expand(path));
  const rows = listFavourites().filter((f) => f.path !== full);
  rows.push({ label: label.trim() || full.split("/").pop() || full, path: full });
  rows.sort((a, b) => a.label.localeCompare(b.label));
  writeFavourites(rows);
  return rows;
}

export function removeFavourite(path: string): Favourite[] {
  const rows = listFavourites().filter((f) => f.path !== resolve(expand(path)));
  writeFavourites(rows);
  return rows;
}
