import { useEffect, useState, type CSSProperties } from "react";
import type { Attendee, CalendarEvent, CalendarInfo, EventDraft, EventPatch, EventRef, Task, TaskProject } from "../../api.ts";
import type { TaskPatch } from "../../../shared/tasks.ts";
import type { Priority } from "../../../shared/taskDates.ts";
import { TASK_COLORS, type TaskColor } from "../../../shared/tasks.ts";
import { CalendarIcon, CheckIcon, ClockIcon, DocIcon, ExternalIcon, HelpIcon, PencilIcon, PinIcon, RepeatIcon, TagIcon, TasksIcon, TrashIcon, UsersIcon, VideoIcon, XIcon } from "../Icons.tsx";
import { Select } from "../Select.tsx";
import { ServiceMark } from "../tasks/ServiceMark.tsx";
import { extractUrls, linkInfo } from "../../../shared/taskLinks.ts";
import { describeRecurrence } from "../../../shared/taskDates.ts";
import { TaskMark, projectColor, projectOf } from "./TaskBits.tsx";
import { MINUTE_MS, dayKey, dayStart, eventDays, fmtTime, whenText } from "./dates.ts";

export type CalendarTarget =
  | { mode: "view"; event: CalendarEvent }
  | { mode: "edit"; event: CalendarEvent }
  | { mode: "create"; range: { start: number; end: number; allDay: boolean } };

export type TaskDraft = { content: string; description: string; projectId: number | undefined; dueDate: string; dueTime: string | null };

type Span = "this" | "future";
type Kind = "event" | "task";

const STATUS_LABEL = { accepted: "Accepted", declined: "Declined", tentative: "Maybe", pending: "No reply" } as const;
const STATUS_ORDER: Attendee["status"][] = ["accepted", "tentative", "pending", "declined"];
const STATUS_ICON = { accepted: CheckIcon, declined: XIcon, tentative: HelpIcon, pending: ClockIcon } as const;

const MEETING_LINK = /https:\/\/(?:meet\.google\.com\/[a-z0-9-]+|[\w.-]*zoom\.us\/j\/[^\s<>]+|teams\.microsoft\.com\/l\/meetup-join\/[^\s<>]+)/i;
const CONFERENCE_FENCE = /-::~:~::~[~:]*::-/g;
const WEB_LINK = /^https?:\/\//i;
const URL_SPLIT = /(https?:\/\/[^\s<>]+)/;

const meetingLink = (event: CalendarEvent): string | null =>
  [event.url, event.location, event.notes].map((text) => text?.match(MEETING_LINK)?.[0]).find(Boolean) ?? null;

/** Notes without the dial-in block a conferencing service pastes between two fence lines. */
function ownNotes(notes: string | null): string {
  if (!notes) return "";
  const fences = [...notes.matchAll(CONFERENCE_FENCE)];
  if (fences.length === 0) return notes.trim();
  const first = fences[0].index;
  const last = fences[fences.length - 1];
  const after = fences.length > 1 ? notes.slice(last.index + last[0].length) : "";
  return `${notes.slice(0, first)}${after}`.trim();
}

const serviceLinked = (text: string) =>
  text.split(URL_SPLIT).map((part, i) => {
    if (i % 2 === 0) return part;
    const info = linkInfo(part);
    return (
      <a key={i} className="cal-inline-link" href={part} target="_blank" rel="noreferrer" title={part}>
        <ServiceMark service={info.service} />
        {info.label}
      </a>
    );
  });

const linked = (text: string) =>
  text.split(URL_SPLIT).map((part, i) => (i % 2 ? <a key={i} href={part} target="_blank" rel="noreferrer">{part}</a> : part));

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

export function EventModal({
  target,
  calendars,
  projects,
  onClose,
  onEdit,
  onCreate,
  onCreateTask,
  onUpdate,
  onDelete,
}: {
  target: CalendarTarget;
  calendars: CalendarInfo[];
  projects: TaskProject[];
  onCreateTask: (draft: TaskDraft) => Promise<void>;
  onClose: () => void;
  onEdit: (event: CalendarEvent) => void;
  onCreate: (draft: EventDraft) => Promise<void>;
  onUpdate: (patch: EventPatch) => Promise<void>;
  onDelete: (ref: EventRef) => Promise<void>;
}) {
  useEscape(onClose);
  return (
    <>
      <div className="scrim stacked" onClick={onClose} />
      {target.mode === "view" ? (
        <EventDetails event={target.event} onClose={onClose} onEdit={() => onEdit(target.event)} onDelete={onDelete} />
      ) : (
        <EventForm target={target} calendars={calendars} projects={projects} onClose={onClose} onCreate={onCreate} onCreateTask={onCreateTask} onUpdate={onUpdate} />
      )}
    </>
  );
}

