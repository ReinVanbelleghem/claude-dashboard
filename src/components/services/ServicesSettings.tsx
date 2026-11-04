import { useEffect, useRef, useState } from "react";
import type { Settings, SettingsPatch } from "../../api.ts";
import {
  blankRepo,
  blankService,
  DEFAULT_COMPOSE,
  DEFAULT_RESTART_MAX,
  type Service,
  type ServicePaths,
  type ServiceRepo,
} from "../../../shared/services.ts";
import { GripIcon, PlusIcon, TrashIcon } from "../Icons.tsx";
import { useSortable } from "../../useSortable.ts";
import { FolderField } from "../FolderPicker.tsx";
import { Select } from "../Select.tsx";

/**
 * What is startable, and where from.
 *
 * Edits are held locally and saved on Save rather than per keystroke: a half-typed
 * command is not a service definition, and the list is what the Services page starts
 * from, so a partial write is a broken stack rather than a cosmetic glitch.
 */
export function ServicesSettings({
  settings,
  save,
}: {
  settings: Settings;
  save: (patch: SettingsPatch) => void;
}) {
  const [defs, setDefs] = useState<Service[]>(settings.services?.defs ?? []);
  const [paths, setPaths] = useState<ServicePaths>(settings.services?.paths ?? { repos: [] });
  const [compose, setCompose] = useState({
    repo: settings.services?.compose?.repo ?? DEFAULT_COMPOSE.repo,
    subdir: settings.services?.compose?.subdir ?? DEFAULT_COMPOSE.subdir,
  });
  const [selected, setSelected] = useState<string | null>(defs[0]?.key ?? null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A save elsewhere (or the first load) replaces what is on screen, but only while
  // there is nothing unsaved to lose.
  useEffect(() => {
    if (dirty) return;
    setDefs(settings.services?.defs ?? []);
    setPaths(settings.services?.paths ?? { repos: [] });
    setCompose({
      repo: settings.services?.compose?.repo ?? DEFAULT_COMPOSE.repo,
      subdir: settings.services?.compose?.subdir ?? DEFAULT_COMPOSE.subdir,
    });
  }, [settings.services, dirty]);

  const service = defs.find((s) => s.key === selected) ?? null;
  const repos = paths.repos ?? [];
  const navRef = useRef<HTMLElement>(null);
  const drag = useSortable({
    count: defs.length,
    listRef: navRef,
    itemSelector: ".svc-cfg-nav-item",
    onMove: (from, to) => {
      const next = defs.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      setDefs(next);
      setDirty(true);
    },
  });

  const edit = (key: string, patch: Partial<Service>) => {
    setDefs((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)));
    setDirty(true);
  };

  const editRepos = (next: ServiceRepo[]) => {
    setPaths({ repos: next });
    setDirty(true);
  };

  function commit() {
    const keys = defs.map((s) => s.key.trim());
    if (keys.some((k) => !k)) return setError("every service needs a key");
    const dupe = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dupe) return setError(`two services share the key "${dupe}"`);
    const repoKeys = repos.map((r) => r.key.trim());
    if (repoKeys.some((k) => !k)) return setError("every repository needs a key");
    const repoDupe = repoKeys.find((k, i) => repoKeys.indexOf(k) !== i);
    if (repoDupe) return setError(`two repositories share the key "${repoDupe}"`);
    const orphan = defs.find((s) => !repoKeys.includes(s.repo));
    if (orphan) return setError(`${orphan.label || orphan.key} points at a repository that no longer exists`);
    setError(null);
    save({ services: { defs, paths, compose: { ...settings.services.compose, ...compose } } });
    setDirty(false);
  }

  function addService() {
    let key = "new-service";
    for (let i = 2; defs.some((s) => s.key === key); i++) key = `new-service-${i}`;
    setDefs([...defs, { ...blankService(key), label: "New service", repo: repos[0]?.key ?? "" }]);
    setSelected(key);
    setDirty(true);
  }

  function addRepo() {
    let key = "repo";
    for (let i = 2; repos.some((r) => r.key === key); i++) key = `repo-${i}`;
    editRepos([...repos, { ...blankRepo(key), label: "New repository" }]);
  }

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>Services</h2>
          <div className="svc-cfg-bar">
            {dirty && <span className="svc-tag warn">unsaved changes</span>}
            <button className="icon-btn tiny" onClick={addService}>
              <PlusIcon />
              Add service
            </button>
            <button className="icon-btn tiny primary" disabled={!dirty} onClick={commit}>
              Save
            </button>
          </div>
        </div>
        <p className="hint">
          One tmux session per service, one pane per command.
        </p>
        {error && <div className="chat-error">{error}</div>}

        <div className="svc-cfg">
          <nav className="svc-cfg-nav" ref={navRef}>
            {defs.map((s, i) => (
              <div
                key={s.key}
                className={`svc-cfg-nav-item ${selected === s.key ? "on" : ""} ${drag.active === i ? "dragging" : ""}`}
                style={drag.itemStyle(i)}
              >
                <button className="sort-grip" data-sort-handle aria-label={`Drag to reorder ${s.label || s.key}`} {...drag.handleProps(i)}>
                  <GripIcon />
                </button>
                <button className="svc-cfg-nav-main" onClick={() => setSelected(s.key)}>
                  <span className="svc-cfg-nav-label">{s.label || s.key}</span>
                  <span className="svc-cfg-nav-sub mono">
                    {s.key}
                    {s.disabled ? " · off" : ""}
                  </span>
                </button>
              </div>
            ))}
            {defs.length === 0 && <p className="hint">No services yet.</p>}
          </nav>

          <div className="svc-cfg-body">
            {service ? (
              <ServicePanel
                service={service}
                all={defs}
                repos={repos}
                onEdit={(patch) => edit(service.key, patch)}
                onRekey={(next) => {
                  edit(service.key, { key: next });
                  setSelected(next);
                }}
                onDelete={() => {
                  setDefs(defs.filter((s) => s.key !== service.key));
                  setSelected(defs.find((s) => s.key !== service.key)?.key ?? null);
                  setDirty(true);
                }}
              />
            ) : (
              <p className="hint">Select a service on the left, or add one.</p>
            )}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Repositories</h2>
          <div className="svc-cfg-bar">
            {dirty && <span className="svc-tag warn">unsaved changes</span>}
            <button className="icon-btn tiny" onClick={addRepo}>
              <PlusIcon />
              Add repository
            </button>
            <button className="icon-btn tiny primary" disabled={!dirty} onClick={commit}>
              Save
            </button>
          </div>
        </div>
        <p className="hint">
          A main checkout plus its worktrees, found as <code>key-branch</code> folders under the worktrees folder.
        </p>

        <div className="svc-repo-head">
          <span>Name</span>
          <span>Key</span>
          <span>Main checkout</span>
          <span>Worktrees folder</span>
          <span />
        </div>
        {repos.map((r, i) => {
          const used = defs.filter((s) => s.repo === r.key).length;
          return (
            <RepoRow
              key={i}
              repo={r}
              used={used}
              onEdit={(patch) => editRepos(repos.map((x, j) => (i === j ? { ...x, ...patch } : x)))}
              onDelete={() => editRepos(repos.filter((_, j) => j !== i))}
            />
          );
        })}
        {repos.length === 0 && <p className="hint">No repositories yet — nothing can start until one is added.</p>}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Docker compose</h2>
          <div className="svc-cfg-bar">
            {dirty && <span className="svc-tag warn">unsaved changes</span>}
            <button className="icon-btn tiny primary" disabled={!dirty} onClick={commit}>
              Save
            </button>
          </div>
        </div>
        <p className="hint">
          The compose project shown under the services. Which containers are listed, and in what order, is
          set from the gear on the Services page.
        </p>
        <div className="set-grid">
          <label className="field">
            <span>Repository</span>
            <Select
              value={compose.repo}
              onChange={(v) => {
                setCompose({ ...compose, repo: v });
                setDirty(true);
              }}
              options={repos.map((r) => ({ value: r.key, label: r.label || r.key, hint: r.path }))}
            />
          </label>
          <label className="field">
            <span>Compose folder inside it</span>
            <input
              className="search mono"
              placeholder="deploy"
              value={compose.subdir}
              onChange={(e) => {
                setCompose({ ...compose, subdir: e.target.value });
                setDirty(true);
              }}
            />
          </label>
        </div>
      </div>
    </>
  );
}

