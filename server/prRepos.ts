import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./paths.ts";
import { getSettings } from "./settings.ts";
import { GRAPH_FORMAT, parseGraphLog, type GraphCommit } from "./git.ts";

/**
 * Checkouts for review sessions.
 *
 * A review session needs the PR's head commit on disk, in a directory nobody else is
 * working in. Rather than touching the user's own clone — adding worktrees to it,
 * fetching refs into it — each repository gets one bare, blobless clone under the
 * dashboard's data directory, and each reviewed commit gets a detached worktree
 * next to it. Blobs are fetched on first use, so the clone stays small and a diff of
 * one file costs one round trip rather than a full history.
 *
 * Everything shells out to git, like server/git.ts does for the user's repositories.
 */
function root(): string {
  const configured = getSettings().reviews.checkoutRoot?.trim();
  return configured || join(DATA_DIR, "pr");
}

/** Where review clones, checkouts and scratch folders live: a session in here is a review, not project work. */
export const reviewRoot = root;

const reposDir = () => join(root(), "repos");
const treesDir = () => join(root(), "worktrees");

async function git(cwd: string | null, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: cwd ?? undefined,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(err.trim() || `git ${args[0]} failed (${code})`);
  return out;
}

/** One git write per repository at a time: two worktree adds in the same clone race on its lock. */
const locks = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  return next;
}

/** Whether this shared `.git` is one of the dashboard's own PR clones. */
export function isReviewRepo(commonDir: string): boolean {
  return commonDir.startsWith(`${reposDir()}/`);
}

/** `owner/repo` for one of the dashboard's PR clones, by its path. */
export function reviewRepoLabel(commonDir: string): string | null {
  if (!isReviewRepo(commonDir)) return null;
  const rel = commonDir.slice(reposDir().length + 1).split("/");
  return rel.length === 2 ? `${rel[0]}/${rel[1].replace(/\.git$/, "")}` : null;
}

export function repoDir(owner: string, repo: string): string {
  return join(reposDir(), owner, `${repo}.git`);
}

export function ensureRepo(owner: string, repo: string): Promise<string> {
  return serialized(`${owner}/${repo}`, async () => {
    const dir = repoDir(owner, repo);
    if (!existsSync(dir)) {
      mkdirSync(join(reposDir(), owner), { recursive: true });
      await git(null, "clone", "--bare", "--filter=blob:none", `git@github.com:${owner}/${repo}.git`, dir);
    }
    return dir;
  });
}

/**
 * Which of these commits the clone does not have yet.
 *
 * `--no-lazy-fetch` is what keeps this a question rather than a download: the clone
 * is a partial one, so asking about an absent object makes git fetch it on the spot,
 * without negotiating what it already has. For one new commit in a large repository
 * that is the whole history again, minutes of it, before the real fetch is even tried.
 */
async function missing(dir: string, shas: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const sha of shas) {
    try {
      await git(dir, "--no-lazy-fetch", "cat-file", "-e", `${sha}^{commit}`);
    } catch {
      out.push(sha);
    }
  }
  return out;
}

/** Make sure these commits exist in the bare clone, fetching only what is missing. */
export async function fetchShas(owner: string, repo: string, shas: string[]): Promise<string> {
  const dir = await ensureRepo(owner, repo);
  if ((await missing(dir, shas)).length === 0) return dir;
  await serialized(`${owner}/${repo}`, async () => {
    const need = await missing(dir, shas);
    if (need.length) await git(dir, "fetch", "--filter=blob:none", "origin", ...need);
  });
  return dir;
}

/** A file's content at one commit, or null when it does not exist there. */
export async function readFileAt(owner: string, repo: string, sha: string, path: string): Promise<string | null> {
  const dir = await fetchShas(owner, repo, [sha]);
  try {
    return await git(dir, "show", `${sha}:${path}`);
  } catch {
    return null;
  }
}

/**
 * One file's diff between two commits with a chosen amount of context. GitHub only
 * hands out three lines of context; this is what "show more" expands with.
 */
