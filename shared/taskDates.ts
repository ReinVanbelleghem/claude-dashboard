/**
 * Natural-language dates for Tasks: the quick-add line ("call Anna morgen 9u p1
 * #Work @phone"), due strings typed elsewhere (`cdash task edit --due`) and the
 * due strings a Todoist import brings along ("every monday at 9am").
 *
 * English and Dutch basics, no dependency. Pure: every function takes `now` (or
 * a local "today") so tests pin the clock. Dates are local calendar days as
 * "YYYY-MM-DD" and times "HH:MM", never epoch ms: a task due "Friday 9:00"
 * stays Friday 9:00 whatever the timezone does in between. Arithmetic on days
 * runs in UTC so a DST switch never shifts a date.
 *
 * Shared by the daemon (adds, recurrence), the CLI and the UI (the live preview
 * under the quick-add field), so all three read a line the same way.
 */

export type RecurrenceUnit = "day" | "week" | "month" | "year";

export type Recurrence = {
  every: number;
  unit: RecurrenceUnit;
  /** unit "week": days it falls on, 0 = Sunday … 6 = Saturday. */
  weekdays?: number[];
  /** unit "month": day of the month (clamped to the month's length). */
  monthDay?: number;
  /** "every!": the next one counts from the day it was completed, not from the due date. */
  fromCompletion?: boolean;
};

export type Due = {
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  /** Local time HH:MM, or null for an all-day task. */
  time: string | null;
  recurrence: Recurrence | null;
  /** What was typed (or imported), kept for display. */
  string: string;
};

export type Priority = 1 | 2 | 3 | 4;

export type TokenKind = "priority" | "project" | "label" | "date" | "time" | "recurrence";

export type QuickAdd = {
  content: string;
  /** 1 = P1 (most urgent) … 4 = P4 (none). Null when not typed. */
  priority: Priority | null;
  /** Project name without the "#", or null. */
  project: string | null;
  labels: string[];
  due: Due | null;
  /** Every recognised piece, in order, for the UI's highlight. */
  tokens: { kind: TokenKind; text: string; start: number; end: number }[];
};

// ── calendar days ────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

