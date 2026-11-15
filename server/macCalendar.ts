import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CalendarEvent, CalendarInfo, CalendarPayload, EventDraft, EventPatch, EventRef, MacAccess, MacCalendarStatus } from "../shared/calendar.ts";
import { DATA_DIR } from "./paths.ts";

const run = promisify(execFile);

const SOURCE = join(import.meta.dir, "calendarHelper.swift");
const BIN_DIR = join(DATA_DIR, "bin");
const HELPER = join(BIN_DIR, "calendar-helper");
const PLIST = join(BIN_DIR, "calendar-helper.plist");
const STORE_PATH = join(DATA_DIR, "calendar.json");
const USAGE = "Claude Dashboard shows your events beside your tasks.";
const PLIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.claude-dashboard.calendar-helper</string>
<key>CFBundleName</key><string>Claude Dashboard</string>
<key>NSCalendarsFullAccessUsageDescription</key><string>${USAGE}</string>
<key>NSCalendarsUsageDescription</key><string>${USAGE}</string>
</dict></plist>
`;

type HelperEvent = Omit<CalendarEvent, "key">;
type HelperReply = {
  access: MacAccess;
  error?: string;
  events?: HelperEvent[];
  event?: HelperEvent;
  calendars?: CalendarInfo[];
};

let enabled: boolean | null = null;
let building: Promise<void> | null = null;

function isEnabled(): boolean {
  if (enabled !== null) return enabled;
  try {
    enabled = existsSync(STORE_PATH) && (JSON.parse(readFileSync(STORE_PATH, "utf8")) as { mac?: boolean }).mac === true;
  } catch {
    enabled = false;
  }
  return enabled;
}

function setEnabled(next: boolean) {
  enabled = next;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify({ mac: next }, null, 2));
}

const helperIsCurrent = () => existsSync(HELPER) && statSync(HELPER).mtimeMs >= statSync(SOURCE).mtimeMs;

const available = () => process.platform === "darwin" && (helperIsCurrent() || Bun.which("swiftc") !== null);

async function build(): Promise<void> {
  mkdirSync(BIN_DIR, { recursive: true });
  writeFileSync(PLIST, PLIST_XML);
  await run(
    "swiftc",
    ["-O", SOURCE, "-o", HELPER, "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", PLIST],
    { timeout: 180_000 },
  );
}

async function helper(args: string[], timeout: number): Promise<HelperReply> {
  if (!helperIsCurrent()) {
    building ??= build().finally(() => (building = null));
    await building;
  }
  const { stdout } = await run(HELPER, args, { timeout, maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout) as HelperReply;
}

export async function macCalendarStatus(): Promise<MacCalendarStatus> {
  if (!available()) return { available: false, enabled: false, access: "unknown" };
  if (!isEnabled()) return { available: true, enabled: false, access: "unknown" };
  const access = await helper(["status"], 15_000).then((r) => r.access).catch((): MacAccess => "unknown");
  return { available: true, enabled: true, access };
}

export async function enableMacCalendar(): Promise<MacCalendarStatus> {
  if (!available()) throw new Error("Mac calendars need macOS with the Swift compiler installed (xcode-select --install).");
  await granted(["calendars"], 300_000);
  setEnabled(true);
  return { available: true, enabled: true, access: "granted" };
}

export function disableMacCalendar(): MacCalendarStatus {
  setEnabled(false);
  return { available: available(), enabled: false, access: "unknown" };
}

async function granted(args: string[], timeout = 30_000): Promise<HelperReply> {
  const reply = await helper(args, timeout);
  if (reply.access !== "granted") {
    throw new Error("macOS does not allow calendar access. Allow it under System Settings › Privacy & Security › Calendars.");
  }
  if (reply.error) throw new Error(reply.error);
  return reply;
}

const toSeconds = (ms: number) => ms / 1000;

const toEvent = (e: HelperEvent): CalendarEvent => ({
  ...e,
  key: `${e.id}@${e.occurrence}`,
  occurrence: e.occurrence * 1000,
  start: e.start * 1000,
  end: e.end * 1000,
});

const byStart = (a: CalendarEvent, b: CalendarEvent) => a.start - b.start || b.end - a.end;

export async function macEvents(from: number, to: number): Promise<CalendarPayload> {
  if (!isEnabled()) return { events: [] };
  const reply = await granted(["events", String(toSeconds(from)), String(toSeconds(to))]);
  return { events: (reply.events ?? []).map(toEvent).sort(byStart) };
}

export async function macCalendars(): Promise<CalendarInfo[]> {
  if (!isEnabled()) return [];
  const reply = await granted(["calendars"]);
  return (reply.calendars ?? []).sort((a, b) => a.account.localeCompare(b.account) || a.title.localeCompare(b.title));
}

function wire(fields: Partial<EventDraft>): Record<string, unknown> {
  const { start, end, ...rest } = fields;
  return {
    ...rest,
    ...(start === undefined ? {} : { start: toSeconds(start) }),
    ...(end === undefined ? {} : { end: toSeconds(end) }),
  };
}

const refOf = (ref: EventRef) => ({ id: ref.id, occurrence: toSeconds(ref.occurrence), span: ref.span ?? "this" });

export async function createMacEvent(draft: EventDraft): Promise<CalendarEvent> {
  const reply = await granted(["create", JSON.stringify(wire(draft))]);
  return toEvent(reply.event!);
}

export async function updateMacEvent(patch: EventPatch): Promise<CalendarEvent> {
  const { id, occurrence, span, ...fields } = patch;
  const reply = await granted(["update", JSON.stringify({ ...wire(fields), ...refOf({ id, occurrence, span }) })]);
  return toEvent(reply.event!);
}

export async function deleteMacEvent(ref: EventRef): Promise<void> {
  await granted(["delete", JSON.stringify(refOf(ref))]);
}
