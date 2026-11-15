import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { CalendarEvent, Task, TaskProject } from "../../api.ts";
import { TaskMark, TaskProjectTag } from "./TaskBits.tsx";
import { useEventHover } from "./EventHoverCard.tsx";
import { addDays } from "../../../shared/taskDates.ts";
import {
  MINUTE_MS,
  SNAP_MINUTES,
  atMinutes,
  dayKey,
  dayOfMonth,
  dayStart,
  diffDays,
  eventDays,
  fmtTime,
  isBar,
  layoutColumns,
  minutesOfDay,
  shiftDays,
  snap,
  weekdayShort,
} from "./dates.ts";

const DEFAULT_HOUR_PX = 48;
const MIN_HOUR_PX = 22;
const MAX_HOUR_PX = 160;
const ZOOM_KEY = "calendar.hourPx";
const ZOOM_SPEED = 0.01;

const clampZoom = (px: number) => Math.min(Math.max(px, MIN_HOUR_PX), MAX_HOUR_PX);

function storedZoom(): number {
  try {
    const saved = Number(localStorage.getItem(ZOOM_KEY));
    return saved > 0 ? clampZoom(saved) : DEFAULT_HOUR_PX;
  } catch {
    return DEFAULT_HOUR_PX;
  }
}
const DAY_MINUTES = 24 * 60;
const TASK_MINUTES = 30;
const DRAG_THRESHOLD_PX = 4;
const FIRST_HOUR_SHOWN = 7;
const SCROLL_LEAD_PX = 14;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export type TimeGridProps = {
  days: string[];
  today: string;
  events: CalendarEvent[];
  tasks: Task[];
  projects: TaskProject[];
  onOpenEvent: (event: CalendarEvent) => void;
  onOpenTask: (task: Task) => void;
  onCreate: (range: { start: number; end: number; allDay: boolean }) => void;
  onMoveEvent: (event: CalendarEvent, start: number, end: number) => void;
  onMoveTask: (task: Task, dueDate: string, dueTime: string | null) => void;
};

type Drag =
  | { kind: "move"; event: CalendarEvent; grab: number; start: number; end: number; moved: boolean }
  | { kind: "resize"; event: CalendarEvent; start: number; end: number; moved: boolean }
  | { kind: "create"; anchor: number; start: number; end: number; moved: boolean }
  | { kind: "task"; task: Task; grab: number; start: number; moved: boolean }
  | { kind: "bar"; event: CalendarEvent; origin: string; delta: number; moved: boolean }
  | { kind: "taskbar"; task: Task; origin: string; delta: number; moved: boolean };

type Block =
  | { kind: "event"; key: string; from: number; to: number; event: CalendarEvent; start: number; end: number; ghost: boolean }
  | { kind: "task"; key: string; from: number; to: number; task: Task; start: number; ghost: boolean }
  | { kind: "new"; key: string; from: number; to: number; start: number; end: number };

type Bar =
  | { kind: "event"; key: string; first: number; last: number; event: CalendarEvent; ghost: boolean }
  | { kind: "task"; key: string; first: number; last: number; task: Task; overdue: boolean; ghost: boolean };

const tint = (color: string | null): CSSProperties => ({ "--ev": color ?? "var(--accent)" }) as CSSProperties;