function RepoRow({
  repo,
  used,
  onEdit,
  onDelete,
}: {
  repo: ServiceRepo;
  used: number;
  onEdit: (patch: Partial<ServiceRepo>) => void;
  onDelete: () => void;
}) {
  const [arming, setArming] = useState(false);
  useEffect(() => {
    if (!arming) return;
    const t = setTimeout(() => setArming(false), 3000);
    return () => clearTimeout(t);
  }, [arming]);

  const blocked = used > 0;
  return (
    <div className="svc-repo-row">
      <input className="search" placeholder="Backend" value={repo.label} onChange={(e) => onEdit({ label: e.target.value })} />
      <input className="search mono" placeholder="backend" value={repo.key} onChange={(e) => onEdit({ key: e.target.value })} />
      <FolderField
        value={repo.path}
        placeholder="~/src/my-app"
        optional={false}
        onChange={(path) => onEdit({ path })}
        pickerTitle={`Pick the ${repo.label || repo.key} main checkout`}
        pickerHint="The checkout or worktree root that contains .git."
        wantRepo
      />
      <FolderField
        value={repo.worktreesDir}
        placeholder="~/src/worktrees"
        optional={false}
        onChange={(worktreesDir) => onEdit({ worktreesDir })}
        pickerTitle={`Pick the ${repo.label || repo.key} worktrees folder`}
        pickerHint={`Worktrees are subfolders named ${repo.key || "key"}-<branch>.`}
      />
      <button
        className={`icon-btn square ${arming ? "danger" : ""}`}
        disabled={blocked}
        title={
          blocked
            ? `Used by ${used} service${used > 1 ? "s" : ""} — point them elsewhere first`
            : arming
              ? "Click again to remove"
              : "Remove repository"
        }
        aria-label="Remove repository"
        onClick={() => (arming ? onDelete() : setArming(true))}
      >
        <TrashIcon />
      </button>
    </div>
  );
}

