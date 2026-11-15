import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Attendee, Availability, CalendarEvent, CalendarInfo, EventDraft, GoogleStatus } from "../shared/calendar.ts";
import { addDays, localDay } from "../shared/taskDates.ts";
import { DATA_DIR, PORT } from "./paths.ts";

const STORE_PATH = join(DATA_DIR, "google.json");
const REDIRECT_URI = `http://localhost:${PORT}/api/google/callback`;
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.freebusy",
].join(" ");
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/calendar/v3";
const PENDING_TTL_MS = 10 * 60_000;

type Account = { email: string; refreshToken: string; scope?: string };

const canListCalendars = (a: Account) => (a.scope ?? "").includes("calendar.calendarlist");
const ID_PREFIX = "g:";

/** A Google calendar's id as the rest of the dashboard sees it, and back again. */
export const googleCalendarId = (account: string, calendar: string) => `${ID_PREFIX}${account}:${calendar}`;

export function parseGoogleCalendarId(id: string | undefined): { account: string; calendar: string } | null {
  if (!id?.startsWith(ID_PREFIX)) return null;
  const rest = id.slice(ID_PREFIX.length);
  const split = rest.indexOf(":");
  return split === -1 ? null : { account: rest.slice(0, split), calendar: rest.slice(split + 1) };
}
type Store = { clientId?: string; clientSecret?: string; accounts?: Account[] };

let store: Store | null = null;
const access = new Map<string, { token: string; expiresAt: number }>();
const pending = new Map<string, { verifier: string; at: number }>();

function read(): Store {
  if (store) return store;
  try {
    store = existsSync(STORE_PATH) ? (JSON.parse(readFileSync(STORE_PATH, "utf8")) as Store) : {};
  } catch {
    store = {};
  }
  return store;
}

function write(next: Store) {
  store = next;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  chmodSync(STORE_PATH, 0o600);
}

function client(): { id: string; secret: string } | null {
  const s = read();
  const id = s.clientId ?? process.env.GOOGLE_CLIENT_ID;
  const secret = s.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET;
  return id && secret ? { id, secret } : null;
}

const base64url = (buf: Buffer) => buf.toString("base64url");

export function googleStatus(): GoogleStatus {
  const s = read();
  const saved = Boolean(s.clientId && s.clientSecret);
  return {
    hasClient: client() !== null,
    clientSource: saved ? "saved" : client() ? "environment" : null,
    accounts: (s.accounts ?? []).map((a) => a.email),
    needsReconnect: (s.accounts ?? []).filter((a) => !canListCalendars(a)).map((a) => a.email),
  };
}

async function revokeAll(accounts: Account[]): Promise<void> {
  await Promise.all(accounts.map((a) => fetch(`${REVOKE_URL}?token=${encodeURIComponent(a.refreshToken)}`, { method: "POST" }).catch(() => {})));
  access.clear();
}

/** Save your own Google client. Accounts signed in through a previous client are signed out, since their access belonged to it. */
export async function setGoogleClient(clientId: string, clientSecret: string): Promise<GoogleStatus> {
  await revokeAll(read().accounts ?? []);
  write({ clientId: clientId.trim(), clientSecret: clientSecret.trim(), accounts: [] });
  return googleStatus();
}

export async function removeGoogleClient(): Promise<GoogleStatus> {
  await revokeAll(read().accounts ?? []);
  write({});
  return googleStatus();
}

export function googleConnectUrl(): string | null {
  const c = client();
  if (!c) return null;
  const now = Date.now();
  for (const [key, p] of pending) if (now - p.at > PENDING_TTL_MS) pending.delete(key);
  const state = base64url(randomBytes(16));
  const verifier = base64url(randomBytes(32));
  pending.set(state, { verifier, at: now });
  const params = new URLSearchParams({
    client_id: c.id,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent select_account",
    state,
    code_challenge: base64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(data.error_description ?? data.error ?? `Google's token endpoint answered ${res.status}`));
  return data;
}

function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: string };
    return claims.email ?? null;
  } catch {
    return null;
  }
}

