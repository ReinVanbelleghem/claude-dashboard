/**
 * Session templates: a recipe for a session you start often, and optionally a
 * schedule that starts it for you.
 *
 * A template fixes everything the new-session dialog asks — directory, model,
 * permission mode, title, first prompt — so running one is a single click. A
 * schedule is a property of the template rather than its own thing: the recipe is
 * what matters, the timer is just one way of pressing Run.
 */

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

export type Schedule = {
  enabled: boolean;
  kind: "weekly" | "interval" | "cron";
  /** 0 = Sunday … 6 = Saturday, for `weekly`. */
  days: number[];
  /** "HH:MM" local time, for `weekly`. */
  time: string;
  /** For `interval`: hours between runs, counted from the last scheduled run. */
  everyHours: number;
  /** Five-field cron, for `cron`. Local time. */
  cron: string;
  /** Do not start another run while one from this template is still going. */
  skipIfRunning: boolean;
};

export type Template = {
  id: string;
  name: string;
  /** What the sessions it starts are called. {date}, {time}, {repo} and {name} expand. */
  titlePattern: string;
  /** Fixed working directory. Empty means Run asks; a schedule needs it set. */
  cwd: string;
  /** Start as a research session: scratch directory, no project tools. */
  research: boolean;
  /** Empty means the dashboard's default model. */
  model: string;
  permissionMode: PermissionMode;
  /** Sent as the first message as soon as the session is up. */
  prompt: string;
  schedule: Schedule | null;
};

export type TemplateRun = {
  id: number;
  templateId: string;
  agentKey: string;
  sessionId: string | null;
  startedAt: number;
  trigger: "manual" | "schedule";
};

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const blankSchedule = (): Schedule => ({
  enabled: false,
  kind: "weekly",
  days: [1, 2, 3, 4, 5],
  time: "09:00",
  everyHours: 4,
  cron: "0 9 * * 1-5",
  skipIfRunning: true,
});

export const blankTemplate = (id: string): Template => ({
  id,
  name: "",
  titlePattern: "{name} · {date}",
  cwd: "",
  research: false,
  model: "",
  permissionMode: "auto",
  prompt: "",
  schedule: null,
});

/** The session title a template produces, with its placeholders filled. */
export function renderTitle(pattern: string, vars: { name: string; cwd: string; now: Date }): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = vars.now;
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const repo = vars.cwd.replace(/\/+$/, "").split("/").pop() ?? "";
  const out = (pattern || "{name}")
    .replace(/\{name\}/g, vars.name)
    .replace(/\{date\}/g, date)
    .replace(/\{time\}/g, time)
    .replace(/\{repo\}/g, repo)
    .trim();
  return out || vars.name;
}

// ── when does it fire next ────────────────────────────────────────────────────

const MINUTE = 60_000;

/**
 * The first minute strictly after `after` at which the schedule fires, or null when
 * it never does (disabled, or a cron that matches nothing in the next year).
 * `lastRun` is what an interval schedule counts from.
 */
export function nextFire(s: Schedule, after: number, lastRun: number | null): number | null {
  if (!s.enabled) return null;
  if (s.kind === "interval") {
    const every = Math.max(1, s.everyHours) * 60 * MINUTE;
    const base = lastRun ?? after;
    let t = base + every;
    while (t <= after) t += every;
    return floorMinute(t);
  }
  if (s.kind === "weekly") {
    if (!s.days.length) return null;
    const [hh, mm] = parseTime(s.time);
    const start = new Date(after);
    for (let i = 0; i < 8; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, hh, mm, 0, 0);
      if (s.days.includes(d.getDay()) && d.getTime() > after) return d.getTime();
    }
    return null;
  }
  const fields = parseCron(s.cron);
  if (!fields) return null;
  let t = floorMinute(after) + MINUTE;
  const limit = after + 366 * 24 * 60 * MINUTE;
  while (t <= limit) {
    const d = new Date(t);
    if (
      fields.min.has(d.getMinutes()) &&
      fields.hour.has(d.getHours()) &&
      fields.dom.has(d.getDate()) &&
      fields.mon.has(d.getMonth() + 1) &&
      fields.dow.has(d.getDay())
    )
      return t;
    // Skip whole hours and days that cannot match, so a sparse cron is still quick.
    if (!fields.hour.has(d.getHours()) || !fields.dom.has(d.getDate()) || !fields.mon.has(d.getMonth() + 1) || !fields.dow.has(d.getDay())) {
      t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1, 0, 0, 0).getTime();
      continue;
    }
    t += MINUTE;
  }
  return null;
}

const floorMinute = (t: number) => Math.floor(t / MINUTE) * MINUTE;

function parseTime(s: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return [9, 0];
  return [Math.min(23, Number(m[1])), Math.min(59, Number(m[2]))];
}

type CronFields = { min: Set<number>; hour: Set<number>; dom: Set<number>; mon: Set<number>; dow: Set<number> };

/** Five fields: minute, hour, day of month, month, day of week. `*`, lists, ranges and `/step`. */
export function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const ranges: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ];
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const set = parseField(parts[i]!, ranges[i]![0], ranges[i]![1]);
    if (!set) return null;
    sets.push(set);
  }
  // Sunday as 7 is common; fold it onto 0.
  if (sets[4]!.has(7)) sets[4]!.add(0);
  return { min: sets[0]!, hour: sets[1]!, dom: sets[2]!, mon: sets[3]!, dow: sets[4]! };
}

function parseField(field: string, lo: number, hi: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const step = m[3] ? Number(m[3]) : 1;
    if (step < 1) return null;
    let from: number;
    let to: number;
    if (m[1] === "*") {
      from = lo;
      to = hi;
    } else {
      from = Number(m[1]);
      to = m[2] ? Number(m[2]) : m[3] ? hi : from;
    }
    if (from < lo || to > (hi === 6 ? 7 : hi) || from > to) return null;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

/** "Weekdays 08:30", "Every 4h", "0 9 * * 1-5" — the schedule in a few words. */
export function describeSchedule(s: Schedule | null): string {
  if (!s || !s.enabled) return "Not scheduled";
  if (s.kind === "interval") return `Every ${s.everyHours}h`;
  if (s.kind === "cron") return s.cron;
  const days = [...s.days].sort((a, b) => a - b);
  const label =
    days.length === 7
      ? "Every day"
      : days.join(",") === "1,2,3,4,5"
        ? "Weekdays"
        : days.join(",") === "0,6"
          ? "Weekends"
          : days.map((d) => DAY_NAMES[d]).join(" ");
  return `${label} ${s.time}`;
}
