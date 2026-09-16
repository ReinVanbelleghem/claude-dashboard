import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { gitApi, shortPath, type RepoStatus, type Worktree } from "../api.ts";
import { BranchPicker, type BranchChoice } from "./BranchPicker.tsx";
import { CheckIcon, FolderIcon, PlusIcon, RefreshIcon, TrashIcon, WorktreeIcon } from "./Icons.tsx";
import { ProvisionEditor } from "./ProvisionEditor.tsx";
import { invalidateStatusCache, watchStatus } from "./useGitRepo.ts";

/**
 * Every checkout of this repository, and the two things you do to that list.
 *
 * A worktree is what lets a session work on a branch without moving the files under
 * any other session, so this is the panel that makes the one-session-per-branch
 * workflow visible: which branches are open where, which of them has uncommitted work
 * in it, and which one you are standing in.
 *
 * Creating is here rather than in the branch popover because the popover's job is
 * "where do I go", and this is "what exists". Removing is here for the same reason,
 * and it is deliberately narrow: a dirty worktree is refused rather than forced, since
 * uncommitted work exists in no git object and nothing brings it back.
 */
export const WorktreesPanel = memo(function WorktreesPanel({
  cwd,
  status,
  initialTrees = null,
  onOpenWorktree,
  title,
  subtitle,
  worktreeRoot,
  currentPath,
  layout = "rows",
}: {
  cwd: string;
  /**
   * Null while the repository is still being read. The list itself does not need it —
   * only creating a checkout does, since that has to know which commit to branch from —
   * so a null status costs the create button and nothing else.
   */
  status: RepoStatus | null;
  /**
   * Checkouts already known to the caller, painted immediately instead of leaving the
   * panel empty until this component's own read comes back. Refreshed by that read, and
   * by every write after it, so a stale seed corrects itself rather than sticking.
   */
  initialTrees?: Worktree[] | null;
  /** Start work in one of these checkouts. */
  onOpenWorktree?: (path: string) => void;
  /** Heading, when this panel is one repository among several on screen. */
  title?: string;
  subtitle?: string | null;
  /** `ui.worktreeRoot`, so the preview names the directory a new checkout will land in. */
  worktreeRoot?: string;
  /**
   * The checkout to mark as the one you are standing in. Defaults to this panel's own
   * repository root, which is what a session means by "here"; pass null where nothing is
   * current — a list of every repository is read from outside all of them, and marking
   * three main checkouts as current would also hide the offer to open any of them.
   */
  currentPath?: string | null;
  /**
   * "rows" is the compact list that sits under the branch rows in a session, where the
   * panel is one of several things in a narrow column. "tiles" is the same list as
   * pickable cards, for the Worktrees tab, where choosing a checkout to work in is the
   * whole point of the screen — the same tiles the new-session dialog uses for the same
   * decision.
   */
  layout?: "rows" | "tiles";
}) {
  const [trees, setTrees] = useState<Worktree[] | null>(initialTrees);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string; hint: string | null } | null>(null);
  const [adding, setAdding] = useState(false);
  /** The branch the new checkout will hold: existing or freshly cut. */
  const [branch, setBranch] = useState<BranchChoice | null>(null);
  /** Removal is confirmed in place: the path of the row currently asking. */
  const [confirming, setConfirming] = useState<string | null>(null);
  /** Bumped by any write: a commit changes the counts without changing the checkouts. */
  const [dirtyNonce, setDirtyNonce] = useState(0);

  const load = useCallback(() => {
    if (!cwd) return;
    gitApi
      .worktrees(cwd)
      .then((r) => {
        setTrees(r.worktrees);
        setError(r.ok ? null : r.error);
      })
      .catch((e: Error) => setError(e.message));
  }, [cwd]);

  /**
   * The seed is already this read's answer, so spending a request to confirm it is the
   * round trip this panel was handed the list to avoid. Skipped once, for the directory
   * it was seeded with — every later read, including the write-driven ones below, runs.
   */
  const seeded = useRef(initialTrees ? cwd : null);
  useEffect(() => {
    if (seeded.current === cwd) {
      seeded.current = null;
      return;
    }
    load();
  }, [load, cwd]);

  /**
   * A write anywhere can change this list — a branch switch frees a branch, a commit
   * cleans a tree, another tab adds a checkout. The badges already share a "something
   * wrote to a repo" signal, fed by both local writes and the daemon's SSE, so reuse it
   * rather than polling.
   */
  useEffect(
    () =>
      watchStatus(() => {
        load();
        setDirtyNonce((n) => n + 1);
      }),
    [load],
  );

  // The tiles layout puts the create form in a dialog, and a dialog closes on Escape.
  useEffect(() => {
    if (layout !== "tiles" || !adding) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAdding(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layout, adding]);

  const act = async (
    label: string,
    call: () => Promise<{ ok: boolean; error: string | null; hint: string | null; note?: string | null; worktrees: Worktree[] }>,
  ) => {
    setBusy(label);
    setNotice(null);
    try {
      const r = await call();
      setTrees(r.worktrees);
      // Statuses elsewhere are now stale: a new checkout appeared, or one is gone.
      invalidateStatusCache();
      setNotice(
        r.ok
          ? r.note
            ? { ok: true, text: r.note, hint: null }
            : null
          : { ok: false, text: r.error ?? `${label} failed`, hint: r.hint },
      );
      return r.ok;
    } catch (e) {
      setNotice({ ok: false, text: (e as Error).message, hint: null });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    if (!branch) return;
    const ok = await act("Create", () =>
      gitApi.worktreeAdd(cwd, branch.name, { create: branch.create }),
    );
    if (ok) {
      setBranch(null);
      setAdding(false);
    }
  };

  const stale = (trees ?? []).filter((w) => w.prunable !== null).length;
  const reprovisionable = (trees ?? []).filter((w) => !w.isMain && w.prunable === null).length;

  /**
   * The branch half of the create form, shared by both layouts: rows open it inline
   * under the header button, tiles open it in a dialog, because the branch list is long
   * enough that expanding it in place pushes every tile below it off the screen.
   */
  const picker = (
    <>
      <BranchPicker
        cwd={cwd}
        from={status?.detached ? (status.head ?? "HEAD") : (status?.branch ?? "HEAD")}
        value={branch}
        onChange={setBranch}
        disabled={!!busy}
        autoFocus
      />
      {branch && (
        <p className="hint">
          {branch.create
            ? `Creates ${branch.name} off ${branch.from ?? "HEAD"} and a checkout at ${dirOf(status, branch.name, worktreeRoot)}.`
            : `Checks ${branch.name} out at ${dirOf(status, branch.name, worktreeRoot)}.`}
        </p>
      )}
    </>
  );

  const createBtn = (
    <button className="icon-btn primary" disabled={!branch || !!busy} onClick={() => void create()}>
      {busy === "Create" ? "Creating…" : "Create worktree"}
    </button>
  );

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="wt-title">
          <h2>{title ?? "Worktrees"}</h2>
          {subtitle && (
            <small className="wt-sub" title={subtitle}>
              {subtitle}
            </small>
          )}
        </span>
        {/* In tiles the offer to add one is a tile of its own, at the end of the list
            where the thing it adds will appear. */}
        {layout === "rows" && (
          <button
            className="icon-btn tiny"
            onClick={() => {
              setBranch(null);
              setAdding(!adding);
            }}
            disabled={!!busy}
            title="Check this repository out again, on another branch, in its own directory"
          >
            {adding ? "Cancel" : "New"}
          </button>
        )}
      </div>

      {layout === "rows" && trees !== null && trees.length === 1 && !adding && (
        <p className="hint">
          One checkout. Add another to work a second branch without moving the files under
          this one.
        </p>
      )}

      {layout === "rows" && adding && (
        <div className="wt-add">
          {picker}
          <button
            className="icon-btn primary wide"
            disabled={!branch || !!busy}
            onClick={() => void create()}
          >
            {busy === "Create" ? "Creating…" : "Create worktree"}
          </button>
        </div>
      )}

      {error && <div className="git-msg bad"><pre>{error}</pre></div>}

      {trees === null && !error && <p className="hint">Reading worktrees…</p>}

      <div className={layout === "tiles" ? "folder-grid wt-grid" : "wt-list"}>
        {(trees ?? []).map((w) => {
          const props = {
            tree: w,
            nonce: dirtyNonce,
            /* Real paths on both sides — git reports one, the session carries another. */
            current: w.path === (currentPath === undefined ? (status?.root ?? null) : currentPath),
            busy,
            confirming: confirming === w.path,
            onConfirm: () => setConfirming(w.path),
            onCancel: () => setConfirming(null),
            onOpen: onOpenWorktree,
            onRemove: async () => {
              setConfirming(null);
              await act("Remove", () => gitApi.worktreeRemove(cwd, w.path));
            },
            onReprovision: async () => {
              await act("Reprovision", () => gitApi.worktreeReprovision(cwd, { path: w.path }));
            },
          };
          return layout === "tiles" ? <Tile key={w.path} {...props} /> : <Row key={w.path} {...props} />;
        })}

        {layout === "tiles" && trees !== null && (
          <button
            className={`folder-card pick dashed ${adding ? "active" : ""}`}
            onClick={() => {
              setBranch(null);
              setAdding(!adding);
            }}
            disabled={!!busy || !status}
            title={
              status
                ? "Check this repository out again, on another branch, in its own directory"
                : "Available once this repository has been read"
            }
          >
            <span className="folder-ic">
              <PlusIcon />
            </span>
            <span className="folder-name">New worktree…</span>
            <span className="folder-sub">
              {status ? "a second branch, its own files" : "reading repository…"}
            </span>
          </button>
        )}
      </div>

      {layout === "tiles" &&
        adding &&
        // Portalled to <body>: this panel's own top-level element is `.panel`, which
        // now always carries a `backdrop-filter`, and that creates a containing block
        // for `.modal`'s `position: fixed` — the modal would center on this panel
        // instead of the viewport. Same bug and fix as ThemeStudio.
        createPortal(
          <>
            <div className="scrim" onClick={() => setAdding(false)} />
            <div
              className="modal wt-new"
              role="dialog"
              aria-modal="true"
              aria-label={`New worktree in ${title ?? "this repository"}`}
            >
              <h3>New worktree</h3>
              <p className="hint">
                Another checkout of {title ?? "this repository"}, on its own branch, in its own
                directory. Nothing in the checkouts you already have moves.
              </p>
              <div className="wt-add">{picker}</div>
              <div className="modal-actions">
                <button className="icon-btn" onClick={() => setAdding(false)} disabled={!!busy}>
                  Cancel
                </button>
                {createBtn}
              </div>
            </div>
          </>,
          document.body,
        )}

      {/*
        Only in tiles, which is the Worktrees page. In a session the panel is one of
        several things in a narrow column and the question there is "which checkout", not
        "what does a new one get" — and the editor would push the list of checkouts off
        the screen to answer a question nobody asked mid-session.
      */}
      {layout === "tiles" && <ProvisionEditor cwd={cwd} />}

      {reprovisionable > 1 && (
        <button
          className="link-btn inline"
          disabled={!!busy}
          onClick={() => void act("Reprovision all", () => gitApi.worktreeReprovision(cwd, { all: true }))}
          title="Re-run provisioning against every other checkout, so a rule you changed since they were created catches up. Never overwrites what's already there."
        >
          {busy === "Reprovision all" ? "Reprovisioning…" : `reprovision ${reprovisionable} worktrees`}
        </button>
      )}

      {stale > 0 && (
        <button
          className="link-btn inline"
          disabled={!!busy}
          onClick={() => void act("Prune", () => gitApi.worktreePrune(cwd))}
          title="Forget records for checkouts whose directories no longer exist. Touches nothing that is still there."
        >
          {busy === "Prune" ? "Pruning…" : `clear ${stale} stale record${stale === 1 ? "" : "s"}`}
        </button>
      )}

      {notice && (
        <div className={`git-msg ${notice.ok ? "" : "bad"}`}>
          <pre>{notice.text}</pre>
          {notice.hint && <p>{notice.hint}</p>}
          <button className="link-btn inline" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </div>
      )}
    </div>
  );
});