export async function finishGoogleConnect(code: string, state: string): Promise<string> {
  const p = pending.get(state);
  pending.delete(state);
  const c = client();
  if (!p) throw new Error("This sign-in link is stale. Start again from the calendar's menu.");
  if (!c) throw new Error("No Google client is set up.");
  const data = await tokenRequest({
    client_id: c.id,
    client_secret: c.secret,
    code,
    code_verifier: p.verifier,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  });
  const email = emailFromIdToken(data.id_token);
  if (typeof data.refresh_token !== "string" || !email) throw new Error("Google did not grant lasting access. Try again and tick every permission.");
  const granted = String(data.scope ?? "");
  if (!granted.includes("calendar.events")) throw new Error("Calendar access was not ticked on Google's screen. Try again and allow it.");
  const s = read();
  write({ ...s, accounts: [...(s.accounts ?? []).filter((a) => a.email !== email), { email, refreshToken: data.refresh_token, scope: granted }] });
  calendarLists.delete(email);
  access.set(email, { token: String(data.access_token), expiresAt: Date.now() + Number(data.expires_in ?? 0) * 1000 });
  return email;
}

export async function disconnectGoogle(email: string): Promise<GoogleStatus> {
  const s = read();
  const account = (s.accounts ?? []).find((a) => a.email === email);
  if (account) await fetch(`${REVOKE_URL}?token=${encodeURIComponent(account.refreshToken)}`, { method: "POST" }).catch(() => {});
  access.delete(email);
  write({ ...s, accounts: (s.accounts ?? []).filter((a) => a.email !== email) });
  return googleStatus();
}

async function accessToken(email: string): Promise<string> {
  const cached = access.get(email);
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
  const c = client();
  const account = (read().accounts ?? []).find((a) => a.email === email);
  if (!c || !account) throw new Error(`${email} is not connected to Google.`);
  const data = await tokenRequest({ client_id: c.id, client_secret: c.secret, refresh_token: account.refreshToken, grant_type: "refresh_token" });
  const token = String(data.access_token);
  access.set(email, { token, expiresAt: Date.now() + Number(data.expires_in ?? 0) * 1000 });
  return token;
}

async function api<T>(email: string, path: string, init?: { method: string; body: unknown }): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    headers: { authorization: `Bearer ${await accessToken(email)}`, "content-type": "application/json" },
    body: init ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) throw new Error(data.error?.message ?? `Google Calendar answered ${res.status}`);
  return data as T;
}

type GoogleAttendee = { email: string; displayName?: string; resource?: boolean; responseStatus?: string; self?: boolean };
type GoogleMoment = { date?: string; dateTime?: string };
type GoogleEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  iCalUID?: string;
  recurringEventId?: string;
  start?: GoogleMoment;
  end?: GoogleMoment;
  attendees?: GoogleAttendee[];
};
type GoogleCalendar = { id: string; summary?: string; summaryOverride?: string; backgroundColor?: string; accessRole?: string; primary?: boolean };

const CALENDAR_LIST_TTL_MS = 5 * 60_000;
const calendarLists = new Map<string, { at: number; list: GoogleCalendar[] }>();

/** The accounts whose calendars the dashboard reads straight from Google. */
export const directAccounts = (): string[] => (read().accounts ?? []).filter(canListCalendars).map((a) => a.email);

async function calendarList(account: string): Promise<GoogleCalendar[]> {
  const cached = calendarLists.get(account);
  if (cached && Date.now() - cached.at < CALENDAR_LIST_TTL_MS) return cached.list;
  const page = await api<{ items?: GoogleCalendar[] }>(account, "/users/me/calendarList?maxResults=250");
  const list = page.items ?? [];
  calendarLists.set(account, { at: Date.now(), list });
  return list;
}

