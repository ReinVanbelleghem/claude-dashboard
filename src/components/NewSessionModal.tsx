import { useEffect, useState } from "react";
import { agentApi, dirApi, modelApi, type Favourite, type PermissionMode } from "../api.ts";
import { MODES, MODE_HELP, MODE_LABEL, STARTER_MODELS } from "./Conversation.tsx";
import { FoldersModal } from "./FoldersModal.tsx";
import { FolderIcon, GitIcon } from "./Icons.tsx";

/**
 * Start a session the dashboard owns: directory, model, permissions, title.
 * Permissions belong here as well as in the running session because one of the
 * modes — bypassPermissions — can only be chosen at spawn time.
 *
 * Directories come from the saved shortlist rather than a file browser: choosing
 * where to work should be one click, and curating that list is a separate job
 * with its own dialog.
 */
export function NewSessionModal({
  projects,
  onClose,
  onStarted,
}: {
  projects: { path: string }[];
  onClose: () => void;
  onStarted: (key: string) => void;
}) {
  const [favourites, setFavourites] = useState<Favourite[] | null>(null);
  const [cwd, setCwd] = useState("");
  const [model, setModel] = useState("default");
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<PermissionMode>("auto");
  const [custom, setCustom] = useState(false);
  const [manage, setManage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the shortlist from recent projects the first time, so the dialog is
  // useful before anything has been curated. Dependency directories excluded:
  // a session can land in one by accident, never on purpose.
  const recent = projects.filter((p) => !p.path.includes("/node_modules/")).slice(0, 6);

  // Whatever the CLI actually offers, learned from the last session that ran.
  // STARTER_MODELS is only the fallback for a dashboard that has never run one.
  const [models, setModels] = useState(STARTER_MODELS);
  useEffect(() => {
    modelApi
      .list()
      .then((r) => {
        if (r.models.length > 0) {
          setModels(r.models.map((m) => ({ value: m.value, label: m.displayName })));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    dirApi
      .favourites()
      .then((r) => {
        setFavourites(r.favourites);
        setCwd(r.favourites[0]?.path ?? recent[0]?.path ?? "");
      })
      .catch(() => setFavourites([]));
    // Seeding is intentionally a mount-only concern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !manage && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, manage]);

  const start = async () => {
    if (!cwd.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { key } = await agentApi.start({
        cwd: cwd.trim(),
        model: model === "default" ? undefined : model,
        permissionMode: mode,
        title: title.trim() || undefined,
      });
      onStarted(key);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const cards: Favourite[] =
    favourites && favourites.length > 0
      ? favourites
      : recent.map((p) => ({ label: p.path.split("/").filter(Boolean).pop() ?? p.path, path: p.path }));

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal wide" role="dialog" aria-modal="true" aria-label="New session">
        <div className="modal-head">
          <div>
            <h3>New session</h3>
            <p className="hint">
              Runs on this machine as a child of the dashboard, with your settings, CLAUDE.md, skills
              and MCP servers — the same as a terminal session, but you drive it from here.
            </p>
          </div>
        </div>

        <div className="field">
          <span className="field-head">
            Working directory
            <button className="link-btn inline" onClick={() => setManage(true)}>
              Manage folders
            </button>
          </span>

          <div className="folder-grid">
            {cards.map((f) => (
              <button
                key={f.path}
                className={`folder-card pick ${cwd === f.path ? "active" : ""}`}
                onClick={() => {
                  setCwd(f.path);
                  setCustom(false);
                }}
                title={f.path}
              >
                <span className="folder-ic">
                  <FolderIcon open={cwd === f.path} />
                </span>
                <span className="folder-name">{f.label}</span>
                <span className="folder-sub">{f.path.replace(/^\/Users\/[^/]+/, "~")}</span>
              </button>
            ))}
            <button
              className={`folder-card pick dashed ${custom ? "active" : ""}`}
              onClick={() => {
                setCustom(true);
                setCwd("");
              }}
            >
              <span className="folder-ic">
                <GitIcon />
              </span>
              <span className="folder-name">Other path…</span>
              <span className="folder-sub">type or paste it</span>
            </button>
          </div>

          {custom && (
            <input
              className="search"
              autoFocus
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/Users/you/src/project"
              spellCheck={false}
              onKeyDown={(e) => e.key === "Enter" && void start()}
            />
          )}
        </div>

        <div className="modal-cols">
          <label className="field">
            <span>Model</span>
            <span className="select-wrap">
              <select
                className="search select"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {models.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </span>
          </label>

          <label className="field">
            <span>Permissions</span>
            <span className="select-wrap">
              <select
                className="search select"
                value={mode}
                onChange={(e) => setMode(e.target.value as PermissionMode)}
              >
                {MODES.map((m) => (
                  <option key={m} value={m} title={MODE_HELP[m]}>
                    {MODE_LABEL[m]}
                  </option>
                ))}
              </select>
            </span>
          </label>
        </div>

        <p className="mode-help">{MODE_HELP[mode]}</p>

        <label className="field">
          <span>Title</span>
          <input
            className="search"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Optional — otherwise generated from your first message"
            onKeyDown={(e) => e.key === "Enter" && void start()}
          />
        </label>

        {error && <div className="chat-error">{error}</div>}

        <div className="modal-actions">
          <button className="icon-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="icon-btn primary" disabled={busy || !cwd.trim()} onClick={start}>
            {busy ? "Starting…" : "Start session"}
          </button>
        </div>
      </div>

      {manage && (
        <FoldersModal
          stacked
          onClose={() => setManage(false)}
          onChanged={(rows) => {
            setFavourites(rows);
            // A directory that was just removed should not stay selected.
            if (rows.length > 0 && !rows.some((r) => r.path === cwd) && !custom) setCwd(rows[0].path);
          }}
        />
      )}
    </>
  );
}
