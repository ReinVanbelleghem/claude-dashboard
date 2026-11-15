import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { gitApi, workspaceApi, type Workspace } from "../../api.ts";
import { workspaceTitle } from "../../../shared/workspaces.ts";

type Checkout = { linked: boolean; dirty: number };

/**
 * Delete a workspace for good. Says what goes with it before anything does: the
 * sessions it holds end, and its worktree can go too when it has one of its own.
 * The branch and the transcripts are never touched.
 */
export function DeleteWorkspaceDialog({
  workspace: w,
  sessions,
  shared,
  onClose,
}: {
  workspace: Workspace;
  /** How many sessions it holds right now. */
  sessions: number;
  /** Other workspaces living in the same folder: their worktree is not this one's to remove. */
  shared: number;
  onClose: () => void;
}) {
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [removeWorktree, setRemoveWorktree] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const st = await gitApi.status(w.folder, true).catch(() => null);
      const linked = !!st?.isRepo && st.isLinkedWorktree && !w.projectKey.startsWith("review:");
      const dirty = linked
        ? await gitApi
            .dirty([w.folder])
            .then((r) => r.dirty[w.folder] ?? 0)
            .catch(() => 0)
        : 0;
      if (alive) setCheckout({ linked, dirty });
    })();
    return () => {
      alive = false;
    };
  }, [w.folder]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canRemove = !!checkout?.linked && shared === 0 && checkout.dirty === 0;
  const path = w.folder.replace(/^\/Users\/[^/]+/, "~");

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await workspaceApi.remove(w.id, { worktree: canRemove && removeWorktree });
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message === "not found" ? "The running daemon is older than this page and cannot delete yet. Restart it and try again." : message);
      setBusy(false);
    }
  };

  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label="Delete workspace">
        <h3>Delete “{workspaceTitle(w)}”?</h3>
        <p className="hint">
          {sessions > 0
            ? `Its ${sessions} session${sessions === 1 ? "" : "s"} will be ended. `
            : "It holds no sessions. "}
          Transcripts stay in History{w.branch ? `, and the branch ${w.branch} keeps its commits` : ""}. This cannot be
          undone; Archive is the way to put it aside instead.
        </p>

        {checkout?.linked && (
          <>
            <label className="switch ws-delete-switch">
              <input
                type="checkbox"
                checked={canRemove && removeWorktree}
                disabled={!canRemove || busy}
                onChange={(e) => setRemoveWorktree(e.target.checked)}
              />
              Also remove the worktree at {path}
            </label>
            {shared > 0 && (
              <p className="hint">
                {shared} other workspace{shared === 1 ? " lives" : "s live"} in this worktree, so it stays.
              </p>
            )}
            {shared === 0 && checkout.dirty > 0 && (
              <p className="hint">
                It has {checkout.dirty} uncommitted change{checkout.dirty === 1 ? "" : "s"}, so it stays. Commit or
                discard them first to remove it; nothing here deletes uncommitted work.
              </p>
            )}
          </>
        )}
        {checkout && !checkout.linked && (
          <p className="hint">
            {w.projectKey.startsWith("review:")
              ? "Its review checkout is one of the dashboard's own and is cleaned up by the dashboard."
              : `It lives in ${path}, which is not a worktree and stays as it is.`}
          </p>
        )}

        {error && <div className="chat-error">{error}</div>}

        <div className="modal-actions">
          <button className="icon-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="icon-btn primary danger" disabled={busy || !checkout} onClick={() => void remove()}>
            {busy ? "Deleting…" : canRemove && removeWorktree ? "Delete workspace and worktree" : "Delete workspace"}
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}

/**
 * Take a project off the sidebar, with every workspace in it. Only the sidebar
 * forgets: folders, worktrees and branches are left exactly as they are.
 */
export function DeleteProjectDialog({
  project,
  workspaces,
  sessions,
  onClose,
}: {
  project: { key: string; name: string; root: string };
  workspaces: number;
  sessions: number;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await workspaceApi.removeProject(project.key);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label="Delete project">
        <h3>Delete “{project.name}” from the sidebar?</h3>
        <p className="hint">
          {workspaces > 0
            ? `Its ${workspaces} workspace${workspaces === 1 ? "" : "s"} go with it, archived ones included. `
            : "It has no workspaces. "}
          {sessions > 0 ? `${sessions} session${sessions === 1 ? "" : "s"} will be ended. ` : ""}
          Nothing on disk changes: {project.root.replace(/^\/Users\/[^/]+/, "~")}, its worktrees and its branches all
          stay, and transcripts remain in History. Starting a session there again brings the project back.
        </p>
        {error && <div className="chat-error">{error}</div>}
        <div className="modal-actions">
          <button className="icon-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="icon-btn primary danger" disabled={busy} onClick={() => void remove()}>
            {busy ? "Deleting…" : "Delete project"}
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
