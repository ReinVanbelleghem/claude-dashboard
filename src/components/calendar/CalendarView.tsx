import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  calendarApi,
  settingsApi,
  taskApi,
  type CalendarEvent,
  type CalendarInfo,
  type CalendarPerson,
  type GoogleStatus,
  type CalendarView as ViewKind,
  type EventDraft,
  type EventPatch,
  type EventRef,
  type MacCalendarStatus,
  type Settings,
  type Task,
  type TaskProject,
  type WeekStart,
} from "../../api.ts";
import { addDays, localDay } from "../../../shared/taskDates.ts";
import { CheckIcon, ChevronIcon, MoreIcon, PlusIcon } from "../Icons.tsx";
import { Popover } from "../Popover.tsx";
import { Select } from "../Select.tsx";
import { EventModal, TaskModal, type CalendarTarget, type TaskDraft } from "./EventModal.tsx";
import { MonthGrid } from "./MonthGrid.tsx";
import { TimeGrid } from "./TimeGrid.tsx";
import { MINUTE_MS, atMinutes, dayStart, minutesOfDay, rangeTitle, shiftAnchor, visibleDays } from "./dates.ts";

const REFRESH_MS = 2 * MINUTE_MS;

const ANCHOR_KEY = "calendar.anchor";
const PENDING_POLL_MS = 10_000;
const PENDING_SHOWN_MS = 5 * MINUTE_MS;

/** A stand-in for an event Google has just created, shown until the Mac's Calendar app has synced the real one. */
const awaitingSync = (draft: EventDraft): CalendarEvent => ({
  key: `pending-${draft.start}-${draft.title}`,
  id: "",
  externalId: null,
  occurrence: Date.now(),
  calendarId: "",
  calendar: "Google",
  account: draft.google?.account ?? "",
  color: null,
  title: draft.title,
  start: draft.start,
  end: draft.end,
  allDay: draft.allDay,
  location: draft.location || null,
  notes: "Created in Google just now. It becomes editable here once the Mac's Calendar app has synced it.",
  url: null,
  recurring: false,
  editable: false,
  attendees: [],
});

function storedAnchor(): string | null {
  try {
    const saved = sessionStorage.getItem(ANCHOR_KEY);
    return saved && /^\d{4}-\d{2}-\d{2}$/.test(saved) ? saved : null;
  } catch {
    return null;
  }
}

const VIEWS: { key: ViewKind; label: string }[] = [
  { key: "week", label: "Week" },
  { key: "workweek", label: "Work week" },
  { key: "month", label: "Month" },
];

const WEEK_STARTS: { value: WeekStart; label: string }[] = [
  { value: 1, label: "Monday" },
  { value: 0, label: "Sunday" },
  { value: 6, label: "Saturday" },
];