export function TimeGrid({ days, today, events, tasks, projects, onOpenEvent, onOpenTask, onCreate, onMoveEvent, onMoveTask }: TimeGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const hover = useEventHover();
  const [hourPx, setHourPx] = useState(storedZoom);
  const shownHourPx = useRef(hourPx);
  const zoomAnchor = useRef<{ hours: number; fromTop: number } | null>(null);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const body = bodyRef.current;
      if (!body) return;
      e.preventDefault();
      zoomAnchor.current = {
        hours: (e.clientY - body.getBoundingClientRect().top) / shownHourPx.current,
        fromTop: e.clientY - scroll.getBoundingClientRect().top,
      };
      setHourPx((px) => clampZoom(px * Math.exp(-e.deltaY * ZOOM_SPEED)));
    };
    scroll.addEventListener("wheel", onWheel, { passive: false });
    return () => scroll.removeEventListener("wheel", onWheel);
  }, []);

  useLayoutEffect(() => {
    shownHourPx.current = hourPx;
    const anchor = zoomAnchor.current;
    const scroll = scrollRef.current;
    const body = bodyRef.current;
    if (!anchor || !scroll || !body) return;
    zoomAnchor.current = null;
    scroll.scrollTop = body.offsetTop + anchor.hours * hourPx - anchor.fromTop;
  }, [hourPx]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(ZOOM_KEY, String(Math.round(hourPx)));
      } catch {
        return;
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [hourPx]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(timer);
  }, []);

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = FIRST_HOUR_SHOWN * shownHourPx.current - SCROLL_LEAD_PX;
  }, [days.length]);

  const pointAt = (x: number, y: number): { day: string; time: number } | null => {
    const columns = bodyRef.current?.querySelectorAll<HTMLElement>(".cal-col");
    if (!columns?.length) return null;
    let index = 0;
    columns.forEach((column, i) => {
      if (x >= column.getBoundingClientRect().left) index = i;
    });
    const rect = columns[index].getBoundingClientRect();
    const minutes = Math.min(Math.max(((y - rect.top) / shownHourPx.current) * 60, 0), DAY_MINUTES);
    return { day: days[index], time: atMinutes(days[index], minutes) };
  };

  const snapTime = (time: number): number => {
    const day = dayKey(time);
    return atMinutes(day, snap(minutesOfDay(time)));
  };

  const advance = (d: Drag, x: number, y: number): Drag => {
    const point = pointAt(x, y);
    if (!point) return d;
    switch (d.kind) {
      case "move": {
        const start = snapTime(point.time - d.grab);
        return { ...d, start, end: start + (d.event.end - d.event.start), moved: true };
      }
      case "resize":
        return { ...d, end: Math.max(snapTime(point.time), d.start + SNAP_MINUTES * MINUTE_MS), moved: true };
      case "create": {
        const time = snapTime(point.time);
        const start = Math.min(d.anchor, time);
        return { ...d, start, end: Math.max(d.anchor, time, start + SNAP_MINUTES * MINUTE_MS), moved: true };
      }
      case "task":
        return { ...d, start: snapTime(point.time - d.grab), moved: true };
      case "bar":
      case "taskbar":
        return { ...d, delta: diffDays(d.origin, point.day), moved: true };
    }
  };

  const finish = (d: Drag) => {
    switch (d.kind) {
      case "move":
        if (!d.moved) onOpenEvent(d.event);
        else if (d.start !== d.event.start) onMoveEvent(d.event, d.start, d.end);
        return;
      case "resize":
        if (d.moved && d.end !== d.event.end) onMoveEvent(d.event, d.start, d.end);
        return;
      case "create": {
        if (d.moved) return onCreate({ start: d.start, end: d.end, allDay: false });
        const start = atMinutes(dayKey(d.anchor), Math.floor(minutesOfDay(d.anchor) / 30) * 30);
        return onCreate({ start, end: start + 60 * MINUTE_MS, allDay: false });
      }
      case "task":
        if (!d.moved) onOpenTask(d.task);
        else onMoveTask(d.task, dayKey(d.start), fmtTime(d.start));
        return;
      case "bar":
        if (!d.moved) onOpenEvent(d.event);
        else if (d.delta !== 0) onMoveEvent(d.event, shiftDays(d.event.start, d.delta), shiftDays(d.event.end, d.delta));
        return;
      case "taskbar":
        if (!d.moved) onOpenTask(d.task);
        else if (d.delta !== 0) onMoveTask(d.task, addDays(d.origin, d.delta), d.task.dueTime);
        return;
    }
  };

  const begin = (e: ReactPointerEvent, initial: Drag) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    hover.hide();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let current = initial;
    const move = (ev: PointerEvent) => {
      if (!current.moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD_PX) return;
      current = advance(current, ev.clientX, ev.clientY);
      setDrag(current);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key);
      setDrag(null);
    };
    const up = () => {
      stop();
      finish(current);
    };
    const key = (ev: KeyboardEvent) => ev.key === "Escape" && stop();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
  };

  const grabOf = (e: ReactPointerEvent, start: number) => (pointAt(e.clientX, e.clientY)?.time ?? start) - start;

  const blocksByDay = useMemo(() => {
    const dragged = drag && drag.moved ? drag : null;
    const shown = events
      .filter((e) => !isBar(e))
      .map((e) =>
        dragged && (dragged.kind === "move" || dragged.kind === "resize") && dragged.event.key === e.key
          ? { event: e, start: dragged.start, end: dragged.end, ghost: true }
          : { event: e, start: e.start, end: e.end, ghost: false },
      );
    const timedTasks = tasks
      .filter((t) => t.completedAt === null && t.dueDate !== null && t.dueTime !== null)
      .map((t) =>
        dragged && dragged.kind === "task" && dragged.task.id === t.id
          ? { task: t, start: dragged.start, ghost: true }
          : { task: t, start: new Date(`${t.dueDate}T${t.dueTime}:00`).getTime(), ghost: false },
      );
    return days.map((day) => {
      const from = dayStart(day);
      const to = dayStart(addDays(day, 1));
      const minutes = (time: number) => Math.round((time - from) / MINUTE_MS);
      const blocks: Block[] = [];
      for (const s of shown) {
        if (s.end <= from || s.start >= to) continue;
        blocks.push({ kind: "event", key: s.event.key, from: minutes(Math.max(s.start, from)), to: minutes(Math.min(s.end, to)), ...s });
      }
      for (const t of timedTasks) {
        if (t.start < from || t.start >= to) continue;
        blocks.push({ kind: "task", key: `task-${t.task.id}`, from: minutes(t.start), to: Math.min(minutes(t.start) + TASK_MINUTES, DAY_MINUTES), ...t });
      }
      if (dragged?.kind === "create" && dragged.end > from && dragged.start < to) {
        blocks.push({ kind: "new", key: "new", from: minutes(Math.max(dragged.start, from)), to: minutes(Math.min(dragged.end, to)), start: dragged.start, end: dragged.end });
      }
      return layoutColumns(blocks);
    });
  }, [days, events, tasks, drag]);

  const bars = useMemo(() => {
    const lastIndex = days.length - 1;
    const clampIndex = (day: string) => Math.min(Math.max(diffDays(days[0], day), 0), lastIndex);
    const dragged = drag && drag.moved ? drag : null;
    const out: Bar[] = [];
    for (const event of events) {
      if (!isBar(event)) continue;
      const delta = dragged?.kind === "bar" && dragged.event.key === event.key ? dragged.delta : 0;
      const [first, last] = eventDays(event).map((day) => addDays(day, delta));
      if (last < days[0] || first > days[lastIndex]) continue;
      out.push({ kind: "event", key: event.key, first: clampIndex(first), last: clampIndex(last), event, ghost: delta !== 0 });
    }
    for (const task of tasks) {
      if (task.completedAt !== null || task.dueDate === null || task.dueTime !== null) continue;
      const overdue = task.dueDate < today;
      const delta = dragged?.kind === "taskbar" && dragged.task.id === task.id ? dragged.delta : 0;
      const day = addDays(overdue ? today : task.dueDate, delta);
      if (day < days[0] || day > days[lastIndex]) continue;
      const index = clampIndex(day);
      out.push({ kind: "task", key: `task-${task.id}`, first: index, last: index, task, overdue, ghost: delta !== 0 });
    }
    return out.sort((a, b) => a.first - b.first || b.last - a.last);
  }, [days, events, tasks, today, drag]);

  const columns = { "--cols": days.length, "--hour": `${hourPx}px` } as CSSProperties;
  const nowTop = (minutesOfDay(now) / 60) * hourPx;

  return (
    <div className={`cal-scroll ${drag?.moved ? "dragging" : ""}`} ref={scrollRef} style={columns} onScroll={hover.hide}>
      {!drag && hover.card}
      <div className="cal-top">
        <div className="cal-head">
          <div className="cal-gutter" />
          {days.map((day) => (
            <div className={`cal-dayhead ${day === today ? "today" : ""}`} key={day}>
              <span>{weekdayShort(day)}</span>
              <b>{dayOfMonth(day)}</b>
            </div>
          ))}
        </div>
        <div className="cal-allday">
          <div className="cal-gutter">all-day</div>
          <div className="cal-allday-area">
            <div className="cal-allday-cells">
              {days.map((day) => (
                <button
                  className="cal-allday-cell"
                  key={day}
                  aria-label={`New all-day event on ${day}`}
                  onClick={() => onCreate({ start: dayStart(day), end: dayStart(day), allDay: true })}
                />
              ))}
            </div>
            <div className="cal-bars">
              {bars.map((bar) => {
                const place = { gridColumn: `${bar.first + 1} / ${bar.last + 2}` };
                if (bar.kind === "task") {
                  return (
                    <div
                      className={`cal-bar task ${bar.overdue ? "overdue" : ""} ${bar.ghost ? "ghost" : ""}`}
                      key={bar.key}
                      style={place}
                      title={bar.task.content}
                      onPointerDown={(e) => begin(e, { kind: "taskbar", task: bar.task, origin: days[bar.first], delta: 0, moved: false })}
                    >
                      <TaskMark task={bar.task} />
                      <span>{bar.task.content}</span>
                      <TaskProjectTag projects={projects} task={bar.task} />
                    </div>
                  );
                }
                const pointerDown = bar.event.editable
                  ? (e: ReactPointerEvent) => begin(e, { kind: "bar", event: bar.event, origin: pointAt(e.clientX, e.clientY)?.day ?? days[bar.first], delta: 0, moved: false })
                  : undefined;
                return (
                  <div
                    className={`cal-bar ${bar.ghost ? "ghost" : ""} ${bar.event.editable ? "" : "locked"} ${bar.event.other ? "other" : ""} ${bar.event.draft ? "draft" : ""}`}
                    key={bar.key}
                    style={{ ...place, ...tint(bar.event.color) }}
                    {...hover.bind(bar.event)}
                    onPointerDown={pointerDown}
                    onClick={bar.event.editable ? undefined : () => onOpenEvent(bar.event)}
                  >
                    <span>{bar.event.title}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="cal-body" ref={bodyRef} style={{ height: 24 * hourPx }}>
        <div className="cal-hours">
          {HOURS.map((h) => (
            <span key={h} style={{ top: h * hourPx }}>
              {h === 0 ? "" : `${String(h).padStart(2, "0")}:00`}
            </span>
          ))}
        </div>
        {days.map((day, index) => (
          <div
            className={`cal-col ${day === today ? "today" : ""}`}
            key={day}
            data-day={day}
            onPointerDown={(e) => {
              const point = pointAt(e.clientX, e.clientY);
              if (!point) return;
              const anchor = atMinutes(dayKey(point.time), Math.floor(minutesOfDay(point.time) / SNAP_MINUTES) * SNAP_MINUTES);
              begin(e, { kind: "create", anchor, start: anchor, end: anchor, moved: false });
            }}
          >
            {day === today && <div className="cal-now" style={{ top: nowTop }} />}
            {blocksByDay[index].map((block) => {
              const box: CSSProperties = {
                top: (block.from / 60) * hourPx,
                height: Math.max(((block.to - block.from) / 60) * hourPx - 2, 16),
                left: `calc(${(block.column / block.columns) * 100}% + 1px)`,
                width: `calc(${100 / block.columns}% - 4px)`,
              };
              const short = ((block.to - block.from) / 60) * hourPx < 34;
              if (block.kind === "new") {
                return (
                  <div className="cal-ev new" key={block.key} style={box}>
                    <b>New event</b>
                    <span>{fmtTime(block.start)} – {fmtTime(block.end)}</span>
                  </div>
                );
              }
              if (block.kind === "task") {
                return (
                  <div
                    className={`cal-ev task ${block.ghost ? "ghost" : ""}`}
                    key={block.key}
                    style={box}
                    title={block.task.content}
                    onPointerDown={(e) => begin(e, { kind: "task", task: block.task, grab: grabOf(e, block.start), start: block.start, moved: false })}
                  >
                    <b><TaskMark task={block.task} />{block.task.content}</b>
                    <TaskProjectTag projects={projects} task={block.task} />
                  </div>
                );
              }
              const { event } = block;
              return (
                <div
                  className={`cal-ev ${short ? "short" : ""} ${block.ghost ? "ghost" : ""} ${event.editable ? "" : "locked"} ${event.other ? "other" : ""} ${event.draft ? "draft" : ""}`}
                  key={block.key}
                  style={{ ...box, ...tint(event.color) }}
                  {...hover.bind(event)}
                  onPointerDown={
                    event.editable
                      ? (e) => begin(e, { kind: "move", event, grab: grabOf(e, block.start), start: block.start, end: block.end, moved: false })
                      : (e) => e.stopPropagation()
                  }
                  onClick={event.editable ? undefined : () => onOpenEvent(event)}
                >
                  <b>{event.title}</b>
                  <span>{fmtTime(block.start)} – {fmtTime(block.end)}{event.location ? ` · ${event.location}` : ""}</span>
                  {event.editable && (
                    <div
                      className="cal-ev-resize"
                      onPointerDown={(e) => begin(e, { kind: "resize", event, start: block.start, end: block.end, moved: false })}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
