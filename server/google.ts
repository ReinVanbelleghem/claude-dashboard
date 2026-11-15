import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Attendee, Availability, CalendarEvent, EventDraft, GoogleStatus } from "../shared/calendar.ts";
import { addDays, localDay } from "../shared/taskDates.ts";
import { DATA_DIR, PORT } from "./paths.ts";

const STORE_PATH = join(DATA_DIR, "google.json");
const REDIRECT_URI = `http://localhost:${PORT}/api/google/callback`;
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
].join(" ");
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/calendar/v3";
const PENDING_TTL_MS = 10 * 60_000;

type Account = { email: string; refreshToken: string };
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
  write({ ...s, accounts: [...(s.accounts ?? []).filter((a) => a.email !== email), { email, refreshToken: data.refresh_token }] });
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

type GoogleAttendee = { email: string; resource?: boolean; responseStatus?: string };
type GoogleEvent = { id: string; htmlLink?: string; hangoutLink?: string; attendees?: GoogleAttendee[] };

const attendeesOf = (guests: string[], rooms: string[]): GoogleAttendee[] => [
  ...guests.map((email) => ({ email })),
  ...rooms.map((email) => ({ email, resource: true })),
];

export async function createGoogleEvent(draft: EventDraft): Promise<{ link: string | null; meet: string | null }> {
  const invite = draft.google;
  if (!invite) throw new Error("No Google account was chosen for this event.");
  const when = draft.allDay
    ? { start: { date: localDay(new Date(draft.start)) }, end: { date: addDays(localDay(new Date(draft.end)), 1) } }
    : { start: { dateTime: new Date(draft.start).toISOString() }, end: { dateTime: new Date(draft.end).toISOString() } };
  const body = {
    summary: draft.title,
    location: draft.location || undefined,
    description: draft.notes || undefined,
    ...when,
    attendees: attendeesOf(invite.guests, invite.rooms),
    ...(invite.meet
      ? { conferenceData: { createRequest: { requestId: base64url(randomBytes(12)), conferenceSolutionKey: { type: "hangoutsMeet" } } } }
      : {}),
  };
  const created = await api<GoogleEvent>(invite.account, "/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1", { method: "POST", body });
  return { link: created.htmlLink ?? null, meet: created.hangoutLink ?? null };
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

type OtherMoment = { date?: string; dateTime?: string };
type OtherEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  recurringEventId?: string;
  start?: OtherMoment;
  end?: OtherMoment;
  attendees?: { email?: string; displayName?: string; responseStatus?: string; resource?: boolean; self?: boolean }[];
};

const REPLY: Record<string, Attendee["status"]> = { accepted: "accepted", declined: "declined", tentative: "tentative" };

const plainText = (html: string) => html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();

function accountFor(email: string): string {
  const accounts = (read().accounts ?? []).map((a) => a.email);
  const domain = email.split("@")[1];
  const account = accounts.find((a) => a.endsWith(`@${domain}`)) ?? accounts[0];
  if (!account) throw new Error("Connect a Google account first.");
  return account;
}

function otherEvent(email: string, e: OtherEvent): CalendarEvent | null {
  if (e.status === "cancelled" || !e.start || !e.end) return null;
  if (e.attendees?.find((a) => a.email?.toLowerCase() === email.toLowerCase())?.responseStatus === "declined") return null;
  const allDay = e.start.date !== undefined;
  const start = new Date(e.start.dateTime ?? `${e.start.date}T00:00:00`).getTime();
  const end = allDay ? new Date(`${e.end.date}T00:00:00`).getTime() - 1000 : new Date(e.end.dateTime ?? "").getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return {
    key: `other:${email}:${e.id}`,
    id: e.id,
    externalId: null,
    occurrence: start,
    calendarId: `other:${email}`,
    calendar: email,
    account: "",
    color: null,
    title: e.summary ?? "Busy",
    start,
    end,
    allDay,
    location: e.location ?? null,
    notes: e.description ? plainText(e.description) : null,
    url: e.htmlLink ?? null,
    recurring: e.recurringEventId !== undefined,
    editable: false,
    attendees: (e.attendees ?? []).map((a) => ({
      name: a.displayName ?? a.email ?? "",
      email: a.email ?? null,
      status: REPLY[a.responseStatus ?? ""] ?? "pending",
      room: a.resource === true,
      me: false,
    })),
    other: true,
  };
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
    const page = await api<{ items?: OtherEvent[] }>(account, `/calendars/${encodeURIComponent(email)}/events?${params}`);
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
