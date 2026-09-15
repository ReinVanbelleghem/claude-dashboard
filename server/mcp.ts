import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "./paths.ts";

/**
 * The machine's MCP servers, and a way to authenticate the ones that need it.
 *
 * This reads the CLI rather than the SDK on purpose. `Query.mcpServerStatus()` is
 * richer — it carries each server's tool list and config scope — but it hangs off a
 * live session, and the question this answers ("what is connected on this machine, and
 * let me fix what isn't") belongs to no session in particular. `claude mcp list` is
 * session-less and health-checks as it goes, which is exactly the shape the settings
 * page needs.
 *
 * The cost is that we parse human output. The format is stable and narrow — one line
 * per server, a status glyph, an optional detail — and an unparsed line is dropped
 * rather than guessed at, so a format change shows up as a short list instead of
 * wrong statuses.
 */

const CACHE_PATH = join(DATA_DIR, "mcp.json");

/** Where the CLI is run. Home rather than a repository, so the list is the
 *  machine's and does not shift with whichever project a session last opened —
 *  the tradeoff being that a project-scoped .mcp.json is out of scope here. */
const PROBE_CWD = homedir();

/** The health check talks to every configured server, so this is minutes-slow at worst. */
const LIST_TIMEOUT_MS = 180_000;

/** An OAuth round trip is human-paced: opening a browser, logging in, consenting. */
const LOGIN_TIMEOUT_MS = 300_000;

export type McpStatus = "connected" | "needs-auth" | "failed" | "pending" | "disabled";

export type McpServer = {
  name: string;
  /** URL for a remote server, the command line for a stdio one. */
  target: string;
  /** "HTTP", "SSE" … when the CLI names one; null for stdio and for claude.ai connectors. */
  transport: string | null;
  status: McpStatus;
  /** The CLI's own explanation, kept verbatim — it is the only error detail there is. */
  detail: string | null;
  /** Where the server comes from, which decides whether we can authenticate it here. */
  origin: "claudeai" | "plugin" | "local";
};

export type McpSnapshot = {
  servers: McpServer[];
  /** When the list was produced, so the page can say how stale it is. */
  checkedAt: number;
  /** Set when the probe itself failed; `servers` is then the last good list. */
  error: string | null;
};

export type McpLogin = {
  name: string;
  startedAt: number;
  /** Combined stdout/stderr, for when the CLI explains a refusal. */
  output: string;
  done: boolean;
  ok: boolean;
  error: string | null;
};

/**
 * One line of `claude mcp list`.
 *
 * `name: target - <glyph> detail`, where the name may itself contain colons
 * (`plugin:slack:slack`) but never ": ", and the detail may contain " - ". Anchoring
 * on the glyph is what makes both safe: the target match is lazy, so it stops at the
 * first " - " that a status glyph actually follows.
 */
const LINE = /^(.+?): (.+?) - ([✔!✘⏸])\s*(.*)$/u;

const GLYPH_STATUS: Record<string, McpStatus> = {
  "✔": "connected",
  "!": "needs-auth",
  "✘": "failed",
  "⏸": "pending",
};

function originOf(name: string): McpServer["origin"] {
  if (name.startsWith("claude.ai ")) return "claudeai";
  if (name.startsWith("plugin:")) return "plugin";
  return "local";
}

export function parseMcpList(out: string): McpServer[] {
  const servers: McpServer[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const [, name, targetRaw, glyph, detail] = m;
    const status = GLYPH_STATUS[glyph];
    if (!status) continue;
    // A trailing "(HTTP)" is the transport, not part of the URL.
    const t = /^(.*?)\s*\(([^()]+)\)$/.exec(targetRaw.trim());
    servers.push({
      name,
      target: (t ? t[1] : targetRaw).trim(),
      transport: t ? t[2] : null,
      status,
      // "Connected" and "Needs authentication" restate the glyph; only a failure says
      // something the badge cannot.
      detail: status === "failed" && detail.trim() ? detail.trim() : null,
      origin: originOf(name),
    });
  }
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return servers;
}

/**
 * The `claude` binary.
 *
 * The daemon is often started by launchd or a double-clicked script, whose PATH is
 * not the shell's, so the usual install locations are tried before giving up on a
 * bare name.
 */
