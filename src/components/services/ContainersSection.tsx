import { useEffect, useRef, useState } from "react";
import { servicesApi, settingsApi, type Settings } from "../../api.ts";
import { containerTone, type Container } from "../../../shared/services.ts";
import { EyeIcon, EyeOffIcon, GearIcon, GripIcon, LogsIcon, MoreIcon, PlayIcon, PromptIcon, RefreshIcon, StopIcon } from "../Icons.tsx";
import type { TerminalTarget } from "./TerminalSheet.tsx";
import { RowMenu, type MenuItem } from "./RowMenu.tsx";
import { useSortable } from "../../useSortable.ts";

/**
 * The docker compose containers under the apps. Unlike services, a hidden
 * container stays hidden while it runs: infra you never touch is noise either way.
 */
export function ContainersSection({
  containers,
  composeDir,
  settings,
  onSettings,
  onTerminal,
}: {
  containers: Container[];
  composeDir: string | null;
  settings: Settings | null;
  onSettings: (s: Settings) => void;
  onTerminal: (t: TerminalTarget) => void;
}) {
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [menuAt, setMenuAt] = useState<HTMLElement | null>(null);
  const [confirmStopAll, setConfirmStopAll] = useState(false);

  useEffect(() => {
    if (!confirmStopAll) return;
    const t = setTimeout(() => setConfirmStopAll(false), 4000);
    return () => clearTimeout(t);
  }, [confirmStopAll]);

  const configured = !!settings?.services.compose.repo;
  const rows = showHidden ? containers : containers.filter((c) => !c.hidden);
  const running = containers.filter((c) => c.running).length;
  const hiddenCount = containers.filter((c) => c.hidden).length;

  async function act(key: string, verb: "up" | "stop" | "restart", services: string[]) {
    if (!services.length) return;
    setBusy(key);
    setError(null);
    try {
      const r = await servicesApi.container(verb, services);
      if (!r.ok) setError(r.error ?? `docker compose ${verb} failed`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const listedRunning = rows.filter((c) => c.running).map((c) => c.service);
  const listedStopped = rows.filter((c) => !c.running).map((c) => c.service);
  const bulk: MenuItem[] = [
    {
      label: `Start all (${listedStopped.length} down)`,
      icon: <PlayIcon />,
      disabled: busy !== null || listedStopped.length === 0,
      onClick: () => void act("all", "up", listedStopped),
    },
    {
      label: `Restart all (${listedRunning.length} running)`,
      icon: <RefreshIcon />,
      disabled: busy !== null || listedRunning.length === 0,
      onClick: () => void act("all", "restart", listedRunning),
    },
    {
      label: confirmStopAll ? `Really stop ${listedRunning.length}?` : `Stop all (${listedRunning.length} running)`,
      icon: <StopIcon />,
      danger: true,
      disabled: busy !== null || listedRunning.length === 0,
      onClick: () => {
        if (confirmStopAll) {
          setConfirmStopAll(false);
          void act("all", "stop", listedRunning);
        } else setConfirmStopAll(true);
      },
    },
  ];

  return (
    <section className="services-section">
      <div className="services-meta">
        <span className="services-count">
          docker compose · {running}/{containers.length} running
          {hiddenCount > 0 && !showHidden ? ` · ${hiddenCount} hidden` : ""}
        </span>
        <span style={{ flex: 1 }} />
        <div className="services-tools">
          {hiddenCount > 0 && (
            <button
              className="icon-btn"
              title={showHidden ? "Hide hidden containers" : "Show hidden containers"}
              aria-pressed={showHidden}
              onClick={() => setShowHidden((v) => !v)}
            >
              {showHidden ? <EyeIcon /> : <EyeOffIcon />}
              {hiddenCount}
            </button>
          )}
          <button
            className="icon-btn square"
            title="Order and visibility"
            aria-label="Container settings"
            disabled={!settings}
            onClick={() => setConfiguring(true)}
          >
            <GearIcon />
          </button>
          <button
            className="icon-btn square"
            title="Actions for all listed containers"
            aria-label="Actions for all listed containers"
            aria-haspopup="menu"
            aria-expanded={menuAt !== null}
            onClick={(e) => setMenuAt(menuAt ? null : e.currentTarget)}
          >
            <MoreIcon />
          </button>
          {menuAt && (
            <RowMenu
              items={bulk}
              anchor={menuAt}
              heading={`All ${rows.length} listed containers`}
              keepOpenFor={confirmStopAll ? undefined : bulk[2].label}
              onClose={() => setMenuAt(null)}
            />
          )}
        </div>
      </div>

      {error && <div className="chat-error">{error}</div>}

      <div className="services-card">
        <div className="tw">
          <table className="services-table">
            <thead>
              <tr>
                <th>Container</th>
                <th>State</th>
                <th>Uptime</th>
                <th>Ports</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {!composeDir && (
                <tr>
                  <td colSpan={5} className="services-empty">
                    {configured
                      ? "Compose folder not found. Check the repository path and the compose subfolder under Settings → Services."
                      : "No compose project yet. Pick a repository and its compose folder under Settings → Services."}
                  </td>
                </tr>
              )}
              {composeDir && rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="services-empty">
                    No containers to show.
                  </td>
                </tr>
              )}
              {rows.map((c) => (
                <ContainerRow
                  key={c.service}
                  container={c}
                  busy={busy === c.service || busy === "all"}
                  onAct={(verb) => void act(c.service, verb, [c.service])}
                  onLogs={() => onTerminal({ kind: "container", service: c.service, mode: "logs", title: c.service })}
                  onShell={() => onTerminal({ kind: "container", service: c.service, mode: "shell", title: c.service })}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {configuring && settings && (
        <ContainerSettings
          containers={containers}
          settings={settings}
          onSettings={onSettings}
          onClose={() => setConfiguring(false)}
        />
      )}
    </section>
  );
}

function ContainerRow({
  container,
  busy,
  onAct,
  onLogs,
  onShell,
}: {
  container: Container;
  busy: boolean;
  onAct: (verb: "up" | "stop" | "restart") => void;
  onLogs: () => void;
  onShell: () => void;
}) {
  return (
    <tr className={container.hidden ? "svc-off" : ""}>
      <td>
        <div className="svc-name mono">{container.service}</div>
        <div className="svc-desc">{container.image || "not created yet"}</div>
      </td>
      <td>
        <span className={`svc-pill tone-${containerTone(container)}`}>
          <i className="svc-dot" />
          {container.state || "not created"}
          {container.health ? ` · ${container.health}` : ""}
        </span>
      </td>
      <td className="svc-muted">{container.status || "–"}</td>
      <td className="mono">{container.ports.length ? container.ports.map((n) => `:${n}`).join(" ") : "–"}</td>
      <td className="right">
        <div className="svc-actions">
          <button className="icon-btn" title="Logs" aria-label="Logs" disabled={container.state === ""} onClick={onLogs}>
            <LogsIcon />
          </button>
          {container.running && (
            <button className="icon-btn" title="Shell" aria-label="Shell" onClick={onShell}>
              <PromptIcon />
            </button>
          )}
          {container.running && (
            <button className="icon-btn" title="Restart" aria-label="Restart" disabled={busy} onClick={() => onAct("restart")}>
              <RefreshIcon />
            </button>
          )}
          {container.running ? (
            <button className="icon-btn" title="Stop" aria-label="Stop" disabled={busy} onClick={() => onAct("stop")}>
              <StopIcon />
            </button>
          ) : (
            <button className="icon-btn" title="Start" aria-label="Start" disabled={busy} onClick={() => onAct("up")}>
              <PlayIcon />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

type Row = { service: string; hidden: boolean; image: string };

/**
 * Order and visibility, saved next to the service definitions. The containers
 * themselves come from docker; where the compose project lives is set under
 * Settings → Services.
 */
function ContainerSettings({
  containers,
  onSettings,
  onClose,
}: {
  containers: Container[];
  settings: Settings;
  onSettings: (s: Settings) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => containers.map(({ service, hidden, image }) => ({ service, hidden, image })));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commit = (next: Row[]) => {
    setRows(next);
    setDirty(true);
  };
  const listRef = useRef<HTMLDivElement>(null);
  const drag = useSortable({
    count: rows.length,
    listRef,
    itemSelector: ".svc-order-row",
    onMove: (from, to) => {
      const next = rows.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      commit(next);
    },
  });

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r = await settingsApi.save({
        services: {
          compose: {
            order: rows.map((r) => r.service),
            hidden: rows.filter((r) => r.hidden).map((r) => r.service),
          },
        },
      });
      onSettings(r.settings);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="svc-scrim" onClick={onClose} role="dialog" aria-modal="true" aria-label="Container settings">
      <div className="svc-modal svc-modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="svc-modal-title">
          <div>
            <h3>Containers</h3>
            <p className="hint">
              Drag the handle to set the order on the stack page. Hidden containers only show with the eye
              toggle on.
            </p>
          </div>
          <button className="icon-btn square svc-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {error && <div className="chat-error">{error}</div>}

        <div className="svc-order" ref={listRef}>
          {rows.map((row, i) => (
            <div
              key={row.service}
              className={`svc-order-row ${row.hidden ? "off" : ""} ${drag.active === i ? "dragging" : ""}`}
              style={drag.itemStyle(i)}
            >
              <button
                type="button"
                className="sort-grip"
                data-sort-handle
                aria-label={`Drag to reorder ${row.service}. Use the arrow keys to move it.`}
                {...drag.handleProps(i)}
              >
                <GripIcon />
              </button>
              <div className="svc-order-text">
                <div className="mono">{row.service}</div>
                <div className="svc-desc">{row.image || "not created yet"}</div>
              </div>
              <label className="check svc-order-visible">
                <input
                  type="checkbox"
                  checked={!row.hidden}
                  onChange={(e) => commit(rows.map((r) => (r.service === row.service ? { ...r, hidden: !e.target.checked } : r)))}
                  aria-label={`Show ${row.service}`}
                />
                <span>visible</span>
              </label>
            </div>
          ))}
        </div>

        <div className="svc-modal-foot">
          <button className="icon-btn tiny ghost" onClick={onClose}>
            Cancel
          </button>
          {dirty && (
            <button className="icon-btn tiny primary" disabled={saving} onClick={() => void save()}>
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
