import type { CalendarEvent, CalendarInfo, EventDraft, EventPatch, EventRef } from "../shared/calendar.ts";
import {
  createGoogleEvent,
  deleteGoogleEvent,
  directAccounts,
  googleCalendars,
  googleEvents,
  parseGoogleCalendarId,
  updateGoogleEvent,
} from "./google.ts";
import { createMacEvent, deleteMacEvent, macCalendars, macEvents, updateMacEvent } from "./macCalendar.ts";

/**
 * One calendar out of two sources. A Google account that is connected is read and
 * written through Google itself, which answers at once; everything else comes from
 * the Calendar app on this Mac. The Mac also holds a synced copy of a connected
 * account's calendars, and those copies are left out so nothing shows twice.
 */
const GOOGLE_LABEL = /google|gmail/i;

type Sources = { calendars: CalendarInfo[]; macHidden: Set<string>; errors: string[] };

async function sources(): Promise<Sources> {
  const mac = await macCalendars();
  const errors: string[] = [];
  const google = (
    await Promise.all(
      directAccounts().map((account) =>
        googleCalendars(account).catch((e: Error) => {
          errors.push(`${account}: ${e.message}`);
          return [] as CalendarInfo[];
        }),
      ),
    )
  ).flat();
  const names = new Set(google.map((c) => c.title.toLowerCase()));
  const accounts = new Set(google.map((c) => c.account.toLowerCase()));
  const isCopy = (c: CalendarInfo) =>
    names.has(c.title.toLowerCase()) && (GOOGLE_LABEL.test(c.account) || accounts.has(c.account.toLowerCase()) || accounts.has(c.title.toLowerCase()));
  const macHidden = new Set(mac.filter(isCopy).map((c) => c.id));
  const hasGoogleDefault = google.some((c) => c.isDefault);
  const kept = mac.filter((c) => !macHidden.has(c.id)).map((c) => (hasGoogleDefault ? { ...c, isDefault: false } : c));
  return { calendars: [...google, ...kept], macHidden, errors };
}

export async function listCalendars(): Promise<CalendarInfo[]> {
  return (await sources()).calendars;
}

const byStart = (a: CalendarEvent, b: CalendarEvent) => a.start - b.start || b.end - a.end;

export async function listEvents(from: number, to: number): Promise<{ events: CalendarEvent[]; errors: string[] }> {
  const [{ macHidden, errors }, mac, google] = await Promise.all([
    sources(),
    macEvents(from, to),
    Promise.all(directAccounts().map((account) => googleEvents(account, from, to).catch((e: Error) => ({ events: [] as CalendarEvent[], errors: [`${account}: ${e.message}`] })))),
  ]);
  const unreachable = google.some((g) => g.events.length === 0 && g.errors.length > 0);
  const fromMac = unreachable ? mac.events : mac.events.filter((e) => !macHidden.has(e.calendarId));
  return {
    events: [...fromMac, ...google.flatMap((g) => g.events)].sort(byStart),
    errors: [...errors, ...google.flatMap((g) => g.errors)],
  };
}

export async function createEvent(draft: EventDraft): Promise<void> {
  if (parseGoogleCalendarId(draft.calendarId) || draft.google) return createGoogleEvent(draft);
  await createMacEvent(draft);
}

export async function updateEvent(patch: EventPatch): Promise<void> {
  if (parseGoogleCalendarId(patch.calendarId)) {
    const { id, occurrence: _occurrence, span: _span, calendarId, seriesId: _seriesId, google: _google, ...fields } = patch;
    return updateGoogleEvent(calendarId!, id, fields);
  }
  const { calendarId: _calendarId, seriesId: _seriesId, ...macPatch } = patch;
  await updateMacEvent(macPatch);
}

export async function deleteEvent(ref: EventRef): Promise<void> {
  if (parseGoogleCalendarId(ref.calendarId)) {
    const wholeSeries = ref.span === "future" && ref.seriesId;
    return deleteGoogleEvent(ref.calendarId!, wholeSeries ? ref.seriesId! : ref.id);
  }
  await deleteMacEvent(ref);
}
