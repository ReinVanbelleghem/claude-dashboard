import { memo, useCallback, useEffect, useState } from "react";
import {
  commentApi,
  fmtAgo,
  gitApi,
  settingsApi,
  type SettingsPatch,
  type ChangedFile,
  type Commit,
  type DiffScope,
  type RepoStatus,
  type ReviewComment,
  type Settings,
} from "../api.ts";
import { BranchSwitcher } from "./BranchSwitcher.tsx";
import { requestCompose } from "./compose.ts";
import { DiffView } from "./DiffView.tsx";
import type { CommentHandlers } from "./ReviewComments.tsx";
import { GitIcon } from "./Icons.tsx";

/**
 * Branch state in one line, for headers and cards.
 *
 * Several of these can mount at once (one per session card), so results are shared
 * through a module-level cache; the daemon caches repoStatus too, but there is no
 * reason to ask it the same question five times on one render.
 */
const statusCache = new Map<string, Promise<RepoStatus>>();

function cachedStatus(cwd: string): Promise<RepoStatus> {
  let p = statusCache.get(cwd);
  if (!p) {
    p = gitApi.status(cwd);
    statusCache.set(cwd, p);
    // Short-lived: a branch switch or a new edit should show up without a reload.
    setTimeout(() => statusCache.delete(cwd), 5_000);
  }
  return p;
}

/**
 * Badges are scattered across the page — one per session card — and none of them
 * know that the panel just switched branch. Rather than give each one a poll, the
 * write path drops the cache and bumps a counter they all watch.
 */
const watchers = new Set<() => void>();

function invalidateStatusCache() {
  statusCache.clear();
  for (const w of watchers) w();
}