function SpanChoice({ span, onSpan }: { span: Span; onSpan: (s: Span) => void }) {
  return (
    <div className="field">
      <span>This event repeats</span>
      <Select
        ariaLabel="Which occurrences"
        value={span}
        onChange={(v) => onSpan(v as Span)}
        options={[
          { value: "this", label: "Only this one" },
          { value: "future", label: "This and all following" },
        ]}
      />
    </div>
  );
}

function EventDetails({
  event,
  onClose,
  onEdit,
  onDelete,
}: {
  event: CalendarEvent;
  onClose: () => void;
  onEdit: () => void;
  onDelete: (ref: EventRef) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [span, setSpan] = useState<Span>("this");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = () => {
    setBusy(true);
    onDelete({ id: event.id, occurrence: event.occurrence, span }).catch((e: Error) => {
      setError(e.message);
      setBusy(false);
    });
  };

  const join = meetingLink(event);
  const notes = ownNotes(event.notes);
  const guests = event.attendees
    .filter((a) => !a.room)
    .sort((a, b) => Number(b.me) - Number(a.me) || STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
  const tally = STATUS_ORDER.map((status) => ({ status, count: guests.filter((g) => g.status === status).length })).filter((t) => t.count > 0);

  return (
    <div className="modal stacked cal-modal cal-details" role="dialog" aria-modal="true" aria-label={event.title}>
      <div className="cal-modal-head">
        <i className="cal-dot" style={{ "--ev": event.color ?? "var(--accent)" } as CSSProperties} />
        <div className="cal-modal-title">
          <h3>{event.title}</h3>
          <p>
            {whenText(event)}
            {event.recurring && <span className="cal-tag"><RepeatIcon /> Repeats</span>}
          </p>
        </div>
        <button className="icon-btn square" aria-label="Close" onClick={onClose}><XIcon /></button>
      </div>

      <div className="cal-detail-body">
        {join && (
          <a className="icon-btn primary cal-join" href={join} target="_blank" rel="noreferrer"><VideoIcon /> Join meeting</a>
        )}

        <div className="cal-rows">
          <div className="cal-row">
            <CalendarIcon />
            <span>{event.calendar}{event.account !== event.calendar && <em>{event.account}</em>}</span>
          </div>
          {event.location && (
            <div className="cal-row">
              <PinIcon />
              <span>{linked(event.location)}</span>
            </div>
          )}
          {event.url && WEB_LINK.test(event.url) && event.url !== join && (
            <div className="cal-row">
              <ExternalIcon />
              <span><a href={event.url} target="_blank" rel="noreferrer">{event.url}</a></span>
            </div>
          )}
        </div>

        {guests.length > 0 && (
          <section className="cal-section">
            <header>
              <UsersIcon />
              <b>{guests.length} {guests.length === 1 ? "guest" : "guests"}</b>
              <span>{tally.map((t) => `${t.count} ${STATUS_LABEL[t.status].toLowerCase()}`).join(" · ")}</span>
            </header>
            <ul className="cal-guests">
              {guests.map((guest) => {
                const StatusIcon = STATUS_ICON[guest.status];
                return (
                  <li className={guest.status} key={guest.name} title={STATUS_LABEL[guest.status]}>
                    <i className="cal-guest-mark"><StatusIcon /></i>
                    <span>{guest.name}{guest.me && <em>you</em>}</span>
                    <em>{STATUS_LABEL[guest.status]}</em>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {notes && (
          <section className="cal-section">
            <header>
              <DocIcon />
              <b>Notes</b>
            </header>
            <div className="cal-notes">{linked(notes)}</div>
          </section>
        )}

        {confirming && event.recurring && <SpanChoice span={span} onSpan={setSpan} />}
        {error && <p className="cal-error">{error}</p>}
      </div>

      <div className="cal-detail-foot">
        {!event.editable && <p>This calendar is read-only.</p>}
        {event.editable &&
          (confirming ? (
            <>
              <button className="icon-btn" onClick={() => setConfirming(false)}>Keep it</button>
              <button className="icon-btn danger" disabled={busy} onClick={remove}><TrashIcon /> Delete event</button>
            </>
          ) : (
            <>
              <button className="icon-btn" onClick={() => setConfirming(true)}><TrashIcon /> Delete</button>
              <button className="icon-btn primary" onClick={onEdit}><PencilIcon /> Edit</button>
            </>
          ))}
      </div>
    </div>
  );
}

function EventForm({
  target,
  calendars,
  projects,
  onClose,
  onCreate,
  onCreateTask,
  onUpdate,
}: {
  target: Exclude<CalendarTarget, { mode: "view" }>;
  calendars: CalendarInfo[];
  projects: TaskProject[];
  onCreateTask: (draft: TaskDraft) => Promise<void>;
  onClose: () => void;
  onCreate: (draft: EventDraft) => Promise<void>;
  onUpdate: (patch: EventPatch) => Promise<void>;
}) {
  const existing = target.mode === "edit" ? target.event : null;
  const initial = target.mode === "edit" ? target.event : target.range;
  const [firstDay, lastDay] = eventDays(initial);
  const writable = calendars.filter((c) => c.editable);

  const [title, setTitle] = useState(existing?.title ?? "");
  const [allDay, setAllDay] = useState(initial.allDay);
  const [startDay, setStartDay] = useState(firstDay);
  const [endDay, setEndDay] = useState(lastDay);
  const [startTime, setStartTime] = useState(initial.allDay ? "09:00" : fmtTime(initial.start));
  const [endTime, setEndTime] = useState(initial.allDay ? "10:00" : fmtTime(initial.end));
  const [calendarId, setCalendarId] = useState(existing?.calendarId ?? writable.find((c) => c.isDefault)?.id ?? writable[0]?.id ?? "");
  const [location, setLocation] = useState(existing?.location ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [span, setSpan] = useState<Span>("this");
  const [kind, setKind] = useState<Kind>("event");
  const [projectId, setProjectId] = useState(() => String(projects.find((p) => p.isInbox)?.id ?? projects[0]?.id ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asTask = !existing && kind === "task";

  useEffect(() => {
    if (!calendarId && writable.length) setCalendarId(writable.find((c) => c.isDefault)?.id ?? writable[0].id);
  }, [calendarId, writable]);

  const moveStartDay = (day: string) => {
    if (!day) return;
    if (endDay < day || endDay === startDay) setEndDay(day);
    setStartDay(day);
  };

  const moveStartTime = (time: string) => {
    if (!time) return;
    const length = new Date(`${endDay}T${endTime}`).getTime() - new Date(`${startDay}T${startTime}`).getTime();
    const end = new Date(`${startDay}T${time}`).getTime() + Math.max(length, 15 * MINUTE_MS);
    setStartTime(time);
    setEndDay(dayKey(end));
    setEndTime(fmtTime(end));
  };

  const fail = (e: Error) => {
    setError(e.message);
    setBusy(false);
  };

  const saveTask = () => {
    if (!title.trim()) return setError("Give the task a name.");
    setBusy(true);
    setError(null);
    onCreateTask({
      content: title.trim(),
      description: notes.trim(),
      projectId: projectId ? Number(projectId) : undefined,
      dueDate: startDay,
      dueTime: allDay ? null : startTime,
    }).catch(fail);
  };

  const save = () => {
    if (asTask) return saveTask();
    const start = allDay ? dayStart(startDay) : new Date(`${startDay}T${startTime}`).getTime();
    const end = allDay ? dayStart(endDay) : new Date(`${endDay}T${endTime}`).getTime();
    if (Number.isNaN(start) || Number.isNaN(end)) return setError("Pick a start and an end.");
    if (end < start || (!allDay && end === start)) return setError("The end has to be after the start.");
    const draft: EventDraft = { title: title.trim() || "New event", start, end, allDay, location: location.trim(), notes: notes.trim(), calendarId: calendarId || undefined };
    setBusy(true);
    setError(null);
    const request = existing ? onUpdate({ ...draft, id: existing.id, occurrence: existing.occurrence, span }) : onCreate(draft);
    request.catch(fail);
  };

  return (
    <form
      className="modal stacked cal-modal"
      role="dialog"
      aria-modal="true"
      aria-label={existing ? "Edit event" : asTask ? "New task" : "New event"}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="cal-modal-head">
        <h3>{existing ? "Edit event" : asTask ? "New task" : "New event"}</h3>
        {!existing && (
          <div className="seg" role="tablist" aria-label="What to add">
            <button type="button" role="tab" aria-selected={kind === "event"} className={kind === "event" ? "active" : ""} onClick={() => setKind("event")}>Event</button>
            <button type="button" role="tab" aria-selected={kind === "task"} className={kind === "task" ? "active" : ""} onClick={() => setKind("task")}>Task</button>
          </div>
        )}
        <button type="button" className="icon-btn square" aria-label="Close" onClick={onClose}><XIcon /></button>
      </div>
      <label className="field">
        <span>{asTask ? "Task" : "Title"}</span>
        <input className="search" autoFocus value={title} placeholder={asTask ? "What needs doing?" : "New event"} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="set-row cal-check">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
        <span>{asTask ? "No time, just the day" : "All day"}</span>
      </label>
      <div className="cal-when">
        <label className="field">
          <span>{asTask ? "Due" : "Starts"}</span>
          <input className="search" type="date" value={startDay} onChange={(e) => moveStartDay(e.target.value)} />
        </label>
        {!allDay && (
          <label className="field">
            <span>At</span>
            <input className="search" type="time" step={900} value={startTime} onChange={(e) => moveStartTime(e.target.value)} />
          </label>
        )}
        {!asTask && (
          <label className="field">
            <span>Ends</span>
            <input className="search" type="date" value={endDay} min={startDay} onChange={(e) => e.target.value && setEndDay(e.target.value)} />
          </label>
        )}
        {!asTask && !allDay && (
          <label className="field">
            <span>At</span>
            <input className="search" type="time" step={900} value={endTime} onChange={(e) => e.target.value && setEndTime(e.target.value)} />
          </label>
        )}
      </div>
      {asTask ? (
        <div className="field">
          <span>Project</span>
          <Select
            ariaLabel="Project"
            value={projectId}
            onChange={setProjectId}
            options={projects.map((p) => ({ value: String(p.id), label: p.name, dot: TASK_COLORS[(p.color ?? "grey") as TaskColor] ?? TASK_COLORS.grey }))}
          />
        </div>
      ) : (
        <>
          <div className="field">
            <span>Calendar</span>
            <Select
              ariaLabel="Calendar"
              value={calendarId}
              onChange={setCalendarId}
              options={writable.map((c) => ({ value: c.id, label: c.title, hint: c.account !== c.title ? c.account : undefined, dot: c.color ?? "var(--accent)" }))}
            />
          </div>
          <label className="field">
            <span>Where</span>
            <input className="search" value={location} onChange={(e) => setLocation(e.target.value)} />
          </label>
        </>
      )}
      <label className="field">
        <span>Notes</span>
        <textarea className="search" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      {existing?.recurring && <SpanChoice span={span} onSpan={setSpan} />}
      {error && <p className="cal-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="icon-btn" onClick={onClose}>Cancel</button>
        <button type="submit" className="icon-btn primary" disabled={busy}>{existing ? "Save" : asTask ? "Add task" : "Add event"}</button>
      </div>
    </form>
  );
}

export function TaskModal({
  task,
  projects,
  today,
  onClose,
  onOpenInTasks,
  onComplete,
  onSave,
}: {
  onSave: (patch: TaskPatch) => Promise<void>;
  task: Task;
  projects: TaskProject[];
  today: string;
  onClose: () => void;
  onOpenInTasks: () => void;
  onComplete: () => void;
}) {
  useEscape(onClose);
  const project = projectOf(projects, task);
  const overdue = task.dueDate !== null && task.dueDate < today;
  const day = task.dueDate === null ? null : new Date(`${task.dueDate}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  const links = [...new Set([...task.links, ...extractUrls(task.description)])];
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <>
        <div className="scrim stacked" onClick={onClose} />
        <TaskForm task={task} projects={projects} today={today} onClose={onClose} onSave={onSave} />
      </>
    );
  }

  return (
    <>
      <div className="scrim stacked" onClick={onClose} />
      <div className="modal stacked cal-modal cal-details" role="dialog" aria-modal="true" aria-label={task.content}>
        <div className="cal-modal-head">
          <TaskMark task={task} />
          <div className="cal-modal-title">
            <h3>{task.content}</h3>
            <p>
              {day && <span className={overdue ? "cal-overdue" : ""}>{overdue ? "Overdue since" : "Due"} {day}{task.dueTime ? ` · ${task.dueTime}` : ""}</span>}
              {task.recurrence && <span className="cal-tag"><RepeatIcon /> {describeRecurrence(task.recurrence)}</span>}
            </p>
          </div>
          <button className="icon-btn square" aria-label="Edit task" title="Edit task" onClick={() => setEditing(true)}><PencilIcon /></button>
          <button className="icon-btn square" aria-label="Close" onClick={onClose}><XIcon /></button>
        </div>

        <div className="cal-detail-body">
          <div className="cal-rows">
            {project && (
              <div className="cal-row">
                <TasksIcon />
                <span><i className="cal-dot" style={{ background: projectColor(project) }} /> {project.name}</span>
              </div>
            )}
            {(task.priority < 4 || task.labels.length > 0) && (
              <div className="cal-row">
                <TagIcon />
                <span className="cal-chips">
                  {task.priority < 4 && <em className={`cal-chip-tag p${task.priority}`}>Priority {task.priority}</em>}
                  {task.labels.map((label) => (
                    <em className="cal-chip-tag" key={label}>@{label}</em>
                  ))}
                </span>
              </div>
            )}
          </div>

          {links.length > 0 && (
            <section className="cal-section">
              <header>
                <ExternalIcon />
                <b>{links.length === 1 ? "Link" : `${links.length} links`}</b>
              </header>
              <div className="cal-links">
                {links.map((url) => {
                  const info = linkInfo(url);
                  return (
                    <a key={url} href={url} target="_blank" rel="noreferrer" title={url}>
                      <ServiceMark service={info.service} />
                      <span>{info.label}</span>
                      <small>{info.kind}</small>
                    </a>
                  );
                })}
              </div>
            </section>
          )}

          {task.description && (
            <section className="cal-section">
              <header>
                <DocIcon />
                <b>Notes</b>
              </header>
              <div className="cal-notes">{serviceLinked(task.description)}</div>
            </section>
          )}
        </div>

        <div className="cal-detail-foot">
          <button className="icon-btn" onClick={onOpenInTasks}>Show in Tasks</button>
          <button className="icon-btn primary" onClick={onComplete}><CheckIcon /> Complete</button>
        </div>
      </div>
    </>
  );
}

const PRIORITIES: { value: Priority; label: string; dot: string }[] = [
  { value: 1, label: "Priority 1", dot: "var(--critical)" },
  { value: 2, label: "Priority 2", dot: "var(--serious)" },
  { value: 3, label: "Priority 3", dot: "var(--accent)" },
  { value: 4, label: "No priority", dot: "var(--text-muted)" },
];

function TaskForm({
  task,
  projects,
  today,
  onClose,
  onSave,
}: {
  task: Task;
  projects: TaskProject[];
  today: string;
  onClose: () => void;
  onSave: (patch: TaskPatch) => Promise<void>;
}) {
  const [content, setContent] = useState(task.content);
  const [dueDate, setDueDate] = useState(task.dueDate ?? today);
  const [timed, setTimed] = useState(task.dueTime !== null);
  const [dueTime, setDueTime] = useState(task.dueTime ?? "09:00");
  const [projectId, setProjectId] = useState(String(task.projectId));
  const [priority, setPriority] = useState(String(task.priority));
  const [description, setDescription] = useState(task.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    if (!content.trim()) return setError("Give the task a name.");
    setBusy(true);
    setError(null);
    onSave({
      content: content.trim(),
      description: description.trim(),
      projectId: Number(projectId),
      priority: Number(priority) as Priority,
      dueDate,
      dueTime: timed ? dueTime : null,
    }).catch((e: Error) => {
      setError(e.message);
      setBusy(false);
    });
  };

  return (
    <form
      className="modal stacked cal-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Edit task"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="cal-modal-head">
        <h3>Edit task</h3>
        <button type="button" className="icon-btn square" aria-label="Close" onClick={onClose}><XIcon /></button>
      </div>
      <label className="field">
        <span>Task</span>
        <input className="search" autoFocus value={content} onChange={(e) => setContent(e.target.value)} />
      </label>
      <label className="set-row cal-check">
        <input type="checkbox" checked={!timed} onChange={(e) => setTimed(!e.target.checked)} />
        <span>No time, just the day</span>
      </label>
      <div className="cal-when">
        <label className="field">
          <span>Due</span>
          <input className="search" type="date" value={dueDate} onChange={(e) => e.target.value && setDueDate(e.target.value)} />
        </label>
        {timed && (
          <label className="field">
            <span>At</span>
            <input className="search" type="time" step={900} value={dueTime} onChange={(e) => e.target.value && setDueTime(e.target.value)} />
          </label>
        )}
      </div>
      <div className="cal-when cal-even">
        <div className="field">
          <span>Project</span>
          <Select
            ariaLabel="Project"
            value={projectId}
            onChange={setProjectId}
            options={projects.map((p) => ({ value: String(p.id), label: p.name, dot: projectColor(p) }))}
          />
        </div>
        <div className="field">
          <span>Priority</span>
          <Select
            ariaLabel="Priority"
            value={priority}
            onChange={setPriority}
            options={PRIORITIES.map((p) => ({ value: String(p.value), label: p.label, dot: p.dot }))}
          />
        </div>
      </div>
      <label className="field">
        <span>Notes</span>
        <textarea className="search" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {error && <p className="cal-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="icon-btn" onClick={onClose}>Cancel</button>
        <button type="submit" className="icon-btn primary" disabled={busy}>Save</button>
      </div>
    </form>
  );
}
