import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { DROPPED_DIR } from "./paths.ts";

/** Big enough for a spreadsheet or a log, small enough not to fill a disk by accident. */
export const MAX_DROP_BYTES = 25 * 1024 * 1024;

/**
 * Keep the name, drop everything that could make it a path.
 *
 * The name comes off a clipboard, so it is untrusted input on its way into a
 * filesystem call: separators, traversal and leading dots all have to go. The
 * extension is preserved across the length cap — truncating
 * `very-long-name….xlsx` to a bare stem would leave the model guessing at a file
 * type it could otherwise just read.
 */
export function safeName(raw: string): string {
  const base = (raw.split(/[/\\]/).pop() ?? "").replace(/[\x00-\x1f]/g, "").trim();
  const stripped = base.replace(/^\.+/, "");
  if (!stripped) return "pasted-file";
  const ext = extname(stripped).slice(0, 12);
  const stem = stripped.slice(0, stripped.length - ext.length);
  return `${stem.slice(0, 100) || "pasted-file"}${ext}`;
}

/**
 * Write one dropped file and return the absolute path to hand the session.
 *
 * The uuid goes in a containing directory rather than into the filename, so the file
 * keeps the name it arrived with — "samsara_question_paths (4).xlsx" is what you
 * recognise in the message you are typing, and what the model quotes back.
 */
export function storeDropped(name: string, bytes: Uint8Array): string {
  const dir = join(DROPPED_DIR, randomUUID());
  mkdirSync(dir, { recursive: true });
  const path = join(dir, safeName(name));
  writeFileSync(path, bytes);
  return path;
}

const DROP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Swept at boot for the same reason stored images are: nothing else ever deletes
 * these, and boot is the only moment when no open composer can still be pointing at
 * one.
 */
export function pruneDropped(now = Date.now()) {
  let removed = 0;
  try {
    for (const entry of readdirSync(DROPPED_DIR)) {
      const dir = join(DROPPED_DIR, entry);
      if (now - statSync(dir).mtimeMs < DROP_RETENTION_MS) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    }
  } catch {
    return; // No directory yet, or unreadable — nothing to prune either way.
  }
  if (removed) console.log(`[claude-dashboard] pruned ${removed} dropped file(s)`);
}