function ServicePanel({
  service,
  all,
  repos,
  onEdit,
  onRekey,
  onDelete,
}: {
  service: Service;
  all: Service[];
  repos: ServiceRepo[];
  onEdit: (patch: Partial<Service>) => void;
  onRekey: (key: string) => void;
  onDelete: () => void;
}) {
  const [arming, setArming] = useState(false);
  const composite = service.includes.length > 0;

  useEffect(() => {
    if (!arming) return;
    const t = setTimeout(() => setArming(false), 3000);
    return () => clearTimeout(t);
  }, [arming]);

  return (
    <>
      <div className="svc-cfg-head">
        <h3>{service.label || service.key}</h3>
        <button
          className={`icon-btn square ${arming ? "danger" : ""}`}
          title={arming ? "Click again to delete this service" : "Delete service"}
          aria-label="Delete service"
          onClick={() => (arming ? onDelete() : setArming(true))}
        >
          <TrashIcon />
        </button>
      </div>
      {arming && <p className="svc-cfg-warn">Click the bin again to delete {service.label || service.key}.</p>}

      <h3 className="set-h">Identity</h3>
      <div className="set-grid">
        <label className="field">
          <span>Name</span>
          <input className="search" value={service.label} onChange={(e) => onEdit({ label: e.target.value })} />
        </label>
        <label className="field">
          <span>Key</span>
          <input className="search mono" value={service.key} onChange={(e) => onRekey(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>Description</span>
        <input
          className="search"
          placeholder="One line, shown under the name in the table"
          value={service.description}
          onChange={(e) => onEdit({ description: e.target.value })}
        />
      </label>
      <label className="set-row">
        <input type="checkbox" checked={service.disabled} onChange={(e) => onEdit({ disabled: e.target.checked })} />
        <span className="set-text">
          <span className="set-label">Disabled</span>
          <span className="set-help">Kept here, but not startable and hidden from the table.</span>
        </span>
      </label>

      <h3 className="set-h">Location</h3>
      <div className="set-grid">
        <label className="field">
          <span>Repository</span>
          <Select
            value={service.repo}
            onChange={(v) => onEdit({ repo: v })}
            options={repos.map((r) => ({ value: r.key, label: r.label || r.key, hint: r.path }))}
          />
        </label>
        <label className="field">
          <span>Subdirectory</span>
          <input
            className="search mono"
            placeholder="apps/api"
            value={service.subdir}
            onChange={(e) => onEdit({ subdir: e.target.value })}
          />
        </label>
      </div>
      <label className="field">
        <span>Setup</span>
        <textarea
          className="search mono"
          rows={3}
          placeholder="source venv/bin/activate && …"
          value={service.setup}
          onChange={(e) => onEdit({ setup: e.target.value })}
        />
      </label>
      <p className="hint">Run before every pane's command, from the directory above.</p>

      <h3 className="set-h">Includes</h3>
      <p className="hint">A service that includes others has no panes of its own; it starts theirs together.</p>
      <div className="svc-chips">
        {all
          .filter((s) => s.key !== service.key)
          .map((s) => {
            const on = service.includes.includes(s.key);
            return (
              <button
                key={s.key}
                className={`svc-chip-toggle ${on ? "on" : ""}`}
                onClick={() =>
                  onEdit({
                    includes: on ? service.includes.filter((k) => k !== s.key) : [...service.includes, s.key],
                  })
                }
              >
                {s.label || s.key}
              </button>
            );
          })}
      </div>

      <h3 className="set-h">Panes</h3>
      {composite ? (
        <p className="hint">Panes come from the included services: {service.includes.join(", ")}.</p>
      ) : (
        <>
          {service.panes.map((p, i) => (
            <div key={i} className="svc-pane-row">
              <input
                className="search"
                placeholder="Title"
                value={p.title}
                onChange={(e) =>
                  onEdit({ panes: service.panes.map((x, j) => (i === j ? { ...x, title: e.target.value } : x)) })
                }
              />
              <input
                className="search mono"
                placeholder="python src/manage.py runserver"
                value={p.cmd}
                onChange={(e) =>
                  onEdit({ panes: service.panes.map((x, j) => (i === j ? { ...x, cmd: e.target.value } : x)) })
                }
              />
              <button
                className="icon-btn square"
                title="Remove pane"
                aria-label="Remove pane"
                onClick={() => onEdit({ panes: service.panes.filter((_, j) => j !== i) })}
              >
                <TrashIcon />
              </button>
            </div>
          ))}
          <div>
            <button
              className="icon-btn tiny"
              onClick={() => onEdit({ panes: [...service.panes, { title: "", cmd: "" }] })}
            >
              <PlusIcon />
              Add pane
            </button>
          </div>
        </>
      )}

      <h3 className="set-h">Auto-restart</h3>
      <p className="hint">Restart a pane when its last error matches, at most {service.restartMax || "∞"} times in ten minutes.</p>
      {service.restartOn.map((r, i) => (
        <div key={i} className="svc-pane-row">
          <Select
            value={r.pane ?? ""}
            onChange={(v) =>
              onEdit({ restartOn: service.restartOn.map((x, j) => (i === j ? { ...x, pane: v || null } : x)) })
            }
            options={[{ value: "", label: "Any pane" }, ...service.panes.map((p) => ({ value: p.title, label: p.title }))]}
          />
          <input
            className="search mono"
            placeholder="One or more subscribers failed"
            value={r.pattern}
            onChange={(e) =>
              onEdit({ restartOn: service.restartOn.map((x, j) => (i === j ? { ...x, pattern: e.target.value } : x)) })
            }
          />
          <button
            className="icon-btn square"
            title="Remove rule"
            aria-label="Remove rule"
            onClick={() => onEdit({ restartOn: service.restartOn.filter((_, j) => j !== i) })}
          >
            <TrashIcon />
          </button>
        </div>
      ))}
      <div>
        <button
          className="icon-btn tiny"
          onClick={() => onEdit({ restartOn: [...service.restartOn, { pane: null, pattern: "" }] })}
        >
          <PlusIcon />
          Add rule
        </button>
      </div>
      {service.restartOn.length > 0 && (
        <label className="field svc-cfg-max">
          <span>Max restarts per 10 minutes (0 = unlimited)</span>
          <input
            className="search"
            type="number"
            min={0}
            value={service.restartMax ?? DEFAULT_RESTART_MAX}
            onChange={(e) => onEdit({ restartMax: Math.max(0, Number(e.target.value) || 0) })}
          />
        </label>
      )}
    </>
  );
}
