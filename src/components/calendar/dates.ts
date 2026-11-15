import type { CalendarEvent, CalendarView, WeekStart } from "../../../shared/calendar.ts";
import { addDays, addMonths, localDay, weekdayOf } from "../../../shared/taskDates.ts";

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;
export const SNAP_MINUTES = 15;

export const dayKey = (ms: number): string => localDay(new Date(ms));

export const dayStart = (day: string): number => new Date(`${day}T00:00:00`).getTime();

export const atMinutes = (day: string, minutes: number): number => {
  const d = new Date(`${day}T00:00:00`);
  d.setMinutes(minutes);
  return d.getTime();
};

export const minutesOfDay = (ms: number): number => {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
};

export const snap = (minutes: number): number => Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;

const pad = (n: number) => String(n).padStart(2, "0");

export const fmtTime = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const diffDays = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export const shiftDays = (ms: number, days: number): number => {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
};

/** The first and last local day an event touches. */
export const eventDays = (e: Pick<CalendarEvent, "start" | "end" | "allDay">): [string, string] => {
  const last = e.allDay || e.end <= e.start ? e.end : e.end - 1;
  return [dayKey(e.start), dayKey(Math.max(last, e.start))];
};

/** Shown as a bar across days rather than a block in the hours. */
export const isBar = (e: Pick<CalendarEvent, "start" | "end" | "allDay">): boolean => e.allDay || e.end - e.start >= DAY_MS;

const weekOf = (day: string, weekStart: number): string => addDays(day, -((weekdayOf(day) - weekStart + 7) % 7));

export function visibleDays(view: CalendarView, anchor: string, weekStart: WeekStart): string[] {
  if (view === "workweek") {
    const monday = weekOf(anchor, 1);
    return Array.from({ length: 5 }, (_, i) => addDays(monday, i));
  }
  if (view === "week") {
    const first = weekOf(anchor, weekStart);
    return Array.from({ length: 7 }, (_, i) => addDays(first, i));
  }
  const firstOfMonth = `${anchor.slice(0, 8)}01`;
  const lastOfMonth = addDays(addMonths(firstOfMonth, 1), -1);
  const first = weekOf(firstOfMonth, weekStart);
  const weeks = Math.ceil((diffDays(first, lastOfMonth) + 1) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => addDays(first, i));
}

export const shiftAnchor = (view: CalendarView, anchor: string, direction: 1 | -1): string =>
  view === "month" ? addMonths(`${anchor.slice(0, 8)}01`, direction) : addDays(anchor, 7 * direction);

const asDate = (day: string) => new Date(`${day}T00:00:00`);

const NEARBY_WEEKS: Record<number, string> = { [-7]: "Previous week", 0: "This week", 7: "Next week" };

/** What the toolbar calls the range on show: a nearby week by name with its dates beside it, anything else by its dates. */
export function rangeTitle(view: CalendarView, days: string[], anchor: string, today: string, weekStart: WeekStart): { title: string; dates: string | null } {
  if (view === "month") return { title: asDate(anchor).toLocaleDateString(undefined, { month: "long", year: "numeric" }), dates: null };
  const first = asDate(days[0]);
  const last = asDate(days[days.length - 1]);
  const sameMonth = first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear();
  const from = first.toLocaleDateString(undefined, sameMonth ? { day: "numeric" } : { day: "numeric", month: "short" });
  const range = (year: boolean) => `${from} – ${last.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}) })}`;
  const nearby = NEARBY_WEEKS[diffDays(visibleDays(view, today, weekStart)[0], days[0])];
  return nearby ? { title: nearby, dates: range(false) } : { title: range(true), dates: null };
}

export const weekdayShort = (day: string): string => asDate(day).toLocaleDateString(undefined, { weekday: "short" });

export const dayOfMonth = (day: string): number => Number(day.slice(8));

export function whenText(e: Pick<CalendarEvent, "start" | "end" | "allDay">): string {
  const [first, last] = eventDays(e);
  const long = (day: string) => asDate(day).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  if (e.allDay) return first === last ? `${long(first)} · all day` : `${long(first)} – ${long(last)}`;
  if (first === last) return `${long(first)} · ${fmtTime(e.start)} – ${fmtTime(e.end)}`;
  return `${long(first)} ${fmtTime(e.start)} – ${long(last)} ${fmtTime(e.end)}`;
}

export type Placed<T> = T & { column: number; columns: number };

const MIN_LAYOUT_MINUTES = 25;

/** Side-by-side columns for items that overlap in time, the way a calendar stacks clashing meetings. */
export function layoutColumns<T extends { from: number; to: number }>(items: T[]): Placed<T>[] {
  const sorted = [...items].sort((a, b) => a.from - b.from || b.to - a.to);
  const placed: Placed<T>[] = [];
  let cluster: Placed<T>[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    for (const item of cluster) item.columns = columnEnds.length;
    placed.push(...cluster);
    cluster = [];
    columnEnds = [];
  };
  for (const item of sorted) {
    const to = Math.max(item.to, item.from + MIN_LAYOUT_MINUTES);
    if (item.from >= clusterEnd && cluster.length) flush();
    let column = columnEnds.findIndex((end) => end <= item.from);
    if (column === -1) column = columnEnds.length;
    columnEnds[column] = to;
    cluster.push({ ...item, column, columns: 1 });
    clusterEnd = cluster.length === 1 ? to : Math.max(clusterEnd, to);
  }
  flush();
  return placed;
}
