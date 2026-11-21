import { useEffect, useState } from "react";
import { workspaceApi, type Project, type Workspace } from "../../api.ts";
import { LocationFields, useLocation } from "../LocationPicker.tsx";

/**
 * New workspace: a goal in one line, the folder it lives in, which checkout of a
 * repository that is (this one, another worktree, or a new one), and whether to
 * start a session straight away. A workspace needs no session.
 *
 * The folder and worktree tiles are the new-session dialog's own: it is the same
 * question, asked about a workspace instead of a session.
 */
export function NewWorkspaceDialog({
  initialFolder,
  initialGoal = "",
  projectId,
  project = null,
  projects,
  onClose,
  onCreated,
}: {
  initialFolder: string | null;
  /** Prefilled when the workspace is started from a task. */
  initialGoal?: string;
  /** The project the new checkout joins. Without one it is filed where its repository and branch say. */
  projectId?: number;
  /** That project, when it keeps a folder of its own: a new worktree is made inside it. */
  project?: Project | null;
  projects: { path: string }[];
  onClose: () => void;
  onCreated: (workspace: Workspace, startSession: boolean) => void;
}) {
  const loc = useLocation({ initialCwd: initialFolder, projects, project });
  const { manage } = loc;
  const [goal, setGoal] = useState(initialGoal);
  const [startSession, setStartSession] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !manage && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, manage]);

  const create = async () => {
    if (!loc.cwd.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const where = await loc.resolve();
      if ("error" in where) {
        setError(where.error);
        setBusy(false);
        return;
      }
      const { workspace } = await workspaceApi.create({ goal: goal.trim(), folder: where.dir, projectId });
      onCreated(workspace, startSession);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal wide scroll" role="dialog" aria-modal="true" aria-label="New workspace">
        <div className="modal-head">
          <div>
            <h3>New workspace</h3>
            <p className="hint">
              One piece of work inside a project, in a worktree of its own if you want one. It can sit empty until
              you start a session in it.
            </p>
          </div>
        </div>

        <label className="field">
          <span>Goal</span>
          <input
            className="search"
            autoFocus
            value={goal}
            maxLength={200}
            placeholder="What will be true when this is done? Leave empty to name it by its branch"
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
          />
        </label>

        <div className="field">
          <span className="field-head">
            Folder
            <button className="link-btn inline" onClick={() => loc.setManage(true)}>
              Manage repositories
            </button>
          </span>
          <LocationFields loc={loc} noun="workspace" allowResearch={false} busy={busy} onEnter={() => void create()} />
        </div>

        <label className="switch ws-dialog-switch">
          <input type="checkbox" checked={startSession} onChange={(e) => setStartSession(e.target.checked)} />
          Start a session right away
        </label>

        {error && <div className="chat-error">{error}</div>}

        <div className="modal-actions">
          <button className="icon-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="icon-btn primary" disabled={busy || !loc.cwd.trim()} onClick={() => void create()}>
            {busy ? "Creating…" : "Create workspace"}
          </button>
        </div>
      </div>
    </>
  );
}