const nameOf = (c: GoogleCalendar) => c.summaryOverride ?? c.summary ?? c.id;
const writable = (c: GoogleCalendar) => c.accessRole === "owner" || c.accessRole === "writer";

export async function googleCalendars(account: string): Promise<CalendarInfo[]> {
  return (await calendarList(account)).map((c) => ({
    id: googleCalendarId(account, c.id),
    title: nameOf(c),
    account,
    color: c.backgroundColor ?? null,
    editable: writable(c),
    isDefault: c.primary === true,
    google: account,
  }));
}

const REPLY: Record<string, Attendee["status"]> = { accepted: "accepted", declined: "declined", tentative: "tentative" };

const plainText = (html: string) => html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();

type Placement = { key: string; calendarId: string; calendar: string; account: string; color: string | null; editable: boolean; me: string | null };

function toCalendarEvent(e: GoogleEvent, at: Placement): CalendarEvent | null {
  if (e.status === "cancelled" || !e.start || !e.end) return null;
  const allDay = e.start.date !== undefined;
  const start = new Date(e.start.dateTime ?? `${e.start.date}T00:00:00`).getTime();
  const end = allDay ? new Date(`${e.end.date}T00:00:00`).getTime() - 1000 : new Date(e.end.dateTime ?? "").getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return {
    key: `${at.key}:${e.id}`,
    id: e.id,
    externalId: e.iCalUID ?? null,
    occurrence: start,
    calendarId: at.calendarId,
    calendar: at.calendar,
    account: at.account,
    color: at.color,
    title: e.summary ?? "Busy",
    start,
    end,
    allDay,
    location: e.location ?? null,
    notes: e.description ? plainText(e.description) : null,
    url: e.hangoutLink ?? null,
    recurring: e.recurringEventId !== undefined,
    seriesId: e.recurringEventId ?? null,
    editable: at.editable,
    attendees: (e.attendees ?? []).map((a) => ({
      name: a.displayName ?? a.email ?? "",
      email: a.email ?? null,
      status: REPLY[a.responseStatus ?? ""] ?? "pending",
      room: a.resource === true,
      me: a.self === true || (at.me !== null && a.email?.toLowerCase() === at.me.toLowerCase()),
    })),
  };
}

const MAX_EVENT_PAGES = 4;

/** Every event of an account's calendars in a range, read from Google. A calendar that fails is reported, not fatal. */
export async function googleEvents(account: string, from: number, to: number): Promise<{ events: CalendarEvent[]; errors: string[] }> {
  const calendars = await calendarList(account);
  const errors: string[] = [];
  const perCalendar = await Promise.all(
    calendars.map(async (c) => {
      const at: Placement = { key: `g:${account}:${c.id}`, calendarId: googleCalendarId(account, c.id), calendar: nameOf(c), account, color: c.backgroundColor ?? null, editable: writable(c), me: account };
      const found: CalendarEvent[] = [];
      try {
        let pageToken: string | undefined;
        for (let page = 0; page < MAX_EVENT_PAGES; page++) {
          const params = new URLSearchParams({ singleEvents: "true", orderBy: "startTime", maxResults: "250", timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString() });
          if (pageToken) params.set("pageToken", pageToken);
          const reply = await api<{ items?: GoogleEvent[]; nextPageToken?: string }>(account, `/calendars/${encodeURIComponent(c.id)}/events?${params}`);
          for (const e of reply.items ?? []) {
            const event = toCalendarEvent(e, at);
            if (event) found.push(event);
          }
          pageToken = reply.nextPageToken;
          if (!pageToken) break;
        }
      } catch (err) {
        errors.push(`${nameOf(c)}: ${(err as Error).message}`);
      }
      return found;
    }),
  );
  return { events: perCalendar.flat(), errors };
}

const momentsOf = (start: number, end: number, allDay: boolean) =>
  allDay
    ? { start: { date: localDay(new Date(start)) }, end: { date: addDays(localDay(new Date(end)), 1) } }
    : { start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(end).toISOString() } };

