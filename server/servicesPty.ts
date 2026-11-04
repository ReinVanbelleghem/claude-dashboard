import { join } from "node:path";
import type { FileSink, ServerWebSocket, Subprocess } from "bun";
import { tmux } from "./services.ts";

/**
 * A browser terminal attached to a real tmux session.
 *
 * Each socket attaches through its own grouped view session (dashview-*) rather than
 * the session itself. Grouped sessions share the windows but keep their own size,
 * so two open tabs do not squeeze each other down to the smaller one — and detaching
 * or closing a tab never disturbs what is actually running.
 */
const VIEW_PREFIX = "dashview";
const WINDOW = "dev";
const BROKER = join(import.meta.dir, "ptyBroker.py");
const PYTHON = process.env.DASHBOARD_PYTHON ?? "python3";

let counter = 0;

export type PtyData =
  | { kind: "tmux"; session: string; paneId: string | null; cols: number; rows: number }
  | { kind: "exec"; argv: string[]; cwd: string; cols: number; rows: number };

type Live = {
  /** The grouped tmux view, or null for a plain command. */
  view: string | null;
  session: string | null;
  proc: Subprocess;
  stdin: FileSink;
  zoomTarget: string | null;
  stopZoom: boolean;
};

const ENV = {
  ...process.env,
  TERM: "xterm-256color",
  PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`,
};

function spawnBroker(argv: string[], cols: number, rows: number, cwd?: string): Subprocess<"pipe", "pipe", "pipe"> {
  return Bun.spawn([PYTHON, BROKER, String(cols), String(rows), ...argv], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: ENV,
  });
}

function pump(socket: ServerWebSocket<PtyData>, proc: Subprocess<"pipe", "pipe", "pipe">): void {
  // Read loop rather than for-await: the socket's own backpressure is what paces
  // this, and the broker blocks on its write when we stop reading.
  void (async () => {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || socket.readyState !== WebSocket.OPEN) break;
        socket.send(value);
      }
    } catch {
      // Broker exited mid-read; fall through to the close below.
    }
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, "exited");
  })();
}

const live = new WeakMap<ServerWebSocket<PtyData>, Live>();

/** Orphaned view sessions from a daemon that died without cleaning up. */
export async function sweepViewSessions(): Promise<void> {
  const res = await tmux("list-sessions", "-F", "#{session_name}");
  if (!res.ok) return;
  for (const name of res.out.split("\n")) {
    if (name.startsWith(`${VIEW_PREFIX}-`)) await tmux("kill-session", "-t", `=${name}`);
  }
}

/** Returns the zoom target for a single-pane view, or null for the whole session. */
async function prepareView(view: string, session: string, paneId: string | null): Promise<string | null> {
  await tmux("new-session", "-d", "-t", session, "-s", view);
  await tmux("set-option", "-t", view, "mouse", "on");
  await tmux("set-option", "-t", view, "set-clipboard", "on");
  if (!paneId) return null;

  const index = (await tmux("display-message", "-p", "-t", paneId, "#{pane_index}")).out.trim();
  if (!/^\d+$/.test(index)) return null;
  const target = `${view}:${WINDOW}.${index}`;
  await tmux("select-pane", "-t", target);
  await tmux("resize-pane", "-Z", "-t", target);
  return target;
}

/**
 * Attaching resizes the window and tmux drops zoom whenever a window resizes, so a
 * single-pane view opens unzoomed unless it is re-asserted until it holds.
 */
async function keepZoomed(socket: ServerWebSocket<PtyData>, view: string, target: string): Promise<void> {
  const started = Date.now();
  let stable = 0;
  while (Date.now() - started < 2500) {
    const state = live.get(socket);
    if (!state || state.stopZoom) return;
    const zoomed = (await tmux("display-message", "-p", "-t", view, "#{window_zoomed_flag}")).out.trim();
    if (zoomed === "1") {
      stable++;
      if (stable >= 4 && Date.now() - started > 400) return;
    } else {
      stable = 0;
      if (zoomed === "0") await tmux("resize-pane", "-Z", "-t", target);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function openPty(socket: ServerWebSocket<PtyData>): Promise<void> {
  const data = socket.data;

  if (data.kind === "exec") {
    const proc = spawnBroker(data.argv, data.cols, data.rows, data.cwd);
    live.set(socket, { view: null, session: null, proc, stdin: proc.stdin, zoomTarget: null, stopZoom: false });
    pump(socket, proc);
    return;
  }

  const { session, paneId, cols, rows } = data;
  if (!(await tmux("has-session", "-t", `=${session}`)).ok) {
    socket.close(4404, "session not found");
    return;
  }

  const view = `${VIEW_PREFIX}-${process.pid}-${++counter}`;
  const zoomTarget = await prepareView(view, session, paneId);
  const proc = spawnBroker(["tmux", "attach-session", "-t", view], cols, rows);
  live.set(socket, { view, session, proc, stdin: proc.stdin, zoomTarget, stopZoom: false });
  pump(socket, proc);
  if (zoomTarget) void keepZoomed(socket, view, zoomTarget);
}

export function writePty(socket: ServerWebSocket<PtyData>, message: string | Uint8Array): void {
  const state = live.get(socket);
  if (!state) return;
  const bytes = typeof message === "string" ? new TextEncoder().encode(message) : message;
  try {
    state.stdin.write(bytes);
    state.stdin.flush();
  } catch {
    // The broker is gone; the close handler will tidy up.
  }
}

export async function closePty(socket: ServerWebSocket<PtyData>): Promise<void> {
  const state = live.get(socket);
  if (!state) return;
  live.delete(socket);
  state.stopZoom = true;

  try {
    state.stdin.end();
  } catch {
    // Already closed.
  }
  state.proc.kill();

  if (!state.view || !state.session) return;

  // A zoomed single-pane view leaves the real session zoomed behind it, which would
  // be a surprise the next time it is opened in a terminal.
  if (state.zoomTarget) {
    const zoomed = (await tmux("display-message", "-p", "-t", state.session, "#{window_zoomed_flag}")).out.trim();
    if (zoomed === "1") await tmux("resize-pane", "-Z", "-t", `${state.session}:${WINDOW}`);
  }
  await tmux("kill-session", "-t", `=${state.view}`);
}