export function localDay(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function localTime(now: Date): string {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function toUtc(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDays(day: string, n: number): string {
  const d = toUtc(day);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtc(d);
}

export function weekdayOf(day: string): number {
  return toUtc(day).getUTCDay();
}

const daysInMonth = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

/** `day` moved by n months, landing on `dom` (default: its own day), clamped to the month's end. */
export function addMonths(day: string, n: number, dom?: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(dom ?? d, daysInMonth(ny, nm)))}`;
}

function validDay(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m - 1)) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Epoch ms of a local day + time, for reminders. */
export function dueEpoch(date: string, time: string | null): number {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = (time ?? "00:00").split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
}

// ── vocabulary ───────────────────────────────────────────────────────────────

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  zondag: 0, maandag: 1, dinsdag: 2, woensdag: 3, donderdag: 4, vrijdag: 5, zaterdag: 6,
};
/** Abbreviations double as ordinary words ("sat", "ma", "do"), so they only count after every/next/on. */
const WEEKDAY_ABBR: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
  zo: 0, ma: 1, di: 2, wo: 3, do: 4, vr: 5, za: 6,
};

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  januari: 1, februari: 2, maart: 3, mei: 5, juni: 6, juli: 7, augustus: 8, oktober: 10,
  jan: 1, feb: 2, mar: 3, mrt: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, okt: 10, nov: 11, dec: 12,
};

const alt = (words: string[]) => [...words].sort((a, b) => b.length - a.length).join("|");
const WD_FULL = alt(Object.keys(WEEKDAYS));
const WD_ANY = alt([...Object.keys(WEEKDAYS), ...Object.keys(WEEKDAY_ABBR)]);
const MONTH = alt(Object.keys(MONTHS));

const wd = (w: string): number => WEEKDAYS[w.toLowerCase()] ?? WEEKDAY_ABBR[w.toLowerCase()];

const UNIT: Record<string, RecurrenceUnit> = {
  day: "day", days: "day", dag: "day", dagen: "day",
  week: "week", weeks: "week", weken: "week",
  month: "month", months: "month", maand: "month", maanden: "month",
  year: "year", years: "year", jaar: "year", jaren: "year",
};
const UNIT_RE = alt(Object.keys(UNIT));

// Time: 9am, 9:30pm, 14:00, 9u, 9u30, 14h30; "at 9", "om 14h" need the prefix
// (a bare "2h" is a duration: "spend 2h on review").
const TIME_BODY = String.raw`(?:\d{1,2}(?::\d{2})?\s?(?:am|pm)|\d{1,2}:\d{2}|\d{1,2}u(?:\d{2})?|\d{1,2}h\d{2})`;
const TIME = String.raw`(?:(?:at|om|@)\s+)?(?:${TIME_BODY}|(?:(?:at|om)\s+\d{1,2}h?))`;

/** "9am" → "09:00", "9u30" → "09:30", "at 14" → "14:00". Null when out of range. */
export function parseTime(raw: string): string | null {
  const s = raw.toLowerCase().replace(/^(?:at|om|@)\s+/, "").trim();
  let m = s.match(/^(\d{1,2})(?::(\d{2}))?\s?(am|pm)$/);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    if (h < 1 || h > 12 || min > 59) return null;
    if (m[3] === "pm" && h !== 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    return `${pad(h)}:${pad(min)}`;
  }
  m = s.match(/^(\d{1,2})(?:[:uh](\d{2})?)?$/);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    if (h > 23 || min > 59) return null;
    return `${pad(h)}:${pad(min)}`;
  }
  return null;
}

// ── recurrence ───────────────────────────────────────────────────────────────

/** The first due day of a new recurring task: today when it falls on today. */
export function firstOccurrence(r: Recurrence, today: string): string {
  if (r.unit === "week" && r.weekdays?.length) {
    for (let i = 0; i < 7; i++) {
      const d = addDays(today, i);
      if (r.weekdays.includes(weekdayOf(d))) return d;
    }
  }
  if (r.unit === "month" && r.monthDay) {
    const here = addMonths(today, 0, r.monthDay);
    return here >= today ? here : addMonths(today, 1, r.monthDay);
  }
  return today;
}

function step(r: Recurrence, from: string, anchorDay: number): string {
  const n = Math.max(1, r.every);
  switch (r.unit) {
    case "day":
      return addDays(from, n);
    case "week": {
      const days = r.weekdays?.length ? [...r.weekdays].sort() : null;
      if (!days) return addDays(from, 7 * n);
      // Later in the same week first, else the first day of the week n weeks on.
      const wd0 = weekdayOf(from);
      const later = days.find((x) => x > wd0);
      if (later !== undefined) return addDays(from, later - wd0);
      const weekStart = addDays(from, -wd0 + 7 * n);
      return addDays(weekStart, days[0]);
    }
    case "month":
      return addMonths(from, n, r.monthDay ?? anchorDay);
    case "year": {
      const [y, m, d] = from.split("-").map(Number);
      return `${y + n}-${pad(m)}-${pad(Math.min(d === 29 && m === 2 ? anchorDay : d, daysInMonth(y + n, m - 1)))}`;
    }
  }
}

/**
 * The next due day after completing a recurring task due on `due`, done on
 * `today`. "every" counts from the due date and skips past anything not after
 * today (an overdue daily task comes back tomorrow, not yesterday); "every!"
 * counts from today.
 */
export function nextOccurrence(r: Recurrence, due: string, today: string): string {
  const anchorDay = Number(due.slice(8, 10));
  let d = step(r, r.fromCompletion ? today : due, anchorDay);
  for (let i = 0; i < 5000 && d <= today; i++) d = step(r, d, anchorDay);
  return d;
}

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function describeRecurrence(r: Recurrence): string {
  const head = r.fromCompletion ? "every!" : "every";
  if (r.unit === "week" && r.weekdays?.length) {
    const days = [...r.weekdays].sort();
    if (days.join() === "1,2,3,4,5" && r.every === 1) return `${head} weekday`;
    const names = days.map((x) => DAY_NAMES[x]).join(", ");
    return r.every > 1 ? `${head} ${r.every} weeks on ${names}` : `${head} ${names}`;
  }
  if (r.unit === "month" && r.monthDay) return r.every > 1 ? `${head} ${r.every} months on the ${r.monthDay}th` : `${head} ${ordinal(r.monthDay)}`;
  return r.every > 1 ? `${head} ${r.every} ${r.unit}s` : `${head} ${r.unit}`;
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

// ── the scanner ──────────────────────────────────────────────────────────────

const B = String.raw`(?<=^|[\s,(])`;
const E = String.raw`(?=$|[\s,.!?;)])`;

type Span = { start: number; end: number; text: string; m: RegExpExecArray };

/** First match of `body` on word boundaries in what is not consumed yet; consumes it. */
function take(work: { s: string }, body: string, kind: TokenKind, tokens: QuickAdd["tokens"], original: string, notFirst = false): Span | null {
  const re = new RegExp(`${notFirst ? String.raw`(?<=[\s,(])` : B}(?:${body})${E}`, "iu");
  const m = re.exec(work.s);
  if (!m) return null;
  const start = m.index;
  const end = start + m[0].length;
  work.s = work.s.slice(0, start) + " ".repeat(end - start) + work.s.slice(end);
  tokens.push({ kind, text: original.slice(start, end), start, end });
  return { start, end, text: original.slice(start, end), m };
}

const RECUR_KEY = String.raw`(?:every!?|ev!?|each|elke|iedere|om\s+de)`;

const RECUR = [
  // every 2 weeks / elke 3 dagen / om de 2 weken
  String.raw`${RECUR_KEY}\s+(?<n>\d+)\s+(?<unit>${UNIT_RE})`,
  // every other week / om de andere week
  String.raw`${RECUR_KEY}\s+(?:other|andere)\s+(?<ounit>${UNIT_RE})`,
  // every weekday / elke werkdag
  String.raw`${RECUR_KEY}\s+(?<work>weekday|workday|werkdag)`,
  // every monday, wednesday and friday / elke maandag en donderdag
  String.raw`${RECUR_KEY}\s+(?<days>(?:${WD_ANY})(?:\s*(?:,|and|en|&)\s*(?:${WD_ANY}))*)`,
  // every 15th / elke 15e
  String.raw`${RECUR_KEY}\s+(?<dom>\d{1,2})(?:st|nd|rd|th|e|ste|de)`,
  // every day / elke week / every month
  String.raw`${RECUR_KEY}\s+(?<unit1>${UNIT_RE})`,
].join("|");
/** "daily" and friends, never as the first word ("Weekly review" is a title). */
const RECUR_ADVERB = String.raw`(?<adverb>daily|dagelijks|weekly|wekelijks|monthly|maandelijks|yearly|annually|jaarlijks)`;

const ADVERB: Record<string, RecurrenceUnit> = {
  daily: "day", dagelijks: "day", weekly: "week", wekelijks: "week",
  monthly: "month", maandelijks: "month", yearly: "year", annually: "year", jaarlijks: "year",
};

function recurrenceOf(m: RegExpExecArray): Recurrence | null {
  const g = m.groups ?? {};
  const bang = /^(?:every|ev)!/i.test(m[0]) ? { fromCompletion: true } : {};
  if (g.n) return { every: Math.max(1, Number(g.n)), unit: UNIT[g.unit.toLowerCase()], ...bang };
  if (g.ounit) return { every: 2, unit: UNIT[g.ounit.toLowerCase()], ...bang };
  if (g.work) return { every: 1, unit: "week", weekdays: [1, 2, 3, 4, 5], ...bang };
  if (g.days) {
    const days = [...new Set(g.days.split(/\s*(?:,|\band\b|\ben\b|&)\s*|\s+/i).filter(Boolean).map(wd).filter((x) => x !== undefined))];
    return days.length ? { every: 1, unit: "week", weekdays: days.sort(), ...bang } : null;
  }
  if (g.dom) {
    const n = Number(g.dom);
    return n >= 1 && n <= 31 ? { every: 1, unit: "month", monthDay: n, ...bang } : null;
  }
  if (g.unit1) return { every: 1, unit: UNIT[g.unit1.toLowerCase()], ...bang };
  if (g.adverb) return { every: 1, unit: ADVERB[g.adverb.toLowerCase()] };
  return null;
}

const DATE = [
  String.raw`(?<today>today|tod|vandaag)`,
  String.raw`(?<dat>day\s+after\s+tomorrow|overmorgen)`,
  String.raw`(?<tom>tomorrow|tmrw?|morgen)`,
  String.raw`(?<nextweek>next\s+week|volgende\s+week)`,
  String.raw`(?<nextmonth>next\s+month|volgende\s+maand)`,
  String.raw`(?:(?<nextp>next|volgende)\s+|(?:on|op)\s+)(?<wdp>${WD_ANY})`,
  String.raw`(?<wd>${WD_FULL})`,
  String.raw`(?:in|over)\s+(?<inN>\d+)\s+(?<inUnit>${UNIT_RE})`,
  String.raw`(?<iso>\d{4}-\d{2}-\d{2})`,
  // Day first; "/" or "-" only, so version numbers (1.10.1) stay text.
  String.raw`(?<dmy>\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)`,
  String.raw`(?<dmon>\d{1,2})(?:st|nd|rd|th|e|ste|de)?\s+(?<mon1>${MONTH})\.?(?:\s+(?<y1>\d{4}))?`,
  String.raw`(?<mon2>${MONTH})\.?\s+(?<dmon2>\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(?<y2>\d{4}))?`,
].join("|");

/** A day strictly after `today` unless it is explicitly today; year rolls over for past dates. */
function dateOf(m: RegExpExecArray, today: string): string | null {
  const g = m.groups ?? {};
  const [ty] = today.split("-").map(Number);
  const upcoming = (d: number, strictlyAfter: boolean) => {
    const w = weekdayOf(today);
    let delta = (d - w + 7) % 7;
    if (delta === 0 && strictlyAfter) delta = 7;
    return addDays(today, delta);
  };
  const thisOrNextYear = (mo: number, d: number, y?: string): string | null => {
    if (y) return validDay(Number(y.length === 2 ? `20${y}` : y), mo, d);
    const here = validDay(ty, mo, d);
    if (here && here >= today) return here;
    return validDay(ty + 1, mo, d);
  };
  if (g.today) return today;
  if (g.tom) return addDays(today, 1);
  if (g.dat) return addDays(today, 2);
  if (g.nextweek) return upcoming(1, true);
  if (g.nextmonth) return addMonths(today, 1, 1);
  if (g.wdp) return upcoming(wd(g.wdp), !!g.nextp);
  if (g.wd) return upcoming(wd(g.wd), false);
  if (g.inN) {
    const n = Number(g.inN);
    const u = UNIT[g.inUnit.toLowerCase()];
    return u === "day" ? addDays(today, n) : u === "week" ? addDays(today, 7 * n) : u === "month" ? addMonths(today, n) : addMonths(today, 12 * n);
  }
  if (g.iso) {
    const [y, mo, d] = g.iso.split("-").map(Number);
    return validDay(y, mo, d);
  }
  if (g.dmy) {
    // Day first (European): 13/11, 13-11-2026, 1.12.
    const [d, mo, y] = g.dmy.split(/[/-]/);
    return thisOrNextYear(Number(mo), Number(d), y);
  }
  if (g.mon1) return thisOrNextYear(MONTHS[g.mon1.toLowerCase()], Number(g.dmon), g.y1);
  if (g.mon2) return thisOrNextYear(MONTHS[g.mon2.toLowerCase()], Number(g.dmon2), g.y2);
  return null;
}

/**
 * Reads date, time and recurrence out of `work` (consuming them), or null when
 * there are none. A time alone means today.
 */
function scanDue(work: { s: string }, original: string, now: Date, tokens: QuickAdd["tokens"]): Due | null {
  const today = localDay(now);
  const parts: Span[] = [];
  let recurrence: Recurrence | null = null;
  let date: string | null = null;

  const r = take(work, RECUR, "recurrence", tokens, original) ?? take(work, RECUR_ADVERB, "recurrence", tokens, original, true);
  if (r) {
    recurrence = recurrenceOf(r.m);
    if (recurrence) parts.push(r);
  }
  // A match that is no real date ("31/02") stays text, and the scan goes on.
  for (let d = recurrence ? null : take(work, DATE, "date", tokens, original); d; d = take(work, DATE, "date", tokens, original)) {
    date = dateOf(d.m, today);
    if (date) {
      parts.push(d);
      break;
    }
    tokens.pop();
  }
  let time: string | null = null;
  for (let t = take(work, TIME, "time", tokens, original); t; t = take(work, TIME, "time", tokens, original)) {
    time = parseTime(t.text);
    if (time) {
      parts.push(t);
      break;
    }
    tokens.pop();
  }
  if (!recurrence && !date && !time) return null;
  if (recurrence) date = firstOccurrence(recurrence, today);
  if (!date) date = today;
  const string = parts
    .sort((a, b) => a.start - b.start)
    .map((p) => p.text.trim())
    .join(" ");
  return { date, time, recurrence, string };
}

/**
 * Splits a quick-add line into the task and what it says about it:
 * "Call Anna tomorrow 9am p1 #Work @phone" → content "Call Anna", due tomorrow
 * 09:00, P1, project Work, label phone. Unrecognised text stays in the content.
 */
export function parseQuickAdd(text: string, now: Date = new Date()): QuickAdd {
  const tokens: QuickAdd["tokens"] = [];
  const work = { s: text };

  const p = take(work, String.raw`p(?<p>[1-4])`, "priority", tokens, text);
  const priority = p ? (Number(p.m.groups!.p) as Priority) : null;

  // #Project, or #[Project with spaces]
  const pr = take(work, String.raw`#(?:\[(?<pb>[^\]]+)\]|(?<pw>[\p{L}\p{N}_\-./]+))`, "project", tokens, text);
  const project = pr ? (pr.m.groups!.pb ?? pr.m.groups!.pw).trim() : null;

  const labels: string[] = [];
  for (let l = take(work, String.raw`@(?<l>[\p{L}\p{N}_\-./]+)`, "label", tokens, text); l; l = take(work, String.raw`@(?<l>[\p{L}\p{N}_\-./]+)`, "label", tokens, text)) {
    if (!labels.includes(l.m.groups!.l)) labels.push(l.m.groups!.l);
  }

  const due = scanDue(work, text, now, tokens);

  tokens.sort((a, b) => a.start - b.start);
  let content = "";
  let at = 0;
  for (const t of tokens) {
    content += text.slice(at, t.start);
    at = t.end;
  }
  content += text.slice(at);
  content = content.replace(/\s+/g, " ").replace(/\s+([,.!?;])/g, "$1").trim();
  return { content, priority, project, labels, due, tokens };
}

/**
 * A due string on its own ("tomorrow 9am", "elke maandag om 9u", a Todoist
 * due.string). Null unless all of it was understood.
 */
export function parseDue(text: string, now: Date = new Date()): Due | null {
  const work = { s: text };
  const due = scanDue(work, text, now, []);
  if (!due) return null;
  // Allow filler words Todoist puts around dates ("starting", "at").
  if (work.s.replace(/\b(?:starting|vanaf|from|at|om|on|op)\b/gi, "").trim()) return null;
  return { ...due, string: text.trim() };
}
