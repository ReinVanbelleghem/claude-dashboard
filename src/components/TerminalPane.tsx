import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { ptyUrl, terminalApi } from "../api.ts";
import { terminalIdOf, type WorkspaceTerminal } from "../../shared/terminals.ts";
import { TerminalIcon, TrashIcon } from "./Icons.tsx";
import { CONTROL_PREFIX, TERMINAL_FONT, TERMINAL_THEME } from "./services/TerminalSheet.tsx";

/** A live attach to one tmux session, sized to whatever box it is put in. */
export function TerminalPane({ session }: { session: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({ fontFamily: TERMINAL_FONT, fontSize: 13, cursorBlink: true, scrollback: 10_000, theme: TERMINAL_THEME });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    fit.fit();

    const socket = new WebSocket(ptyUrl(session, null, term.cols, term.rows));
    socket.binaryType = "arraybuffer";
    socket.onmessage = (e) => (typeof e.data === "string" ? term.write(e.data) : term.write(new Uint8Array(e.data as ArrayBuffer)));
    socket.onclose = (e) => term.write(`\r\n[disconnected${e.reason ? `: ${e.reason}` : ""}]\r\n`);
    const input = term.onData((d) => socket.readyState === WebSocket.OPEN && socket.send(d));
    const sendResize = () => {
      if (socket.readyState === WebSocket.OPEN) socket.send(`${CONTROL_PREFIX}${JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })}\n`);
    };
    const refit = () => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      fit.fit();
      sendResize();
    };
    socket.onopen = sendResize;
    const observer = new ResizeObserver(refit);
    observer.observe(host);
    const frame = requestAnimationFrame(refit);
    void document.fonts?.ready.then(refit).catch(() => {});
    term.focus();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      input.dispose();
      socket.close();
      term.dispose();
    };
  }, [session]);

  return <div className="term-host" ref={hostRef} />;
}

/** Looks a terminal up by the key sessions are opened with; null while loading, false once it is known to be gone. */
export function useTerminal(key: string): WorkspaceTerminal | null | false {
  const [found, setFound] = useState<WorkspaceTerminal | null | false>(null);
  useEffect(() => {
    let stale = false;
    setFound(null);
    terminalApi
      .list()
      .then((r) => !stale && setFound(r.terminals.find((t) => t.id === terminalIdOf(key)) ?? false))
      .catch(() => !stale && setFound(false));
    return () => {
      stale = true;
    };
  }, [key]);
  return found;
}

/** A terminal where a session would be: the header a drawer or tile expects, then the shell. */
export function TerminalPanel({
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
  const terminal = useTerminal(id);
  return (
    <>
      <div className="drawer-head term-head" onPointerDown={onHeadPointerDown}>
        {headStart}
        <h3>
          <TerminalIcon /> {terminal ? terminal.title : "Terminal"}
        </h3>
        <div className="drawer-actions">
          {terminal && (
            <button
              className="icon-btn tiny"
              title="End this terminal and whatever is running in it"
              onClick={() => {
                void terminalApi.close(terminal.id).catch(() => {});
                onClose();
              }}
            >
              <TrashIcon /> End
            </button>
          )}
        </div>
      </div>
      {terminal && <p className="term-sub">{terminal.folder.replace(/^\/Users\/[^/]+/, "~")}</p>}
      {terminal === false && <div className="empty">This terminal has ended.</div>}
      {terminal && <TerminalPane key={terminal.session} session={terminal.session} />}
    </>
  );
}

/** A terminal on a page of its own, filling the window the way a session's conversation does. */
export function TerminalPage({ id, onBack, onOpenWorkspace }: { id: string; onBack: () => void; onOpenWorkspace?: (workspaceId: number) => void }) {
  const terminal = useTerminal(id);
  return (
    <div className="page session-chat">
      <div className="page-head">
        <button className="icon-btn" onClick={onBack}>
          ← Back
        </button>
        <div>
          <h1>{terminal ? terminal.title : "Terminal"}</h1>
          <p className="page-sub">{terminal ? terminal.folder.replace(/^\/Users\/[^/]+/, "~") : ""}</p>
        </div>
        <span style={{ flex: 1 }} />
        {terminal && terminal.workspaceId !== null && onOpenWorkspace && (
          <button className="icon-btn" onClick={() => onOpenWorkspace(terminal.workspaceId!)}>
            Workspace
          </button>
        )}
        {terminal && (
          <button
            className="icon-btn"
            title="End this terminal and whatever is running in it"
            onClick={() => {
              void terminalApi.close(terminal.id).catch(() => {});
              onBack();
            }}
          >
            <TrashIcon /> End
          </button>
        )}
      </div>
      {terminal === false && <div className="empty">This terminal has ended.</div>}
      <div className="session-cols">
        <div className="session-main">{terminal && <div className="panel term-page"><TerminalPane key={terminal.session} session={terminal.session} /></div>}</div>
      </div>
    </div>
  );
}