const eventPath = (calendar: string, id: string) => `/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(id)}`;

/** Change an event in a Google calendar. On a repeating event this changes the one occurrence. */
export async function updateGoogleEvent(calendarId: string, id: string, fields: Partial<EventDraft>, current?: { start: number; end: number; allDay: boolean }): Promise<void> {
  const at = parseGoogleCalendarId(calendarId);
  if (!at) throw new Error("that is not a Google calendar");
  const body: Record<string, unknown> = {};
  if (fields.title !== undefined) body.summary = fields.title;
  if (fields.location !== undefined) body.location = fields.location;
  if (fields.notes !== undefined) body.description = fields.notes;
  if (fields.start !== undefined || fields.end !== undefined || fields.allDay !== undefined) {
    const start = fields.start ?? current?.start;
    const end = fields.end ?? current?.end;
    if (start === undefined || end === undefined) throw new Error("a start and an end are both needed to move an event");
    Object.assign(body, momentsOf(start, end, fields.allDay ?? current?.allDay ?? false));
  }
  await api(at.account, `${eventPath(at.calendar, id)}?sendUpdates=all`, { method: "PATCH", body });
}

export async function deleteGoogleEvent(calendarId: string, id: string): Promise<void> {
  const at = parseGoogleCalendarId(calendarId);
  if (!at) throw new Error("that is not a Google calendar");
  const res = await fetch(`${API}${eventPath(at.calendar, id)}?sendUpdates=all`, { method: "DELETE", headers: { authorization: `Bearer ${await accessToken(at.account)}` } });
  if (!res.ok && res.status !== 410) throw new Error(`Google Calendar answered ${res.status}`);
}

/** Replace who is invited to an event in a Google calendar, keeping the replies of everyone who stays. */
export async function setGoogleEventGuests(calendarId: string, id: string, guests: string[], rooms: string[]): Promise<void> {
  const at = parseGoogleCalendarId(calendarId);
  if (!at) throw new Error("that is not a Google calendar");
  const event = await api<GoogleEvent>(at.account, eventPath(at.calendar, id));
  const current = new Map((event.attendees ?? []).map((a) => [a.email.toLowerCase(), a]));
  const self = (event.attendees ?? []).filter((a) => a.self);
  const attendees = [...self, ...attendeesOf(guests, rooms).filter((a) => !self.some((me) => me.email.toLowerCase() === a.email.toLowerCase())).map((a) => current.get(a.email.toLowerCase()) ?? a)];
  await api(at.account, `${eventPath(at.calendar, id)}?sendUpdates=all`, { method: "PATCH", body: { attendees } });
}

const attendeesOf = (guests: string[], rooms: string[]): GoogleAttendee[] => [
  ...guests.map((email) => ({ email })),
  ...rooms.map((email) => ({ email, resource: true })),
];

/** Create an event in Google: in the draft's own Google calendar, or the inviting account's main one. */
export async function createGoogleEvent(draft: EventDraft): Promise<void> {
  const at = parseGoogleCalendarId(draft.calendarId) ?? (draft.google ? { account: draft.google.account, calendar: "primary" } : null);
  if (!at) throw new Error("No Google calendar was chosen for this event.");
  const invite = draft.google;
  const body = {
    summary: draft.title,
    location: draft.location || undefined,
    description: draft.notes || undefined,
    ...momentsOf(draft.start, draft.end, draft.allDay),
    ...(invite ? { attendees: attendeesOf(invite.guests, invite.rooms) } : {}),
    ...(invite?.meet
      ? { conferenceData: { createRequest: { requestId: base64url(randomBytes(12)), conferenceSolutionKey: { type: "hangoutsMeet" } } } }
      : {}),
  };
  await api(at.account, `/calendars/${encodeURIComponent(at.calendar)}/events?sendUpdates=all&conferenceDataVersion=1`, { method: "POST", body });
}

