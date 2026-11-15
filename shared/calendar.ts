export type MacAccess = "granted" | "denied" | "notDetermined" | "unknown";

export type MacCalendarStatus = {
  /** macOS with either the built helper or a Swift compiler to build it. */
  available: boolean;
  enabled: boolean;
  access: MacAccess;
};

export type CalendarView = "week" | "workweek" | "month";

/** 0 = Sunday, 1 = Monday, 6 = Saturday. */
export type WeekStart = 0 | 1 | 6;

export type Attendee = {
  name: string;
  status: "accepted" | "declined" | "tentative" | "pending";
  email: string | null;
  /** A meeting room or other resource rather than a person. */
  room: boolean;
  me: boolean;
};

export type CalendarEvent = {
  /** Unique per occurrence, so two days of one repeating event can sit in one list. */
  key: string;
  id: string;
  /** The event's iCalendar id, which is how Google knows the same event. */
  externalId: string | null;
  /** When this occurrence was originally due, in ms; with `id` it names one occurrence of a repeating event. */
  occurrence: number;
  calendarId: string;
  calendar: string;
  account: string;
  color: string | null;
  title: string;
  /** Epoch ms. An all-day event ends inside its last day, not at the midnight after it. */
  start: number;
  end: number;
  allDay: boolean;
  location: string | null;
  notes: string | null;
  url: string | null;
  recurring: boolean;
  editable: boolean;
  attendees: Attendee[];
  /** From someone else's or a room's calendar, shown beside your own for comparison. */
  other?: boolean;
  /** A suggested meeting that does not exist yet; it waits for approval. */
  draft?: boolean;
  /** A stand-in for an event Google has just created, shown until the Mac has synced the real one. */
  syncing?: boolean;
};

/** A colleague's or a room's calendar kept in the sidebar. */
export type OtherCalendar = { email: string; name: string; color: string; shown: boolean; room?: boolean };

export type CalendarInfo = {
  id: string;
  title: string;
  account: string;
  color: string | null;
  editable: boolean;
  isDefault: boolean;
};

export type EventDraft = {
  calendarId?: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location?: string;
  notes?: string;
  /** Set when the event has guests, a room or a Meet link: Google then creates it and sends the invitations. */
  google?: GoogleInvite;
};

/** A meeting suggested by a planning session, shown on the calendar as a draft until approved or discarded. */
export type Proposal = EventDraft & { id: string; createdAt: number };

export type GoogleInvite = { account: string; guests: string[]; rooms: string[]; meet: boolean };

export type GoogleStatus = {
  hasClient: boolean;
  /** Where the client comes from: saved through the dashboard, or handed to the daemon in its environment. */
  clientSource: "saved" | "environment" | null;
  accounts: string[];
};

export type Availability = "free" | "busy" | "unknown";

/** Someone or some room seen on your events, for suggesting who to invite. */
export type Person = { email: string; name: string; room: boolean; count: number };

export type EventRef = {
  id: string;
  occurrence: number;
  /** For a repeating event: only this occurrence, or this one and every later one. */
  span?: "this" | "future";
};

export type EventPatch = EventRef & Partial<EventDraft>;

export type CalendarPayload = { events: CalendarEvent[] };
