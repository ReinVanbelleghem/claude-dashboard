import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "./paths.ts";

export type LiveSession = {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string | null;
  status: string | null;
  waitingFor: string | null;
  kind: string | null;
  entrypoint: string | null;
  version: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  statusUpdatedAt: number | null;
  messagingSocketPath: string | null;
  /** True when the OS still has this pid. Stale registry files are common. */
  alive: boolean;
};

/** Statuses that mean the session is blocked on Rein, not on itself. */
const NEEDS_INPUT = new Set(["needs_input", "waiting"]);

export function needsInput(s: LiveSession): boolean {
  return s.alive && (NEEDS_INPUT.has(s.status ?? "") || !!s.waitingFor);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means the process exists but belongs to someone else.
    return err?.code === "EPERM";
  }
}

export function readRegistry(): LiveSession[] {
  let names: string[];
  try {
    names = readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }

  const out: LiveSession[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let raw: any;
    try {
      raw = JSON.parse(readFileSync(join(SESSIONS_DIR, name), "utf8"));
    } catch {
      continue;
    }
    if (typeof raw?.pid !== "number" || typeof raw?.sessionId !== "string") continue;

    out.push({
      pid: raw.pid,
      sessionId: raw.sessionId,
      cwd: raw.cwd ?? "",
      name: raw.name ?? null,
      status: raw.status ?? null,
      waitingFor: typeof raw.waitingFor === "string" ? raw.waitingFor : null,
      kind: raw.kind ?? null,
      entrypoint: raw.entrypoint ?? null,
      version: raw.version ?? null,
      startedAt: raw.startedAt ?? null,
      updatedAt: raw.updatedAt ?? null,
      statusUpdatedAt: raw.statusUpdatedAt ?? null,
      messagingSocketPath: raw.messagingSocketPath ?? null,
      alive: pidAlive(raw.pid),
    });
  }

  out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return out;
}
