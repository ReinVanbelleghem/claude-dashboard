/**
 * Finds the dashboard daemon, or starts one that outlives the app.
 *
 * The daemon is not the app's child in any way that matters: it is started
 * detached, in a session of its own with its output in a log file, so quitting
 * the app leaves it and the sessions it runs alone.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export const PORT = Number(process.env.DASHBOARD_PORT ?? 5757);
export const APP_URL = `http://localhost:${PORT}`;
export const DATA_DIR = process.env.DASHBOARD_HOME ?? join(homedir(), ".claude-dashboard");
export const LOG_PATH = join(DATA_DIR, "daemon.log");
/** The app's own link scheme: a notification's click opens the app on what it is about. */
export const LINK_SCHEME = "claude-dashboard";

const START_TIMEOUT_MS = 20_000;
/** A first start indexes every transcript before it listens. */
const START_HARD_CAP_MS = 180_000;
const POLL_MS = 250;

export type Health = { ok: boolean; pid?: number; version?: string | null; build?: string | null };

export type Daemon = {
  /** The folder holding server/, shared/, dist/ and node_modules/. */
  root: string;
  /** The bun binary that runs it. */
  bun: string;
  /** What the app ships, to tell a daemon from an older build apart. */
  build: string | null;
};

/** Packaged, everything sits in the bundle's Resources; from a checkout it is the checkout and the bun on this machine. */
export function locateDaemon(resourcesPath: string, packaged: boolean, checkout: string): Daemon {
  const root = packaged ? join(resourcesPath, "daemon") : checkout;
  const bun = packaged ? join(resourcesPath, "bun") : (process.env.DASHBOARD_BUN ?? join(homedir(), ".bun", "bin", "bun"));
  let build: string | null = null;
  try {
    build = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { build?: string }).build ?? null;
  } catch {
    build = null;
  }
  return { root, bun, build };
}

export async function health(timeoutMs = 1500): Promise<Health | null> {
  try {
    const res = await fetch(`${APP_URL}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as Health;
    return body.ok ? body : null;
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The end of the daemon's log, for an error dialog. */
export function logTail(bytes = 3000): string {
  try {
    const fd = openSync(LOG_PATH, "r");
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, bytes);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const text = buf.toString("utf8");
      return len < size ? text.slice(text.indexOf("\n") + 1) : text;
    } finally {
      closeSync(fd);
    }
  } catch {
    return `(no log at ${LOG_PATH})`;
  }
}

/**
 * An app started from the Dock gets launchd's bare PATH, on which the daemon
 * would find neither claude nor git, gh or tmux. The usual install folders go
 * in front; a start from a terminal already has them and loses nothing.
 */
function daemonPath(): string {
  const extra = [join(homedir(), ".local", "bin"), join(homedir(), ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  return [...extra, process.env.PATH ?? "/usr/bin:/bin"].join(delimiter);
}

function spawnDaemon(d: Daemon): { pid: number | undefined; exited: () => string | null } {
  if (!existsSync(d.bun)) throw new Error(`No bun at ${d.bun}.`);
  mkdirSync(DATA_DIR, { recursive: true });
  const logFd = openSync(LOG_PATH, "a");
  let exit: string | null = null;
  try {
    const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env;
    const child = spawn(d.bun, ["run", join(d.root, "server", "index.ts")], {
      cwd: homedir(),
      env: { ...env, PORT: String(PORT), DASHBOARD_HOME: DATA_DIR, DASHBOARD_LINK_BASE: `${LINK_SCHEME}://open`, PATH: daemonPath() },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.once("exit", (code, signal) => (exit = `code ${code}, signal ${signal}`));
    child.once("error", (err) => (exit = `could not start: ${err.message}`));
    child.unref();
    return { pid: child.pid, exited: () => exit };
  } finally {
    closeSync(logFd);
  }
}

export type Attached = { health: Health; spawned: boolean };

/** The running daemon, or a new one once it answers. Throws with the log's last lines when none comes up. */
export async function ensureDaemon(d: Daemon): Promise<Attached> {
  const running = await health();
  if (running) return { health: running, spawned: false };

  const child = spawnDaemon(d);
  const started = Date.now();
  const stillWorking = () => !!child.pid && isPidAlive(child.pid) && Date.now() - started < START_HARD_CAP_MS;
  while (Date.now() - started < START_TIMEOUT_MS || stillWorking()) {
    const up = await health();
    if (up) return { health: up, spawned: true };
    const exit = child.exited();
    if (exit) throw new Error(`The daemon stopped while starting (${exit}).\n\nLast lines of ${LOG_PATH}:\n${logTail()}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`The daemon did not come up within ${Math.round((Date.now() - started) / 1000)} s.\n\nLast lines of ${LOG_PATH}:\n${logTail()}`);
}

/** Asks the daemon to end its sessions and exit, and waits until it has. */
export async function stopDaemon(pid: number, waitMs = 10_000): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isPidAlive(pid);
  }
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return !isPidAlive(pid);
}
