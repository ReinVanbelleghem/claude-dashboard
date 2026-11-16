import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replyOf, type CalendarEvent } from "../shared/calendar.ts";
import { listEvents } from "./calendarSources.ts";
import { fireEvent } from "./notify.ts";
import { DATA_DIR } from "./paths.ts";
import { getSettings } from "./settings.ts";

const STORE_PATH = join(DATA_DIR, "calendar-watch.json");
const REFRESH_MS = 2 * 60_000;
const TICK_MS = 20_000;
const FIRST_REFRESH_MS = 5_000;
const INVITE_HORIZON_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_LEAD_MINUTES = 10;
const MAX_LEAD_MINUTES = 240;
const HREF = "#/calendar";

type Store = {
  /** Invitations already seen unanswered; null until the first reading, which only takes stock. */
  invites: string[] | null;
  /** Occurrences already announced as starting, with their start so past ones can be dropped. */
  reminded: Record<string, number>;
};

let store: Store | null = null;
let cached: CalendarEvent[] = [];

function state(): Store {
  if (store) return store;
  try {
    const saved = existsSync(STORE_PATH) ? (JSON.parse(readFileSync(STORE_PATH, "utf8")) as Partial<Store>) : {};
    store = { invites: Array.isArray(saved.invites) ? saved.invites : null, reminded: saved.reminded ?? {} };
  } catch {
    store = { invites: null, reminded: {} };
  }
  return store;
}

function keep(next: Store) {
  store = next;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(next, null, 2));
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const day = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const span = (e: CalendarEvent) => (e.allDay ? "all day" : `${clock(e.start)}–${clock(e.end)}`);

const inviteKey = (e: CalendarEvent) => `${e.calendarId}:${e.seriesId ?? e.id}`;
const occurrenceKey = (e: CalendarEvent) => `${e.key}:${e.start}`;

/** The lead time for "starting soon", from settings, kept within sane bounds. */
export function leadMinutes(): number {
  const raw = Number(getSettings().ui.calendarReminderMinutes);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_LEAD_MINUTES;
  return Math.min(MAX_LEAD_MINUTES, Math.round(raw));
}

const watched = (events: CalendarEvent[], hidden: string[]) => events.filter((e) => !e.other && !e.draft && !hidden.includes(e.calendarId));

/** Unanswered invitations not seen before, one per repeating series, and the set to remember. */
export function newInvites(events: CalendarEvent[], known: string[] | null, complete: boolean): { fresh: CalendarEvent[]; known: string[] } {
  const pending = new Map<string, CalendarEvent>();
  for (const e of events) {
    if (replyOf(e) !== "pending") continue;
    const key = inviteKey(e);
    if (!pending.has(key)) pending.set(key, e);
  }
  const before = new Set(known ?? []);
  const fresh = known === null ? [] : [...pending].filter(([key]) => !before.has(key)).map(([, e]) => e);
  const next = complete ? [...pending.keys()] : [...new Set([...before, ...pending.keys()])];
  return { fresh, known: next };
}

/** Timed events that start within the lead time and have not been announced yet. */
export function startingSoon(events: CalendarEvent[], now: number, leadMs: number, reminded: Record<string, number>): CalendarEvent[] {
  return events.filter((e) => !e.allDay && e.start > now && e.start - now <= leadMs && replyOf(e) !== "declined" && reminded[occurrenceKey(e)] === undefined);
}

function wanted(): { invite: boolean; starting: boolean } {
  const n = getSettings().notifications;
  return { invite: n.enabled && n.events.calendarInvite, starting: n.enabled && n.events.calendarStarting };
}

async function refresh() {
  const want = wanted();
  if (!want.invite && !want.starting) {
    cached = [];
    if (state().invites !== null) keep({ ...state(), invites: null });
    return;
  }
  const now = Date.now();
  const { events, errors } = await listEvents(now, now + INVITE_HORIZON_MS);
  cached = watched(events, getSettings().ui.calendarHidden ?? []);
  const { fresh, known } = newInvites(cached, state().invites, errors.length === 0);
  keep({ ...state(), invites: known });
  if (!want.invite) return;
  for (const e of fresh) {
    const from = e.organizer ? ` · from ${e.organizer}` : "";
    void fireEvent(
      {
        kind: "calendarInvite",
        key: `calendar:invite:${inviteKey(e)}`,
        sessionId: null,
        muteIds: [],
        label: e.title,
        context: e.recurring ? `${e.calendar} · repeats` : e.calendar,
        detail: `${day(e.start)}, ${span(e)}${from}`,
      },
      HREF,
    );
  }
}

function tick() {
  if (!wanted().starting) return;
  const now = Date.now();
  const due = startingSoon(cached, now, leadMinutes() * 60_000, state().reminded);
  if (due.length === 0) return;
  const reminded = Object.fromEntries(Object.entries(state().reminded).filter(([, start]) => start > now));
  for (const e of due) reminded[occurrenceKey(e)] = e.start;
  keep({ ...state(), reminded });
  for (const e of due) {
    const minutes = Math.max(1, Math.round((e.start - now) / 60_000));
    const where = e.location ? ` · ${e.location}` : "";
    void fireEvent(
      {
        kind: "calendarStarting",
        key: `calendar:starting:${occurrenceKey(e)}`,
        sessionId: null,
        muteIds: [],
        label: e.title,
        context: e.calendar,
        detail: `In ${minutes} min · ${span(e)}${where}`,
      },
      HREF,
    );
  }
}

/** Watches your calendars for new invitations and for meetings about to start. */
export function initCalendarWatch() {
  const safely = (work: () => void | Promise<void>, what: string) => async () => {
    try {
      await work();
    } catch (err) {
      console.error(`[claude-dashboard] calendar ${what} failed:`, err);
    }
  };
  const reading = safely(refresh, "watch");
  setTimeout(reading, FIRST_REFRESH_MS);
  setInterval(reading, REFRESH_MS);
  setInterval(safely(tick, "reminders"), TICK_MS);
}
