import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { containerPtyUrl, ptyUrl, servicesApi } from "../../api.ts";
import { paneTone, type SearchAction, type ServiceSession } from "../../../shared/services.ts";
import { SearchIcon } from "../Icons.tsx";

export type TerminalTarget =
  | {
      kind?: "tmux";
      session: string;
      /** A single pane, zoomed in its own view, or null for the whole window. */
      paneId: string | null;
      title: string;
      checkout: string;
    }
  | { kind: "container"; service: string; mode: "logs" | "shell"; title: string };

const isTmux = (t: TerminalTarget): t is Extract<TerminalTarget, { session: string }> => t.kind !== "container";

const CONTROL_PREFIX = "\u0000";
const FONT = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';

const THEME = {
  background: "#0b0f14",
  foreground: "#d6dde6",
  cursor: "#7dd3fc",
  cursorAccent: "#0b0f14",
  selectionBackground: "#334155",
  black: "#0b0f14",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#cbd5e1",
  brightBlack: "#64748b",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#f8fafc",
};

const MIN_WIDTH = 480;

/**
 * A real tmux attach in a resizable right-hand sheet.
 *
 * Search goes through tmux's copy mode rather than xterm's buffer: under an attach
 * xterm only ever holds the visible screen, and tmux owns the scrollback.
 */
export function TerminalSheet({
  target,
  session,
  onClose,
  onSelectPane,
}: {
  target: TerminalTarget;
  session: ServiceSession | null;
  onClose: () => void;
  onSelectPane: (paneId: string | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [width, setWidth] = useState(() => Math.min(1100, Math.max(MIN_WIDTH, window.innerWidth * 0.62)));
  const tmuxTarget = isTmux(target) ? target : null;
  const containerTarget = isTmux(target) ? null : target;
  const searchTarget = tmuxTarget ? (tmuxTarget.paneId ?? tmuxTarget.session) : "";
  const socketUrl = (cols: number, rows: number) =>
    tmuxTarget
      ? ptyUrl(tmuxTarget.session, tmuxTarget.paneId, cols, rows)
      : containerPtyUrl(containerTarget!.service, containerTarget!.mode, cols, rows);
  const socketKey = tmuxTarget
    ? `tmux:${tmuxTarget.session}:${tmuxTarget.paneId ?? ""}`
    : `container:${containerTarget!.service}:${containerTarget!.mode}`;

  const runSearch = useCallback(
    async (action: SearchAction, text: string) => {
      try {
        const r = await servicesApi.search(searchTarget, action, text);
        if (action === "cancel") return;
        setNote(!r.found ? "no match in this pane's history" : r.matches > 1 ? `${r.matches} matches` : "1 match");
      } catch (e) {
        setNote(e instanceof Error ? e.message : String(e));
      }
    },
    [searchTarget],
  );

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setNote(null);
    void runSearch("cancel", "");
    termRef.current?.focus();
  }, [runSearch]);

  // Escape closes the search first and the sheet second, so one key does not do
  // both at once and lose the terminal out from under a search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tmuxTarget && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        setNote(null);
        requestAnimationFrame(() => searchRef.current?.select());
        return;
      }
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (searchOpen) closeSearch();
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [searchOpen, closeSearch, onClose, tmuxTarget]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({ fontFamily: FONT, fontSize: 13, cursorBlink: true, scrollback: 10_000, theme: THEME });
    termRef.current = term;
    // Cmd-F belongs to tmux search, so xterm must not swallow it.
    term.attachCustomKeyEventHandler((e) => !((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f"));
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    fit.fit();

    const socket = new WebSocket(socketUrl(term.cols, term.rows));
    socket.binaryType = "arraybuffer";
    socket.onmessage = (e) =>
      typeof e.data === "string" ? term.write(e.data) : term.write(new Uint8Array(e.data as ArrayBuffer));
    socket.onclose = (e) => term.write(`\r\n[disconnected${e.reason ? `: ${e.reason}` : ""}]\r\n`);

    const input = term.onData((d) => socket.readyState === WebSocket.OPEN && socket.send(d));
    const sendResize = () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(`${CONTROL_PREFIX}${JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })}\n`);
      }
    };
    const refit = () => {
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
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socketKey]);

  // Dragging the left edge: the sheet is a working surface, not a dialog, so it
  // gets to be as wide as the output needs.
  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    const move = (ev: MouseEvent) =>
      setWidth(Math.min(window.innerWidth - 80, Math.max(MIN_WIDTH, window.innerWidth - ev.clientX)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  return (
    <>
      <div className="svc-sheet-scrim" onMouseDown={onClose} aria-hidden="true" />
      <div className="svc-sheet" style={{ width }} role="dialog" aria-label={`${target.title} terminal`}>
        <div className="svc-sheet-grip" onMouseDown={startDrag} title="Drag to resize" />
        <div className="svc-sheet-head">
          <div className="svc-sheet-title">
            <strong className={tmuxTarget ? "" : "mono"}>{target.title}</strong>
            {tmuxTarget ? (
              <>
                {tmuxTarget.checkout && <span className="mono hint">{tmuxTarget.checkout}</span>}
                <span className="mono hint">· {tmuxTarget.session}</span>
              </>
            ) : (
              <span className="hint">{containerTarget?.mode === "logs" ? "docker compose logs" : "docker compose exec"}</span>
            )}
          </div>
          <span style={{ flex: 1 }} />
          {tmuxTarget && (
            <button className="icon-btn tiny" onClick={() => setSearchOpen(true)} title="Search history (⌘F)">
              <SearchIcon />
            </button>
          )}
          <button className="icon-btn tiny" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="svc-sheet-hint">
          {tmuxTarget
            ? "Real tmux attach. Scroll with the wheel, Option-drag to select text, ⌘F searches the history. Ctrl-b d detaches without stopping anything. Drag the left edge to resize."
            : containerTarget?.mode === "logs"
              ? "Last 300 lines, then live. Closing the panel stops following; the container keeps running. Drag the left edge to resize."
              : "bash when the image has it, sh otherwise. Exit the shell or close the panel to end it. Drag the left edge to resize."}
        </p>

        {tmuxTarget && session && session.panes.length > 1 && (
          <div className="svc-tabs">
            <button className={`svc-tab ${tmuxTarget.paneId === null ? "on" : ""}`} onClick={() => onSelectPane(null)}>
              All panes
            </button>
            {session.panes.map((p) => (
              <button
                key={p.id}
                className={`svc-tab ${tmuxTarget.paneId === p.id ? "on" : ""}`}
                onClick={() => onSelectPane(p.id)}
              >
                <i className={`svc-dot tone-${paneTone(p)}`} />
                {p.title}
              </button>
            ))}
          </div>
        )}

        {searchOpen && (
          <form
            className="svc-search"
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch(query ? "find" : "next", query);
            }}
          >
            <SearchIcon />
            <input
              ref={searchRef}
              className="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.shiftKey) {
                  e.preventDefault();
                  void runSearch("previous", query);
                }
              }}
              placeholder="Search this pane's history"
            />
            {note && <span className="hint">{note}</span>}
            <span className="hint" style={{ marginLeft: "auto" }}>
              Enter older · Shift-Enter newer · Esc exits
            </span>
            <button type="button" className="icon-btn tiny" onClick={closeSearch}>
              ×
            </button>
          </form>
        )}

        <div ref={hostRef} className="svc-term" />
      </div>
    </>
  );
}
