import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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
  type OtherCalendar,
  type Settings,
  type Task,
  type TaskProject,
  type WeekStart,
} from "../../api.ts";
import { addDays, localDay } from "../../../shared/taskDates.ts";
import { CheckIcon, ChevronIcon, MoreIcon, PanelLeftIcon, PlusIcon } from "../Icons.tsx";
import { CalendarSidebar } from "./CalendarSidebar.tsx";
import { GoogleSetup } from "./GoogleSetup.tsx";
import { Popover } from "../Popover.tsx";
import { Select } from "../Select.tsx";
import { EventModal, TaskModal, type CalendarTarget, type TaskDraft } from "./EventModal.tsx";
import { MonthGrid } from "./MonthGrid.tsx";
import { TimeGrid } from "./TimeGrid.tsx";
import { MINUTE_MS, atMinutes, dayStart, minutesOfDay, rangeTitle, shiftAnchor, visibleDays } from "./dates.ts";

const REFRESH_MS = 2 * MINUTE_MS;

const ANCHOR_KEY = "calendar.anchor";
const SIDEBAR_KEY = "calendar.sidebar";
const OTHER_COLORS = ["#e0556a", "#e0a030", "#2bb3c0", "#b06cf0", "#d9773a", "#5b8def", "#8a9a5b", "#c85fa8"];

