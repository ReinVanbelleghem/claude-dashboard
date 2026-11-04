import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { nextFire, renderTitle, type Template, type TemplateRun } from "../shared/templates.ts";
import { getAgent, listAgents, startAgent } from "./agents.ts";
import { expand, scratchDir } from "./dirs.ts";
import { getSettings } from "./settings.ts";

/**
 * Runs templates, by hand and on their schedules.
 *
 * The scheduler is a one-minute tick over the templates in settings. Each schedule's
 * next fire is computed from its last scheduled run, so a daemon that was down over
 * a fire time runs the template once on coming back rather than never, and a tick
 * that is late by a few seconds still fires. Runs are recorded so the page can show
 * what each template produced and when it is next due.
 */
const TICK_MS = 60_000;
/** How far behind a schedule may be and still fire on catch-up. */
const CATCH_UP_MS = 6 * 60 * 60 * 1000;

export type RunResult = { ok: true; key: string } | { ok: false; error: string };

export function runTemplate(db: Database, t: Template, trigger: "manual" | "schedule", cwdOverride?: string): RunResult {
  const cwd = t.research ? scratchDir() : expand((cwdOverride || t.cwd || "").trim());
  if (!t.research && !cwd) return { ok: false, error: "this template has no working directory; pick one to run it" };
  if (!t.research && !existsSync(cwd)) return { ok: false, error: `no such directory: ${cwd}` };
  if (trigger === "schedule" && t.schedule?.skipIfRunning && isRunning(t.id)) {
    return { ok: false, error: "a run of this template is still going" };
  }
  const now = new Date();
  const key = startAgent({
    cwd,
    research: t.research,
    model: t.model || undefined,
    permissionMode: t.permissionMode,
    prompt: t.prompt.trim() || undefined,
    title: renderTitle(t.titlePattern, { name: t.name || "Template", cwd, now }),
    templateId: t.id,
  });
  db.query("INSERT INTO template_runs (template_id, agent_key, session_id, started_at, trigger) VALUES (?, ?, ?, ?, ?)").run(
    t.id,
    key,
    getAgent(key)?.sessionId ?? null,
    now.getTime(),
    trigger,
  );
  return { ok: true, key };
}

const isRunning = (templateId: string) =>
  listAgents().some((a) => a.templateId === templateId && a.status !== "ended" && a.status !== "error");

export function listRuns(db: Database, limit = 200): TemplateRun[] {
  const rows = db
    .query<{ id: number; template_id: string; agent_key: string; session_id: string | null; started_at: number; trigger: string }, [number]>(
      "SELECT * FROM template_runs ORDER BY started_at DESC LIMIT ?",
    )
    .all(limit);
  return rows.map((r) => ({
    id: r.id,
    templateId: r.template_id,
    agentKey: r.agent_key,
    // The session id is only known once the CLI reports it; fill it in from the
    // live agent when the row predates that.
    sessionId: r.session_id ?? getAgent(r.agent_key)?.sessionId ?? null,
    startedAt: r.started_at,
    trigger: r.trigger === "schedule" ? "schedule" : "manual",
  }));
}

function lastScheduledRun(db: Database, templateId: string): number | null {
  const row = db
    .query<{ t: number | null }, [string]>("SELECT MAX(started_at) AS t FROM template_runs WHERE template_id = ? AND trigger = 'schedule'")
    .get(templateId);
  return row?.t ?? null;
}

/** When each scheduled template fires next, for the page's "next in" line. */
export function nextFires(db: Database, now = Date.now()): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const t of getSettings().templates) {
    out[t.id] = t.schedule ? nextFire(t.schedule, now, lastScheduledRun(db, t.id)) : null;
  }
  return out;
}

export function startScheduler(db: Database, onRun: (t: Template, r: RunResult) => void): void {
  // Anchored at boot: anything due since then fires, within the catch-up window.
  let lastTick = Date.now();
  const tick = () => {
    const now = Date.now();
    for (const t of getSettings().templates) {
      if (!t.schedule?.enabled) continue;
      const since = Math.max(lastTick, lastScheduledRun(db, t.id) ?? 0, now - CATCH_UP_MS);
      const due = nextFire(t.schedule, since, lastScheduledRun(db, t.id));
      if (due === null || due > now) continue;
      onRun(t, runTemplate(db, t, "schedule"));
    }
    lastTick = now;
  };
  setInterval(tick, TICK_MS);
}