/** Replace who is invited to an event the Mac knows by its iCalendar id, keeping the replies of everyone who stays. */
export async function setGoogleGuests(account: string, externalId: string, guests: string[], rooms: string[]): Promise<void> {
  const found = await api<{ items?: GoogleEvent[] }>(account, `/calendars/primary/events?iCalUID=${encodeURIComponent(externalId)}&maxResults=1`);
  const event = found.items?.[0];
  if (!event) throw new Error(`This event is not on ${account}'s main Google calendar, so its guests cannot be changed here.`);
  const current = new Map((event.attendees ?? []).map((a) => [a.email.toLowerCase(), a]));
  const attendees = attendeesOf(guests, rooms).map((a) => current.get(a.email.toLowerCase()) ?? a);
  await api(account, `/calendars/primary/events/${encodeURIComponent(event.id)}?sendUpdates=all`, { method: "PATCH", body: { attendees } });
}

export async function googleAvailability(account: string, emails: string[], start: number, end: number): Promise<Record<string, Availability>> {
  if (emails.length === 0) return {};
  const reply = await api<{ calendars?: Record<string, { busy?: unknown[]; errors?: unknown[] }> }>(account, "/freeBusy", {
    method: "POST",
    body: { timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), items: emails.map((id) => ({ id })) },
  });
  return Object.fromEntries(
    emails.map((email) => {
      const entry = reply.calendars?.[email];
      const state: Availability = !entry || entry.errors?.length ? "unknown" : entry.busy?.length ? "busy" : "free";
      return [email, state];
    }),
  );
}

function accountFor(email: string): string {
  const accounts = (read().accounts ?? []).map((a) => a.email);
  const domain = email.split("@")[1];
  const account = accounts.find((a) => a.endsWith(`@${domain}`)) ?? accounts[0];
  if (!account) throw new Error("Connect a Google account first.");
  return account;
}

function otherEvent(email: string, e: GoogleEvent): CalendarEvent | null {
  if (e.attendees?.find((a) => a.email?.toLowerCase() === email.toLowerCase())?.responseStatus === "declined") return null;
  const event = toCalendarEvent(e, { key: `other:${email}`, calendarId: `other:${email}`, calendar: email, account: "", color: null, editable: false, me: null });
  return event ? { ...event, url: e.htmlLink ?? null, other: true } : null;
}

const busyBlock = (email: string, start: number, end: number): CalendarEvent => ({
  key: `other:${email}:busy-${start}`,
  id: `busy-${start}`,
  externalId: null,
  occurrence: start,
  calendarId: `other:${email}`,
  calendar: email,
  account: "",
  color: null,
  title: "Busy",
  start,
  end,
  allDay: false,
  location: null,
  notes: null,
  url: null,
  recurring: false,
  editable: false,
  attendees: [],
  other: true,
});

/**
 * Someone else's or a room's events in a range. When their calendar only shares
 * free and busy times with you, the result is busy blocks without details.
 */
export async function googleOtherEvents(email: string, from: number, to: number): Promise<{ events: CalendarEvent[]; limited: boolean }> {
  const account = accountFor(email);
  const window = { timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString() };
  try {
    const params = new URLSearchParams({ ...window, singleEvents: "true", orderBy: "startTime", maxResults: "250" });
    const page = await api<{ items?: GoogleEvent[] }>(account, `/calendars/${encodeURIComponent(email)}/events?${params}`);
    const events = (page.items ?? []).map((e) => otherEvent(email, e)).filter((e): e is CalendarEvent => e !== null);
    return { events, limited: false };
  } catch {
    const reply = await api<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason?: string }[] }> }>(account, "/freeBusy", {
      method: "POST",
      body: { ...window, items: [{ id: email }] },
    });
    const entry = reply.calendars?.[email];
    if (!entry || entry.errors?.length) throw new Error(`${email}'s calendar is not shared with ${account}.`);
    return { events: (entry.busy ?? []).map((b) => busyBlock(email, new Date(b.start).getTime(), new Date(b.end).getTime())), limited: true };
  }
}