let cachedBin: string | null = null;
function claudeBin(): string {
  if (cachedBin) return cachedBin;
  const candidates = [
    process.env.CLAUDE_BIN,
    join(homedir(), ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ].filter((c): c is string => Boolean(c));
  cachedBin = candidates.find((c) => existsSync(c)) ?? "claude";
  return cachedBin;
}

function readCache(): McpSnapshot | null {
  try {
    const snap = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as McpSnapshot;
    return Array.isArray(snap?.servers) ? snap : null;
  } catch {
    return null;
  }
}

function writeCache(snap: McpSnapshot) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(snap, null, 2));
  } catch {
    // Losing the cache only costs a slower first paint next time.
  }
}

/** The last list we produced, so the page paints before the health check finishes. */
export function cachedMcp(): McpSnapshot {
  return readCache() ?? { servers: [], checkedAt: 0, error: null };
}

/**
 * One health check at a time.
 *
 * Two tabs asking at once, or a refresh landing while the first is still walking 39
 * servers, would otherwise start a second minute-long probe for the same answer.
 */
let inFlight: Promise<McpSnapshot> | null = null;

export function refreshMcp(): Promise<McpSnapshot> {
  if (inFlight) return inFlight;
  inFlight = probe().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Starts a health check without waiting for it.
 *
 * A warm run is ten seconds, but a cold one — the CLI refreshing its connector list
 * and plugin cache — has been seen to take minutes, and holding an HTTP request open
 * that long is its own kind of broken. So the request that asks for a check returns at
 * once and the page follows `checking` instead, the same way it follows a sign-in.
 */
export function startMcpRefresh(): boolean {
  const already = inFlight !== null;
  void refreshMcp();
  return !already;
}

export function isCheckingMcp(): boolean {
  return inFlight !== null;
}

async function probe(): Promise<McpSnapshot> {
  const previous = cachedMcp();
  try {
    const proc = Bun.spawn([claudeBin(), "mcp", "list"], {
      cwd: PROBE_CWD,
      stdout: "pipe",
      stderr: "pipe",
      // No tty, so nothing can stop to ask us something.
      env: { ...process.env, NO_COLOR: "1", CI: "1" },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, LIST_TIMEOUT_MS);
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    clearTimeout(timer);

    if (timedOut) {
      return { ...previous, error: `Health check timed out after ${LIST_TIMEOUT_MS / 1000}s` };
    }
    const servers = parseMcpList(out);
    /**
     * An empty parse is reported rather than cached. A machine with no servers and a
     * CLI whose output we no longer understand look identical here, and overwriting a
     * good list with nothing would make the second case look like the first.
     */
    if (servers.length === 0) {
      const why = err.trim() || out.trim() || "No MCP servers found";
      return { servers: previous.servers, checkedAt: previous.checkedAt, error: why.slice(0, 400) };
    }
    const snap: McpSnapshot = { servers, checkedAt: Date.now(), error: null };
    writeCache(snap);
    return snap;
  } catch (e) {
    return { ...previous, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * OAuth, in progress.
 *
 * `claude mcp login` opens a browser and waits for its own localhost callback, which
 * can only work because the daemon runs on the machine you are looking at. It is
 * human-paced, so the request that starts it returns immediately and the page follows
 * the run here instead of holding a socket open for five minutes.
 */
const logins = new Map<string, McpLogin>();

export function mcpLogins(): McpLogin[] {
  return [...logins.values()];
}

export function startMcpLogin(name: string): { ok: boolean; error: string | null } {
  const existing = logins.get(name);
  if (existing && !existing.done) return { ok: false, error: "Already waiting on the browser for this one." };

  const login: McpLogin = { name, startedAt: Date.now(), output: "", done: false, ok: false, error: null };
  logins.set(name, login);

  try {
    const proc = Bun.spawn([claudeBin(), "mcp", "login", name], {
      cwd: PROBE_CWD,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const timer = setTimeout(() => proc.kill(), LOGIN_TIMEOUT_MS);

    void (async () => {
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      clearTimeout(timer);
      login.output = `${out}${err}`.trim().slice(-2000);
      login.done = true;
      login.ok = code === 0;
      login.error = code === 0 ? null : login.output.split("\n").filter(Boolean).pop() ?? `Exited ${code}`;
      // The list is now wrong either way — a success flips a status, a failure may
      // have left a detail worth reading.
      if (code === 0) void refreshMcp();
    })();

    return { ok: true, error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logins.set(name, { ...login, done: true, ok: false, error });
    return { ok: false, error };
  }
}

/** Clears a finished run, so its banner does not outlive the reason to read it. */
export function dismissMcpLogin(name: string) {
  const login = logins.get(name);
  if (login?.done) logins.delete(name);
}
