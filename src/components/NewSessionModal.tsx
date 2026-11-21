import { useEffect, useState } from "react";
import { agentApi, modelApi, type PermissionMode, type Settings } from "../api.ts";
import { MODES, MODE_HELP, MODE_LABEL, STARTER_MODELS } from "./Conversation.tsx";
import { permissionModeOr, renderTitle } from "../../shared/templates.ts";
import { FolderIcon, SearchIcon } from "./Icons.tsx";
import { LocationFields, useLocation } from "./LocationPicker.tsx";
import { Select } from "./Select.tsx";

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
  /**
   * Directory to start on, when the caller already knows which one. It is shown as a
   * pinned card rather than written into the free-text field: the shortlist stays
   * visible, so a prefill you did not want is one click to leave.
   */
  initialCwd = null,
  initialResearch = false,
  workspaceId = null,
  settings = null,
}: {
  projects: { path: string }[];
  onClose: () => void;
  onStarted: (key: string) => void;
  initialCwd?: string | null;
  /** Open on a chat with no project, as the sidebar's Chats group starts one. */
  initialResearch?: boolean;
  /** File the session in this workspace rather than wherever its folder would land it. */
  workspaceId?: number | null;
  settings?: Settings | null;
}) {
  const loc = useLocation({ initialCwd, initialResearch, projects });
  const { cwd, setCwd, setCustom, research, setResearch, repo, manage } = loc;
  const [model, setModel] = useState(settings?.ui.defaultModel || "default");
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<PermissionMode>(permissionModeOr(settings?.ui.defaultPermissionMode));
  /** A template chosen at the top: its prompt rides along on start. */
  const [fromTemplate, setFromTemplate] = useState<string | null>(null);
  const templatePrompt = () => settings?.templates.find((t) => t.id === fromTemplate)?.prompt.trim() || undefined;
  /**
   * Whether the directory and worktree pickers are on screen. Opened from a worktree
   * they are not: that click already answered both questions, and re-asking them is two
   * grids of tiles between you and the only thing left to decide. The answer is shown
   * as one card, with the pickers a click away.
   */
  const [picking, setPicking] = useState(initialCwd === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whatever the CLI actually offers, learned from the last session that ran.
  // STARTER_MODELS is only the fallback for a dashboard that has never run one.
  const [models, setModels] = useState<{ value: string; label: string; hint?: string }[]>(
    STARTER_MODELS,
  );
  const disabledModels = settings?.ui.disabledModels ?? [];
  const customModels = settings?.ui.customModels ?? [];
  useEffect(() => {
    modelApi
      .list()
      .then((r) => {
        const cliModels = r.models.map((m) => ({ value: m.value, label: m.displayName, hint: m.description }));
        const combined = [
          ...cliModels,
          ...customModels
            .filter((c) => !cliModels.some((m) => m.value === c.value))
            .map((c) => ({ value: c.value, label: c.label, hint: c.value })),
        ];
        const enabled = combined.filter((m) => !disabledModels.includes(m.value));
        if (enabled.length > 0) setModels(enabled);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !manage && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, manage]);

  const start = async () => {
    if (!research && !cwd.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (research) {
        const { key } = await agentApi.start({
          research: true,
          model: model === "default" ? undefined : model,
          permissionMode: mode,
          title: title.trim() || undefined,
          prompt: templatePrompt(),
          templateId: fromTemplate ?? undefined,
        });
        onStarted(key);
        return;
      }
      const where = await loc.resolve();
      if ("error" in where) {
        setError(where.error);
        setBusy(false);
        return;
      }
      const dir = where.dir;
      const { key } = await agentApi.start({
        cwd: dir,
        prompt: templatePrompt(),
        templateId: fromTemplate ?? undefined,
        model: model === "default" ? undefined : model,
        permissionMode: mode,
        title: title.trim() || undefined,
        workspace: workspaceId ?? undefined,
      });
      onStarted(key);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal wide scroll" role="dialog" aria-modal="true" aria-label="New session">
        <div className="modal-head">
          <div>
            <h3>New session</h3>
            <p className="hint">
              {research
                ? "No repository, no files, no shell — nothing on this machine is reachable, so a general question is answered on its own terms. Your MCP connectors and web search still work."
                : "Runs on this machine as a child of the dashboard, with your settings, CLAUDE.md, skills and MCP servers — the same as a terminal session, but you drive it from here."}
            </p>
          </div>
        </div>

        {(settings?.templates?.length ?? 0) > 0 && (
          <div className="field">
            <span className="field-head">Start from a template</span>
            <Select
              value={fromTemplate ?? ""}
              placeholder="Blank session"
              options={[
                { value: "", label: "Blank session" },
                ...(settings?.templates ?? []).map((t) => ({ value: t.id, label: t.name || "Untitled", hint: t.prompt.split("\n")[0] })),
              ]}
              onChange={(id) => {
                setFromTemplate(id || null);
                const t = settings?.templates.find((x) => x.id === id);
                if (!t) return;
                setResearch(t.research);
                if (t.cwd) {
                  setCwd(t.cwd);
                  setCustom(true);
                }
                if (t.model) setModel(t.model);
                setMode(t.permissionMode);
                setTitle(renderTitle(t.titlePattern, { name: t.name, cwd: t.cwd, now: new Date() }));
              }}
            />
          </div>
        )}

        <div className="field">
          <span className="field-head">
            {research ? "No project" : "Working directory"}
            {picking ? (
              <button className="link-btn inline" onClick={() => loc.setManage(true)}>
                Manage repositories
              </button>
            ) : (
              <button className="link-btn inline" onClick={() => setPicking(true)}>
                Change
              </button>
            )}
          </span>

          {!picking && research && (
            <div className="folder-card locked">
              <span className="folder-ic">
                <SearchIcon />
              </span>
              <span className="folder-name">Research</span>
              <span className="folder-sub">connectors and web only</span>
            </div>
          )}

          {!picking && !research && (
            <div className="folder-card locked" title={cwd}>
              <span className="folder-ic">
                <FolderIcon open />
              </span>
              <span className="folder-name">
                {cwd.split("/").filter(Boolean).pop() ?? cwd}
                {repo?.branch && <span className="chip muted">{repo.branch}</span>}
              </span>
              <span className="folder-sub">{cwd.replace(/^\/Users\/[^/]+/, "~")}</span>
            </div>
          )}

          {picking && <LocationFields loc={loc} busy={busy} onEnter={() => void start()} />}
        </div>

        <div className="modal-cols">
          <label className="field">
            <span>Model</span>
            <Select value={model} options={models} onChange={setModel} />
          </label>

          <label className="field">
            <span>Permissions</span>
            <Select
              value={mode}
              onChange={(v) => setMode(v as PermissionMode)}
              options={MODES.map((m) => ({ value: m, label: MODE_LABEL[m], hint: MODE_HELP[m] }))}
            />
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
          <button
            className="icon-btn primary"
            disabled={busy || (!research && !cwd.trim())}
            onClick={start}
          >
            {busy ? "Starting…" : "Start session"}
          </button>
        </div>
      </div>

    </>
  );
}