/** Where a new worktree would land, so the form says it before you commit to it. */
function dirOf(status: RepoStatus | null, branch: string, root?: string): string {
  const main = status?.mainRoot;
  if (!main) return root?.trim() ? root.trim() : "a sibling directory";
  const slug =
    branch
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "worktree";
  // The server places a new checkout in `ui.worktreeRoot` when it is set, and beside
  // the repository otherwise, so the preview has to read the same setting or it names
  // a directory nothing will appear in.
  const parent = root?.trim() ? root.trim().replace(/\/+$/, "") : main.split("/").slice(0, -1).join("/");
  const name = main.split("/").filter(Boolean).pop() ?? "repo";
  return `${parent}/${name}-${slug}`;
}

/**
 * One checkout.
 *
 * The uncommitted count is read per row: `git worktree list` does not carry it, and it
 * is the one fact that decides whether this row can be removed at all. Read one path at
 * a time rather than a batch per panel, so each tile fills as its own answer lands
 * instead of every tile waiting on the slowest checkout in the repository.
 */
function useDirtyCount(w: Worktree, nonce: number): number | null {
  const [dirty, setDirty] = useState<number | null>(null);

  useEffect(() => {
    // Nothing to count in a directory that is gone.
    if (w.prunable !== null) return;
    let alive = true;
    gitApi
      .dirty([w.path])
      .then((r) => {
        if (alive && typeof r.dirty[w.path] === "number") setDirty(r.dirty[w.path]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [w.path, w.head, w.prunable, nonce]);

  return dirty;
}

type EntryProps = {
  tree: Worktree;
  /** Bumped to force a re-read after a write. */
  nonce: number;
  current: boolean;
  busy: string | null;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRemove: () => void;
  onReprovision: () => void;
  onOpen?: (path: string) => void;
};

function Row({
  tree: w,
  current,
  busy,
  confirming,
  onConfirm,
  onCancel,
  onRemove,
  onReprovision,
  onOpen,
  nonce,
}: EntryProps) {
  const dirty = useDirtyCount(w, nonce);
  const removable = !w.isMain && w.locked === null;
  const reprovisionable = !w.isMain && w.prunable === null;

  return (
    <div className={`wt-row ${current ? "current" : ""}`}>
      <span className="wt-mark">{current ? <CheckIcon /> : <WorktreeIcon />}</span>
      <div className="wt-main">
        <div className="wt-name">
          {w.detached ? (
            <span className="wt-detached">detached at {w.head?.slice(0, 8)}</span>
          ) : (
            (w.branch ?? "—")
          )}
          {w.isMain && <span className="chip muted">main</span>}
          {w.locked !== null && (
            <span className="chip muted" title={w.locked || "locked"}>
              locked
            </span>
          )}
          {w.prunable !== null && (
            <span className="chip muted" title={w.prunable}>
              missing
            </span>
          )}
        </div>
        {/* Trimmed to its last few segments rather than styled to overflow: a path is
            read left to right, and CSS tricks for keeping the tail visible reorder the
            leading slash. The full path is on the title. */}
        <div className="wt-path" title={w.path}>
          {shortPath(w.path, 3)}
        </div>
        {dirty !== null && dirty > 0 && (
          <div className="wt-dirty">
            {dirty} uncommitted change{dirty === 1 ? "" : "s"}
          </div>
        )}
      </div>

      <div className="wt-actions">
        {!current && onOpen && w.prunable === null && (
          <button
            className="icon-btn tiny"
            disabled={!!busy}
            onClick={() => onOpen(w.path)}
            title={`Start a session in ${w.path}`}
          >
            Open
          </button>
        )}
        {reprovisionable && !confirming && (
          <button
            className="icon-btn tiny"
            disabled={!!busy}
            onClick={onReprovision}
            title="Re-run provisioning here — fills in anything a rule change added since this checkout was created. Never overwrites what's already there."
          >
            {busy === "Reprovision" ? "Reprovisioning…" : "Reprovision"}
          </button>
        )}
        {removable &&
          (confirming ? (
            <>
              <button className="icon-btn tiny danger" disabled={!!busy} onClick={onRemove}>
                {busy === "Remove" ? "Removing…" : "Remove"}
              </button>
              <button className="link-btn inline" onClick={onCancel}>
                cancel
              </button>
            </>
          ) : (
            <button
              className="icon-btn tiny"
              disabled={!!busy}
              onClick={onConfirm}
              title={
                w.prunable !== null
                  ? "Clear the record for this missing checkout"
                  : `Delete this directory. ${w.branch ?? "The branch"} and every commit on it survive; uncommitted changes do not, and a dirty worktree is refused.`
              }
            >
              Remove
            </button>
          ))}
      </div>
    </div>
  );
}

/**
 * One checkout, as a card you click to work in it.
 *
 * The whole card is the open action, so the decision here reads the same as the one in
 * the new-session dialog — pick the checkout, get a session in it. Removing is the
 * small destructive corner button, and it asks first: the card's footer becomes the
 * confirmation rather than a dialog appearing over the list.
 */
function Tile({
  tree: w,
  nonce,
  current,
  busy,
  confirming,
  onConfirm,
  onCancel,
  onRemove,
  onReprovision,
  onOpen,
}: EntryProps) {
  const dirty = useDirtyCount(w, nonce);
  const missing = w.prunable !== null;
  const openable = !!onOpen && !missing && !current;
  const removable = !w.isMain && w.locked === null;
  const reprovisionable = !w.isMain && !missing;

  const body = (
    <>
      <span className="folder-ic">
        {current ? <CheckIcon /> : openable ? <FolderIcon /> : <WorktreeIcon />}
      </span>
      <span className="folder-name wt-tile-name">
        {w.detached ? (
          <span className="wt-detached">detached at {w.head?.slice(0, 8)}</span>
        ) : (
          (w.branch ?? "—")
        )}
        {w.isMain && <span className="chip muted">main</span>}
        {current && <span className="chip muted">here</span>}
        {w.locked !== null && (
          <span className="chip muted" title={w.locked || "locked"}>
            locked
          </span>
        )}
        {missing && (
          <span className="chip muted" title={w.prunable ?? undefined}>
            missing
          </span>
        )}
      </span>
      <span className="folder-sub">{shortPath(w.path, 3)}</span>
      {dirty !== null && dirty > 0 && (
        <span className="wt-dirty">
          {dirty} uncommitted change{dirty === 1 ? "" : "s"}
        </span>
      )}
      {openable && <span className="wt-tile-cta">Start a session here</span>}
    </>
  );

  return (
    <div className={`wt-tile ${current ? "current" : ""} ${missing ? "missing" : ""}`}>
      {openable ? (
        <button
          className="folder-card pick"
          disabled={!!busy}
          onClick={() => onOpen?.(w.path)}
          title={`Start a session in ${w.path}`}
        >
          {body}
        </button>
      ) : (
        <div className="folder-card" title={w.path}>
          {body}
        </div>
      )}

      {reprovisionable && !confirming && (
        <button
          className="icon-btn tiny wt-tile-reprovision"
          disabled={!!busy}
          onClick={onReprovision}
          title="Re-run provisioning here — fills in anything a rule change added since this checkout was created. Never overwrites what's already there."
        >
          <RefreshIcon />
        </button>
      )}
      {removable && !confirming && (
        <button
          className="icon-btn tiny wt-tile-x"
          disabled={!!busy}
          onClick={onConfirm}
          title={
            missing
              ? "Clear the record for this missing checkout"
              : `Delete this directory. ${w.branch ?? "The branch"} and every commit on it survive; uncommitted changes do not, and a dirty worktree is refused.`
          }
        >
          <TrashIcon />
        </button>
      )}
      {removable && confirming && (
        <div className="wt-tile-foot">
          <button className="icon-btn tiny danger" disabled={!!busy} onClick={onRemove}>
            {busy === "Remove" ? "Removing…" : "Remove"}
          </button>
          <button className="link-btn inline" onClick={onCancel}>
            cancel
          </button>
        </div>
      )}
    </div>
  );
}

/** A worktree list is only interesting once there is a repo to list it for. */
export function hasWorktreeSupport(status: RepoStatus | null): boolean {
  return !!status?.isRepo && !!status.commonDir;
}