export function CalendarView({
  tasks,
  projects,
  settings,
  onSettings,
  changed,
  onOpenInTasks,
}: {
  onOpenInTasks: (task: Task) => void;
  tasks: Task[];
  projects: TaskProject[];
  settings: Settings | null;
  onSettings: (s: Settings) => void;
  /** Bumped when the daemon reports a calendar change made elsewhere. */
  changed: number;
}) {
  const [status, setStatus] = useState<MacCalendarStatus | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [calendars, setCalendars] = useState<CalendarInfo[]>([]);
  const [people, setPeople] = useState<CalendarPerson[]>([]);
  const [google, setGoogle] = useState<GoogleStatus>({ hasClient: false, accounts: [] });
  const [pending, setPending] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [today, setToday] = useState(() => localDay(new Date()));
  const [anchor, setAnchor] = useState(() => storedAnchor() ?? today);

  useEffect(() => {
    try {
      if (anchor === today) sessionStorage.removeItem(ANCHOR_KEY);
      else sessionStorage.setItem(ANCHOR_KEY, anchor);
    } catch {
      return;
    }
  }, [anchor, today]);
  const [target, setTarget] = useState<CalendarTarget | null>(null);
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  const view: ViewKind = settings?.ui.calendarView ?? "week";
  const weekStart: WeekStart = settings?.ui.calendarWeekStart ?? 1;
  const hidden = settings?.ui.calendarHidden ?? [];
  const shownEvents = useMemo(() => {
    const arrived = (p: CalendarEvent) => events.some((e) => e.title === p.title && e.start === p.start);
    return [...events.filter((e) => !hidden.includes(e.calendarId)), ...pending.filter((p) => !arrived(p))];
  }, [events, hidden, pending]);
  const days = useMemo(() => visibleDays(view, anchor, weekStart), [view, anchor, weekStart]);
  const from = dayStart(days[0]);
  const to = dayStart(addDays(days[days.length - 1], 1));
  const latest = useRef(0);

  const saveUi = (patch: Partial<Settings["ui"]>) =>
    settingsApi
      .save({ ui: patch })
      .then((r) => onSettings(r.settings))
      .catch((e: Error) => setError(e.message));

  const load = useCallback(async () => {
    const request = ++latest.current;
    try {
      const next = await calendarApi.status();
      if (request !== latest.current) return;
      setStatus(next);
      calendarApi.google().then(setGoogle).catch(() => {});
      if (!next.enabled) return setEvents([]);
      const payload = await calendarApi.events(from, to);
      if (request !== latest.current) return;
      setEvents(payload.events);
      setError(null);
    } catch (e) {
      if (request === latest.current) setError((e as Error).message);
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load, changed]);

  useEffect(() => {
    const tick = () => {
      setToday(localDay(new Date()));
      void load();
    };
    const timer = window.setInterval(tick, REFRESH_MS);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, [load]);

  useEffect(() => {
    if (!status?.enabled) return;
    calendarApi
      .calendars()
      .then((r) => setCalendars(r.calendars))
      .catch((e: Error) => setError(e.message));
    calendarApi
      .people()
      .then((r) => setPeople(r.people))
      .catch(() => {});
  }, [status?.enabled]);

  useEffect(() => {
    if (pending.length === 0) return;
    const timer = window.setInterval(() => {
      setPending((list) => list.filter((p) => Date.now() - p.occurrence < PENDING_SHOWN_MS));
      void load();
    }, PENDING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [pending.length, load]);

  const settle = (work: Promise<unknown>) =>
    work
      .then(() => setError(null))
      .catch((e: Error) => setError(e.message))
      .finally(() => void load());

  const moveEvent = (event: CalendarEvent, start: number, end: number) => {
    setEvents((list) => list.map((e) => (e.key === event.key ? { ...e, start, end } : e)));
    void settle(calendarApi.update({ id: event.id, occurrence: event.occurrence, start, end }));
  };

  const moveTask = (task: Task, dueDate: string, dueTime: string | null) => void settle(taskApi.update(task.id, { dueDate, dueTime }));

  const create = async (draft: EventDraft) => {
    await calendarApi.create(draft);
    if (draft.google) setPending((list) => [...list, awaitingSync(draft)]);
    setTarget(null);
    void load();
  };

  const createTask = async (draft: TaskDraft) => {
    const { task } = await taskApi.add({ content: draft.content, description: draft.description, projectId: draft.projectId });
    await taskApi.update(task.id, { dueDate: draft.dueDate, dueTime: draft.dueTime });
    setTarget(null);
  };

  const update = async (patch: EventPatch) => {
    await calendarApi.update(patch);
    setTarget(null);
    void load();
  };

  const remove = async (ref: EventRef) => {
    await calendarApi.remove(ref);
    setTarget(null);
    void load();
  };

  const newEvent = () => {
    const day = days.includes(today) ? today : days[0];
    const start = atMinutes(day, day === today ? Math.ceil((minutesOfDay(Date.now()) + 1) / 30) * 30 : 9 * 60);
    setTarget({ mode: "create", range: { start, end: start + 60 * MINUTE_MS, allDay: false } });
  };

  if (!status) return <div className="empty">{error ?? "Loading calendar…"}</div>;

  if (!status.enabled) {
    return (
      <div className="panel cal-connect">
        <h2>Calendar</h2>
        <p className="hint">Your events beside your tasks, read from this Mac's Calendar app.</p>
        <Setup status={status} onStatus={setStatus} />
      </div>
    );
  }

  const heading = rangeTitle(view, days, anchor, today, weekStart);

  const grid = {
    days,
    today,
    events: shownEvents,
    tasks,
    projects,
    onOpenEvent: (event: CalendarEvent) => setTarget({ mode: "view", event }),
    onOpenTask: setOpenTask,
    onCreate: (range: { start: number; end: number; allDay: boolean }) => setTarget({ mode: "create", range }),
    onMoveEvent: moveEvent,
    onMoveTask: moveTask,
  };

  return (
    <div className="cal">
      <div className="cal-bar-top">
        <button className="icon-btn" onClick={() => setAnchor(today)}>Today</button>
        <div className="cal-nav">
          <button className="icon-btn square cal-prev" aria-label="Previous" onClick={() => setAnchor(shiftAnchor(view, anchor, -1))}><ChevronIcon /></button>
          <button className="icon-btn square cal-next" aria-label="Next" onClick={() => setAnchor(shiftAnchor(view, anchor, 1))}><ChevronIcon /></button>
        </div>
        <h2>
          {heading.title}
          {heading.dates && <small>{heading.dates}</small>}
        </h2>
        <div className="cal-spacer" />
        {view === "week" && (
          <div className="cal-weekstart">
            <span>Week starts</span>
            <Select
              compact
              ariaLabel="First day of the week"
              value={String(weekStart)}
              onChange={(v) => saveUi({ calendarWeekStart: Number(v) as WeekStart })}
              options={WEEK_STARTS.map((w) => ({ value: String(w.value), label: w.label }))}
            />
          </div>
        )}
        <button className="icon-btn primary" onClick={newEvent}><PlusIcon /> New event</button>
        <button
          className="icon-btn square"
          aria-label="Calendar options"
          aria-haspopup="menu"
          onClick={(e) => setMenuAnchor(menuAnchor ? null : e.currentTarget)}
        >
          <MoreIcon />
        </button>
      </div>

      {menuAnchor && (
        <Popover anchor={menuAnchor} onClose={() => setMenuAnchor(null)} className="cal-menu">
          <div className="svc-menu-heading">View</div>
          {VIEWS.map((v) => (
            <button key={v.key} role="menuitemradio" aria-checked={view === v.key} onClick={() => saveUi({ calendarView: v.key })}>
              <span className="cal-menu-label">{v.label}</span>
              {view === v.key && <CheckIcon />}
            </button>
          ))}
          <hr />
          <div className="svc-menu-heading">Calendars</div>
          {calendars.map((c) => {
            const visible = !hidden.includes(c.id);
            return (
              <button
                key={c.id}
                role="menuitemcheckbox"
                aria-checked={visible}
                className={visible ? "" : "off"}
                onClick={() => saveUi({ calendarHidden: visible ? [...hidden, c.id] : hidden.filter((id) => id !== c.id) })}
              >
                <i className="cal-dot" style={{ background: c.color ?? "var(--accent)" }} />
                <span className="cal-menu-label">
                  {c.title}
                  {c.account !== c.title && <em>{c.account}</em>}
                </span>
                {visible && <CheckIcon />}
              </button>
            );
          })}
          {google.hasClient && (
            <>
              <hr />
              <div className="svc-menu-heading">Google, for guests and rooms</div>
              {google.accounts.map((email) => (
                <button key={email} role="menuitem" title="Disconnect this account" onClick={() => calendarApi.disconnectGoogle(email).then(setGoogle)}>
                  <span className="cal-menu-label">{email}</span>
                  <em className="cal-menu-note">Disconnect</em>
                </button>
              ))}
              <button role="menuitem" onClick={() => window.open("/api/google/connect", "_blank", "noopener")}>
                <PlusIcon />
                <span className="cal-menu-label">{google.accounts.length ? "Connect another account" : "Connect a Google account"}</span>
              </button>
            </>
          )}
          <hr />
          <button
            role="menuitem"
            className="danger"
            onClick={() => {
              setMenuAnchor(null);
              void calendarApi.disable().then(setStatus);
            }}
          >
            Turn off the calendar
          </button>
        </Popover>
      )}

      {error && <p className="cal-error">{error}</p>}

      <div className="panel cal-frame">
        {view === "month" ? (
          <MonthGrid
            {...grid}
            anchor={anchor}
            onShowDay={(day) => {
              setAnchor(day);
              void saveUi({ calendarView: "week" });
            }}
          />
        ) : (
          <TimeGrid {...grid} />
        )}
      </div>

      {target && (
        <EventModal
          target={target}
          calendars={calendars}
          projects={projects}
          people={people}
          googleAccounts={google.accounts}
          onCreateTask={createTask}
          onClose={() => setTarget(null)}
          onEdit={(event) => setTarget({ mode: "edit", event })}
          onCreate={create}
          onUpdate={update}
          onDelete={remove}
        />
      )}
      {openTask && (
        <TaskModal
          task={openTask}
          projects={projects}
          today={today}
          onClose={() => setOpenTask(null)}
          onOpenInTasks={() => onOpenInTasks(openTask)}
          onSave={async (patch) => {
            await taskApi.update(openTask.id, patch);
            setOpenTask(null);
          }}
          onComplete={() => {
            void taskApi.complete(openTask.id);
            setOpenTask(null);
          }}
        />
      )}
    </div>
  );
}

function Setup({ status, onStatus }: { status: MacCalendarStatus; onStatus: (s: MacCalendarStatus) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enable = () => {
    setBusy(true);
    calendarApi
      .enable()
      .then(onStatus)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  if (!status.available) {
    return <p className="cal-none">The calendar reads from the Mac's Calendar app, so it needs macOS with the Swift compiler installed (xcode-select --install).</p>;
  }

  return (
    <div className="cal-setup">
      <div className="cal-actions">
        <button className="icon-btn primary" disabled={busy} onClick={enable}>{busy ? "Waiting for macOS…" : "Use this Mac's calendars"}</button>
      </div>
      <p className="cal-none">
        Shows every account in the Mac's Calendar app. macOS asks for permission once; the first time also takes about half a minute to set up.
      </p>
      {error && <p className="cal-error">{error}</p>}
    </div>
  );
}
