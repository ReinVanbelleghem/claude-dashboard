import { memo } from "react";
import { BranchSwitcher } from "./BranchSwitcher.tsx";
import type { GitRepo } from "./useGitRepo.ts";

/**
 * Everything that writes to the repository, in one place.
 *
 * The diff panel below the conversation is for reading — what changed, on this
 * branch and in the working tree. Acting on it is a different job, and it kept
 * pushing the thing you were reading off the screen, so the branch, the remote and
 * the commit box live here in the sidebar instead. Staging stays with the file list,
 * because picking files is part of reading them.
 *
 * Memoised for the same reason the diff panel is: the page it sits on re-renders on
 * every timeline event while a session is running, and none of that touches git.
 */
export const GitControls = memo(function GitControls({
  repo,
  agentKey,
}: {
  repo: GitRepo;
  /** The session working in this directory, when the dashboard owns one. */
  agentKey?: string | null;
}) {
  const { status, busy, notice } = repo;

  if (!status) return null;
  if (!status.isRepo) return null;

  const staged = status.counts.staged;
  const canCommit = !busy && staged > 0 && repo.message.trim().length > 0;

  return (
    <div className="panel git-controls-panel">
      <div className="panel-head">
        <h2>Git</h2>
        <button className="icon-btn tiny" onClick={repo.refresh} title="Re-read the repository">
          Refresh
        </button>
      </div>

      <BranchSwitcher
        cwd={repo.cwd}
        status={status}
        onSwitched={repo.applySwitch}
        sessionHere={!!agentKey}
      />

      <p className="hint git-meta">
        {status.name}
        {status.upstream ? ` · tracking ${status.upstream}` : " · no upstream"}
        {status.ahead > 0 && ` · ${status.ahead} ahead`}
        {status.behind > 0 && ` · ${status.behind} behind`}
      </p>

      <div className="git-remote-row">
        {/* Offered whenever the branch tracks something, not only when `behind` is
            above zero: that count is read from local refs, so it stays at zero until
            someone fetches — which is the first thing a pull does. */}
        {!status.detached && status.branch && status.upstream && (
          <button
            className="icon-btn"
            onClick={repo.pull}
            disabled={!!busy}
            title={`Fast-forward ${status.branch} onto ${status.upstream}. Refuses if the histories have diverged — it never merges or rebases.`}
          >
            {busy === "Pull" ? "Pulling…" : status.behind > 0 ? `Pull ↓${status.behind}` : "Pull"}
          </button>
        )}
        {/* Offered without an upstream too — that is the case where the first push is
            the thing that creates one. */}
        {!status.detached && status.branch && (
          <button
            className="icon-btn"
            onClick={repo.push}
            disabled={!!busy || (!!status.upstream && status.ahead === 0)}
            title={
              status.upstream
                ? `Push ${status.branch} to ${status.upstream}. Never forced — refuses if the remote is ahead.`
                : `${status.branch} has no upstream. Pushing publishes it and sets one.`
            }
          >
            {busy === "Push"
              ? "Pushing…"
              : !status.upstream
                ? "Publish branch"
                : status.ahead > 0
                  ? `Push ↑${status.ahead}`
                  : "Push"}
          </button>
        )}
      </div>

      {/* What a commit would take, said plainly — the file list that proves it is at
          the other end of the page. */}
      <div className="git-commit-box">
        <div className="git-staged-line">
          {status.detached ? (
            <span className="bad-text">HEAD is detached — commit from a branch instead.</span>
          ) : staged > 0 ? (
            <>
              <strong>{staged}</strong> file{staged === 1 ? "" : "s"} staged
              <button
                className="link-btn inline"
                disabled={!!busy}
                onClick={() => repo.unstage({ all: true })}
              >
                unstage all
              </button>
            </>
          ) : (
            <>
              {/* Siblings, not nested: the gap between them comes from this row's
                  flex layout, which does not reach inside a wrapping span. */}
              <span>Nothing staged</span>
              {status.counts.unstaged + status.counts.untracked > 0 && (
                <button
                  className="link-btn inline"
                  disabled={!!busy}
                  onClick={() => repo.stage({ all: true })}
                >
                  stage all {status.counts.unstaged + status.counts.untracked}
                </button>
              )}
            </>
          )}
        </div>

        <textarea
          rows={3}
          placeholder={staged > 0 ? "Describe this commit…" : "Stage something first…"}
          value={repo.message}
          onChange={(e) => repo.setMessage(e.target.value)}
          // The same shortcut the composer uses, so it works where you would expect.
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canCommit) {
              e.preventDefault();
              void repo.commit();
            }
          }}
        />
        <button
          className="icon-btn primary wide"
          disabled={!canCommit}
          onClick={() => void repo.commit()}
          title={
            staged === 0
              ? "Nothing is staged — a commit only ever takes what is staged."
              : `Commit ${staged} staged file${staged === 1 ? "" : "s"} to ${status.branch ?? "HEAD"} (⌘↵)`
          }
        >
          {/* Not "Commit to <branch>": the branch is named in full two rows above,
              and a real branch name wraps that button onto three lines. */}
          {busy === "Commit" ? "Committing…" : "Commit"}
        </button>
      </div>

      {notice && (
        <div className={`git-msg ${notice.ok ? "" : "bad"}`}>
          <pre>{notice.text}</pre>
          {notice.hint && <p>{notice.hint}</p>}
          <button className="link-btn inline" onClick={repo.dismiss}>
            dismiss
          </button>
        </div>
      )}
    </div>
  );
});
