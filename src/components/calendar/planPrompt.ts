import type { CalendarInfo, OtherCalendar } from "../../api.ts";

export type PlanContext = {
  request: string;
  now: Date;
  rangeFrom: number;
  rangeTo: number;
  /** The calendar the meetings go into. */
  calendar: CalendarInfo | null;
  /** The Google account that sends invitations for that calendar, when it is a Google one and connected. */
  inviteFrom: string | null;
  onShow: OtherCalendar[];
  /** Standing instructions the user keeps for every planning session. */
  standing: string;
  askFirst: boolean;
};

const stamp = (d: Date) => d.toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** What a planning session is told: the request, what is on screen, and how to read and write the calendar through the daemon. */
export function planPrompt(c: PlanContext): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lines = [
    "Plan meetings in my calendar. My request:",
    "",
    c.request.trim(),
    "",
    "## Context",
    `- Now: ${stamp(c.now)} (${zone}).`,
    `- The week on my screen runs from ${stamp(new Date(c.rangeFrom))} to ${stamp(new Date(c.rangeTo))}.`,
    c.calendar
      ? `- Book into my calendar "${c.calendar.title}" (${c.calendar.account}): pass calendarId "${c.calendar.id}". Do not use another calendar.`
      : "- I have no calendar you can write to. Tell me instead of trying.",
    c.inviteFrom
      ? `- That calendar belongs to the Google account ${c.inviteFrom}, so guests, rooms and Meet links are possible: use it as the "account".`
      : "- That calendar is not a connected Google calendar, so events cannot have guests, rooms or Meet links. Say so if my request needs them.",
    c.onShow.length
      ? `- Calendars I have open beside mine: ${c.onShow.map((o) => `${o.name} <${o.email}>${o.room ? " (room)" : ""}`).join(", ")}. Assume I mean these people and rooms unless I name others.`
      : "- No other calendars are open beside mine.",
    "",
    "## How to read and write the calendar",
    "You have calendar tools; use them, not a shell. Give and read times as local date-times such as 2026-11-17T14:00.",
    "- my_events: my own events in a range.",
    "- list_people: people and rooms I have met with before, with their addresses.",
    "- their_events: someone's or a room's events in a range.",
    "- free_or_busy: whether people and rooms are free for one slot.",
    "- propose_meeting: put a meeting on my calendar as a draft. I see drafts in the calendar, can drag them to another time, and approve or discard each one there; approving creates the real event.",
    "- create_event: create a real event straight away. With guests or rooms, invitations go out immediately.",
    'To invite people, book a room or add a Meet link, pass "account" (my Google address) with "guests", "rooms" and "meet".',
    "",
    ...(c.standing.trim() ? ["## My standing instructions", "These apply to every plan and win over the defaults under Rules:", "", c.standing.trim(), ""] : []),
    "## Rules",
    "- Look at the real calendars before proposing times. Prefer slots where everyone is free, inside 09:00–17:30 on weekdays unless I say otherwise, and avoid 12:00–13:00.",
    "- When a room is wanted and I named none, pick a free room that fits the number of people.",
    "- Match names I mention against the people list; ask me if a name is ambiguous or missing.",
    c.askFirst
      ? "- Do not use create_event. Post every meeting of your plan with propose_meeting, then tell me in one or two lines what you drafted and that I can approve them in the calendar. Invitations reach real people, so the approval is mine."
      : "- I have chosen to book without a confirmation step: create the events once you have a plan that works, then tell me what you booked.",
    "- After creating, list what was created and anything you could not do.",
  ];
  return lines.join("\n");
}
