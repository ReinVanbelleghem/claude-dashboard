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
  /** A meeting room or other resource rather than a person. */
  room: boolean;
  me: boolean;
};

export type CalendarEvent = {
  /** Unique per occurrence, so two days of one repeating event can sit in one list. */
  key: string;
  id: string;
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
};

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
};

export type EventRef = {
  id: string;
  occurrence: number;
  /** For a repeating event: only this occurrence, or this one and every later one. */
  span?: "this" | "future";
};

export type EventPatch = EventRef & Partial<EventDraft>;

export type CalendarPayload = { events: CalendarEvent[] };
