import type { Database } from "bun:sqlite";
import { repoStatus } from "./git.ts";

/**
 * Which repository each indexed session belongs to.
 *
 * Transcripts are keyed by working directory, so a session run in a worktree files
 * under its own `~/.claude/projects/<slug>` and History shows it as a project of its
 * own. That is the limitation this closes: `sessions.repo_key` holds the shared `.git`,
 * which is the same for every checkout of one repository, so all of them group back
 * together while `worktree_root` still says which checkout it actually ran in.
 *
 * This is a separate pass rather than part of the indexer for one reason: the answer
 * comes from git, which means spawning a process, and the indexer is synchronous from
 * end to end. It is also cheap to run separately, because both columns derive from
 * `cwd` alone — nothing in the transcript is involved, so no re-index is ever needed to
 * populate them, only this.
 *
 * `repo_key` uses three states, which is what keeps the pass from re-asking git about
 * the same directory every four seconds:
 *
 *  - `NULL`    — not looked at yet
 *  - `''`      — looked at, not in a git repository (or the directory is gone)
 *  - a path    — the repository's shared `.git`
 */

/**
 * Directories already resolved this process. The empty-string marker covers restarts;
 * this covers the far more common case of a cwd that resolves to nothing repeatedly
 * within one run.
 */
const seen = new Map<string, { key: string; root: string | null }>();

/** How many directories to resolve per pass, so a first run cannot stall the tick. */
const BATCH = 24;

export async function resolveRepoKeys(db: Database): Promise<number> {
  const rows = db
    .query<{ cwd: string }, [number]>(
      `SELECT DISTINCT cwd FROM sessions
        WHERE cwd IS NOT NULL AND cwd != '' AND repo_key IS NULL
        LIMIT ?`,
    )
    .all(BATCH);
  if (rows.length === 0) return 0;

  const update = db.query<never, [string, string | null, string]>(
    "UPDATE sessions SET repo_key = ?, worktree_root = ? WHERE cwd = ?",
  );

  let done = 0;
  for (const { cwd } of rows) {
    let hit = seen.get(cwd);
    if (!hit) {
      const s = await repoStatus(cwd);
      hit = { key: s.isRepo && s.commonDir ? s.commonDir : "", root: s.root };
      seen.set(cwd, hit);
    }
    update.run(hit.key, hit.root, cwd);
    done++;
  }
  return done;
}

/**
 * Forget what was resolved, so the next pass asks git again.
 *
 * Called when worktrees change: a directory that was not a repository a minute ago can
 * be one now, and the empty-string marker would otherwise make that permanent.
 */
export function invalidateRepoKeys(db: Database): void {
  seen.clear();
  db.exec("UPDATE sessions SET repo_key = NULL WHERE repo_key = ''");
}
