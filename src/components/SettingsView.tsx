import { createPortal } from "react-dom";
import { FoldersModal } from "./FoldersModal.tsx";
import { useEffect, useRef, useState } from "react";
import {
  configApi,
  modelApi,
  settingsApi,
  type ModelInfo,
  type NotifyEventKind,
  type Settings,
  type SettingsPatch,
} from "../api.ts";
import type { Appearance } from "../appearance.ts";
import { AppearancePanel } from "./AppearancePanel.tsx";
import { FolderField } from "./FolderPicker.tsx";
import { FolderIcon, CheckIcon, GripIcon, TrashIcon } from "./Icons.tsx";
import { McpPanel } from "./McpPanel.tsx";
import { NotificationsPanel } from "./NotificationsPanel.tsx";
import { OpenTargetPicker } from "./OpenTargetPicker.tsx";
import { footerPagesOf, orderedPages, type PageDef } from "../pages.ts";
import { useSortable } from "../useSortable.ts";
import { ServicesSettings } from "./services/ServicesSettings.tsx";
import { Select } from "./Select.tsx";
import { MODES, MODE_HELP, MODE_LABEL } from "./Conversation.tsx";
import { permissionModeOr } from "../../shared/templates.ts";
import { ReviewsSettings } from "./pr/ReviewsSettings.tsx";

function labelFromModelId(id: string): string {
  const m = id.match(/^claude-([a-z]+)-(.+)$/);
  if (!m) return id;
  const [, family, version] = m;
  return `${family[0].toUpperCase()}${family.slice(1)} ${version.replace(/-/g, ".")}`;
}

/**
 * Preferences, saved on change.
 *
 * Notifications are the substance here: which states are worth interrupting you
 * for, through which channel, and when to stay quiet. Everything writes straight
 * to the daemon's settings.json, so a reload or another tab sees the same state.
 */

/**
 * Sections are one panel each, reached from the left rail rather than by
 * scrolling: notifications alone is longer than a screen, and the three short
 * panels were disappearing under it.
 */
type SectionKey = "appearance" | "pages" | "notifications" | "sessions" | "artifacts" | "services" | "code" | "mcp";

const SECTIONS: { key: SectionKey; label: string; help: string }[] = [
  { key: "appearance", label: "Appearance", help: "Theme, accent, tab icon" },
  { key: "pages", label: "Pages", help: "Which pages the dock shows" },
  { key: "notifications", label: "Notifications", help: "What interrupts you" },
  { key: "sessions", label: "Sessions", help: "Where a card opens, model and permissions" },
  { key: "artifacts", label: "Folders", help: "Your repositories, and where projects, notes, drawings and pages are kept" },
  { key: "services", label: "Services", help: "The local dev stack" },
  { key: "code", label: "Code", help: "Diffs, worktrees and pull requests" },
  { key: "mcp", label: "MCP", help: "Connectors and sign-in" },
];

const SECTION_KEY = "settings-section";