export async function fileDiff(
  owner: string,
  repo: string,
  base: string,
  head: string,
  path: string,
  previous: string | null,
  context: number,
): Promise<string> {
  const dir = await fetchShas(owner, repo, [base, head]);
  const lines = Math.min(Math.max(0, Math.floor(context)), 100_000);
  const paths = previous && previous !== path ? [previous, path] : [path];
  return git(dir, "diff", "--no-color", "--find-renames", `-U${lines}`, base, head, "--", ...paths);
}

const GRAPH_LIMIT = 300;

/** The PR's commits and what landed on the base since it forked, for the lane graph. */
export async function branchGraph(owner: string, repo: string, head: string, base: string): Promise<GraphCommit[]> {
  const dir = await fetchShas(owner, repo, [head, base]);
  const fork = (await git(dir, "merge-base", head, base).catch(() => "")).trim();
  const out = await git(
    dir,
    "log",
    "--no-color",
    "--no-show-signature",
    "--date-order",
    `--format=${GRAPH_FORMAT}`,
    `--max-count=${GRAPH_LIMIT}`,
    head,
    base,
    ...(fork ? ["--not", `${fork}^@`] : []),
  );
  return parseGraphLog(out);
}

/** What one commit changed, as a unified patch from the local clone. */
export async function commitPatch(owner: string, repo: string, sha: string, context: number): Promise<string> {
  const dir = await fetchShas(owner, repo, [sha]);
  const lines = Math.min(Math.max(0, Math.floor(context)), 100_000);
  return git(dir, "show", "--no-color", "--format=", "--find-renames", `-U${lines}`, sha);
}

export function worktreePath(owner: string, repo: string, sha: string): string {
  return join(treesDir(), owner, repo, sha);
}

/** A detached checkout of one commit, created on first use and reused after. */
export async function ensureWorktree(owner: string, repo: string, sha: string): Promise<string> {
  const dir = await fetchShas(owner, repo, [sha]);
  const path = worktreePath(owner, repo, sha);
  return serialized(`${owner}/${repo}`, async () => {
    if (!existsSync(path)) {
      mkdirSync(join(treesDir(), owner, repo), { recursive: true });
      await git(dir, "worktree", "add", "--detach", path, sha);
    }
    return path;
  });
}

/**
 * Drop checkouts beyond the configured number, oldest first, never one a session is
 * still working in. Each checkout is a full tree of the repository, so letting them
 * pile up costs real disk.
 */
export async function pruneWorktrees(inUse: Set<string>): Promise<number> {
  const keep = Math.max(0, getSettings().reviews.keepCheckouts ?? 6);
  let removed = 0;
  if (!existsSync(treesDir())) return 0;
  for (const owner of readdirSync(treesDir())) {
    const ownerDir = join(treesDir(), owner);
    if (!statSync(ownerDir).isDirectory()) continue;
    for (const repo of readdirSync(ownerDir)) {
      const repoTrees = join(ownerDir, repo);
      if (!statSync(repoTrees).isDirectory()) continue;
      const trees = readdirSync(repoTrees)
        .map((sha) => ({ sha, path: join(repoTrees, sha) }))
        .filter((t) => statSync(t.path).isDirectory() && !inUse.has(t.path))
        .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
      for (const tree of trees.slice(keep)) {
        try {
          await git(repoDir(owner, repo), "worktree", "remove", "--force", tree.path);
        } catch {
          rmSync(tree.path, { recursive: true, force: true });
        }
        removed++;
      }
      try {
        await git(repoDir(owner, repo), "worktree", "prune");
      } catch {
        // Nothing to prune, or no clone; either way not an error here.
      }
    }
  }
  return removed;
}

/** An empty directory for a run that wants no checkout at all. */
export function scratchFor(runId: string): string {
  const dir = join(root(), "scratch", runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeScratch(runId: string) {
  rmSync(join(root(), "scratch", runId), { recursive: true, force: true });
}
