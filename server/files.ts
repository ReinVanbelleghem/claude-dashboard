import { createHash } from "node:crypto";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { grep as gitGrep, invalidateStatus, listFiles, repoStatus, safePath } from "./git.ts";
import { projectFolderHolding } from "./paths.ts";

/**
 * Reading and writing one file inside a session's repository, for the editor in the
 * diff panel.
 *
 * The dashboard listens on localhost, but "a path from the browser" is still the
 * thing that decides which file gets overwritten, so every request is pinned to the
 * repository:
 *
 *  - The path is repo-relative, and is resolved against the repo root and checked to
 *    still be under it. Symlinks are resolved before that check, so a link pointing
 *    out of the tree is refused rather than followed.
 *  - Only an existing regular file can be written. This never creates a file, never
 *    writes through a directory, and never touches anything outside a repo.
 *  - A write carries the hash of the content it was based on. A session editing the
 *    same file is the normal case here, not an exotic race, and without this the
 *    editor would silently overwrite whatever Claude just wrote.
 */

/** Big enough for any source file; past this it is a build artefact or a blob. */
const MAX_BYTES = 1_000_000;

export type FileRead = {
  ok: boolean;
  path: string;
  content: string;
  /** Hash of what was read, to be handed back on save. */
  hash: string;
  error: string | null;
};

export type FileWrite = {
  ok: boolean;
  /** Hash of what is now on disk, so the editor can keep saving without reloading. */
  hash: string | null;
  error: string | null;
  hint: string | null;
};

const hashOf = (content: string) => createHash("sha256").update(content).digest("hex");

/**
 * Resolve a repo-relative path to somewhere it is safe to touch, or explain why not.
 * `realpath` is applied to both ends so a symlinked repo root (/var → /private/var on
 * macOS) compares equal, while a symlink escaping the tree does not.
 */
async function locate(
  cwd: string,
  path: string,
): Promise<{ abs: string; root: string } | { error: string }> {
  const rel = path.trim();
  if (!rel || !safePath(rel)) return { error: "bad path" };
  /**
   * Git's own bookkeeping is never editable content. This matters most in a linked
   * worktree, where `.git` is a *file* holding `gitdir: …` rather than a directory:
   * the isFile() check below would wave it through, and writing to it severs the
   * worktree from its repository.
   */
  if (rel.split("/").includes(".git")) return { error: "not editable: .git" };

  const base = await baseOf(cwd);
  if (!base) return { error: "not a git repository" };

  let root: string;
  try {
    root = realpathSync(base.root);
  } catch {
    return { error: "cannot resolve the repository root" };
  }

  const abs = resolve(root, rel);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return { error: `no such file: ${rel}` };
  }
  if (real !== root && !real.startsWith(root + sep)) return { error: "path escapes the repository" };

  try {
    if (!statSync(real).isFile()) return { error: `not a file: ${rel}` };
  } catch {
    return { error: `no such file: ${rel}` };
  }

  return { abs: real, root };
}

/**
 * The folder a file path is relative to: the repository `cwd` is in, or, outside
 * any repository, the project folder it is in. Nothing else on the disk is
 * browsed or edited from here.
 */
async function baseOf(cwd: string): Promise<{ root: string; git: boolean } | null> {
  const status = await repoStatus(cwd);
  if (status.isRepo && status.root) return { root: status.root, git: true };
  const folder = projectFolderHolding(cwd);
  return folder ? { root: folder, git: false } : null;
}

const WALK_LIMIT = 5_000;
const GREP_FILE_BYTES = 1_000_000;

/**
 * Every file under a plain folder, as paths from it, and the checkouts inside
 * it. A checkout, a project's worktree, is not walked: it is a repository of
 * its own, mostly build output to a raw walk, and git is asked about it instead.
 */
