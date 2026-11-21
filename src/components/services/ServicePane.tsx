import { createContext, useContext, useState, type PointerEvent, type ReactNode } from "react";
import { servicesApi } from "../../api.ts";
import { paneTone, serviceSessionOf, sessionPath, sessionTone, type ServiceSession, type ServicesState } from "../../../shared/services.ts";
import { RefreshIcon, ServiceIcon, StopIcon } from "../Icons.tsx";
import { TerminalPane } from "../TerminalPane.tsx";

export type OpenService = (key: string, opts?: { full?: boolean; option?: boolean }) => void;

/**
 * What is running, and how to open one of them. Provided once at the top, so a
 * service's row opens the same way wherever it is listed: by the click settings.
 */
export const ServicesContext = createContext<{ state: ServicesState | null; open: OpenService | null }>({ state: null, open: null });

const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

function useService(key: string) {
  const { state } = useContext(ServicesContext);
  const name = serviceSessionOf(key);
  const session: ServiceSession | null | false = state ? (state.sessions.find((s) => s.name === name) ?? false) : null;
  return { name, session, path: sessionPath(state, name) };
}

function Actions({ session, onStopped }: { session: ServiceSession; onStopped: () => void }) {
  const dead = session.panes.filter((p) => !p.alive).length;
  return (
    <>
      {dead > 0 && (
        <button className="icon-btn tiny" title={`Restart ${dead} crashed pane${dead > 1 ? "s" : ""}`} onClick={() => void servicesApi.restartDead(session.name).catch(() => {})}>
          <RefreshIcon /> Restart crashed
        </button>
      )}
      <button
        className="icon-btn tiny"
        title="Stop this service"
        onClick={() => {
          void servicesApi.stop(session.name).catch(() => {});
          onStopped();
        }}
      >
        <StopIcon /> Stop
      </button>
    </>
  );
}

function Panes({ session, paneId, onPick }: { session: ServiceSession; paneId: string | null; onPick: (id: string | null) => void }) {
  if (session.panes.length < 2) return null;
  return (
    <div className="svc-tabs svc-pane-tabs">
      <button className={`svc-tab ${paneId === null ? "on" : ""}`} onClick={() => onPick(null)}>
        All panes
      </button>
      {session.panes.map((p) => (
        <button key={p.id} className={`svc-tab ${paneId === p.id ? "on" : ""}`} onClick={() => onPick(p.id)}>
          <i className={`svc-dot tone-${paneTone(p)}`} />
          {p.title}
        </button>
      ))}
    </div>
  );
}

const sub = (session: ServiceSession, path: string | null) => [session.checkout, path ? home(path) : null].filter(Boolean).join(" · ");

/** A running service where a session would be: the header a drawer or tile expects, then its panes. */
export function ServicePanel({
  id,
  onClose,
  onHeadPointerDown,
  headStart,
}: {
  id: string;
  onClose: () => void;
  onHeadPointerDown?: (e: PointerEvent) => void;
  headStart?: ReactNode;
}) {
  const { session, path } = useService(id);
  const [paneId, setPaneId] = useState<string | null>(null);
  const shown = session && session.panes.some((p) => p.id === paneId) ? paneId : null;
  return (
    <>
      <div className="drawer-head term-head kind-service" onPointerDown={onHeadPointerDown}>
        {headStart}
        <h3>
          <ServiceIcon /> {session ? session.serviceLabel : "Service"}
          {session && <i className={`svc-dot tone-${sessionTone(session)}`} />}
        </h3>
        <div className="drawer-actions">{session && <Actions session={session} onStopped={onClose} />}</div>
      </div>
      {session && <p className="term-sub">{sub(session, path)}</p>}
      {session === false && <div className="empty">This service is not running.</div>}
      {session && <Panes session={session} paneId={shown} onPick={setPaneId} />}
      {session && <TerminalPane key={`${session.name}:${shown ?? ""}`} session={session.name} paneId={shown} />}
    </>
  );
}

/** A running service on a page of its own. */
export function ServicePage({ id, onBack }: { id: string; onBack: () => void }) {
  const { session, path } = useService(id);
  const [paneId, setPaneId] = useState<string | null>(null);
  const shown = session && session.panes.some((p) => p.id === paneId) ? paneId : null;
  return (
    <div className="page session-chat">
      <div className="page-head">
        <button className="icon-btn" onClick={onBack}>
          ← Back
        </button>
        <div>
          <h1>{session ? session.serviceLabel : "Service"}</h1>
          <p className="page-sub">{session ? sub(session, path) : ""}</p>
        </div>
        <span style={{ flex: 1 }} />
        {session && <Actions session={session} onStopped={onBack} />}
      </div>
      {session === false && <div className="empty">This service is not running.</div>}
      {session && <Panes session={session} paneId={shown} onPick={setPaneId} />}
      <div className="session-cols">
        <div className="session-main">
          {session && (
            <div className="panel term-page">
              <TerminalPane key={`${session.name}:${shown ?? ""}`} session={session.name} paneId={shown} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