function storedSidebar(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "0";
  } catch {
    return true;
  }
}
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
  const [google, setGoogle] = useState<GoogleStatus>({ hasClient: false, clientSource: null, accounts: [] });
  const [googleSetup, setGoogleSetup] = useState(false);
  const [pending, setPending] = useState<CalendarEvent[]>([]);
  const [passing, setPassing] = useState<OtherCalendar[]>([]);
  const [otherEvents, setOtherEvents] = useState<Record<string, CalendarEvent[]>>({});
  const [otherProblems, setOtherProblems] = useState<Record<string, string>>({});
  const [sidebar, setSidebar] = useState(storedSidebar);
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
  const order = settings?.ui.calendarOrder ?? [];
  const orderedCalendars = useMemo(() => {
    const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
    return [...calendars].sort((a, b) => rank(a.id) - rank(b.id));
  }, [calendars, order]);
  const pinned = settings?.ui.calendarOthers ?? [];
  const compared = useMemo(() => [...passing, ...pinned.filter((o) => o.shown)], [passing, pinned]);
  const comparedKey = compared.map((o) => o.email).join(",");
  const shownEvents = useMemo(() => {
    const arrived = (p: CalendarEvent) => events.some((e) => e.title === p.title && e.start === p.start);
    const others = compared.flatMap((o) => (otherEvents[o.email] ?? []).map((e) => ({ ...e, calendar: o.name, color: o.color })));
    return [...events.filter((e) => !hidden.includes(e.calendarId)), ...pending.filter((p) => !arrived(p)), ...others];
  }, [events, hidden, pending, compared, otherEvents]);
  const days = useMemo(() => visibleDays(view, anchor, weekStart), [view, anchor, weekStart]);
  const from = dayStart(days[0]);
  const to = dayStart(addDays(days[days.length - 1], 1));
  const latest = useRef(0);
  const layoutRef = useRef<HTMLDivElement>(null);
  const [layoutTop, setLayoutTop] = useState<number | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const top = layoutRef.current?.getBoundingClientRect().top;
      if (top !== undefined) setLayoutTop(Math.round(top + window.scrollY));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [status?.enabled, error]);

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

  useEffect(() => {
    if (comparedKey === "" || google.accounts.length === 0) return;
    let stale = false;
    for (const email of comparedKey.split(",")) {
      calendarApi
        .otherCalendar(email, from, to)
        .then((r) => {
          if (stale) return;
          setOtherEvents((all) => ({ ...all, [email]: r.events }));
          setOtherProblems(({ [email]: _gone, ...rest }) => (r.limited ? { ...rest, [email]: "Only free and busy times are shared with you." } : rest));
        })
        .catch((e: Error) => {
          if (stale) return;
          setOtherEvents((all) => ({ ...all, [email]: [] }));
          setOtherProblems((all) => ({ ...all, [email]: e.message }));
        });
    }
    return () => {
      stale = true;
    };
  }, [comparedKey, from, to, changed, google.accounts.length]);

  const toggleSidebar = () =>
    setSidebar((open) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, open ? "0" : "1");
      } catch {
        return !open;
      }
      return !open;
    });

  const nextColor = () => OTHER_COLORS.find((c) => ![...pinned, ...passing].some((o) => o.color === c)) ?? OTHER_COLORS[(pinned.length + passing.length) % OTHER_COLORS.length];

  const showOther = (person: { email: string; name: string; room: boolean }) =>
    setPassing((list) => (list.some((o) => o.email === person.email) ? list : [{ ...person, color: nextColor(), shown: true }, ...list]));

  const toggleOther = (email: string) => {
    if (passing.some((o) => o.email === email)) return setPassing((list) => list.filter((o) => o.email !== email));
    void saveUi({ calendarOthers: pinned.map((o) => (o.email === email ? { ...o, shown: !o.shown } : o)) });
  };

  const pinOther = (email: string) => {
    const visiting = passing.find((o) => o.email === email);
    if (visiting) {
      setPassing((list) => list.filter((o) => o.email !== email));
      return void saveUi({ calendarOthers: [...pinned, visiting] });
    }
    const kept = pinned.find((o) => o.email === email);
    if (kept?.shown) setPassing((list) => [kept, ...list]);
    void saveUi({ calendarOthers: pinned.filter((o) => o.email !== email) });
  };

  const moved = <T,>(list: T[], from: number, to: number): T[] => {
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  };

  const toggleCalendar = (id: string) => saveUi({ calendarHidden: hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id] });

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
        <button className={`icon-btn square ${sidebar ? "active" : ""}`} aria-label={sidebar ? "Hide the calendar list" : "Show the calendar list"} aria-pressed={sidebar} title="Calendars" onClick={toggleSidebar}>
          <PanelLeftIcon />
        </button>
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
          {orderedCalendars.map((c) => {
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
          <hr />
          <div className="svc-menu-heading">Google, for guests and rooms</div>
          {!google.hasClient && (
            <button
              role="menuitem"
              onClick={() => {
                setMenuAnchor(null);
                setGoogleSetup(true);
              }}
            >
              <PlusIcon />
              <span className="cal-menu-label">Set up Google…</span>
            </button>
          )}
          {google.hasClient && (
            <>
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
              <button
                role="menuitem"
                onClick={() => {
                  setMenuAnchor(null);
                  setGoogleSetup(true);
                }}
              >
                <span className="cal-menu-label">Google client…</span>
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

      <div
        className={`cal-layout ${sidebar ? "with-side" : ""}`}
        ref={layoutRef}
        style={layoutTop === null ? undefined : ({ "--cal-top": `${layoutTop}px` } as CSSProperties)}
      >
      {sidebar && (
        <CalendarSidebar
          calendars={orderedCalendars}
          hidden={hidden}
          onToggleCalendar={toggleCalendar}
          onMoveCalendar={(a, b) => saveUi({ calendarOrder: moved(orderedCalendars.map((c) => c.id), a, b) })}
          onReorderPinned={(next) => saveUi({ calendarOthers: next })}
          canCompare={google.accounts.length > 0}
          hasClient={google.hasClient}
          onSetUpGoogle={() => setGoogleSetup(true)}
          people={people}
          pinned={pinned}
          passing={passing}
          problems={otherProblems}
          onShow={showOther}
          onToggle={toggleOther}
          onPin={pinOther}
        />
      )}
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
      </div>

      {googleSetup && <GoogleSetup google={google} onGoogle={setGoogle} onClose={() => setGoogleSetup(false)} />}
      {target && (
        <EventModal
          target={target}
          calendars={calendars}
          projects={projects}
          people={people}
          googleAccounts={google.accounts}
          comparing={compared.map((o) => o.email)}
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
