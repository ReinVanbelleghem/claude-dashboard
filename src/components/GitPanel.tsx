import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { buildTree, type TreeNode } from "./fileTree.ts";
import {
  commentApi,
  gitApi,
  settingsApi,
  type SettingsPatch,
  type ChangedFile,
  type DiffRange,
  type DiffScope,
  type RepoStatus,
  type ReviewComment,
  type Settings,
} from "../api.ts";
import { Select } from "./Select.tsx";
import { composeWhenOpen, requestCompose } from "./compose.ts";
import { DiffView, langOf, parsePatch } from "./DiffView.tsx";
import { FileEditor } from "./FileEditor.tsx";
import { FilePicker } from "./FilePicker.tsx";
import type { CommentHandlers } from "./ReviewComments.tsx";
import { EditorIcon, GitIcon, PanelLeftIcon, PencilIcon, RefreshIcon, WorktreeIcon } from "./Icons.tsx";
import { cachedStatus, watchStatus, type GitRepo } from "./useGitRepo.ts";

const TREE_INDENT = 9;
const STATUS_NAME: Record<string, string> = { M: "Modified", A: "New file", D: "Deleted", R: "Renamed", C: "Copied", "?": "Untracked" };
const FILE_LIST_KEY = "git-file-list";

/** Branch state in one line, for headers and cards. */
export function GitBadge({ cwd, compact = false }: { cwd: string; compact?: boolean }) {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [nonce, setNonce] = useState(0);

  // Any write, anywhere on the page, changes what this is counting.
  useEffect(() => watchStatus(() => setNonce((n) => n + 1)), []);

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

  /**
   * In a linked worktree the directory name is the worktree's, not the repository's,
   * so a card sitting in `app-feat-login` would otherwise never mention `app`. The
   * repo name is prepended and the icon changes, which is what keeps five cards on
   * five checkouts of one repo distinguishable from five unrelated projects.
   */
  const repo = status.isLinkedWorktree && status.mainRoot
    ? (status.mainRoot.split("/").filter(Boolean).pop() ?? null)
    : null;

  return (
    <span
      className={`git-badge ${compact ? "compact" : ""}`}
      title={
        status.isLinkedWorktree
          ? `${repo ?? status.name} · ${status.branch ?? "detached"} · worktree at ${status.root}`
          : `${status.name} · ${status.root}`
      }
    >
      {status.isLinkedWorktree ? <WorktreeIcon /> : <GitIcon />}
      {/* Shown even when compact: the session cards are the crowded place, and they
          are also the one place where telling two checkouts apart actually matters. */}
      {repo && <span className="git-badge-repo">{repo}</span>}
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
 * What this branch is doing — the reading half of git.
 *
 * Two scopes answer two different questions: "uncommitted" is what is uncommitted
 * right now — the code a session just wrote and you have not reviewed — and
 * "branch" is everything this branch adds over its base, which is what a PR would
 * contain. Staging lives here because picking files is part of reading them; the
 * branch, the remote and the commit box are in the sidebar, with the other controls.
 *
 * Memoised: the roster emits an event per timeline item, so the page re-renders
 * many times a second during a turn. None of that changes the git view, and
 * re-rendering a large diff that often is wasted work.
 */
export const GitPanel = memo(function GitPanel({
  repo,
  settings,
  onSettings,
  agentKey,
  targets,
  onOpenSession,
  range = null,
  onClearRange,
}: {
  repo: GitRepo;
  /** Show what lies between two refs, one layer of a stack, where "Whole branch" would be. */
  range?: (DiffRange & { label: string }) | null;
  onClearRange?: () => void;
  settings: Settings | null;
  onSettings: (s: Settings) => void;
  /** The session driving this directory, when the dashboard owns one. */
  agentKey?: string | null;
  /** Shown away from any conversation: the sessions a draft can be handed to, one of which is then opened. */
  targets?: { key: string; title: string }[];
  onOpenSession?: (agentKey: string) => void;
}) {
  const { cwd, status, busy, stage, unstage, discard } = repo;
  const [scope, setScope] = useState<DiffScope>("uncommitted");
  const [file, setFile] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [branchList, setBranchList] = useState<ChangedFile[] | null>(null);
  /** Only ever the comments for this repo *and* this branch — see `reload` below. */
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [showOther, setShowOther] = useState(false);
  /** How many open comments this branch's scope is holding back. */
  const [offBranch, setOffBranch] = useState(0);
  const [listStranded, setListStranded] = useState(false);
  /** Those comments themselves, fetched only when you ask to see them. */
  const [otherRows, setOtherRows] = useState<ReviewComment[] | null>(null);
  /**
   * Bumped after the editor writes a file. Nothing else on the page can tell that a
   * file's contents changed — HEAD is where it was and the counts may be identical,
   * since a file that was already modified is still modified — so the diffs are told
   * to re-read explicitly.
   */
  const [edits, setEdits] = useState(0);
  /** Open the picker / edit a file the diff never mentioned. */
  const [picking, setPicking] = useState(false);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const kindsRef = useRef(new Map<string, string>());
  const seenKinds = useMemo(() => {
    for (const parsed of parsePatch(patch ?? "")) {
      if (parsed.note === "new file") kindsRef.current.set(parsed.path, "A");
      else if (parsed.note === "deleted") kindsRef.current.set(parsed.path, "D");
      else if (parsed.from && parsed.from !== parsed.path) kindsRef.current.set(parsed.path, "R");
    }
    return new Map(kindsRef.current);
  }, [patch]);
  const [listOpen, setListOpen] = useState(() => {
    try {
      return localStorage.getItem(FILE_LIST_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const toggleList = () => {
    const next = !listOpen;
    setListOpen(next);
    try {
      localStorage.setItem(FILE_LIST_KEY, next ? "open" : "closed");
    } catch {
      return;
    }
  };
  const [editPath, setEditPath] = useState<string | null>(null);

  const mode = settings?.ui.diffMode ?? "unified";
  const ignoreWs = settings?.ui.diffIgnoreWhitespace ?? false;

  /**
   * HEAD moved — a switch, a pull, a commit — so nearly everything on screen belongs
   * to a commit that is no longer current: the selected file may not exist there, the
   * base comparison is different and the history is a different range. Clearing it is
   * cheaper and less confusing than working out which parts survived.
   */
  useEffect(() => {
    setFile(null);
    setPatch(null);
    setBranchList(null);
    setSent(null);
    setEditPath(null);
  }, [repo.moved, cwd]);

  /**
   * Where a file opens in VS Code. `vscode://` is handled by the OS, so the browser
   * hands it straight to the editor — no CLI on the daemon's PATH, and nothing for
   * the dashboard to shell out for. Paths in the patch are relative to the repo root.
   */
  const root = status?.root ?? null;
  const editorHref = useCallback(
    (path: string) => (root ? `vscode://file${root}/${path}` : null),
    [root],
  );

  // The file list for branch scope is a different query from the worktree status.
  useEffect(() => {
    if (scope !== "branch" || !status?.isRepo) return;
    gitApi.branchFiles(cwd, range).then((r) => setBranchList(r.files)).catch(() => setBranchList([]));
  }, [scope, cwd, status?.isRepo, status?.head, edits, range?.base, range?.head]);

  useEffect(() => {
    if (!range) return;
    scopeChosen.current = true;
    setScope("branch");
    setFile(null);
  }, [range?.base, range?.head]);


  const scopeChosen = useRef(false);
  const startOnBranch = !!status?.isRepo && status.files.length === 0 && status.aheadOfBase > 0;
  useEffect(() => {
    if (!status?.isRepo || scopeChosen.current) return;
    scopeChosen.current = true;
    if (startOnBranch) setScope("branch");
  }, [status?.isRepo, startOnBranch]);

  const worktreeStamp = (status?.files ?? []).map((f) => `${f.path}:${f.status}:${f.insertions}:${f.deletions}`).join("|");

  // Diffs are fetched on demand: the whole-scope patch, or one file's.
  useEffect(() => {
    if (!cwd || status?.isRepo === false) return;
    setLoading(true);
    gitApi
      .diff({ cwd, scope, range, path: file ?? undefined, ignoreWhitespace: ignoreWs })
      .then((r) => setPatch(r.patch))
      .catch(() => setPatch(""))
      .finally(() => setLoading(false));
  }, [cwd, scope, file, ignoreWs, status?.isRepo, status?.head, worktreeStamp, edits, range?.base, range?.head]);


  /**
   * Comments are read for one repo and one branch.
   *
   * The repo root, not the cwd, so they follow the repository rather than the
   * directory a session happened to start in — and the branch, because a comment
   * written against another branch's code describes lines that are not in this
   * tree. Rendering those inline would pin them to whatever now sits on that line
   * number, which is worse than not showing them: it looks like a review of code
   * nobody reviewed.
   *
   * A comment with no branch recorded comes back on every branch. Those predate
   * branch tracking, and hiding them everywhere would lose them.
   */
  const repoRoot = status?.root ?? null;
  /** Identity of the repository rather than this checkout — see commentApi.list. */
  const repoKey = status?.commonDir ?? null;
  const branch = status?.branch ?? null;
  const reload = useCallback(() => {
    if (!repoRoot) return;
    commentApi
      .list(repoRoot, branch, repoKey)
      .then((r) => {
        setComments(r.comments);
        setOffBranch(r.offBranch);
      })
      .catch(() => {});
  }, [repoRoot, repoKey, branch]);

  useEffect(reload, [reload]);

  /**
   * Switching branch changes which comments exist here, so anything held from the
   * last one has to go — including the off-branch list, which was computed against
   * a different "other".
   */
  useEffect(() => {
    setShowOther(false);
    setOtherRows(null);
  }, [branch, repoRoot]);

  /** Fetch the repo-wide list and keep what this branch's scope excluded. */
  const loadOther = useCallback(async () => {
    if (!repoRoot) return;
    const r = await commentApi.list(repoRoot, undefined, repoKey).catch(() => null);
    if (!r) return;
    setOtherRows(r.comments.filter((c) => c.status === "open" && c.branch && c.branch !== branch));
  }, [repoRoot, repoKey, branch]);

  const handlers: CommentHandlers = {
    add: async (input) => {
      if (!repoRoot) return;
      await commentApi.add({ ...input, repo: repoRoot, repoKey, branch }).catch(() => {});
      reload();
    },
    update: async (id, patch) => {
      await commentApi.update(id, patch).catch(() => {});
      reload();
      // The off-branch list is a separate read, so it has to be told as well.
      if (otherRows) void loadOther();
    },
    remove: async (id) => {
      await commentApi.remove(id).catch(() => {});
      reload();
      if (otherRows) void loadOther();
    },
  };

  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const steadyHandlers = useMemo<CommentHandlers>(
    () => ({
      add: (input) => handlersRef.current.add(input),
      update: (id, change) => handlersRef.current.update(id, change),
      remove: (id) => handlersRef.current.remove(id),
    }),
    [],
  );
  const review = useMemo(() => ({ comments, handlers: steadyHandlers, showResolved }), [comments, steadyHandlers, showResolved]);
  const discardFile = useCallback((path: string, from: string | null) => void discard(from ? [path, from] : [path]), [discard]);
  const refresh = repo.refresh;
  const editing = useMemo(
    () => ({
      cwd,
      onSaved: () => {
        setEdits((n) => n + 1);
        refresh();
      },
    }),
    [cwd, refresh],
  );

  const openComments = comments.filter((c) => c.status === "open");
  const resolvedCount = comments.length - openComments.length;

  /**
   * Compose the comments into a prompt and put it in the session's composer. It is
   * deliberately not sent: a generated prompt is a first draft, and the point of
   * seeing it is being able to change it before Claude acts on it. They are marked as
   * seen by the composer when the message actually goes.
   */
  const draftForClaude = async (target?: string) => {
    if (!repoRoot) return;
    setSent(null);
    const { text, ids } = await commentApi.prompt(repoRoot, branch);
    if (!text) {
      setSent("Nothing to send — every open comment belongs to another branch.");
      return;
    }
    if (target) {
      composeWhenOpen(target, { text, commentIds: ids });
      onOpenSession?.(target);
      setSent(`Put ${ids.length} comment${ids.length === 1 ? "" : "s"} in that session's composer — edit it, then send when you're happy.`);
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

  /** Show, or stop showing, the comments this branch's scope holds back. */
  const toggleOther = () => {
    const next = !showOther;
    setShowOther(next);
    if (next && otherRows === null) void loadOther();
  };

  /** Drop every comment that belongs to a branch other than this one. */
  const clearOtherBranches = async () => {
    await Promise.all((otherRows ?? []).map((c) => commentApi.remove(c.id).catch(() => {})));
    setShowOther(false);
    setOtherRows(null);
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
   * Staging only exists for the working tree — a branch-scope list is history, and
   * has nothing to add or remove. A partially staged file is deliberately in both
   * groups: part of it is going into the next commit and part of it isn't, and one
   * row in one group can't say that.
   */
  const staging = scope === "uncommitted";
  const stagedFiles = staging ? files.filter((f) => f.staged) : [];
  const pendingFiles = staging ? files.filter((f) => f.unstaged || f.untracked) : [];

  /**
   * Both paths of a rename move together. Staging only the new one would leave the
   * deletion of the old one behind, which commits the file twice over.
   */
  const allTree = buildTree(files);
  const stagedTree = buildTree(stagedFiles);
  const pendingTree = buildTree(pendingFiles);

  const pathsOf = (f: ChangedFile) => (f.from ? [f.path, f.from] : [f.path]);

  /**
   * A row in the list picks a file and stages it. Opening it in an editor and
   * discarding it are attached to the file's header in the diff instead — those act
   * on the contents, which is what you are looking at over there.
   */
  const kindOf = (f: ChangedFile) => (f.status === "M" ? (seenKinds.get(f.path) ?? "M") : f.status);

  const fileRow = (f: ChangedFile, group: "staged" | "pending" | null, depth = 0) => (
    <div className="git-file-row" key={`${group ?? "all"}:${f.path}`}>
      <button
        className={`git-file ${file === f.path ? "active" : ""}`}
        style={{ paddingLeft: 8 + depth * TREE_INDENT }}
        onClick={() => setFile(f.path)}
        title={f.from ? `${f.from} → ${f.path}` : f.path}
      >
        <span className="git-file-name">
          <b>{f.path.slice(f.path.lastIndexOf("/") + 1)}</b>
        </span>
        <span className="git-file-stat">
          {f.insertions > 0 && <span className="tok-add">+{f.insertions}</span>}
          {f.deletions > 0 && <span className="tok-del">−{f.deletions}</span>}
        </span>
        <span className={`git-status s-${f.untracked ? "new" : kindOf(f).toLowerCase()}`} title={STATUS_NAME[f.untracked ? "?" : kindOf(f)]}>
          {f.untracked ? "U" : kindOf(f)}
        </span>
      </button>
      {group && (
        <button
          className="git-act"
          disabled={!!busy}
          title={group === "staged" ? `Unstage ${f.path}` : `Stage ${f.path}`}
          onClick={() =>
            group === "staged" ? unstage({ paths: pathsOf(f) }) : stage({ paths: pathsOf(f) })
          }
        >
          {group === "staged" ? "−" : "+"}
        </button>
      )}
    </div>
  );

  /**
   * A comment belongs to a repo, but the diff on screen is one scope and possibly
   * one file. Counting all of them made the bar claim comments on a clean working
   * tree, so the two are reported separately: what you can see here, and what
   * exists elsewhere in this repo.
   */
  const fileTree = (node: TreeNode<ChangedFile>, group: "staged" | "pending" | null, depth = 0): ReactNode => (
    <>
      {node.folders.map((folder) => {
        const key = `${group ?? "all"}:${folder.path}`;
        const shut = folded.has(key);
        return (
          <Fragment key={key}>
            <button
              className="git-folder"
              style={{ paddingLeft: 8 + depth * TREE_INDENT }}
              aria-expanded={!shut}
              title={folder.path}
              onClick={() =>
                setFolded((prev) => {
                  const next = new Set(prev);
                  if (shut) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
            >
              <span className={`diff-caret ${shut ? "" : "open"}`} aria-hidden="true" />
              <span className="git-folder-name">{folder.name}</span>
            </button>
            {!shut && fileTree(folder, group, depth + 1)}
          </Fragment>
        );
      })}
      {node.files.map((f) => fileRow(f, group, depth))}
    </>
  );

  const shown = new Set(file ? [file] : files.map((f) => f.path));
  const inView = openComments.filter((c) => shown.has(c.path));
  /**
   * On this branch but not in the diff on screen — reachable by widening the scope or
   * clearing the file filter. Off-branch comments are deliberately not counted here:
   * no scope change brings them into view, so offering "show whole branch" for them
   * sends you looking for something that cannot appear.
   */
  const elsewhere = openComments.length - inView.length;
  /**
   * The ones the diff cannot show. Listed on request rather than only counted: a
   * comment whose file is no longer in the tree has no row to sit under, so without
   * this it can be counted but never read or deleted.
   */
  const stranded = openComments.filter((c) => !shown.has(c.path));

  const showing = scope;
  const show = (next: DiffScope) => {
    setScope(next);
    setFile(null);
  };
  const reread = () => {
    setEdits((n) => n + 1);
    repo.refresh();
  };

  return (
    <div className="panel git-panel">
      {picking && (
        <FilePicker
          cwd={cwd}
          onClose={() => setPicking(false)}
          onPick={(p) => {
            setPicking(false);
            setEditPath(p);
          }}
        />
      )}

      <div className="git-bar">
        <button className="icon-btn square" onClick={toggleList} title={listOpen ? "Hide the file list" : "Show the file list"} aria-label={listOpen ? "Hide the file list" : "Show the file list"} aria-expanded={listOpen}>
          <PanelLeftIcon />
        </button>
        <div className="seg" role="tablist" aria-label="What to show">
          <button role="tab" aria-selected={showing === "uncommitted"} className={showing === "uncommitted" ? "active" : ""} onClick={() => show("uncommitted")}>
            Uncommitted
            {(status.counts.staged + status.counts.unstaged + status.counts.untracked) > 0 && <em>{(status.counts.staged + status.counts.unstaged + status.counts.untracked)}</em>}
          </button>
          <button role="tab" aria-selected={showing === "branch"} className={showing === "branch" ? "active" : ""} onClick={() => show("branch")}>
            {range ? range.label : "Whole branch"}
            {branchList && branchList.length > 0 && <em>{branchList.length}</em>}
          </button>
        </div>
        {range ? (
          <span className="git-bar-meta git-bar-range">
            <span title={`${range.base}...${range.head}`}>
              {range.head} over {range.base}
            </span>
            {onClearRange && (
              <button className="link-btn" onClick={onClearRange}>
                Show the whole branch
              </button>
            )}
          </span>
        ) : (
          <span className="git-bar-meta">
            {status.base && !status.onBase && `${status.aheadOfBase} commit${status.aheadOfBase === 1 ? "" : "s"} over ${status.base}`}
            {status.onBase && status.base && `On the base branch (${status.base})`}
          </span>
        )}
            <div className="seg">
              <button className={mode === "unified" ? "active" : ""} onClick={() => saveUi({ diffMode: "unified" })}>
                Unified
              </button>
              <button className={mode === "split" ? "active" : ""} onClick={() => saveUi({ diffMode: "split" })}>
                Split
              </button>
            </div>
        <span className="git-bar-tools">
          <button className="icon-btn square" onClick={() => setPicking(true)} title="Open any file in this repository for editing" aria-label="Open a file">
            <PencilIcon />
          </button>
          {(cwd || root) && (
            <a className="icon-btn square" href={`vscode://file${cwd || root}`} title={`Open ${cwd || root} in VS Code`} aria-label="Open in VS Code">
              <EditorIcon />
            </a>
          )}
          <button className="icon-btn square" onClick={reread} title="Re-read the repository. It also refreshes by itself every few seconds." aria-label="Refresh">
            <RefreshIcon />
          </button>
        </span>
      </div>

      <>
          {scope === "branch" && status.onBase && (
            <div className="hint" style={{ marginBottom: 10 }}>
              You are on {status.base ?? "the base branch"}, so there is nothing this branch adds.
            </div>
          )}

          <div className={`git-split${listOpen ? "" : " no-side"}`}>
            <div className={`git-side${listOpen ? "" : " shut"}`}>
              <div className="git-files">
                <button className={`git-all ${file === null ? "active" : ""}`} onClick={() => setFile(null)}>
                  <span>All files</span>
                  <em>{files.length}</em>
                </button>

                {!staging && fileTree(allTree, null)}

                {staging && stagedFiles.length > 0 && (
                  <div className="git-group">
                    <span>Staged ({stagedFiles.length})</span>
                    <button className="link-btn inline" disabled={!!busy} onClick={() => unstage({ all: true })}>
                      unstage all
                    </button>
                  </div>
                )}
                {staging && fileTree(stagedTree, "staged")}

                {staging && pendingFiles.length > 0 && (
                  <div className="git-group">
                    <span>Not staged ({pendingFiles.length})</span>
                    <button className="link-btn inline" disabled={!!busy} onClick={() => stage({ all: true })}>
                      stage all
                    </button>
                  </div>
                )}
                {staging && fileTree(pendingTree, "pending")}

                {files.length === 0 && <div className="hint" style={{ padding: "8px 4px" }}>Nothing changed.</div>}
              </div>
            </div>

            <div className="git-diff">
              {/* Shown when there is anything to say about this branch's review —
                  including when this branch has nothing but another one does, since
                  that count is the only thing pointing at comments that are now
                  deliberately out of sight. */}
              {(comments.length > 0 || offBranch > 0) && (
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
                    {/* Terse on purpose: this bar already carries four counts, and the
                        "review those" link next to it is what explains the word. */}
                    {offBranch > 0 && (
                      <span
                        className="review-elsewhere"
                        title={`${offBranch} open comment${offBranch === 1 ? "" : "s"} written on ${offBranch === 1 ? "another branch" : "other branches"} — hidden here because the code they point at is not in this tree`}
                      >
                        {" · "}
                        {offBranch} hidden
                      </span>
                    )}
                    {resolvedCount > 0 && ` · ${resolvedCount} resolved`}
                  </span>
                  {/* A comment on a committed file is unreachable from the working
                      tree, so offer the scope that does show it. */}
                  {elsewhere > 0 && scope === "uncommitted" && (
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
                  {elsewhere > 0 && (
                    <button
                      className="link-btn inline"
                      title="Read and delete the comments this diff cannot show"
                      onClick={() => setListStranded((v) => !v)}
                    >
                      {listStranded ? "hide list" : "list them"}
                    </button>
                  )}
                  {offBranch > 0 && (
                    <button className="link-btn inline" onClick={toggleOther}>
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
                  {resolvedCount > 0 && (
                    <button
                      className="icon-btn"
                      title={`Deletes the ${resolvedCount} resolved comment${resolvedCount === 1 ? "" : "s"} on this branch — other branches are left alone`}
                      onClick={() =>
                        repoRoot &&
                        commentApi.clearResolved(repoRoot, branch).then(reload).catch(() => {})
                      }
                    >
                      Clear resolved
                    </button>
                  )}
                  {comments.length > 0 && (
                    <button
                      className="icon-btn danger"
                      title={`Deletes all ${comments.length} comment${comments.length === 1 ? "" : "s"} on this branch, open ones included — other branches are left alone`}
                      onClick={() => {
                        if (!repoRoot) return;
                        const ok = window.confirm(
                          `Delete all ${comments.length} comment${comments.length === 1 ? "" : "s"} on this branch? This cannot be undone.`,
                        );
                        if (!ok) return;
                        commentApi.clearAll(repoRoot, branch).then(reload).catch(() => {});
                      }}
                    >
                      Clear all
                    </button>
                  )}
                  {targets && targets.length > 1 ? (
                    <Select
                      compact
                      value=""
                      disabled={openComments.length === 0}
                      ariaLabel="Draft for Claude in a session"
                      heading="Draft in which session?"
                      options={targets.map((t) => ({ value: t.key, label: t.title }))}
                      onChange={(key) => void draftForClaude(key)}
                      renderTrigger={() => (
                        <span className={`icon-btn primary${openComments.length === 0 ? " disabled" : ""}`}>Draft for Claude</span>
                      )}
                    />
                  ) : (
                  <button
                    className="icon-btn primary"
                    disabled={openComments.length === 0}
                    onClick={() => void draftForClaude(targets?.[0]?.key)}
                    title={
                      agentKey || targets?.length
                        ? `Drafts all ${openComments.length} open comment${openComments.length === 1 ? "" : "s"} on this branch into the composer — nothing is sent until you send it`
                        : "No session running here — copies the prompt instead"
                    }
                  >
                    {agentKey || targets?.length ? "Draft for Claude" : "Copy as prompt"}
                  </button>
                  )}
                </div>
              )}
              {sent && <div className="review-sent">{sent}</div>}

              {/* Same idea for this branch's own strays: the file is gone from the diff
                  (deleted, committed away, or filtered out), so the comment has no row
                  to render under. Shown here so it can be read and removed. */}
              {listStranded && stranded.length > 0 && (
                <div className="review-orphans">
                  <div className="review-orphans-head">
                    <span>
                      On this branch but not in the diff on screen — widening the scope may
                      bring some back; anything whose file is gone can only be dealt with here.
                    </span>
                  </div>
                  {stranded.map((c) => (
                    <div className="review-orphan" key={c.id}>
                      <span className="review-orphan-where">
                        {c.path || "(no file)"}
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

              {/* Off-branch comments, shown in full because there is nowhere else to
                  see them: their code isn't in this tree, so no diff will ever render
                  them inline. Listing the text is what makes them deletable. */}
              {showOther && (
                <div className="review-orphans">
                  <div className="review-orphans-head">
                    <span>
                      Written on another branch — hidden from this branch's diff, not
                      included in the prompt, and not reachable from any diff here.
                    </span>
                    {otherRows && otherRows.length > 0 && (
                      <button className="icon-btn tiny danger" onClick={clearOtherBranches}>
                        Delete all {otherRows.length}
                      </button>
                    )}
                  </div>
                  {otherRows === null && <div className="hint">Reading them…</div>}
                  {(otherRows ?? []).map((c) => (
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

              {/* A file opened from the picker takes over this pane: it has no patch
                  to sit under, and the diff is still there when you close it. */}
              {editPath ? (
                <div className="diff-file">
                  <FileEditor
                    key={editPath}
                    cwd={cwd}
                    path={editPath}
                    lang={langOf(editPath)}
                    onClose={() => setEditPath(null)}
                    onSaved={() => {
                      setEdits((n) => n + 1);
                      repo.refresh();
                    }}
                  />
                </div>
              ) : loading && patch === null ? (
                <div className="empty">Reading diff…</div>
              ) : (
                <DiffView
                  patch={patch ?? ""}
                  mode={mode}
                  fileHref={editorHref}
                  // Only the working tree has anything to discard; a branch-scope
                  // patch is commits, which this panel does not rewrite.
                  onDiscard={scope === "uncommitted" ? discardFile : undefined}
                  /* Both scopes edit the same thing — the file on disk — so a fix
                     made while reading the branch diff lands as an uncommitted
                     change, and both lists show it on the next read. */
                  edit={editing}
                  review={repoRoot ? review : undefined}
                  emptyLabel={
                    scope === "uncommitted" ? "Working tree is clean." : "This branch adds no changes."
                  }
                />
              )}
            </div>
          </div>
      </>
    </div>
  );
});
