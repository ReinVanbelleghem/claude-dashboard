import { useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { gitApi, servicesApi, type WorkspaceStack } from "../../api.ts";
import { sessionTone, type ServiceSession, type ServicesState, type ServiceView, type Tone } from "../../../shared/services.ts";
import { GearIcon, GitIcon, PlayIcon, RefreshIcon, ServiceIcon, StarIcon, StopIcon } from "../Icons.tsx";
import { Select } from "../Select.tsx";
import { TerminalSheet, type TerminalTarget } from "./TerminalSheet.tsx";
import { ServicesContext } from "./ServicePane.tsx";
import { serviceKey } from "../../../shared/services.ts";

const SET_KEY = "service-set:";

const readSet = (projectKey: string): string[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(SET_KEY + projectKey) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const TONE_LABEL: Record<Tone, string> = {
  idle: "Stopped",
  info: "Starting",
  ok: "Running",
  warn: "Degraded",
  attention: "Attention",
  bad: "Down",
};

/** A place the services can run from: this workspace's checkout, or another layer of its stack. */
type Target = { path: string | null; branch: string; label: string; current: boolean; name?: string | null };

type Row = {
  service: ServiceView;
  /** The copy running in the chosen checkout. */
  here: ServiceSession | null;
  /** Copies running in other checkouts, which hold the ports this one would want. */
  elsewhere: ServiceSession[];
  missing: string[];
};

/**
 * The services of one workspace: what its repository can run, started in this
 * workspace's checkout without asking which one. In a stack the layer to run
 * from is a choice, and moving the services to another layer stops them where
 * they were, since two copies would fight over the same ports.
 */
export function WorkspaceServices({
  state,
  folder,
  projectKey,
  stack,
  onOpenSettings,
  onStackChanged,
  title = "Services",
}: {
  title?: ReactNode;
  state: ServicesState | null;
  folder: string;
  projectKey: string;
  stack: WorkspaceStack | null;
  onOpenSettings?: () => void;
  onStackChanged?: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [terminal, setTerminal] = useState<TerminalTarget | null>(null);
  const { open } = useContext(ServicesContext);
  const [set, setSet] = useState<string[]>(() => readSet(projectKey));
  useEffect(() => setSet(readSet(projectKey)), [projectKey]);

  const targets: Target[] = useMemo(() => {
    const layers = stack?.layers ?? [];
    if (layers.length < 2) return [{ path: folder, branch: layers[0]?.branch ?? "", label: "This checkout", current: true }];
    return [...layers].reverse().map((l) => ({
      path: l.current ? folder : l.checkout,
      branch: l.branch,
      label: l.pr ? `#${l.pr.number}` : l.branch,
      name: l.pr?.title ?? null,
      current: l.current,
    }));
  }, [stack, folder]);
  const target = targets.find((t) => t.branch === picked) ?? targets.find((t) => t.current) ?? targets[0]!;
  const path = target.path;

  const reachable = useMemo(() => new Set(targets.flatMap((t) => (t.path ? [t.path] : []))), [targets]);
  const rows: Row[] = useMemo(() => {
    const services = (state?.services ?? []).filter((s) => !s.disabled && s.checkouts.some((c) => reachable.has(c.path)));
    return services.map((service) => {
      const view = service.checkouts.find((c) => c.path === path) ?? null;
      const here = view ? (service.sessions.find((x) => x.name === view.session) ?? null) : null;
      return {
        service,
        here,
        elsewhere: service.sessions.filter((x) => x.name !== view?.session),
        missing: view ? view.missing : ["a checkout for this layer"],
      };
    });
  }, [state, reachable, path]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function start(row: Row) {
    if (!path || row.here) return;
    for (const other of row.elsewhere) await servicesApi.stop(other.name);
    const r = await servicesApi.start(row.service.key, path);
    if (!r.ok) throw new Error([`${row.service.label}: ${r.error ?? "could not start"}`, ...(r.missing ?? [])].join(" · "));
  }

  const toggle = (key: string) => {
    const next = set.includes(key) ? set.filter((k) => k !== key) : [...set, key];
    setSet(next);
    try {
      localStorage.setItem(SET_KEY + projectKey, JSON.stringify(next));
    } catch {
      return;
    }
  };

  const inSet = rows.filter((r) => set.includes(r.service.key));
  const toStart = inSet.filter((r) => !r.here && r.missing.length === 0);
  const runningHere = rows.filter((r) => r.here);

  const makeCheckout = () =>
    act("checkout", async () => {
      const r = await gitApi.worktreeAdd(folder, target.branch);
      if (!r.ok) throw new Error(r.error ?? "could not create the worktree");
      onStackChanged?.();
    });

  return (
    <section className="panel wsvc">
      <div className="panel-head">
        <h2>{title}</h2>
        <span className="wsp-panel-actions">
          {runningHere.length > 0 && (
            <button
              className="icon-btn"
              disabled={busy !== null}
              onClick={() => void act("stop-all", async () => void (await Promise.all(runningHere.map((r) => servicesApi.stop(r.here!.name)))))}
            >
              <StopIcon /> Stop all
            </button>
          )}
          <button
            className="icon-btn primary"
            disabled={busy !== null || toStart.length === 0}
            title={
              inSet.length === 0
                ? "Star the services this project needs, then start them in one go"
                : toStart.length === 0
                  ? "Every starred service is already running here"
                  : `Start ${toStart.map((r) => r.service.label).join(", ")}`
            }
            onClick={() =>
              void act("start-set", async () => {
                for (const r of toStart) await start(r);
              })
            }
          >
            <PlayIcon /> Start starred{toStart.length > 0 ? ` (${toStart.length})` : ""}
          </button>
          {onOpenSettings && (
            <button className="icon-btn square" onClick={onOpenSettings} title="Configure services" aria-label="Configure services">
              <GearIcon />
            </button>
          )}
        </span>
      </div>

      {targets.length > 1 && (
        <div className="wsvc-layers">
          <span className="wsvc-layers-label">Run from</span>
          <div className="wsvc-layers-select">
            <Select
              ariaLabel="Run from"
              value={target.branch}
              title={target.path ? `${target.branch} · ${target.path}` : `${target.branch} has no checkout yet`}
              options={targets.map((t) => ({
                value: t.branch,
                label: t.name ? `${t.label} ${t.name}` : t.label,
                hint: t.current ? "here" : t.path ? undefined : "no checkout yet",
                icon: <GitIcon />,
              }))}
              onChange={setPicked}
            />
          </div>
        </div>
      )}

      {error && <div className="chat-error">{error}</div>}

      {!path && (
        <p className="wsvc-note">
          <code>{target.branch}</code> is not checked out anywhere, so nothing can run from it yet.{" "}
          <button className="link-btn inline" disabled={busy !== null} onClick={makeCheckout}>
            Create a worktree for it
          </button>
        </p>
      )}

      {!state && <p className="wsp-none">Reading the services…</p>}
      {state && rows.length === 0 && (
        <p className="wsp-none">No service is set up for this repository. Add its path and a service under Settings → Services.</p>
      )}

      {rows.map((row) => {
        const { service, here, elsewhere } = row;
        const tone: Tone = here ? sessionTone(here) : "idle";
        const dead = here?.panes.filter((p) => !p.alive).length ?? 0;
        const working = busy === service.key;
        const blocked = !path || row.missing.length > 0;
        return (
          <div key={service.key} className="wsvc-row">
            <button
              className={`icon-btn ghost square wt-pin ${set.includes(service.key) ? "on" : ""}`}
              title={set.includes(service.key) ? "Starred: starts with the others" : "Star it to start it with the others"}
              aria-pressed={set.includes(service.key)}
              aria-label={`Star ${service.label}`}
              onClick={() => toggle(service.key)}
            >
              <StarIcon filled={set.includes(service.key)} />
            </button>
            <span className="wsvc-name">
              <strong>{service.label}</strong>
              <small>
                {service.ports.length > 0 && <span className="mono">{service.ports.map((n) => `:${n}`).join(" ")}</span>}
                {!here && elsewhere.length > 0 && <span>running on {elsewhere.map((x) => x.checkout).join(", ")}</span>}
                {!here && elsewhere.length === 0 && path && row.missing.length > 0 && <span>missing {row.missing.join(", ")}</span>}
                {dead > 0 && (
                  <span className="wsvc-bad">
                    {dead} of {here!.panes.length} crashed
                  </span>
                )}
              </small>
            </span>
            <span className={`svc-pill tone-${tone}`}>
              <i className="svc-dot" />
              {TONE_LABEL[tone]}
            </span>
            <span className="svc-actions">
              {here ? (
                <>
                  {dead > 0 && (
                    <button
                      className="icon-btn"
                      disabled={working}
                      title="Restart the crashed panes"
                      aria-label="Restart crashed panes"
                      onClick={() => void act(service.key, () => servicesApi.restartDead(here.name))}
                    >
                      <RefreshIcon />
                    </button>
                  )}
                  <button
                    className="icon-btn"
                    title="Open its panes. ⌘-click and ⌥-click open it the way Settings says."
                    aria-label={`Open ${service.label}`}
                    onClick={(e) =>
                      open
                        ? open(serviceKey(here.name), { full: e.metaKey || e.ctrlKey, option: e.altKey })
                        : setTerminal({ session: here.name, paneId: null, title: service.label, checkout: here.checkout })
                    }
                  >
                    <ServiceIcon />
                  </button>
                  <button
                    className="icon-btn"
                    disabled={working}
                    title="Stop"
                    aria-label={`Stop ${service.label}`}
                    onClick={() => void act(service.key, () => servicesApi.stop(here.name))}
                  >
                    <StopIcon />
                  </button>
                </>
              ) : (
                <button
                  className="icon-btn wsvc-start"
                  disabled={working || blocked}
                  title={
                    blocked
                      ? `Cannot start: missing ${row.missing.join(", ")}`
                      : elsewhere.length > 0
                        ? `Stop it on ${elsewhere.map((x) => x.checkout).join(", ")} and start it here`
                        : "Start here"
                  }
                  aria-label={`Start ${service.label}`}
                  onClick={() => void act(service.key, () => start(row))}
                >
                  <PlayIcon />
                  {elsewhere.length > 0 ? "Move here" : "Start"}
                </button>
              )}
            </span>
          </div>
        );
      })}

      {terminal && (
        <TerminalSheet
          target={terminal}
          session={terminal.kind === "container" ? null : ((state?.sessions ?? []).find((x) => x.name === terminal.session) ?? null)}
          onClose={() => setTerminal(null)}
          onSelectPane={(paneId) => terminal.kind !== "container" && setTerminal({ ...terminal, paneId })}
        />
      )}
    </section>
  );
}
