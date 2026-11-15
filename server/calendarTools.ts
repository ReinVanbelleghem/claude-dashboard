import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { CalendarEvent, EventDraft } from "../shared/calendar.ts";
import { localDay, localTime } from "../shared/taskDates.ts";
import { addProposal } from "./calendarProposals.ts";
import { createEvent, listCalendars, listEvents } from "./calendarSources.ts";
import { googleAvailability, googleOtherEvents, googleStatus } from "./google.ts";
import { macPeople } from "./macCalendar.ts";

const SERVER = "calendar";

/**
 * The calendar as tools for a planning session. A planning session has no shell,
 * so it cannot call the daemon's HTTP routes; these run in the daemon itself.
 * Times go in and out as local date-times ("2026-11-17T14:00"), because a model
 * asked to do arithmetic on epoch milliseconds gets the day wrong.
 */
const local = (ms: number) => `${localDay(new Date(ms))}T${localTime(new Date(ms))}`;

const when = z.string().describe('Local date and time without a zone, such as "2026-11-17T14:00"');

function toMs(text: string): number {
  const ms = new Date(text).getTime();
  if (Number.isNaN(ms)) throw new Error(`"${text}" is not a date and time like 2026-11-17T14:00`);
  return ms;
}

const brief = (e: CalendarEvent) => ({
  title: e.title,
  start: local(e.start),
  end: local(e.end),
  allDay: e.allDay,
  calendar: e.calendar,
  location: e.location,
  guests: e.attendees.filter((a) => !a.room).map((a) => a.name),
});

const answer = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

const meeting = {
  title: z.string(),
  start: when,
  end: when,
  allDay: z.boolean().optional(),
  calendarId: z.string().optional().describe("The id of the calendar to book into, from list_calendars"),
  location: z.string().optional(),
  notes: z.string().optional(),
  account: z.string().optional().describe("The Google account that sends the invitations; required with guests, rooms or meet"),
  guests: z.array(z.string()).optional().describe("Email addresses to invite"),
  rooms: z.array(z.string()).optional().describe("Room addresses, from list_people"),
  meet: z.boolean().optional().describe("Add a Google Meet link"),
};

type MeetingInput = { title: string; start: string; end: string; allDay?: boolean; calendarId?: string; location?: string; notes?: string; account?: string; guests?: string[]; rooms?: string[]; meet?: boolean };

function draftOf(m: MeetingInput): EventDraft {
  const invites = (m.guests?.length ?? 0) > 0 || (m.rooms?.length ?? 0) > 0 || m.meet === true;
  if (invites && !m.account) throw new Error("guests, rooms and a Meet link need the Google account to invite from");
  return {
    title: m.title,
    start: toMs(m.start),
    end: toMs(m.end),
    allDay: m.allDay === true,
    calendarId: m.calendarId,
    location: m.location,
    notes: m.notes,
    ...(invites ? { google: { account: m.account!, guests: m.guests ?? [], rooms: m.rooms ?? [], meet: m.meet === true } } : {}),
  };
}

export const CALENDAR_SAFE_TOOLS = ["list_calendars", "my_events", "list_people", "their_events", "free_or_busy", "propose_meeting"].map((name) => `mcp__${SERVER}__${name}`);

export function calendarToolServer(onChange: () => void) {
  return {
    [SERVER]: createSdkMcpServer({
      name: SERVER,
      version: "1.0.0",
      tools: [
        tool("list_calendars", "The user's calendars that can be written to, and the connected Google accounts.", {}, async () =>
          answer({ calendars: (await listCalendars()).filter((c) => c.editable).map((c) => ({ id: c.id, title: c.title, account: c.account, isDefault: c.isDefault, google: c.google !== undefined })), googleAccounts: googleStatus().accounts }),
        ),
        tool("my_events", "The user's own events between two moments.", { from: when, to: when }, async ({ from, to }) =>
          answer((await listEvents(toMs(from), toMs(to))).events.map(brief)),
        ),
        tool("list_people", "People and rooms the user has met with before: name, email and whether it is a room. Rooms often carry their capacity in the name.", {}, async () =>
          answer((await macPeople()).map((p) => ({ name: p.name, email: p.email, room: p.room }))),
        ),
        tool(
          "their_events",
          "Another person's or a room's events between two moments. When their calendar only shares free and busy times, the events are untitled busy blocks.",
          { email: z.string(), from: when, to: when },
          async ({ email, from, to }) => {
            const { events, limited } = await googleOtherEvents(email, toMs(from), toMs(to));
            return answer({ onlyBusyTimes: limited, events: events.map(brief) });
          },
        ),
        tool(
          "free_or_busy",
          "Whether each person or room is free for one slot.",
          { account: z.string().describe("The user's Google account"), emails: z.array(z.string()), start: when, end: when },
          async ({ account, emails, start, end }) => answer(await googleAvailability(account, emails, toMs(start), toMs(end))),
        ),
        tool("propose_meeting", "Put a meeting on the user's calendar as a draft. Nothing is booked and nobody is invited until the user approves it there.", meeting, async (m) => {
          const proposal = addProposal(draftOf(m));
          onChange();
          return answer({ drafted: proposal.title, start: local(proposal.start), end: local(proposal.end) });
        }),
        tool("create_event", "Create a real event straight away. With guests or rooms, Google emails the invitations immediately.", meeting, async (m) => {
          const draft = draftOf(m);
          await createEvent(draft);
          onChange();
          return answer({ created: draft.title, start: local(draft.start), end: local(draft.end) });
        }),
      ],
    }),
  };
}
