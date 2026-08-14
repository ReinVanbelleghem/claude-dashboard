import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DATA_DIR } from "./paths.ts";

/**
 * Review comments on lines and files.
 *
 * These are the one thing in the dashboard the user authors, so they live in their
 * own file rather than the index database — a re-index wipes derived tables, and
 * losing a review to a schema change would be unforgivable.
 *
 * Identity is (repo, path, line): the repo is the git root, so a comment survives
 * switching branches, stashing, and looking at the same file through a different
 * diff scope. Line numbers do move, so each comment also records the text of the
 * line it was attached to; when that no longer matches, the comment is reported as
 * adrift rather than silently pointing at the wrong code.
 */

export type CommentSide = "old" | "new";

export type ReviewComment = {
  id: string;
  /** Absolute path of the repository root. */
  repo: string;
  /** Repo-relative file path. Empty string for a comment about the review itself. */
  path: string;
  /** 1-based line number, or null for a file-level comment. */
  line: number | null;
  side: CommentSide;
  /** The line's content when the comment was written, for drift detection. */
  anchorText: string | null;
  branch: string | null;
  body: string;
  status: "open" | "resolved";
  createdAt: number;
  updatedAt: number;
  /** When these were last handed to a session, so you can see what Claude has seen. */
  sentAt: number | null;
};

const PATH = join(DATA_DIR, "comments.json");
let all: ReviewComment[] = [];
/** False until a read has actually succeeded, so we never write over unread data. */
let loaded = false;

function load(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(PATH, "utf8"));
    all = Array.isArray(parsed) ? (parsed as ReviewComment[]) : [];
    loaded = true;
  } catch (err) {
    // A missing file is the normal first run; anything else means we must not
    // treat "no comments" as the truth.
    const missing = (err as { code?: string })?.code === "ENOENT";
    all = [];
    loaded = missing;
    if (!missing) console.error("[claude-dashboard] could not read comments.json:", err);
  }
  return loaded;
}

/**
 * Every mutation is a read-modify-write against the file, not a flush of whatever
 * this process happens to hold.
 *
 * Comments are hand-written by the user and irreplaceable, and a stale or failed
 * in-memory copy flushing over the file is exactly how the resumable-session list
 * got wiped once already. Reading first also means a restart mid-review cannot
 * lose anything.
 */
function mutate<T>(fn: (rows: ReviewComment[]) => { rows: ReviewComment[]; result: T }): T | null {
  if (!load()) return null;
  const { rows, result } = fn(all);
  all = rows;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(PATH, JSON.stringify(all, null, 2));
  } catch (err) {
    console.error("[claude-dashboard] could not write comments.json:", err);
    return null;
  }
  return result;
}

load();

export function listComments(repo?: string): ReviewComment[] {
  // Re-read so a second dashboard tab, or an edit made by hand, is picked up.
  load();
  const rows = repo ? all.filter((c) => c.repo === repo) : all;
  // Oldest first within a file, so a thread reads top to bottom.
  return [...rows].sort(
    (a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0) || a.createdAt - b.createdAt,
  );
}

export function addComment(input: {
  repo: string;
  path?: string;
  line?: number | null;
  side?: CommentSide;
  anchorText?: string | null;
  branch?: string | null;
  body: string;
}): ReviewComment | null {
  const body = input.body?.trim();
  if (!input.repo || !body) return null;
  const now = Date.now();
  const comment: ReviewComment = {
    id: randomUUID(),
    repo: input.repo,
    path: input.path ?? "",
    line: input.line ?? null,
    side: input.side ?? "new",
    anchorText: input.anchorText ?? null,
    branch: input.branch ?? null,
    body,
    status: "open",
    createdAt: now,
    updatedAt: now,
    sentAt: null,
  };
  return mutate((rows) => ({ rows: [...rows, comment], result: comment }));
}

export function updateComment(
  id: string,
  patch: { body?: string; status?: "open" | "resolved" },
): ReviewComment | null {
  const body = patch.body?.trim();
  if (patch.body !== undefined && !body) return null;
  return mutate((rows) => {
    const c = rows.find((x) => x.id === id);
    if (!c) return { rows, result: null };
    if (body !== undefined) c.body = body;
    if (patch.status) c.status = patch.status;
    c.updatedAt = Date.now();
    return { rows, result: c };
  });
}

export function deleteComment(id: string): boolean {
  return (
    mutate((rows) => {
      const kept = rows.filter((c) => c.id !== id);
      return { rows: kept, result: kept.length !== rows.length };
    }) ?? false
  );
}

/** Clear the resolved ones for a repo; open comments are never bulk-deleted. */
export function clearResolved(repo: string): number {
  return (
    mutate((rows) => {
      const kept = rows.filter((c) => !(c.repo === repo && c.status === "resolved"));
      return { rows: kept, result: rows.length - kept.length };
    }) ?? 0
  );
}

export function markSent(ids: string[]) {
  const now = Date.now();
  mutate((rows) => {
    for (const c of rows) if (ids.includes(c.id)) c.sentAt = now;
    return { rows, result: true };
  });
}

/**
 * Turn open comments into a prompt.
 *
 * Grouped by file and ordered by line, with the commented line quoted underneath
 * so the session does not have to guess which code is meant — line numbers alone
 * go stale the moment it starts editing. Deliberately ends with an instruction to
 * ask rather than assume: a terse review comment is often ambiguous, and a wrong
 * confident change is worse than a question.
 */
export function buildPrompt(
  repo: string,
  opts: { ids?: string[]; branch?: string | null } = {},
): { text: string; ids: string[] } {
  /**
   * Scoped to the branch when one is given. Comments are keyed by repo so they
   * survive a branch switch, which is right for storage and wrong for a prompt: a
   * comment written against another branch's code describes lines that aren't in the
   * tree any more, so sending it asks the session to act on code it cannot see.
   *
   * Comments with no branch recorded are kept. They predate branch tracking or were
   * written outside a branch, and there is no evidence they belong elsewhere —
   * dropping them would silently discard a review nobody could get back.
   */
  const rows = listComments(repo).filter(
    (c) =>
      c.status === "open" &&
      (!opts.ids || opts.ids.includes(c.id)) &&
      (!opts.branch || !c.branch || c.branch === opts.branch),
  );
  if (rows.length === 0) return { text: "", ids: [] };

  const byFile = new Map<string, ReviewComment[]>();
  for (const c of rows) {
    const key = c.path || "(general)";
    byFile.set(key, [...(byFile.get(key) ?? []), c]);
  }

  const lines: string[] = [
    `Here are my review comments on ${basename(repo)}${opts.branch ? ` (${opts.branch})` : ""} — ` +
      `${rows.length} item${rows.length === 1 ? "" : "s"}.`,
    "",
  ];

  let n = 0;
  for (const [file, comments] of byFile) {
    lines.push(`## ${file}`);
    for (const c of comments) {
      n++;
      lines.push(`${n}. ${c.line ? `line ${c.line}` : "file"}: ${c.body}`);
      if (c.anchorText?.trim()) lines.push("   ```", `   ${c.anchorText.trim()}`, "   ```");
    }
    lines.push("");
  }

  lines.push(
    "Work through them in order. Where a comment is ambiguous or you disagree, say so and ask " +
      "instead of guessing — and tell me which ones you have addressed.",
  );

  return { text: lines.join("\n"), ids: rows.map((c) => c.id) };
}
