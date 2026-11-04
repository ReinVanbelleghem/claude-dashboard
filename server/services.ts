import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { composeDir, listContainers } from "./containers.ts";
import { currentBranch } from "./dirs.ts";
import {
  paneTone,
  RESTART_WINDOW_MS,
  type Checkout,
  type CheckoutView,
  type PaneState,
  type Service,
  type ServicePaths,
  type ComposeSettings,
  type Container,
  DEFAULT_COMPOSE,
  type ServiceSession,
  type ServicesState,
  type ServiceView,
  type SessionHealth,
  type SearchAction,
  type StartResult,
} from "../shared/services.ts";

export type { SearchAction };

/**
 * Local dev services, on top of tmux.
 *
 * tmux is the database. A session carries @dash_service and @dash_checkout, a pane
 * carries the command that started it, when it started, and the bookkeeping for error
 * detection and auto-restart. Nothing is cached here, so the page is never stale and a
 * daemon restart is invisible — the sessions were never ours to lose.
 *
 * The session prefix is configurable so a stack started by another launcher under a
 * different name can still be adopted.
 */
const SESSION_PREFIX = process.env.DASHBOARD_TMUX_PREFIX ?? "dash";
const WINDOW = "dev";
const TMUX = process.env.DASHBOARD_TMUX_BIN ?? "tmux";
const BREW_PATH = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`;

type Run = { ok: boolean; out: string; err: string };

export async function tmux(...args: string[]): Promise<Run> {
  try {
    const proc = Bun.spawn([TMUX, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: BREW_PATH },
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { ok: (await proc.exited) === 0, out, err };
  } catch (e) {
    return { ok: false, out: "", err: e instanceof Error ? e.message : String(e) };
  }
}

export const tmuxUp = async () => (await tmux("list-sessions")).ok;

// ── paths and checkouts ───────────────────────────────────────────────────────
const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * The main checkout plus every worktree of that repo. The label is what names the
 * tmux session — "<repo> (main)", or the worktree's folder suffix — so a checkout
 * always maps to the same session name.
 */
export function checkoutsFor(repoKey: string, paths: ServicePaths): Checkout[] {
  const repo = paths.repos.find((r) => r.key === repoKey);
  if (!repo) return [];
  const out: Checkout[] = [];
  const main = repo.path ? expand(repo.path) : "";
  if (main && existsSync(main)) out.push({ label: `${repo.key} (main)`, path: main, main: true, branch: branchOf(main) });

  const root = repo.worktreesDir ? expand(repo.worktreesDir) : "";
  if (root && existsSync(root)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith(`${repo.key}-`))
        .map((e) => e.name);
    } catch {
      entries = [];
    }
    for (const name of entries.sort()) {
      const path = join(root, name);
      out.push({ label: name.slice(repo.key.length + 1), path, main: false, branch: branchOf(path) });
    }
  }
  return out;
}

/** "detached" for a real detached HEAD, "not a checkout" when there is no .git at all. */
const branchOf = (dir: string): string | null =>
  existsSync(join(dir, ".git")) ? currentBranch(dir) : "not a checkout";

export const sessionNameFor = (serviceLabel: string, checkoutLabel: string) =>
  `${SESSION_PREFIX}-${slug(checkoutLabel)}-${slug(serviceLabel)}`;

// ── expanding a service into panes ────────────────────────────────────────────
type FullPane = { title: string; cmd: string; cwd: string };

/**
 * A service's panes with their commands fully built. A composite recurses into what
 * it includes, so every pane keeps the subdir and setup of the service that defined
 * it however deep the nesting goes. `seen` guards against an includes cycle.
 */
export function fullPanes(service: Service, all: Service[], checkout: string, seen: string[] = []): FullPane[] {
  if (seen.includes(service.key)) return [];
  const next = [...seen, service.key];

  if (service.includes.length) {
    return service.includes.flatMap((key) => {
      const inner = all.find((s) => s.key === key);
      return inner ? fullPanes(inner, all, checkout, next) : [];
    });
  }

  const cwd = service.subdir ? join(checkout, service.subdir) : checkout;
  const prefix = service.setup ? `cd '${cwd}' && ${service.setup}` : `cd '${cwd}'`;
  return service.panes.map((p) => ({ title: p.title, cmd: `${prefix} && ${p.cmd}`, cwd }));
}

const PORT_RE = /(?::|--port[= ]|-p[= ])(\d{4,5})\b/g;

export const portsIn = (text: string): number[] => [
  ...new Set([...text.matchAll(PORT_RE)].map((m) => Number(m[1])).filter((n) => n >= 1024)),
];

// ── reading tmux ──────────────────────────────────────────────────────────────
/** A pane whose foreground process is a bare shell has dropped out of its command. */
const DEAD_COMMANDS = new Set(["zsh", "-zsh", "bash", "-bash", "sh", "-sh", "fish"]);

const PANE_FORMAT = [
  "#{pane_id}",
  "#{pane_index}",
  "#{@dash_title}",
  "#{pane_title}",
  "#{pane_current_command}",
  "#{@dash_cmd}",
  "#{@dash_started_at}",
  "#{@dash_crashed_at}",
  "#{@dash_auto}",
].join("\t");

async function listPanes(session: string): Promise<PaneState[]> {
  const res = await tmux("list-panes", "-t", `${session}:${WINDOW}`, "-F", PANE_FORMAT);
  if (!res.ok) return [];
  const panes: PaneState[] = [];
  for (const line of res.out.split("\n")) {
    if (!line.trim()) continue;
    const [id, index, qTitle, paneTitle, currentCommand, cmd, startedAt, crashedAt, auto] = line.split("\t");
    const alive = !DEAD_COMMANDS.has(currentCommand);
    const [count] = (auto ?? "").split("\t");
    panes.push({
      id,
      index: Number(index) || 0,
      title: qTitle || paneTitle || `pane ${index}`,
      command: cmd ?? "",
      alive,
      startedAt: Number(startedAt) ? Number(startedAt) * 1000 : null,
      crashedAt: Number(crashedAt) ? Number(crashedAt) * 1000 : null,
      error: null,
      ports: portsIn(cmd ?? ""),
      autoRestarts: Number(count) || 0,
      autoRestartExhausted: false,
    });
  }
  return panes.sort((a, b) => a.index - b.index);
}

/** Crash timestamps are written here rather than polled, so "down 12s" survives a reload. */
async function markCrashes(panes: PaneState[]): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await Promise.all(
    panes.map(async (p) => {
      if (p.alive && p.crashedAt !== null) {
        await tmux("set-option", "-p", "-t", p.id, "-u", "@dash_crashed_at");
        p.crashedAt = null;
      } else if (!p.alive && p.crashedAt === null) {
        await tmux("set-option", "-p", "-t", p.id, "@dash_crashed_at", String(now));
        p.crashedAt = now * 1000;
      }
    }),
  );
}

const healthOf = (panes: PaneState[]): SessionHealth =>
  panes.every((p) => p.alive) ? "ok" : panes.some((p) => p.alive) ? "partial" : "down";

export async function listSessions(): Promise<ServiceSession[]> {
  const res = await tmux(
    "list-sessions",
    "-F",
    "#{session_name}\t#{@dash_service}\t#{@dash_checkout}\t#{session_attached}\t#{session_created}\t#{@dash_service_key}",
  );
  if (!res.ok) return [];

  const out: ServiceSession[] = [];
  for (const line of res.out.split("\n")) {
    if (!line.trim()) continue;
    const [name, service, checkout, attached, created, serviceKey] = line.split("\t");
    if (!name.startsWith(`${SESSION_PREFIX}-`)) continue;
    const panes = await listPanes(name);
    await markCrashes(panes);
    out.push({
      name,
      serviceKey: serviceKey || "",
      serviceLabel: service || name,
      checkout: checkout || "",
      attached: attached === "1",
      createdAt: Number(created) ? Number(created) * 1000 : 0,
      panes,
      health: healthOf(panes),
    });
  }
  return out;
}

// ── starting ──────────────────────────────────────────────────────────────────
async function setPane(target: string, title: string, cmd: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await tmux("send-keys", "-t", target, cmd, "C-m");
  await tmux("select-pane", "-t", target, "-T", title);
  await tmux("set-option", "-p", "-t", target, "@dash_title", title);
  await tmux("set-option", "-p", "-t", target, "@dash_cmd", cmd);
  await tmux("set-option", "-p", "-t", target, "@dash_started_at", String(now));
  await markHistory(target);
}

/**
 * Where the scrollback stood when the command started. Error detection only reads
 * what came after it, so output from a previous run is not re-reported as new.
 */
async function markHistory(target: string): Promise<void> {
  const size = (await tmux("display-message", "-p", "-t", target, "#{history_size}")).out.trim();
  await tmux("set-option", "-p", "-t", target, "@dash_mark", size || "0");
}

export async function startService(
  service: Service,
  all: Service[],
  checkout: Checkout,
): Promise<StartResult> {
  const session = sessionNameFor(service.label, checkout.label);
  if ((await tmux("has-session", "-t", `=${session}`)).ok) {
    return { ok: true, session, already: true };
  }

  const panes = fullPanes(service, all, checkout.path);
  if (!panes.length) return { ok: false, error: `${service.label} has no panes to run` };

  const missing = [...new Set(panes.map((p) => p.cwd))].filter((d) => !existsSync(d));
  if (missing.length) return { ok: false, error: "Directory not found", missing };

  const created = await tmux("new-session", "-d", "-s", session, "-n", WINDOW, "-c", checkout.path);
  if (!created.ok) return { ok: false, error: created.err.trim() || "tmux refused to create the session" };

  const first = (await tmux("list-panes", "-t", `${session}:${WINDOW}`, "-F", "#{pane_id}")).out.trim();
  const ids = [first];
  for (let i = 1; i < panes.length; i++) {
    // The first split is vertical and the rest horizontal, which is what gives the
    // tiled layout an even grid rather than a column of slivers.
    const res = await tmux(
      "split-window",
      i === 1 ? "-v" : "-h",
      "-t",
      ids[i - 1],
      "-c",
      panes[i].cwd,
      "-P",
      "-F",
      "#{pane_id}",
    );
    ids.push(res.out.trim());
  }

  for (let i = 0; i < panes.length; i++) await setPane(ids[i], panes[i].title, panes[i].cmd);
  await tmux("select-layout", "-t", `${session}:${WINDOW}`, "tiled");

  await tmux("set-option", "-t", session, "@dash_service", service.label);
  await tmux("set-option", "-t", session, "@dash_service_key", service.key);
  await tmux("set-option", "-t", session, "@dash_checkout", checkout.label);
  await tmux("set-option", "-t", `${session}:${WINDOW}`, "pane-border-status", "top");
  await tmux(
    "set-option",
    "-t",
    `${session}:${WINDOW}`,
    "pane-border-format",
    "#{?@dash_title,#{@dash_title},#{pane_title}}",
  );
  // Scoped to this session, so none of it touches the user's own tmux config.
  await tmux("set-option", "-t", session, "mouse", "on");
  await tmux("set-option", "-t", session, "history-limit", "50000");
  await tmux("set-option", "-t", session, "set-clipboard", "on");

  return { ok: true, session };
}

// ── stopping and restarting ───────────────────────────────────────────────────
export async function stopSession(name: string): Promise<{ ok: boolean; error?: string }> {
  const res = await tmux("kill-session", "-t", `=${name}`);
  return res.ok ? { ok: true } : { ok: false, error: res.err.trim() || "no such session" };
}

export async function stopAll(): Promise<{ ok: true; stopped: number }> {
  const sessions = await listSessions();
  for (const s of sessions) await stopSession(s.name);
  return { ok: true, stopped: sessions.length };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function restartPane(paneId: string): Promise<{ ok: boolean; error?: string }> {
  const cmd = (await tmux("show-options", "-p", "-v", "-t", paneId, "@dash_cmd")).out.trim();
  if (!cmd) return { ok: false, error: "this pane has no recorded command" };

  const live = await tmux("list-panes", "-a", "-F", "#{pane_id}\t#{pane_current_command}");
  const row = live.out.split("\n").find((l) => l.startsWith(`${paneId}\t`));
  if (!row) return { ok: false, error: "no such pane" };
  if (!DEAD_COMMANDS.has(row.split("\t")[1])) {
    // Still running: interrupt it and let it unwind before sending the command again.
    await tmux("send-keys", "-t", paneId, "C-c");
    await sleep(300);
  }

  await tmux("send-keys", "-t", paneId, "clear", "C-m");
  await sleep(150);
  await tmux("clear-history", "-t", paneId);
  await tmux("set-option", "-p", "-t", paneId, "-u", "@dash_err_seen");
  await markHistory(paneId);
  await tmux("send-keys", "-t", paneId, cmd, "C-m");
  await tmux("set-option", "-p", "-t", paneId, "@dash_started_at", String(Math.floor(Date.now() / 1000)));
  await tmux("set-option", "-p", "-t", paneId, "-u", "@dash_crashed_at");
  return { ok: true };
}

export async function restartDead(session: string): Promise<{ ok: true; restarted: number; dead: number }> {
  const panes = (await listPanes(session)).filter((p) => !p.alive);
  let restarted = 0;
  for (const p of panes) if ((await restartPane(p.id)).ok) restarted++;
  return { ok: true, restarted, dead: panes.length };
}

export async function capturePane(paneId: string, lines = 500): Promise<string> {
  const res = await tmux("capture-pane", "-p", "-e", "-J", "-S", `-${lines}`, "-t", paneId);
  return res.ok ? res.out : "";
}

/**
 * Search runs through tmux's own copy mode rather than the browser: under an attach
 * xterm only ever holds the visible screen, tmux owns the scrollback.
 */
export async function searchPane(target: string, action: SearchAction, query: string) {
  const state = await tmux("display-message", "-p", "-t", target, "#{pane_in_mode}\t#{search_present}\t#{search_count}");
  const [inMode] = state.out.trim().split("\t");

  if (action === "cancel") {
    if (inMode === "1") await tmux("send-keys", "-t", target, "-X", "cancel");
    return { ok: true, pane: target, inMode: false, found: false, matches: 0 };
  }
  if (action === "find" || inMode !== "1") {
    await tmux("copy-mode", "-t", target);
    await tmux("send-keys", "-t", target, "-X", "search-backward", query);
  } else {
    await tmux("send-keys", "-t", target, "-X", action === "next" ? "search-again" : "search-reverse");
  }

  const after = await tmux("display-message", "-p", "-t", target, "#{pane_in_mode}\t#{search_present}\t#{search_count}");
  const [mode, present, count] = after.out.trim().split("\t");
  return {
    ok: true,
    pane: target,
    inMode: mode === "1",
    found: present === "1",
    matches: Number(count) || 0,
  };
}

// ── error detection ───────────────────────────────────────────────────────────
const ERROR_SIGNATURES = [
  /^Traceback \(most recent call last\):/,
  /^[A-Za-z_.]*(?:Error|Exception)\b.*/,
  /^\s*(?:CRITICAL|FATAL)\b.*/,
  /panic:/,
];

/**
 * Scans what each pane printed since its command started and flags the last line
 * that looks like a failure. `@dash_err_seen` holds what was last reported, so a
 * dismissed error stays dismissed until a new one arrives or the count rises.
 */
export async function annotateErrors(sessions: ServiceSession[]): Promise<void> {
  for (const session of sessions) {
    for (const pane of session.panes) {
      const mark = Number((await tmux("show-options", "-p", "-v", "-t", pane.id, "@dash_mark")).out.trim()) || 0;
      const size = Number((await tmux("display-message", "-p", "-t", pane.id, "#{history_size}")).out.trim()) || 0;
      const span = Math.max(0, size - mark);
      if (span === 0 && pane.alive) continue;

      const text = await capturePane(pane.id, Math.min(span + 50, 2000));
      const hits = text.split("\n").filter((l) => ERROR_SIGNATURES.some((re) => re.test(l)));
      if (!hits.length) continue;

      const last = hits[hits.length - 1].trim().slice(0, 300);
      const seen = (await tmux("show-options", "-p", "-v", "-t", pane.id, "@dash_err_seen")).out.trim();
      const [seenCount, seenText] = seen.split("\t");
      if (seenText === last && Number(seenCount) === hits.length) continue;
      await tmux("set-option", "-p", "-t", pane.id, "@dash_err_seen", `${hits.length}\t${last}`);
      pane.error = { text: last, count: hits.length };
    }
  }
}

export async function dismissError(paneId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await tmux("set-option", "-p", "-t", paneId, "-u", "@dash_err_seen");
  return res.ok ? { ok: true } : { ok: false, error: "no such pane" };
}

// ── auto-restart ──────────────────────────────────────────────────────────────
const AUTO_RESTART_COOLDOWN_MS = 20_000;

const ruleMatches = (rule: { pane: string | null; pattern: string }, title: string, text: string) =>
  (!rule.pane || rule.pane === title) && !!rule.pattern && text.toLowerCase().includes(rule.pattern.toLowerCase());

/**
 * Restarts a pane whose error matches one of its service's rules, at most
 * `restartMax` times in a ten-minute window and never twice inside the cooldown.
 * The counter lives on the pane as "<count>\t<since>\t<last>", so the budget is not
 * refreshed by a daemon restart.
 */
export async function runAutoRestarts(sessions: ServiceSession[], services: Service[]): Promise<string[]> {
  const done: string[] = [];
  const now = Date.now();

  for (const session of sessions) {
    const service = services.find((s) => s.key === session.serviceKey || s.label === session.serviceLabel);
    if (!service) continue;
    const rules = service.includes.length
      ? service.includes
          .flatMap((k) => services.find((s) => s.key === k)?.restartOn ?? [])
          .concat(service.restartOn)
      : service.restartOn;
    if (!rules.length) continue;

    for (const pane of session.panes) {
      if (!pane.alive || !pane.error) continue;
      if (!rules.some((r) => ruleMatches(r, pane.title, pane.error!.text))) continue;

      const raw = (await tmux("show-options", "-p", "-v", "-t", pane.id, "@dash_auto")).out.trim();
      const [countRaw, sinceRaw, lastRaw] = raw.split("\t");
      let count = Number(countRaw) || 0;
      const since = Number(sinceRaw) || 0;
      const last = Number(lastRaw) || 0;

      if (now - since > RESTART_WINDOW_MS) count = 0;
      if (now - last < AUTO_RESTART_COOLDOWN_MS) continue;
      if (service.restartMax > 0 && count >= service.restartMax) {
        pane.autoRestarts = count;
        pane.autoRestartExhausted = true;
        continue;
      }

      if (!(await restartPane(pane.id)).ok) continue;
      await tmux(
        "set-option",
        "-p",
        "-t",
        pane.id,
        "@dash_auto",
        `${count + 1}\t${count === 0 ? now : since || now}\t${now}`,
      );
      pane.autoRestarts = count + 1;
      pane.error = null;
      done.push(`${session.serviceLabel} / ${pane.title}`);
    }
  }
  return done;
}

// ── the whole picture ─────────────────────────────────────────────────────────
export async function buildState(
  services: Service[],
  paths: ServicePaths,
  compose: ComposeSettings = DEFAULT_COMPOSE,
): Promise<ServicesState> {
  const up = await tmuxUp();
  const [sessions, containers] = await Promise.all([
    up ? listSessions() : Promise.resolve([] as ServiceSession[]),
    listContainers(compose, paths).catch(() => [] as Container[]),
  ]);
  if (sessions.length) {
    await annotateErrors(sessions);
    const restarted = await runAutoRestarts(sessions, services);
    for (const what of restarted) console.log(`auto-restarted ${what}`);
  }

  const views: ServiceView[] = services.map((s) => {
    const panes = fullPanes(s, services, "/");
    const checkouts: CheckoutView[] = checkoutsFor(s.repo, paths).map((c) => {
      const name = sessionNameFor(s.label, c.label);
      const dirs = [...new Set(fullPanes(s, services, c.path).map((p) => p.cwd))];
      return {
        ...c,
        session: name,
        running: sessions.some((x) => x.name === name),
        missing: dirs.filter((d) => !existsSync(d)),
      };
    });
    return {
      ...s,
      startable: panes.length > 0 && !s.disabled,
      paneCount: panes.length,
      ports: portsIn(panes.map((p) => p.cmd).join(" ")),
      checkouts,
      sessions: sessions.filter((x) => x.serviceKey === s.key || x.serviceLabel === s.label),
    };
  });

  return { tmuxUp: up, services: views, sessions, paths, containers, composeDir: composeDir(compose, paths) };
}

export const paneToneOf = paneTone;