export function GitBadge({ cwd, compact = false }: { cwd: string; compact?: boolean }) {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const bump = () => setNonce((n) => n + 1);
    watchers.add(bump);
    return () => {
      watchers.delete(bump);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    cachedStatus(cwd)
      .then((s) => alive && setStatus(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [cwd, nonce]);

  if (!status?.isRepo) return null;
  const dirty = status.counts.staged + status.counts.unstaged + status.counts.untracked;

  return (
    <span className={`git-badge ${compact ? "compact" : ""}`} title={`${status.name} · ${status.root}`}>
      <GitIcon />
      <span className="git-badge-branch">
        {status.detached ? `detached ${status.head?.slice(0, 7)}` : status.branch}
      </span>
      {dirty > 0 && <span className="git-badge-dirty">{dirty} changed</span>}
      {status.aheadOfBase > 0 && !compact && (
        <span className="git-badge-ahead">+{status.aheadOfBase} commit{status.aheadOfBase === 1 ? "" : "s"}</span>
      )}
    </span>
  );
}

/**
 * What this branch is doing.
 *
 * Two scopes answer two different questions: "worktree" is what is uncommitted
 * right now — the code a session just wrote and you have not reviewed — and
 * "branch" is everything this branch adds over its base, which is what a PR would
 * contain. The only thing this panel changes is which branch you are on, via the
 * header; staging and committing still stay with Claude.
 */
/**
 * Memoised: the roster emits an event per timeline item, so the page re-renders
 * many times a second during a turn. None of that changes the git view, and
 * re-rendering a large diff that often is wasted work.
 */
export const GitPanel = memo(function GitPanel({
  cwd,
  settings,
  onSettings,
  agentKey,
}: {
  cwd: string;
  settings: Settings | null;
  onSettings: (s: Settings) => void;
  /** The session driving this directory, when the dashboard owns one. */
  agentKey?: string | null;
}) {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [scope, setScope] = useState<DiffScope>("worktree");
  const [file, setFile] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [branchList, setBranchList] = useState<ChangedFile[] | null>(null);
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [openSha, setOpenSha] = useState<string | null>(null);
  const [commitPatch, setCommitPatch] = useState<string | null>(null);
  const [tab, setTab] = useState<"changes" | "history">("changes");
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [showOther, setShowOther] = useState(false);
  const [pulling, setPulling] = useState(false);
  /** Outcome of the last pull — a fast-forward count, or why it was refused. */
  const [pulled, setPulled] = useState<{ ok: boolean; text: string; hint: string | null } | null>(null);

  const mode = settings?.ui.diffMode ?? "unified";
  const ignoreWs = settings?.ui.diffIgnoreWhitespace ?? false;

  const refresh = useCallback(() => {
    gitApi.status(cwd, true).then(setStatus).catch(() => setStatus(null));
  }, [cwd]);

  /**
   * A branch switch invalidates nearly everything on screen: the selected file may
   * not exist on the new branch, the base comparison is different, and the history
   * is a different range. Clearing them is cheaper and less confusing than trying to
   * work out which survived.
   */
  const onSwitched = useCallback((next: RepoStatus) => {
    invalidateStatusCache();
    setStatus(next);
    setFile(null);
    setPatch(null);
    setBranchList(null);
    setCommits(null);
    setOpenSha(null);
    setSent(null);
  }, []);

  useEffect(() => {
    gitApi.status(cwd).then(setStatus).catch(() => setStatus(null));
  }, [cwd]);

  /**
   * Fast-forward this branch onto its upstream. Lives here rather than in the branch
   * dropdown because it acts on the branch you are already on — the dropdown is for
   * changing which branch that is.
   */
  const pull = useCallback(async () => {
    setPulling(true);
    setPulled(null);
    const r = await gitApi.pull(cwd).catch((e: Error) => ({
      ok: false,
      status: null,
      error: e.message,
      hint: null,
      note: null,
    }));
    setPulling(false);
    setPulled({
      ok: r.ok,
      text: (r.ok ? r.note : r.error) ?? (r.ok ? "Pulled." : "Pull failed."),
      hint: r.hint ?? null,
    });
    // New commits mean a different diff, a different history and a moved HEAD.
    if (r.ok && r.status) onSwitched(r.status);
    else if (r.status) setStatus(r.status);
  }, [cwd, onSwitched]);

  // The file list for branch scope is a different query from the worktree status.
  useEffect(() => {
    if (scope !== "branch" || !status?.isRepo) return;
    gitApi.branchFiles(cwd).then((r) => setBranchList(r.files)).catch(() => setBranchList([]));
  }, [scope, cwd, status?.isRepo, status?.head]);

  useEffect(() => {
    if (tab !== "history" || !status?.isRepo) return;
    gitApi.log(cwd, 30).then((r) => setCommits(r.commits)).catch(() => setCommits([]));
  }, [tab, cwd, status?.isRepo, status?.head]);

  // Diffs are fetched on demand: the whole-scope patch, or one file's.
  useEffect(() => {
    if (!status?.isRepo) return;
    setLoading(true);
    gitApi
      .diff({ cwd, scope, path: file ?? undefined, ignoreWhitespace: ignoreWs })
      .then((r) => setPatch(r.patch))
      .catch(() => setPatch(""))
      .finally(() => setLoading(false));
  }, [cwd, scope, file, ignoreWs, status?.isRepo, status?.head, status?.counts.unstaged]);

  useEffect(() => {
    if (!openSha) return;
    setCommitPatch(null);
    gitApi
      .commit(cwd, openSha, ignoreWs)
      .then((r) => setCommitPatch(r.patch))
      .catch(() => setCommitPatch(""));
  }, [openSha, cwd, ignoreWs]);

  // Comments are keyed by repo root, so they follow the repo rather than the cwd
  // a session happens to be started in.
  const repo = status?.root ?? null;
  const reload = useCallback(() => {
    if (!repo) return;
    commentApi.list(repo).then((r) => setComments(r.comments)).catch(() => {});
  }, [repo]);

  useEffect(reload, [reload]);

  const handlers: CommentHandlers = {
    add: async (input) => {
      if (!repo) return;
      await commentApi.add({ ...input, repo, branch: status?.branch ?? null }).catch(() => {});
      reload();
    },
    update: async (id, patch) => {
      await commentApi.update(id, patch).catch(() => {});
      reload();
    },
    remove: async (id) => {
      await commentApi.remove(id).catch(() => {});
      reload();
    },
  };

  const openComments = comments.filter((c) => c.status === "open");

  /**
   * Comments belong to a repo, but a prompt only makes sense for the branch you are
   * on: one written against another branch's code points at lines that aren't in the
   * tree any more. Those are held back from the prompt and listed separately, because
   * a comment you can neither send nor reach in a diff is one you can't get rid of.
   *
   * A comment with no branch recorded counts as this branch — there is nothing to say
   * it belongs elsewhere.
   */
  const onThisBranch = openComments.filter((c) => !c.branch || c.branch === status?.branch);
  const otherBranches = openComments.filter((c) => c.branch && c.branch !== status?.branch);

  /**
   * Compose the comments into a prompt and put it in the session's composer. It is
   * deliberately not sent: a generated prompt is a first draft, and the point of
   * seeing it is being able to change it before Claude acts on it. They are marked as
   * seen by the composer when the message actually goes.
   */
  const draftForClaude = async () => {
    if (!repo) return;
    setSent(null);
    const { text, ids } = await commentApi.prompt(repo, status?.branch ?? null);
    if (!text) {
      setSent("Nothing to send — every open comment belongs to another branch.");
      return;
    }
    if (agentKey && requestCompose(agentKey, { text, commentIds: ids })) {
      setSent(
        `Put ${ids.length} comment${ids.length === 1 ? "" : "s"} in the composer above — edit it, then send when you're happy.`,
      );
      return;
    }
    await navigator.clipboard?.writeText(text).catch(() => {});
    setSent(
      agentKey
        ? "The composer isn't on screen — copied the prompt to your clipboard instead."
        : "No session is running here — copied the prompt to your clipboard instead.",
    );
  };

  /** Drop every comment that belongs to a branch other than this one. */
  const clearOtherBranches = async () => {
    await Promise.all(otherBranches.map((c) => commentApi.remove(c.id).catch(() => {})));
    setShowOther(false);
    reload();
  };

  const saveUi = (ui: SettingsPatch["ui"]) => {
    settingsApi.save({ ui }).then((r) => onSettings(r.settings)).catch(() => {});
  };

  if (!status) return <div className="panel"><div className="empty">Checking for a repository…</div></div>;

  if (!status.isRepo) {
    return (
      <div className="panel">
        <h2>Git</h2>
        <p className="hint">
          {status.error ?? "This directory is not inside a git repository, so there is nothing to diff."}
        </p>
      </div>
    );
  }

  const files: ChangedFile[] = scope === "branch" ? (branchList ?? []) : status.files;

  /**
   * A comment belongs to a repo, but the diff on screen is one scope and possibly
   * one file. Counting all of them made the bar claim comments on a clean working
   * tree, so the two are reported separately: what you can see here, and what
   * exists elsewhere in this repo.
   */
  const shown = new Set(file ? [file] : files.map((f) => f.path));
  const inView = onThisBranch.filter((c) => shown.has(c.path));
  /**
   * On this branch but not in the diff on screen — reachable by widening the scope or
   * clearing the file filter. Off-branch comments are deliberately not counted here:
   * no scope change brings them into view, so offering "show whole branch" for them
   * sends you looking for something that cannot appear.
   */
  const elsewhere = onThisBranch.length - inView.length;

  return (
    <div className="panel git-panel">
      <div className="panel-head">
        <h2>
          <BranchSwitcher
            cwd={cwd}
            status={status}
            onSwitched={onSwitched}
            sessionHere={!!agentKey}
          />
        </h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div className="seg">
            <button className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>
              Changes
            </button>
            <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
              History
            </button>
          </div>
          {/* Offered whenever the branch tracks something, not only when `behind` is
              above zero: that count is read from local refs, so it stays at zero
              until someone fetches — which is the first thing a pull does. */}
          {!status.detached && status.branch && status.upstream && (
            <button
              className="icon-btn primary"
              onClick={pull}
              disabled={pulling}
              title={`Fast-forward ${status.branch} onto ${status.upstream}. Refuses if the histories have diverged — it never merges or rebases.`}
            >
              {pulling ? "Pulling…" : status.behind > 0 ? `Pull ↓${status.behind}` : "Pull"}
            </button>
          )}
          <button className="icon-btn" onClick={refresh} title="Re-read the repository">
            Refresh
          </button>
        </div>
      </div>

      <p className="hint git-meta">
        {status.name}
        {status.upstream ? ` · tracking ${status.upstream}` : " · no upstream"}
        {status.ahead > 0 && ` · ${status.ahead} ahead`}
        {status.behind > 0 && ` · ${status.behind} behind`}
        {status.base && !status.onBase && ` · ${status.aheadOfBase} commit${status.aheadOfBase === 1 ? "" : "s"} over ${status.base}`}
        {status.onBase && status.base && ` · on the base branch (${status.base})`}
      </p>

      {pulled && (
        <div className={`git-msg ${pulled.ok ? "" : "bad"}`}>
          <pre>{pulled.text}</pre>
          {pulled.hint && <p>{pulled.hint}</p>}
          <button className="link-btn inline" onClick={() => setPulled(null)}>
            dismiss
          </button>
        </div>
      )}

      {tab === "changes" ? (
        <>
          <div className="git-controls">
            <div className="seg">
              <button className={scope === "worktree" ? "active" : ""} onClick={() => { setScope("worktree"); setFile(null); }}>
                Uncommitted
                {status.counts.staged + status.counts.unstaged + status.counts.untracked > 0 &&
                  ` (${status.counts.staged + status.counts.unstaged + status.counts.untracked})`}
              </button>
              <button className={scope === "branch" ? "active" : ""} onClick={() => { setScope("branch"); setFile(null); }}>
                Whole branch{branchList ? ` (${branchList.length})` : ""}
              </button>
            </div>
            <span style={{ flex: 1 }} />
            <div className="seg">
              <button className={mode === "unified" ? "active" : ""} onClick={() => saveUi({ diffMode: "unified" })}>
                Unified
              </button>
              <button className={mode === "split" ? "active" : ""} onClick={() => saveUi({ diffMode: "split" })}>
                Split
              </button>
            </div>
            <label className="check" title="Hide whitespace-only changes">
              <input
                type="checkbox"
                checked={ignoreWs}
                onChange={(e) => saveUi({ diffIgnoreWhitespace: e.target.checked })}
              />
              Ignore whitespace
            </label>
          </div>

          {scope === "branch" && status.onBase && (
            <div className="hint" style={{ marginBottom: 10 }}>
              You are on {status.base ?? "the base branch"}, so there is nothing this branch adds.
            </div>
          )}

          <div className="git-split">
            <div className="git-files">
              <button className={`git-file ${file === null ? "active" : ""}`} onClick={() => setFile(null)}>
                <span className="git-file-name">All files</span>
                <span className="git-file-stat">{files.length}</span>
              </button>
              {files.map((f) => (
                <button
                  key={f.path}
                  className={`git-file ${file === f.path ? "active" : ""}`}
                  onClick={() => setFile(f.path)}
                  title={f.from ? `${f.from} → ${f.path}` : f.path}
                >
                  <span className={`git-status s-${f.untracked ? "new" : f.status.toLowerCase()}`}>
                    {f.untracked ? "?" : f.status}
                  </span>
                  <span className="git-file-name">{f.path}</span>
                  <span className="git-file-stat">
                    {f.insertions > 0 && <span className="tok-add">+{f.insertions}</span>}
                    {f.deletions > 0 && <span className="tok-del">−{f.deletions}</span>}
                  </span>
                </button>
              ))}
              {files.length === 0 && <div className="hint" style={{ padding: "8px 4px" }}>Nothing changed.</div>}
            </div>

            <div className="git-diff">
              {comments.length > 0 && (
                <div className="review-bar">
                  <span className="review-count">
                    {inView.length > 0
                      ? `${inView.length} open comment${inView.length === 1 ? "" : "s"} here`
                      : "no comments in this view"}
                    {elsewhere > 0 && (
                      <span className="review-elsewhere">
                        {" · "}
                        {elsewhere} elsewhere on this branch
                      </span>
                    )}
                    {otherBranches.length > 0 && (
                      <span className="review-elsewhere">
                        {" · "}
                        {otherBranches.length} on another branch
                      </span>
                    )}
                    {comments.length > openComments.length &&
                      ` · ${comments.length - openComments.length} resolved`}
                  </span>
                  {/* A comment on a committed file is unreachable from the working
                      tree, so offer the scope that does show it. */}
                  {elsewhere > 0 && scope === "worktree" && (
                    <button
                      className="link-btn inline"
                      onClick={() => {
                        setScope("branch");
                        setFile(null);
                      }}
                    >
                      show whole branch
                    </button>
                  )}
                  {elsewhere > 0 && file && (
                    <button className="link-btn inline" onClick={() => setFile(null)}>
                      show all files
                    </button>
                  )}
                  {otherBranches.length > 0 && (
                    <button className="link-btn inline" onClick={() => setShowOther(!showOther)}>
                      {showOther ? "hide those" : "review those"}
                    </button>
                  )}
                  <span style={{ flex: 1 }} />
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={showResolved}
                      onChange={(e) => setShowResolved(e.target.checked)}
                    />
                    Show resolved
                  </label>
                  {comments.length > openComments.length && (
                    <button
                      className="icon-btn"
                      onClick={() =>
                        repo && commentApi.clearResolved(repo).then(reload).catch(() => {})
                      }
                    >
                      Clear resolved
                    </button>
                  )}
                  <button
                    className="icon-btn primary"
                    disabled={onThisBranch.length === 0}
                    onClick={draftForClaude}
                    title={
                      agentKey
                        ? `Drafts all ${onThisBranch.length} open comment${onThisBranch.length === 1 ? "" : "s"} on this branch into the composer — nothing is sent until you send it`
                        : "No session running here — copies the prompt instead"
                    }
                  >
                    {agentKey ? "Draft for Claude" : "Copy as prompt"}
                  </button>
                </div>
              )}
              {sent && <div className="review-sent">{sent}</div>}

              {/* Off-branch comments, shown in full because there is nowhere else to
                  see them: their code isn't in this tree, so no diff will ever render
                  them inline. Listing the text is what makes them deletable. */}
              {showOther && otherBranches.length > 0 && (
                <div className="review-orphans">
                  <div className="review-orphans-head">
                    <span>
                      Written on another branch — not included in the prompt, and not
                      reachable from any diff here.
                    </span>
                    <button className="icon-btn tiny danger" onClick={clearOtherBranches}>
                      Delete all {otherBranches.length}
                    </button>
                  </div>
                  {otherBranches.map((c) => (
                    <div className="review-orphan" key={c.id}>
                      <span className="review-orphan-where">
                        {c.branch}
                        {c.path ? ` · ${c.path}` : ""}
                        {c.line ? `:${c.line}` : ""}
                      </span>
                      <span className="review-orphan-body">{c.body}</span>
                      <button
                        className="icon-btn tiny"
                        onClick={() => handlers.remove(c.id)}
                        title="Delete this comment"
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {loading && patch === null ? (
                <div className="empty">Reading diff…</div>
              ) : (
                <DiffView
                  patch={patch ?? ""}
                  mode={mode}
                  review={repo ? { comments, handlers, showResolved } : undefined}
                  emptyLabel={
                    scope === "worktree" ? "Working tree is clean." : "This branch adds no changes."
                  }
                />
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="git-history">
          <p className="hint">
            {status.base && !status.onBase
              ? `Commits on ${status.branch} that ${status.base} does not have.`
              : `Recent commits on ${status.branch}.`}
          </p>
          {commits === null ? (
            <div className="empty">Reading log…</div>
          ) : commits.length === 0 ? (
            <div className="empty">No commits to show.</div>
          ) : (
            commits.map((c) => (
              <div className={`commit ${openSha === c.sha ? "open" : ""}`} key={c.sha}>
                <button
                  className="commit-head"
                  onClick={() => setOpenSha(openSha === c.sha ? null : c.sha)}
                >
                  <span className="commit-sha">{c.short}</span>
                  <span className="commit-subject">{c.subject}</span>
                  <span className="commit-meta">
                    {c.author} · {fmtAgo(c.ts)} · {c.files} file{c.files === 1 ? "" : "s"}
                    {c.insertions > 0 && <span className="tok-add"> +{c.insertions}</span>}
                    {c.deletions > 0 && <span className="tok-del"> −{c.deletions}</span>}
                  </span>
                </button>
                {openSha === c.sha && (
                  <div className="commit-body">
                    {commitPatch === null ? (
                      <div className="empty">Reading commit…</div>
                    ) : (
                      <DiffView patch={commitPatch} mode={mode} emptyLabel="Empty commit." />
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
});
