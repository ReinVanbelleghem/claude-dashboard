import { useCallback, useEffect, useState } from "react";
import { gitApi, shortPath, type RepoStatus, type Settings, type WorktreeRepo } from "../api.ts";
import { WorktreesPanel } from "./WorktreesPanel.tsx";
import { cachedStatus, watchStatus } from "./useGitRepo.ts";

/**
 * Every checkout on this machine, grouped by the repository it belongs to.
 *
 * The per-session panel answers "what does this repository have", which is the right
 * question while you are in a session and the wrong one when you are cleaning up: a
 * worktree you are done with is, by definition, one you have no session open in. So
 * this view asks the same question of every repository at once, and reuses the panel
 * per group rather than restating list, create, open and remove in a second place.
 *
 * The repository list comes from the server, which folds session history and the
 * configured worktree directory onto the shared `.git`. Statuses are then read here,
 * one per repository, because that read is already cached and shared with the badges.
 */
export function WorktreesView({
  settings,
  onOpenWorktree,
}: {
  settings: Settings | null;
  /** Start a session in one of these checkouts. */
  onOpenWorktree?: (path: string) => void;
}) {
  const [repos, setRepos] = useState<WorktreeRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    gitApi
      .repos()
      .then((r) => {
        setRepos(r.repos);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  /**
   * A checkout added or removed anywhere — here, in a session, in another tab — changes
   * this list, and the same signal the badges use already fires for all three.
   */
  useEffect(() => watchStatus(load), [load]);

  if (error)
    return (
      <div className="panel">
        <h2>Worktrees</h2>
        <div className="git-msg bad">
          <pre>{error}</pre>
        </div>
      </div>
    );

  if (repos === null)
    return (
      <div className="panel">
        <h2>Worktrees</h2>
        <p className="hint">Reading repositories…</p>
      </div>
    );

  if (!repos.length)
    return (
      <div className="panel">
        <h2>Worktrees</h2>
        <p className="hint">
          No repositories yet. Start a session in one, or name a directory under
          Settings → Git, and its checkouts show up here.
        </p>
      </div>
    );

  return (
    <div className="wt-repos">
      {repos.map((repo) => (
        <RepoGroup
          key={repo.repoKey}
          repo={repo}
          worktreeRoot={settings?.ui.worktreeRoot}
          onOpenWorktree={onOpenWorktree}
        />
      ))}
    </div>
  );
}

/**
 * One repository's checkouts.
 *
 * The panel needs a status to know where a new checkout would land, and it takes it as
 * a prop rather than fetching it — that is what lets the session page hand it the status
 * it already has. Here there is none to hand down, so this wrapper reads it, through the
 * shared cache so a repository open in a session costs nothing extra.
 *
 * That read is slow: it stats every changed file in a repository the size of a backend.
 * The checkouts came with the repository list and do not depend on it, so they are
 * handed straight to the panel and the status arrives underneath them — the list is
 * readable and clickable while only the create button is still waiting.
 */
function RepoGroup({
  repo,
  worktreeRoot,
  onOpenWorktree,
}: {
  repo: WorktreeRepo;
  worktreeRoot?: string;
  onOpenWorktree?: (path: string) => void;
}) {
  const [status, setStatus] = useState<RepoStatus | null>(null);

  useEffect(() => {
    let alive = true;
    // Ask from the main checkout when there is one: `git worktree list` answers the
    // same from any of them, but `isMain` is decided by comparing against mainRoot.
    cachedStatus(repo.mainRoot ?? repo.root)
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repo.mainRoot, repo.root]);

  return (
    <WorktreesPanel
      cwd={status?.root ?? repo.root}
      status={status?.isRepo ? status : null}
      initialTrees={repo.worktrees}
      title={repo.name}
      subtitle={shortPath(repo.mainRoot ?? repo.root, 3)}
      worktreeRoot={worktreeRoot}
      currentPath={null}
      layout="tiles"
      onOpenWorktree={onOpenWorktree}
    />
  );
}
