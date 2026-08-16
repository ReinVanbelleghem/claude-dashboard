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

/**
 * Does this comment belong to the branch being looked at?
 *
 * A comment with no branch recorded counts as being on whichever branch you are
 * on. Those predate branch tracking or were written off a branch entirely, and
 * there is nothing to say they belong elsewhere — hiding them would make a review
 * nobody can get back invisible from every branch at once.
 */
function onBranch(c: ReviewComment, branch: string | null): boolean {
  return !c.branch || c.branch === branch;
}

/**
 * The comments for a repo, optionally narrowed to one branch.
 *
 * Storage is keyed by repo so a comment survives a branch switch, which is right
 * for keeping them and wrong for showing them: a comment written against another
 * branch's code points at lines that are not in this tree, so rendering it in this
 * branch's diff attaches it to whatever now happens to sit on that line number.
 * Reading is therefore scoped to (repo, branch) and the store is not.
 *
 * `branch` distinguishes three cases deliberately: omitted means the whole repo,
 * a name means that branch, and `null` means a detached HEAD — where the only
 * comments that can apply are the ones written with no branch of their own.
 */
export function listComments(repo?: string, branch?: string | null): ReviewComment[] {
  // Re-read so a second dashboard tab, or an edit made by hand, is picked up.
  load();
  let rows = repo ? all.filter((c) => c.repo === repo) : all;
  if (branch !== undefined) rows = rows.filter((c) => onBranch(c, branch));
  // Oldest first within a file, so a thread reads top to bottom.
  return [...rows].sort(
    (a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0) || a.createdAt - b.createdAt,
  );
}

/**
 * How many open comments in this repo belong to a branch other than this one.
 *
 * A count rather than the comments themselves: they are deliberately not rendered
 * here, but a review you cannot see and cannot count is one you forget you wrote.
 * This is what lets the UI offer a way back to them without putting them on screen.
 */
export function countOffBranch(repo: string, branch: string | null): number {
  load();
  return all.filter((c) => c.repo === repo && c.status === "open" && !onBranch(c, branch)).length;
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

/**
 * Clear the resolved ones; open comments are never bulk-deleted.
 *
 * Scoped to a branch when one is given, because the button that calls this sits
 * next to a count of what is on screen. Clearing more than you were shown is a
 * delete you did not agree to.
 */
export function clearResolved(repo: string, branch?: string | null): number {
  return (
    mutate((rows) => {
      const kept = rows.filter(
        (c) =>
          !(
            c.repo === repo &&
            c.status === "resolved" &&
            (branch === undefined || onBranch(c, branch))
          ),
      );
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
   * Scoped exactly like the list the user was looking at when they pressed the
   * button. Sending a comment that is not on screen is the one thing this must not
   * do: it asks the session to act on code that is not in the tree, and does it
   * without the reviewer ever having seen the request.
   */
  const rows = listComments(repo, opts.branch).filter(
    (c) => c.status === "open" && (!opts.ids || opts.ids.includes(c.id)),
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
