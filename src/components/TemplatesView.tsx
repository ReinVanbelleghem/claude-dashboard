import { useEffect, useMemo, useState } from "react";
import { dirApi, fmtAgo, modelApi, settingsApi, shortPath, templateApi, type AgentSummary, type Favourite, type Settings } from "../api.ts";
import {
  blankSchedule,
  blankTemplate,
  DAY_NAMES,
  describeSchedule,
  parseCron,
  renderTitle,
  type Schedule,
  type Template,
  type TemplateRun,
} from "../../shared/templates.ts";
import { MODES, MODE_HELP, MODE_LABEL, STARTER_MODELS } from "./Conversation.tsx";
import { FolderField } from "./FolderPicker.tsx";
import { ClockIcon, CopyIcon, FolderIcon, PencilIcon, PlayIcon, PlusIcon, SearchIcon, TemplateIcon, TrashIcon } from "./Icons.tsx";
import { Select } from "./Select.tsx";
import { PromptBox } from "./PromptBox.tsx";

/**
 * Session templates: recipes you run often, each optionally on a schedule.
 *
 * A card per template with Run, Edit and Duplicate; the schedule line says when it
 * fires next; recent runs link to the sessions they produced. Templates are content,
 * not preferences, so they live here rather than under Settings.
 */
export function TemplatesView({
  settings,
  onSettings,
  agents,
  runsKey,
  onOpenSession,
}: {
  settings: Settings | null;
  onSettings: (s: Settings) => void;
  agents: AgentSummary[];
  /** Bumped by the SSE `template-runs` event. */
  runsKey: number;
  onOpenSession: (key: string) => void;
}) {
  const templates = settings?.templates ?? [];
  const [runs, setRuns] = useState<TemplateRun[]>([]);
  const [next, setNext] = useState<Record<string, number | null>>({});
  const [editing, setEditing] = useState<Template | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [askCwdFor, setAskCwdFor] = useState<Template | null>(null);

  useEffect(() => {
    templateApi
      .runs()
      .then((r) => {
        setRuns(r.runs);
        setNext(r.next);
      })
      .catch(() => {});
  }, [runsKey]);

  // The "next in" line counts down; a minute's tick keeps it honest.
  const [, setNow] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNow((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const save = async (list: Template[]) => {
    setError(null);
    try {
      const r = await settingsApi.save({ templates: list });
      onSettings(r.settings);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const run = async (t: Template, cwd?: string) => {
    if (!t.research && !t.cwd && !cwd) {
      setAskCwdFor(t);
      return;
    }
    setBusy(t.id);
    setError(null);
    try {
      const r = await templateApi.run(t.id, cwd);
      onOpenSession(r.key);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const duplicate = (t: Template) => {
    const copy = { ...t, id: newId(), name: `${t.name} copy`, schedule: t.schedule ? { ...t.schedule, enabled: false } : null };
    setEditing(copy);
    setIsNew(true);
  };

  const runsFor = useMemo(() => {
    const m = new Map<string, TemplateRun[]>();
    for (const r of runs) m.set(r.templateId, [...(m.get(r.templateId) ?? []), r]);
    return m;
  }, [runs]);

  const live = new Set(agents.filter((a) => a.status !== "ended" && a.status !== "error").map((a) => a.key));

  return (
    <div className="templates">
      <div className="services-head">
        <div>
          <h1>Templates</h1>
        </div>
        <div className="services-tools">
          <button
            className="icon-btn"
            onClick={() => {
              setEditing({ ...blankTemplate(newId()), model: settings?.ui.defaultModel ?? "" });
              setIsNew(true);
            }}
          >
            <PlusIcon />
            New template
          </button>
        </div>
      </div>

      {error && <div className="chat-error">{error}</div>}

      {templates.length === 0 ? (
        <div className="services-card">
          <div className="services-empty">
            <TemplateIcon />
            <div>
              No templates yet. A template fixes the directory, model, mode, title and first prompt of a session
              you start often, so running it is one click. Give it a schedule and it runs itself.
            </div>
          </div>
        </div>
      ) : (
        <div className="tpl-grid">
          {templates.map((t) => {
            const mine = runsFor.get(t.id) ?? [];
            const last = mine[0];
            const due = next[t.id];
            const running = mine.some((r) => live.has(r.agentKey));
            return (
              <div key={t.id} className={`tpl-card ${t.schedule?.enabled ? "scheduled" : ""}`}>
                <div className="tpl-card-head">
                  <div className="tpl-name">{t.name || "Untitled"}</div>
                  <div className="svc-actions">
                    <button className="icon-btn" title="Run now" aria-label="Run now" disabled={busy === t.id} onClick={() => void run(t)}>
                      <PlayIcon />
                    </button>
                    <button
                      className="icon-btn"
                      title="Edit"
                      aria-label="Edit"
                      onClick={() => {
                        setEditing(t);
                        setIsNew(false);
                      }}
                    >
                      <PencilIcon />
                    </button>
                    <button className="icon-btn" title="Duplicate" aria-label="Duplicate" onClick={() => duplicate(t)}>
                      <CopyIcon />
                    </button>
                  </div>
                </div>
                <div className="tpl-prompt">{t.prompt.trim().split("\n")[0] || <em>No first prompt</em>}</div>
                <div className="tpl-meta">
                  <span className="mono">{t.research ? "research" : t.cwd ? shortPath(t.cwd, 2) : "asks for a directory"}</span>
                  <span>·</span>
                  <span>{t.model || "default model"}</span>
                  <span>·</span>
                  <span>{MODE_LABEL[t.permissionMode] ?? t.permissionMode}</span>
                </div>
                <div className={`tpl-schedule ${t.schedule?.enabled ? "on" : ""}`}>
                  <ClockIcon />
                  <span>{describeSchedule(t.schedule)}</span>
                  {t.schedule?.enabled && typeof due === "number" && <span className="hint">· next {fmtIn(due)}</span>}
                  {running && <span className="svc-tag on">running</span>}
                </div>
                {mine.length > 0 && (
                  <div className="tpl-runs">
                    {mine.slice(0, 3).map((r) => (
                      <button key={r.id} className="tpl-run" onClick={() => onOpenSession(r.agentKey)} title="Open this run">
                        <i className={`dot ${live.has(r.agentKey) ? "live" : ""}`} />
                        {fmtAgo(r.startedAt)}
                        <span className="hint">· {r.trigger === "schedule" ? "scheduled" : "manual"}</span>
                      </button>
                    ))}
                    {mine.length > 3 && <span className="hint">+{mine.length - 3} more</span>}
                  </div>
                )}
                {last === undefined && <div className="tpl-runs hint">Never run</div>}
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <TemplateEditor
          template={editing}
          isNew={isNew}
          settings={settings}
          onClose={() => setEditing(null)}
          onSave={async (t) => {
            const list = isNew ? [...templates, t] : templates.map((x) => (x.id === t.id ? t : x));
            await save(list);
            setEditing(null);
          }}
          onDelete={async () => {
            await save(templates.filter((x) => x.id !== editing.id));
            setEditing(null);
          }}
        />
      )}

      {askCwdFor && (
        <PickCwd
          template={askCwdFor}
          onClose={() => setAskCwdFor(null)}
          onPick={(cwd) => {
            const t = askCwdFor;
            setAskCwdFor(null);
            void run(t, cwd);
          }}
        />
      )}
    </div>
  );
}

const newId = () => `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function fmtIn(at: number): string {
  const ms = at - Date.now();
  if (ms <= 0) return "now";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `in ${h}h ${min % 60}m`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}

function PickCwd({ template, onClose, onPick }: { template: Template; onClose: () => void; onPick: (cwd: string) => void }) {
  const [cwd, setCwd] = useState("");
  return (
    <div className="svc-scrim" onClick={onClose} role="dialog" aria-modal="true">
      <div className="svc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="svc-modal-title">
          <div>
            <h3>Run {template.name || "template"}</h3>
            <p className="hint">This template has no fixed directory. Where should this run?</p>
          </div>
        </div>
        <FolderField value={cwd} onChange={setCwd} placeholder="~/src/my-app" optional={false} stacked pickerTitle="Pick the working directory" />
        <div className="svc-modal-foot">
          <button className="icon-btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="icon-btn primary" disabled={!cwd.trim()} onClick={() => onPick(cwd.trim())}>
            Run
          </button>
        </div>
      </div>
    </div>
  );
}

function TemplateEditor({
  template,
  isNew,
  settings,
  onClose,
  onSave,
  onDelete,
}: {
  template: Template;
  isNew: boolean;
  settings: Settings | null;
  onClose: () => void;
  onSave: (t: Template) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [t, setT] = useState<Template>(template);
  const [arming, setArming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<{ value: string; label: string; hint?: string }[]>(STARTER_MODELS);
  const [favourites, setFavourites] = useState<Favourite[]>([]);
  // "Other" stays open once chosen, even while the path is still empty.
  const [custom, setCustom] = useState<boolean>(false);
  const edit = (patch: Partial<Template>) => setT((x) => ({ ...x, ...patch }));
  const editSchedule = (patch: Partial<Schedule>) => setT((x) => ({ ...x, schedule: { ...(x.schedule ?? blankSchedule()), ...patch } }));

  useEffect(() => {
    dirApi
      .favourites()
      .then((r) => {
        setFavourites(r.favourites);
        if (template.cwd && !r.favourites.some((f) => f.path === template.cwd)) setCustom(true);
      })
      .catch(() => {});
  }, [template.cwd]);

  useEffect(() => {
    const custom = settings?.ui.customModels ?? [];
    const off = settings?.ui.disabledModels ?? [];
    modelApi
      .list()
      .then((r) => {
        const cli = r.models.map((m) => ({ value: m.value, label: m.displayName, hint: m.description }));
        setModels([...cli, ...custom.filter((c) => !cli.some((m) => m.value === c.value))].filter((m) => !off.includes(m.value)));
      })
      .catch(() => {});
  }, [settings]);

  useEffect(() => {
    if (!arming) return;
    const id = setTimeout(() => setArming(false), 3000);
    return () => clearTimeout(id);
  }, [arming]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const sched = t.schedule;
  const cronOk = !sched || sched.kind !== "cron" || parseCron(sched.cron) !== null;
  const scheduleNeedsCwd = !!sched?.enabled && !t.research && !t.cwd.trim();
  const canSave = t.name.trim().length > 0 && cronOk && !scheduleNeedsCwd;
  const preview = renderTitle(t.titlePattern, { name: t.name || "Template", cwd: t.cwd, now: new Date() });
  const onFavourite = !t.research && !custom && favourites.some((f) => f.path === t.cwd);

  return (
    <div className="svc-scrim" onClick={onClose} role="dialog" aria-modal="true" aria-label={isNew ? "New template" : "Edit template"}>
      <div className="svc-modal svc-modal-wide tpl-editor" onClick={(e) => e.stopPropagation()}>
        <div className="svc-modal-title">
          <div>
            <h3>{isNew ? "New template" : t.name || "Template"}</h3>
          </div>
          {!isNew && (
            <button
              className={`icon-btn square ${arming ? "danger" : ""}`}
              title={arming ? "Click again to delete" : "Delete template"}
              aria-label="Delete template"
              onClick={() => (arming ? void onDelete() : setArming(true))}
            >
              <TrashIcon />
            </button>
          )}
        </div>

        <div className="tpl-editor-body">
          <section className="tpl-section">
            <div className="tpl-row">
              <label className="field">
                <span>Name</span>
                <input className="search" value={t.name} placeholder="Morning inbox" autoFocus onChange={(e) => edit({ name: e.target.value })} />
              </label>
              <label className="field">
                <span>Session title</span>
                <input className="search" value={t.titlePattern} placeholder="{name} · {date}" onChange={(e) => edit({ titlePattern: e.target.value })} />
              </label>
            </div>
            <p className="tpl-hint">
              <code>{"{name}"}</code> <code>{"{date}"}</code> <code>{"{time}"}</code> <code>{"{repo}"}</code> expand · sessions will be called <b>{preview}</b>
            </p>
          </section>

          <section className="tpl-section">
            <h3 className="set-h">Where it runs</h3>
            <div className="folder-grid tpl-folders">
              <button
                className={`folder-card pick dashed ${t.research ? "active" : ""}`}
                onClick={() => {
                  edit({ research: true, cwd: "" });
                  setCustom(false);
                }}
                title="No file or shell access — connectors and web search only"
              >
                <span className="folder-ic">
                  <SearchIcon />
                </span>
                <span className="folder-name">Research</span>
                <span className="folder-sub">no project</span>
              </button>
              {favourites.map((f) => (
                <button
                  key={f.path}
                  className={`folder-card pick ${onFavourite && t.cwd === f.path ? "active" : ""}`}
                  onClick={() => {
                    edit({ research: false, cwd: f.path });
                    setCustom(false);
                  }}
                  title={f.path}
                >
                  <span className="folder-ic">
                    <FolderIcon />
                  </span>
                  <span className="folder-name">{f.label}</span>
                  <span className="folder-sub">{shortPath(f.path, 2)}</span>
                </button>
              ))}
              <button
                className={`folder-card pick dashed ${custom ? "active" : ""}`}
                onClick={() => {
                  edit({ research: false });
                  setCustom(true);
                }}
              >
                <span className="folder-ic">
                  <FolderIcon open />
                </span>
                <span className="folder-name">Other folder</span>
                <span className="folder-sub">browse or type a path</span>
              </button>
              <button
                className={`folder-card pick dashed ${!t.research && !custom && !t.cwd ? "active" : ""}`}
                onClick={() => {
                  edit({ research: false, cwd: "" });
                  setCustom(false);
                }}
                title="The directory is chosen each time the template is run"
              >
                <span className="folder-ic">
                  <PlayIcon />
                </span>
                <span className="folder-name">Ask when run</span>
                <span className="folder-sub">cannot be scheduled</span>
              </button>
            </div>
            {custom && (
              <FolderField
                value={t.cwd}
                placeholder="~/src/my-app"
                optional={false}
                stacked
                onChange={(cwd) => edit({ cwd })}
                pickerTitle="Pick the working directory"
                pickerHint="The checkout the session starts in."
              />
            )}
          </section>

          <section className="tpl-section">
            <h3 className="set-h">How it runs</h3>
            <div className="tpl-row">
              <label className="field">
                <span>Model</span>
                <Select value={t.model} options={[{ value: "", label: "Dashboard default" }, ...models]} onChange={(v) => edit({ model: v })} />
              </label>
              <label className="field">
                <span>Permission mode</span>
                <Select
                  value={t.permissionMode}
                  options={MODES.map((m) => ({ value: m, label: MODE_LABEL[m], hint: MODE_HELP[m] }))}
                  onChange={(v) => edit({ permissionMode: v as Template["permissionMode"] })}
                />
              </label>
            </div>
            <label className="field">
              <span>First prompt</span>
              <PromptBox rows={5} value={t.prompt} placeholder="Sent as soon as the session is up. Type / for skills and commands." onChange={(prompt) => edit({ prompt })} />
            </label>
          </section>

          <section className="tpl-section">
            <div className="tpl-section-head">
              <h3 className="set-h">Schedule</h3>
              <label className="switch">
                <input type="checkbox" checked={!!sched?.enabled} onChange={(e) => editSchedule({ enabled: e.target.checked })} />
                <span>{sched?.enabled ? "On" : "Off"}</span>
              </label>
            </div>
            {sched?.enabled ? (
              <div className="tpl-schedule-edit">
                <div className="scope" role="radiogroup">
                  {(["weekly", "interval", "cron"] as const).map((k) => (
                    <button key={k} role="radio" aria-checked={sched.kind === k} className={`scope-btn ${sched.kind === k ? "on" : ""}`} onClick={() => editSchedule({ kind: k })}>
                      {k === "weekly" ? "Days and time" : k === "interval" ? "Every N hours" : "Cron"}
                    </button>
                  ))}
                </div>
                {sched.kind === "weekly" && (
                  <div className="tpl-weekly">
                    <div className="tpl-days">
                      {DAY_NAMES.map((d, i) => (
                        <button
                          key={d}
                          className={`tag-chip ${sched.days.includes(i) ? "on" : ""}`}
                          aria-pressed={sched.days.includes(i)}
                          onClick={() => editSchedule({ days: sched.days.includes(i) ? sched.days.filter((x) => x !== i) : [...sched.days, i] })}
                        >
                          {d}
                        </button>
                      ))}
                    </div>
                    <label className="field tpl-time">
                      <span>At</span>
                      <input className="search" type="time" value={sched.time} onChange={(e) => editSchedule({ time: e.target.value })} />
                    </label>
                  </div>
                )}
                {sched.kind === "interval" && (
                  <label className="field tpl-time">
                    <span>Every (hours)</span>
                    <input className="search" type="number" min={1} max={168} value={sched.everyHours} onChange={(e) => editSchedule({ everyHours: Math.max(1, Number(e.target.value) || 1) })} />
                  </label>
                )}
                {sched.kind === "cron" && (
                  <label className="field">
                    <span>Cron expression · minute hour day month weekday, local time</span>
                    <input className={`search mono ${cronOk ? "" : "bad"}`} value={sched.cron} onChange={(e) => editSchedule({ cron: e.target.value })} />
                    {!cronOk && <span className="tpl-hint warn">That does not parse. Example: 0 9 * * 1-5</span>}
                  </label>
                )}
                <label className="check">
                  <input type="checkbox" checked={sched.skipIfRunning} onChange={(e) => editSchedule({ skipIfRunning: e.target.checked })} />
                  <span>Skip a fire while the previous run is still going</span>
                </label>
                {scheduleNeedsCwd && <p className="tpl-hint warn">A scheduled template needs a fixed folder, since nobody is there to pick one.</p>}
              </div>
            ) : (
              <p className="tpl-hint">Off: run it from the card, the palette, or the new-session dialog.</p>
            )}
          </section>
        </div>

        <div className="svc-modal-foot">
          <button className="icon-btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="icon-btn primary"
            disabled={!canSave || saving}
            onClick={() => {
              setSaving(true);
              void onSave({ ...t, name: t.name.trim(), cwd: t.cwd.trim() }).finally(() => setSaving(false));
            }}
          >
            {isNew ? "Create" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
