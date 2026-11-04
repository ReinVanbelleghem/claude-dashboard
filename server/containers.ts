import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ComposeSettings, Container, ServicePaths } from "../shared/services.ts";

/**
 * The docker compose containers under the apps. Everything comes from `docker
 * compose` itself; the only state kept here is a short cache, since `ps` is slow
 * enough to matter at the broadcast cadence.
 */
const PATH = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`;
const COMPOSE_INPUTS = ["docker-compose.yml", "docker-compose.override.yml", "compose.yml", ".env"];
const PS_TTL_MS = 4_000;

const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function composeDir(compose: ComposeSettings, paths: ServicePaths): string | null {
  const repo = paths.repos.find((r) => r.key === compose.repo);
  if (!repo?.path) return null;
  const dir = join(expand(repo.path), compose.subdir);
  return existsSync(dir) ? dir : null;
}

type Completed = { ok: boolean; out: string; err: string };

export async function compose(cwd: string, ...args: string[]): Promise<Completed> {
  const proc = Bun.spawn(["docker", "compose", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, out, err };
}

// ── declared services, cached on the compose file's mtime ─────────────────────
const declaredCache = new Map<string, { stamp: string; services: string[] }>();

function inputsStamp(cwd: string): string {
  return COMPOSE_INPUTS.map((n) => {
    try {
      return String(statSync(join(cwd, n)).mtimeMs);
    } catch {
      return "-";
    }
  }).join("|");
}

async function declaredServices(cwd: string): Promise<string[]> {
  const stamp = inputsStamp(cwd);
  const hit = declaredCache.get(cwd);
  if (hit && hit.stamp === stamp) return hit.services;
  const r = await compose(cwd, "config", "--services");
  const services = r.ok ? r.out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  declaredCache.set(cwd, { stamp, services });
  return services;
}

// ── ps ────────────────────────────────────────────────────────────────────────
type RawPs = {
  Service?: string;
  State?: string;
  Status?: string;
  Health?: string;
  Image?: string;
  CreatedAt?: string;
  Publishers?: { PublishedPort?: number }[] | null;
};

function parsePs(out: string): RawPs[] {
  const text = out.trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      return JSON.parse(text) as RawPs[];
    } catch {
      return [];
    }
  }
  const rows: RawPs[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as RawPs);
    } catch {
      // A warning line docker printed on stdout; skip it.
    }
  }
  return rows;
}

const psCache = new Map<string, { at: number; list: Container[] }>();

export function invalidateContainers(): void {
  psCache.clear();
}

async function rawContainers(cwd: string): Promise<Container[]> {
  const [listed, declared] = await Promise.all([compose(cwd, "ps", "-a", "--format", "json"), declaredServices(cwd)]);
  const found = new Map<string, Container>();
  for (const raw of parsePs(listed.out)) {
    const service = raw.Service ?? "";
    if (!service) continue;
    const ports = [...new Set((raw.Publishers ?? []).map((p) => Number(p.PublishedPort) || 0).filter((n) => n > 0))].sort(
      (a, b) => a - b,
    );
    const state = raw.State ?? "";
    found.set(service, {
      service,
      state,
      status: raw.Status ?? "",
      health: raw.Health ?? "",
      ports,
      image: raw.Image ?? "",
      createdAt: raw.CreatedAt ?? "",
      running: state === "running",
      hidden: false,
    });
  }
  for (const service of declared) {
    if (!found.has(service)) {
      found.set(service, {
        service,
        state: "",
        status: "not created",
        health: "",
        ports: [],
        image: "",
        createdAt: "",
        running: false,
        hidden: false,
      });
    }
  }
  return [...found.values()];
}

/** Containers in display order: the configured order first, then the rest by name. */
export async function listContainers(settings: ComposeSettings, paths: ServicePaths): Promise<Container[]> {
  const cwd = composeDir(settings, paths);
  if (!cwd) return [];
  const hit = psCache.get(cwd);
  let list: Container[];
  if (hit && Date.now() - hit.at < PS_TTL_MS) list = hit.list;
  else {
    list = await rawContainers(cwd);
    psCache.set(cwd, { at: Date.now(), list });
  }
  const hidden = new Set(settings.hidden);
  const rank = new Map(settings.order.map((s, i) => [s, i]));
  return list
    .map((c) => ({ ...c, hidden: hidden.has(c.service) }))
    .sort((a, b) => {
      const ra = rank.get(a.service) ?? Infinity;
      const rb = rank.get(b.service) ?? Infinity;
      if (ra !== rb) return ra - rb;
      return a.service.localeCompare(b.service);
    });
}

export type ContainerVerb = "up" | "stop" | "restart";

export async function containerAction(
  settings: ComposeSettings,
  paths: ServicePaths,
  verb: ContainerVerb,
  services: string[],
): Promise<{ ok: boolean; error?: string }> {
  const cwd = composeDir(settings, paths);
  if (!cwd) return { ok: false, error: "compose directory not found" };
  const clean = services.filter((s) => /^[A-Za-z0-9_.-]+$/.test(s));
  if (!clean.length) return { ok: false, error: "no containers named" };
  const args = verb === "up" ? ["up", "-d", ...clean] : [verb, ...clean];
  const r = await compose(cwd, ...args);
  invalidateContainers();
  return r.ok ? { ok: true } : { ok: false, error: r.err.trim().split("\n").pop() || `docker compose ${verb} failed` };
}

/** The command a browser terminal runs for a container, never taken from the client. */
export function containerArgv(service: string, mode: "logs" | "shell"): string[] | null {
  if (!/^[A-Za-z0-9_.-]+$/.test(service)) return null;
  if (mode === "logs") return ["docker", "compose", "logs", "-f", "--tail", "300", service];
  return ["docker", "compose", "exec", service, "sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"];
}