function plainFiles(root: string, checkouts: string[] = []): string[] {
  const out: string[] = [];
  const queue = [""];
  while (queue.length > 0 && out.length < WALK_LIMIT) {
    const rel = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    if (rel && entries.some((e) => e.name === ".git")) {
      checkouts.push(rel);
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(next);
      } else if (e.isFile()) out.push(next);
      if (out.length >= WALK_LIMIT) break;
    }
  }
  return out.sort();
}

export type TextHit = { path: string; line: number; column: number; text: string };

/** Search the text of a plain folder's files: what `git grep` answers inside a repository. */
export async function grepFolder(
  cwd: string,
  query: string,
  opts: { caseSensitive?: boolean; regex?: boolean } = {},
): Promise<{ ok: boolean; hits: TextHit[]; truncated: boolean; error: string | null } | null> {
  const base = await baseOf(cwd);
  if (!base || base.git) return null;
  if (!query) return { ok: true, hits: [], truncated: false, error: null };
  let pattern: RegExp;
  try {
    pattern = new RegExp(opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), opts.caseSensitive ? "" : "i");
  } catch (err) {
    return { ok: false, hits: [], truncated: false, error: err instanceof Error ? err.message : "bad pattern" };
  }
  const hits: TextHit[] = [];
  const checkouts: string[] = [];
  for (const path of plainFiles(base.root, checkouts)) {
    const file = Bun.file(join(base.root, path));
    if (file.size > GREP_FILE_BYTES) continue;
    const text = await file.text().catch(() => "");
    if (!text || text.includes("\0")) continue;
    let inFile = 0;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && inFile < 50; i++) {
      const m = pattern.exec(lines[i]!);
      if (!m) continue;
      if (hits.length >= 1000) return { ok: true, hits, truncated: true, error: null };
      hits.push({ path, line: i + 1, column: m.index + 1, text: lines[i]!.slice(0, 400) });
      inFile++;
    }
  }
  let truncated = false;
  for (const checkout of checkouts) {
    const found = await gitGrep(join(base.root, checkout), query, opts);
    if (!found.ok) continue;
    truncated ||= found.truncated;
    for (const hit of found.hits) {
      if (hits.length >= 1000) return { ok: true, hits, truncated: true, error: null };
      hits.push({ ...hit, path: `${checkout}/${hit.path}` });
    }
  }
  return { ok: true, hits, truncated, error: null };
}

// ── browsing, to open a file that no diff mentions ────────────────────────────
export type BrowseEntry = {
  name: string;
  /** Repo-relative, which is what everything else here speaks. */
  path: string;
  dir: boolean;
};

export type Browse = {
  ok: boolean;
  /** Absolute repo root, for showing where you are. */
  root: string | null;
  /** The directory being listed, repo-relative; "" is the root. */
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
  /** True when a search matched more than it is willing to send. */
  truncated: boolean;
  error: string | null;
};

/** A screenful and then some. Past this, typing another letter beats scrolling. */
const SEARCH_LIMIT = 300;

/**
 * Directories that are never what you meant to edit. `.git` especially: its contents
 * are the repository itself, and a stray save in there is not an edit but a corruption.
 */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "target", "venv", "__pycache__"]);

/**
 * List a directory in the repo, or search the whole repo when given a query.
 *
 * Search goes through git rather than a directory walk, so it sees tracked and
 * untracked files but nothing .gitignore excludes — in a working checkout, a raw walk
 * is mostly build output. Browsing is a real directory read, so a folder git has
 * nothing to say about still opens.
 */
