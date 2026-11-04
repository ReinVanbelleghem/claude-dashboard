import { useEffect, useMemo, useState } from "react";
import { servicesApi, type Settings } from "../../api.ts";
import {
  sessionTone,
  type ServiceSession,
  type ServicesState,
  type ServiceView,
  type Tone,
} from "../../../shared/services.ts";
import { EyeIcon, EyeOffIcon, GearIcon, MoreIcon, PencilIcon, PlayIcon, PromptIcon, RefreshIcon, StopIcon } from "../Icons.tsx";
import { TerminalSheet, type TerminalTarget } from "./TerminalSheet.tsx";
import { StartMenu } from "./StartMenu.tsx";
import { RowMenu, type MenuItem } from "./RowMenu.tsx";
import { ContainersSection } from "./ContainersSection.tsx";

/**
 * The local dev stack as one table.
 *
 * A row is a service, not a session: the question being answered is "is my backend
 * up", and a service that is stopped still has to be visible to be started. The
 * running session, when there is one, is what fills the status, panes and uptime
 * columns in place of the definition's own.
 */
export function ServicesView({
  state,
  settings,
  onSettings,
  onOpenSettings,
}: {
  state: ServicesState | null;
  settings: Settings | null;
  onSettings: (s: Settings) => void;
  onOpenSettings: () => void;
}) {
  const [terminal, setTerminal] = useState<TerminalTarget | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [startFor, setStartFor] = useState<ServiceView | null>(null);

  // A second's tick is what makes the uptime column count up rather than sit still
  // between polls.
  const [, setNow] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const visible = useMemo(
    () => (state?.services ?? []).filter((s) => showHidden || !s.disabled),
    [state, showHidden],
  );
  const disabled = (state?.services ?? []).filter((s) => s.disabled).length;
  const running = (state?.sessions ?? []).length;

  async function act(key: string, fn: () => Promise<{ ok?: boolean; error?: string }>) {
    setBusy(key);
    setError(null);
    try {
      const r = await fn();
      if (r.error) setError(r.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!state) return <div className="empty">Connecting…</div>;

  return (
    <div className="services">
      <div className="services-head">
        <div>
          <h1>Local stack</h1>
        </div>
        <div className="services-tools">
          {disabled > 0 && (
            <button
              className="icon-btn"
              title={showHidden ? `Hide ${disabled} disabled` : `Show ${disabled} hidden`}
              aria-label={showHidden ? `Hide ${disabled} disabled` : `Show ${disabled} hidden`}
              onClick={() => setShowHidden((v) => !v)}
            >
              {showHidden ? <EyeIcon /> : <EyeOffIcon />}
              {disabled}
            </button>
          )}
          <button className="icon-btn square" onClick={onOpenSettings} title="Configure services" aria-label="Configure services">
            <GearIcon />
          </button>
        </div>
      </div>

      <span className="services-count">
        {running}/{state.services.length} running
        {disabled > 0 && !showHidden ? ` · ${disabled} hidden` : ""}
      </span>

      {error && <div className="chat-error">{error}</div>}
      {!state.tmuxUp && (
        <div className="empty">
          tmux is not running. Starting a service will start it.
        </div>
      )}

      <div className="services-card">
        <div className="tw">
          <table className="services-table">
            <thead>
              <tr>
                <th>Service</th>
                <th>Status</th>
                <th>Panes</th>
                <th>Ports</th>
                <th>Since</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={6} className="services-empty">
                    {(state.paths?.repos?.length ?? 0) === 0
                      ? "Nothing configured yet. Add a repository, then a service, under Settings → Services."
                      : "No services yet. Add one under Settings → Services."}
                  </td>
                </tr>
              )}
              {visible.map((s) => (
                <ServiceRow
                  key={s.key}
                  service={s}
                  busy={busy}
                  onStart={() => setStartFor(s)}
                  onStop={(session) => void act(s.key, () => servicesApi.stop(session))}
                  onRestartDead={(session) => void act(s.key, () => servicesApi.restartDead(session))}
                  onTerminal={(t) => setTerminal(t)}
                  onConfigure={onOpenSettings}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ContainersSection
        containers={state.containers ?? []}
        composeDir={state.composeDir ?? null}
        settings={settings}
        onSettings={onSettings}
        onTerminal={setTerminal}
      />

      {startFor && (
        <StartMenu
          service={startFor}
          onClose={() => setStartFor(null)}
          onStarted={(session) => {
            setStartFor(null);
            setTerminal({ session, paneId: null, title: startFor.label, checkout: "" });
          }}
          onOpenRunning={(session) => {
            setStartFor(null);
            setTerminal({ session, paneId: null, title: startFor.label, checkout: "" });
          }}
        />
      )}

      {terminal && (
        <TerminalSheet
          target={terminal}
          session={
            terminal.kind === "container"
              ? null
              : ((state.sessions ?? []).find((x) => x.name === terminal.session) ?? null)
          }
          onClose={() => setTerminal(null)}
          onSelectPane={(paneId) => terminal.kind !== "container" && setTerminal({ ...terminal, paneId })}
        />
      )}
    </div>
  );
}

const TONE_LABEL: Record<Tone, string> = {
  idle: "Stopped",
  info: "Starting",
  ok: "Running",
  warn: "Degraded",
  attention: "Attention",
  bad: "Down",
};

function Pill({ tone, label }: { tone: Tone; label?: string }) {
  return (
    <span className={`svc-pill tone-${tone}`}>
      <i className="svc-dot" />
      {label ?? TONE_LABEL[tone]}
    </span>
  );
}

/** "3m", "2h 10m", "4d 2h" — the same shape the uptime column uses everywhere. */
function since(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** The description line, with the subdir in mono unless the text already names it. */
function Description({ service }: { service: ServiceView }) {
  const text = service.description.replace(`(${service.subdir})`, "").trim();
  const showDir = !!service.subdir && !service.description.includes(service.subdir);
  const composite = service.includes.length > 0;
  if (!text && !showDir && !composite) return null;
  return (
    <div className="svc-desc">
      {text}
      {showDir && (
        <>
          {text ? " " : ""}
          <code>({service.subdir})</code>
        </>
      )}
      {composite && (
        <>
          {text || showDir ? " · " : ""}
          <code>{service.includes.join(" + ")}</code>
        </>
      )}
    </div>
  );
}

function ServiceRow({
  service,
  busy,
  onStart,
  onStop,
  onRestartDead,
  onTerminal,
  onConfigure,
}: {
  service: ServiceView;
  busy: string | null;
  onStart: () => void;
  onStop: (session: string) => void;
  onRestartDead: (session: string) => void;
  onTerminal: (t: TerminalTarget) => void;
  onConfigure: () => void;
}) {
  const [menuAt, setMenuAt] = useState<HTMLElement | null>(null);
  const session: ServiceSession | null = service.sessions[0] ?? null;
  const tone = session ? sessionTone(session) : "idle";
  const dead = session?.panes.filter((p) => !p.alive).length ?? 0;
  const working = busy === service.key;

  const attach = () =>
    session && onTerminal({ session: session.name, paneId: null, title: service.label, checkout: session.checkout });

  const items: MenuItem[] = [{ label: "Edit service", icon: <PencilIcon />, onClick: onConfigure }];

  return (
    <tr className={service.disabled ? "svc-off" : ""}>
      <td>
        <div className="svc-name">
          {service.label}
          {service.disabled && <span className="svc-tag">disabled</span>}
          {session && <span className="svc-chip">{session.checkout}</span>}
        </div>
        <Description service={service} />
      </td>
      <td>
        <Pill tone={tone} />
        {dead > 0 && <div className="svc-sub">{dead} of {session!.panes.length} crashed</div>}
      </td>
      <td>
        <div className="svc-panes">
          {(session?.panes ?? service.panes.map((p) => ({ title: p.title, id: p.title, alive: true }))).map(
            (p: { title: string; id: string; alive: boolean }) => (
              <button
                key={p.id}
                className={`svc-pane-chip ${session ? (p.alive ? "on" : "off") : ""}`}
                disabled={!session}
                title={session ? `Open ${p.title}` : "Not running"}
                onClick={() =>
                  session &&
                  onTerminal({ session: session.name, paneId: p.id, title: service.label, checkout: session.checkout })
                }
              >
                {p.title}
              </button>
            ),
          )}
          {service.panes.length === 0 && service.includes.length > 0 && (
            <span className="svc-sub">from {service.includes.join(" + ")}</span>
          )}
        </div>
      </td>
      <td className="mono">{service.ports.length ? service.ports.map((n) => `:${n}`).join(" ") : "–"}</td>
      <td className="mono">{session?.createdAt ? since(session.createdAt) : "–"}</td>
      <td className="right">
        <div className="svc-actions">
          {session ? (
            <>
              {dead > 0 && (
                <button
                  className="icon-btn"
                  disabled={working}
                  title={`Restart ${dead} crashed pane${dead > 1 ? "s" : ""}`}
                  aria-label="Restart crashed panes"
                  onClick={() => onRestartDead(session.name)}
                >
                  <RefreshIcon />
                </button>
              )}
              <button className="icon-btn" title="Attach" aria-label="Attach" onClick={attach}>
                <PromptIcon />
              </button>
              <button className="icon-btn" disabled={working} title="Stop" aria-label="Stop" onClick={() => onStop(session.name)}>
                <StopIcon />
              </button>
            </>
          ) : (
            <>
              <button
                className="icon-btn"
                disabled={!service.startable || working}
                title={service.startable ? "Start" : service.disabled ? "Disabled" : "No panes to start"}
                aria-label="Start"
                onClick={onStart}
              >
                <PlayIcon />
              </button>
              <button
                className="icon-btn"
                title="More"
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={menuAt !== null}
                onClick={(e) => setMenuAt(menuAt ? null : e.currentTarget)}
              >
                <MoreIcon />
              </button>
              {menuAt && <RowMenu items={items} anchor={menuAt} onClose={() => setMenuAt(null)} />}
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