export function SettingsView({
  settings,
  onSettings,
  appearance,
  onAppearance,
}: {
  settings: Settings | null;
  onSettings: (s: Settings) => void;
  appearance: Appearance;
  onAppearance: (patch: Partial<Appearance>) => void;
}) {
  const [saving, setSaving] = useState(false);
  // Remembered, because settings is a place you come back to for one thing.
  const [showRepos, setShowRepos] = useState(false);
  const [section, setSection] = useState<SectionKey>(() => {
    const saved = localStorage.getItem(SECTION_KEY);
    // Sections have been merged twice — "diffs" into "git", then "git" and "reviews"
    // into "code", and "models" into "sessions". A stale key lands on whichever panel
    // now holds what it used to, rather than back at the top of the rail.
    const MOVED: Record<string, SectionKey> = { diffs: "code", git: "code", reviews: "code", models: "sessions" };
    if (saved && MOVED[saved]) return MOVED[saved];
    return SECTIONS.some((s) => s.key === saved) ? (saved as SectionKey) : "appearance";
  });

  useEffect(() => {
    localStorage.setItem(SECTION_KEY, section);
  }, [section]);

  const [allModels, setAllModels] = useState<ModelInfo[]>([]);
  useEffect(() => {
    modelApi
      .list()
      .then((r) => setAllModels(r.models))
      .catch(() => {});
  }, []);

  const [knownIds, setKnownIds] = useState<string[]>([]);
  useEffect(() => {
    configApi
      .get()
      .then((r) => setKnownIds(Object.keys(r.pricing)))
      .catch(() => {});
  }, []);

  const [customDraft, setCustomDraft] = useState("");

  const nav = (
    <nav className="settings-nav" aria-label="Settings sections">
      {SECTIONS.map((s) => (
        <button
          key={s.key}
          className={`settings-nav-item ${section === s.key ? "on" : ""}`}
          aria-current={section === s.key ? "page" : undefined}
          onClick={() => setSection(s.key)}
        >
          <span className="settings-nav-label">{s.label}</span>
          <span className="settings-nav-help">{s.help}</span>
        </button>
      ))}
    </nav>
  );

  // Appearance renders either way: it is local state, so there is nothing to wait
  // for, and it is the panel you are most likely here to play with. MCP is the same
  // case for a different reason — it reads the machine, not the settings file.
  if (!settings) {
    return (
      <div className="settings-layout">
        {nav}
        <div className="settings-body">
          {section === "appearance" ? (
            <AppearancePanel appearance={appearance} onChange={onAppearance} />
          ) : section === "mcp" ? (
            <McpPanel />
          ) : (
            <div className="empty">Loading settings…</div>
          )}
        </div>
      </div>
    );
  }
  const save = (patch: SettingsPatch) => {
    setSaving(true);
    settingsApi
      .save(patch)
      .then((r) => onSettings(r.settings))
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  return (
    <div className="settings-layout">
      {nav}
      <div className="settings-body">
        {section === "appearance" && (
          <div className="panel">
            <h2>Name</h2>
            <p className="hint">
              What the sidebar, the breadcrumb and the window title call this app. Two words
              become a wordmark over a subtitle in the sidebar.
            </p>
            <AppNameField value={settings.ui.appName ?? "Claude Dashboard"} onSave={(appName) => save({ ui: { appName } })} />
          </div>
        )}
        {section === "appearance" && (
          <AppearancePanel
            appearance={appearance}
            onChange={onAppearance}
            themes={settings.ui.themes ?? []}
            onThemes={(themes) => save({ ui: { themes } })}
          />
        )}

        {section === "pages" && (
          <div className="settings-section">
            <h3>Pages</h3>
            <p className="hint">
              Drag to reorder within a list. A page turned off leaves the sidebar and the palette; nothing is deleted.
            </p>
            <PagesList settings={settings} save={save} />
            <p className="hint">
              <b>Home</b> and <b>Settings</b> stay put: one is where a hidden page sends you,
              the other is the way back here.
            </p>
          </div>
        )}

        {section === "notifications" && <NotificationsPanel settings={settings} saving={saving} save={save} onSettings={onSettings} />}

        {section === "sessions" && (
          <div className="panel">
            <h2>Sessions</h2>
            <p className="hint">
              Every card also carries an ↗ that always opens the full page, whatever these are set to.
            </p>
            <label className="set-row">
              <input
                type="checkbox"
                checked={settings.ui.workspaceAutoGoal !== false}
                onChange={(e) => save({ ui: { workspaceAutoGoal: e.target.checked } })}
              />
              <span className="set-text">
                <span className="set-label">Name workspaces automatically</span>
                <span className="set-help">
                  A workspace nobody gave a goal gets one from its first prompt, with one small-model call. Off, it shows
                  the folder name until you type one.
                </span>
              </span>
            </label>
            <div className="open-target-grid">
              <label className="field">
                <span>Click</span>
                <OpenTargetPicker
                  value={settings.ui.clickOpensIn}
                  onChange={(v) => save({ ui: { clickOpensIn: v } })}
                />
              </label>
              <label className="field">
                <span>⌘/Ctrl-click</span>
                <OpenTargetPicker
                  value={settings.ui.cmdClickOpensIn}
                  onChange={(v) => save({ ui: { cmdClickOpensIn: v } })}
                />
              </label>
              <label className="field">
                <span>⌥/Option-click</span>
                <OpenTargetPicker
                  value={settings.ui.optionClickOpensIn}
                  onChange={(v) => save({ ui: { optionClickOpensIn: v } })}
                />
              </label>
            </div>
          </div>
        )}

        {(() => {
          if (section !== "sessions") return null;
          const customModels = settings.ui.customModels ?? [];
          const disabled = settings.ui.disabledModels ?? [];
          const merged = [
            ...allModels
              .filter((m) => m.value !== "default")
              .map((m) => ({
                value: m.value,
                label: m.displayName,
                hint: m.description,
                custom: false,
              })),
            ...customModels
              .filter((c) => !allModels.some((m) => m.value === c.value))
              .map((c) => ({ value: c.value, label: c.label, hint: c.value, custom: true })),
          ];
          const knownCandidates = knownIds.filter((id) => !merged.some((m) => m.value === id));

          const addCustom = (value: string, label?: string) => {
            const v = value.trim();
            if (!v || merged.some((m) => m.value === v)) return;
            save({
              ui: { customModels: [...customModels, { value: v, label: label?.trim() || labelFromModelId(v) }] },
            });
            setCustomDraft("");
          };
          const removeCustom = (value: string) => {
            save({
              ui: {
                customModels: customModels.filter((c) => c.value !== value),
                disabledModels: disabled.filter((v) => v !== value),
                defaultModel: settings.ui.defaultModel === value ? "" : settings.ui.defaultModel,
              },
            });
          };

          return (
            <div className="panel">
              <h2>Defaults</h2>
              <p className="hint">
                What a new session starts with unless you pick something else when starting it. A resumed session comes
                back with these too.
              </p>
              <div className="session-defaults-grid">
                <label className="field">
                  <span>Model</span>
                  <Select
                    value={settings.ui.defaultModel || "default"}
                    options={[
                      { value: "default", label: "Default (recommended)", hint: "Let the CLI pick" },
                      ...merged.filter((m) => !disabled.includes(m.value)),
                    ]}
                    onChange={(v) => save({ ui: { defaultModel: v === "default" ? "" : v } })}
                  />
                </label>
                <label className="field">
                  <span>Permissions</span>
                  <Select
                    ariaLabel="Default permissions"
                    value={permissionModeOr(settings.ui.defaultPermissionMode)}
                    options={MODES.map((m) => ({ value: m, label: MODE_LABEL[m], hint: MODE_HELP[m] }))}
                    onChange={(v) => save({ ui: { defaultPermissionMode: v } })}
                  />
                </label>
              </div>

              <h2 style={{ marginTop: 22 }}>Available models</h2>
              <p className="hint">Turn off the ones you never want to see. At least one has to stay on.</p>
              {merged.length === 0 ? (
                <p className="set-help">Loading the model list — start or open a session once to populate it.</p>
              ) : (
                <div className="set-group">
                  {merged.map((m) => {
                    const isOn = !disabled.includes(m.value);
                    const onlyOneLeft = isOn && merged.length - disabled.length <= 1;
                    return (
                      <label className="set-row" key={m.value}>
                        <input
                          type="checkbox"
                          checked={isOn}
                          disabled={onlyOneLeft}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? disabled.filter((v) => v !== m.value)
                              : [...disabled, m.value];
                            save({ ui: { disabledModels: next } });
                          }}
                        />
                        <span className="set-text">
                          <span className="set-label">
                            {m.label}
                            {m.custom && <span className="set-help"> · {m.value} · added by hand</span>}
                          </span>
                          <span className="set-help">{m.hint}</span>
                        </span>
                        {m.custom && (
                          <button
                            type="button"
                            className="icon-btn tiny"
                            title="Remove this model"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              removeCustom(m.value);
                            }}
                          >
                            <TrashIcon />
                          </button>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}

              <h2 style={{ marginTop: 22 }}>Add an older or unlisted model</h2>
              <p className="hint">
                Any exact model ID, family alias or version prefix works, but is only validated when a
                session starts with it.
              </p>
              {knownCandidates.length > 0 && (
                <div className="chip-row" style={{ marginBottom: 10 }}>
                  {knownCandidates.map((id) => (
                    <button
                      type="button"
                      key={id}
                      className="chip-btn"
                      onClick={() => addCustom(id)}
                      title={id}
                    >
                      + {labelFromModelId(id)}
                    </button>
                  ))}
                </div>
              )}
              <div className="inline-add-row">
                <label className="field">
                  <span>Model ID</span>
                  <input
                    className="search"
                    spellCheck={false}
                    placeholder="e.g. claude-opus-4-8"
                    value={customDraft}
                    onChange={(e) => setCustomDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addCustom(customDraft);
                    }}
                  />
                </label>
                <div className="field inline-add-btn">
                  <span aria-hidden="true">&nbsp;</span>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={!customDraft.trim()}
                    onClick={() => addCustom(customDraft)}
                  >
                    Add
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {section === "code" && (
          <div className="panel">
            <h2>Diffs</h2>
            <p className="hint">Defaults for the git views. Changing them here or there is the same thing.</p>
            <div className="set-grid">
              <label className="field">
                <span>Default layout</span>
                <Select
                  value={settings.ui.diffMode}
                  onChange={(v) => save({ ui: { diffMode: v as "unified" | "split" } })}
                  options={[
                    { value: "unified", label: "Unified" },
                    { value: "split", label: "Split" },
                  ]}
                />
              </label>
              <label className="set-row" style={{ alignSelf: "end" }}>
                <input
                  type="checkbox"
                  checked={settings.ui.diffIgnoreWhitespace}
                  onChange={(e) => save({ ui: { diffIgnoreWhitespace: e.target.checked } })}
                />
                <span className="set-text">
                  <span className="set-label">Ignore whitespace</span>
                  <span className="set-help">Hide changes that only reindent.</span>
                </span>
              </label>
            </div>
            <h2 style={{ marginTop: 22 }}>Worktrees</h2>
            <p className="hint">New worktrees are created beside the repository unless you pick a folder here.</p>
            <div style={{ maxWidth: 520 }}>
              <FolderField
                label="Create worktrees in"
                value={settings.ui.worktreeRoot ?? ""}
                placeholder="Beside the repository"
                onChange={(v) => save({ ui: { worktreeRoot: v } })}
                pickerTitle="Pick the worktrees folder"
                pickerHint="New worktrees are created as subfolders of this directory."
              />
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.ui.worktreeExclude === true}
                onChange={(e) => save({ ui: { worktreeExclude: e.target.checked } })}
              />
              <span>Let it add those paths to the repository's local exclude file</span>
            </label>
            <p className="hint">
              Writes the symlinked paths to <code>.git/info/exclude</code>, which git never commits, so a
              worktree with a <code>node_modules</code> symlink can still be removed.
            </p>
            <p className="hint">
              {(settings.ui.worktreeProvision ?? []).length > 0
                ? `Carried into every new worktree: ${(settings.ui.worktreeProvision ?? [])
                    .map((r) => `${r.path} (${r.mode})`)
                    .join(", ")}. Edit this baseline in settings.json.`
                : "Nothing is carried into a new worktree by default; set ui.worktreeProvision in settings.json."}
              {" "}Per-repository rules live under <b>Worktrees</b>, on the repository itself.
              {Object.keys(settings.ui.worktreeProvisionByRepo ?? {}).length > 0 &&
                ` ${Object.keys(settings.ui.worktreeProvisionByRepo ?? {}).length} repositor${
                  Object.keys(settings.ui.worktreeProvisionByRepo ?? {}).length === 1 ? "y has" : "ies have"
                } their own.`}
            </p>
          </div>
        )}

        {section === "artifacts" && (
          <>
            <div className="panel">
              <h2>Repositories</h2>
              <p className="hint">
                The repositories, and any other folders, you start from. They are the tiles offered when you add a workspace to a project or
                start a session.
              </p>
              <button className="icon-btn" onClick={() => setShowRepos(true)}>
                <FolderIcon /> Manage repositories
              </button>
              {showRepos && createPortal(<FoldersModal onClose={() => setShowRepos(false)} />, document.body)}
            </div>
            <div className="panel">
              <h2>Projects</h2>
              <p className="hint">
                One folder per project, holding its worktrees and its own <code>drawings</code> and <code>artifacts</code>. The three folders
                below are for what belongs to no project.
              </p>
              <div style={{ maxWidth: 520 }}>
                <FolderField
                  label="Keep projects in"
                  value={settings.ui.projectsRoot ?? ""}
                  placeholder="~/projects (default)"
                  onChange={(v) => save({ ui: { projectsRoot: v } })}
                  pickerTitle="Pick the projects folder"
                  pickerHint="A new project gets a subfolder here. Projects that already have a folder stay where they are."
                />
              </div>
            </div>
            <div className="panel">
              <h2>Notes</h2>
              <p className="hint">Markdown files.</p>
              <div style={{ maxWidth: 520 }}>
                <FolderField
                  label="Keep notes in"
                  value={settings.ui.notesRoot ?? ""}
                  placeholder="~/Notes"
                  onChange={(v) => save({ ui: { notesRoot: v } })}
                  pickerTitle="Pick the notes folder"
                  pickerHint="Every Markdown file under it is listed on the Notes page."
                />
              </div>
            </div>
            <div className="panel">
              <h2>Drawings</h2>
              <p className="hint">One .excalidraw file per drawing.</p>
              <div style={{ maxWidth: 520 }}>
                <FolderField
                  label="Keep drawings in"
                  value={settings.ui.drawingsRoot ?? ""}
                  placeholder="~/drawings"
                  onChange={(v) => save({ ui: { drawingsRoot: v } })}
                  pickerTitle="Pick the drawings folder"
                  pickerHint="Every .excalidraw file directly in it is shown on the Drawings page."
                />
              </div>
            </div>
            <div className="panel">
              <h2>Artifacts</h2>
              <p className="hint">Generated HTML pages.</p>
              <div style={{ maxWidth: 520 }}>
                <FolderField
                  label="Keep artifacts in"
                  value={settings.ui.artifactsRoot ?? ""}
                  placeholder="~/artifacts"
                  onChange={(v) => save({ ui: { artifactsRoot: v } })}
                  pickerTitle="Pick the artifacts folder"
                  pickerHint="Every HTML page written under it is indexed and shown on the Artifacts page."
                />
              </div>
            </div>
          </>
        )}


        {section === "services" && <ServicesSettings settings={settings} save={save} />}

        {section === "code" && (
          <ReviewsSettings
            settings={settings}
            save={save}
            models={[
              ...allModels.filter((m) => m.value !== "default").map((m) => ({ value: m.value, label: m.displayName })),
              ...(settings.ui.customModels ?? []).filter((c) => !allModels.some((m) => m.value === c.value)),
            ]}
          />
        )}

        {section === "mcp" && <McpPanel />}
      </div>
    </div>
  );
}

function PagesList({ settings, save }: { settings: Settings; save: (patch: SettingsPatch) => void }) {
  const pages = orderedPages(settings.ui.pageOrder);
  const inFooter = footerPagesOf(settings.ui.footerPages);
  const main = pages.filter((p) => !inFooter.has(p.key));
  const footer = pages.filter((p) => inFooter.has(p.key));
  const saveLists = (mainKeys: string[], footerKeys: string[]) =>
    save({ ui: { pageOrder: [...mainKeys, ...footerKeys], footerPages: footerKeys } });
  const keys = (list: PageDef[]) => list.map((p) => p.key as string);
  return (
    <>
      <h4 className="set-subhead">Main navigation</h4>
      <p className="hint">Rows with a label, at the top of the sidebar.</p>
      <PageRows
        pages={main}
        settings={settings}
        save={save}
        moveLabel="Move to bottom bar"
        onReorder={(next) => saveLists(next, keys(footer))}
        onMoveAcross={(key) => saveLists(keys(main).filter((k) => k !== key), [...keys(footer), key])}
      />
      <h4 className="set-subhead">Bottom bar</h4>
      <p className="hint">Icons only, at the foot of the sidebar. Settings always sits at the far end.</p>
      <PageRows
        pages={footer}
        settings={settings}
        save={save}
        moveLabel="Move to main navigation"
        onReorder={(next) => saveLists(keys(main), next)}
        onMoveAcross={(key) => saveLists([...keys(main), key], keys(footer).filter((k) => k !== key))}
      />
    </>
  );
}

function PageRows({
  pages,
  settings,
  save,
  moveLabel,
  onReorder,
  onMoveAcross,
}: {
  pages: PageDef[];
  settings: Settings;
  save: (patch: SettingsPatch) => void;
  moveLabel: string;
  onReorder: (keys: string[]) => void;
  onMoveAcross: (key: string) => void;
}) {
  const hidden = settings.ui.hiddenPages ?? [];
  const listRef = useRef<HTMLDivElement>(null);
  const drag = useSortable({
    count: pages.length,
    listRef,
    itemSelector: ".set-row",
    onMove: (from, to) => {
      const next = pages.map((p) => p.key as string);
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      onReorder(next);
    },
  });
  if (pages.length === 0) return <p className="hint set-empty">Nothing here yet.</p>;
  return (
    <div className="set-group" ref={listRef}>
      {pages.map((p, i) => (
        <label key={p.key} className={`set-row ${drag.active === i ? "dragging" : ""}`} style={drag.itemStyle(i)}>
          <span className="set-row-lead">
            <button
              type="button"
              className="sort-grip"
              data-sort-handle
              aria-label={`Drag to reorder ${p.label || "Desktop"}`}
              onClick={(e) => e.preventDefault()}
              {...drag.handleProps(i)}
            >
              <GripIcon />
            </button>
            <input
              type="checkbox"
              checked={!hidden.includes(p.key)}
              disabled={p.fixed}
              onChange={(e) =>
                save({
                  ui: { hiddenPages: e.target.checked ? hidden.filter((k) => k !== p.key) : [...hidden, p.key] },
                })
              }
            />
          </span>
          <span className="set-text">
            <span className="set-label">{p.label || "Desktop"}</span>
            <span className="set-help">
              {p.hint}
              {p.fixed ? " · always on" : ""}
            </span>
          </span>
          <button
            type="button"
            className="icon-btn tiny set-row-move"
            onClick={(e) => {
              e.preventDefault();
              onMoveAcross(p.key);
            }}
          >
            {moveLabel}
          </button>
        </label>
      ))}
    </div>
  );
}

function AppNameField({ value, onSave }: { value: string; onSave: (name: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.trim() || "Claude Dashboard";
    if (next !== value) onSave(next);
    setDraft(next);
  };
  return (
    <label className="field" style={{ maxWidth: 360 }}>
      <span>App name</span>
      <input
        className="search"
        value={draft}
        placeholder="Claude Dashboard"
        maxLength={40}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          if (e.key === "Escape") setDraft(value);
        }}
      />
    </label>
  );
}