export async function browse(
  cwd: string,
  opts: { path?: string; q?: string } = {},
): Promise<Browse> {
  const empty = { root: null, path: "", parent: null, entries: [], truncated: false };
  const base = await baseOf(cwd);
  if (!base) return { ok: false, ...empty, error: "not a git repository" };

  let root: string;
  try {
    root = realpathSync(base.root);
  } catch {
    return { ok: false, ...empty, error: "cannot resolve the repository root" };
  }

  const q = opts.q?.trim().toLowerCase() ?? "";
  if (q) {
    let all: string[];
    if (base.git) all = await listFiles(cwd);
    else {
      const checkouts: string[] = [];
      all = plainFiles(root, checkouts);
      for (const checkout of checkouts) all.push(...(await listFiles(join(root, checkout))).map((p) => `${checkout}/${p}`));
    }
    const hits = all.filter((p) => p.toLowerCase().includes(q));
    return {
      ok: true,
      root,
      path: "",
      parent: null,
      entries: hits.slice(0, SEARCH_LIMIT).map((p) => ({
        name: p.split("/").pop() ?? p,
        path: p,
        dir: false,
      })),
      truncated: hits.length > SEARCH_LIMIT,
      error: null,
    };
  }

  const rel = (opts.path ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (rel && !safePath(rel)) return { ok: false, ...empty, root, error: "bad path" };

  const abs = rel ? resolve(root, rel) : root;
  let real: string;
  try {
    real = realpathSync(abs);
    if (!statSync(real).isDirectory()) return { ok: false, ...empty, root, error: `not a folder: ${rel}` };
  } catch {
    return { ok: false, ...empty, root, error: `no such folder: ${rel || "."}` };
  }
  if (real !== root && !real.startsWith(root + sep))
    return { ok: false, ...empty, root, error: "path escapes the repository" };

  let entries: BrowseEntry[] = [];
  try {
    entries = readdirSync(real, { withFileTypes: true })
      // `.git` is skipped whatever it is: a directory in the main checkout, a file
      // in a linked worktree. The rest are only ever build directories.
      .filter((e) => e.name !== ".git" && !(e.isDirectory() && SKIP_DIRS.has(e.name)))
      .map((e) => ({
        name: e.name,
        path: rel ? `${rel}/${e.name}` : e.name,
        // A symlinked directory is still somewhere to navigate; where it points is
        // checked when a file inside it is actually opened.
        dir: e.isDirectory() || (e.isSymbolicLink() && isDir(join(real, e.name))),
      }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  } catch {
    // Unreadable: report the location with nothing in it rather than an error page.
  }

  return {
    ok: true,
    root,
    path: rel,
    parent: rel ? rel.split("/").slice(0, -1).join("/") : null,
    entries,
    truncated: false,
    error: null,
  };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export async function readFile(cwd: string, path: string): Promise<FileRead> {
  const found = await locate(cwd, path);
  if ("error" in found) return { ok: false, path, content: "", hash: "", error: found.error };

  const file = Bun.file(found.abs);
  if (file.size > MAX_BYTES)
    return {
      ok: false,
      path,
      content: "",
      hash: "",
      error: `${path} is ${Math.round(file.size / 1024)} KB — too large to edit here`,
    };

  const content = await file.text();
  // A NUL byte is the same test `git diff` uses to call a file binary. Editing one
  // as text would corrupt it on the way back out.
  if (content.includes("\0"))
    return { ok: false, path, content: "", hash: "", error: `${path} is a binary file` };

  return { ok: true, path, content, hash: hashOf(content), error: null };
}

export async function writeFile(
  cwd: string,
  path: string,
  content: string,
  baseHash: string,
): Promise<FileWrite> {
  const found = await locate(cwd, path);
  if ("error" in found) return { ok: false, hash: null, error: found.error, hint: null };

  if (content.length > MAX_BYTES)
    return { ok: false, hash: null, error: "that is too much text to save", hint: null };

  const current = await Bun.file(found.abs).text();
  if (baseHash && hashOf(current) !== baseHash)
    return {
      ok: false,
      hash: hashOf(current),
      error: `${path} changed on disk since you opened it`,
      hint: "Something else wrote to it — a session, or your editor. Reload the file and reapply your change.",
    };

  await Bun.write(found.abs, content);
  // The working tree just changed, so the cached status is describing the old one.
  invalidateStatus();
  return { ok: true, hash: hashOf(content), error: null, hint: null };
}
