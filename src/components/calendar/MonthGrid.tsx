import { useMemo, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { CalendarEvent, Task, TaskProject } from "../../api.ts";
import { TaskMark, taskTint, taskTitle } from "./TaskBits.tsx";
import { StatusMark } from "./StatusMark.tsx";
import { useEventHover } from "./EventHoverCard.tsx";
import { addDays } from "../../../shared/taskDates.ts";
import { replyOf } from "../../../shared/calendar.ts";
import { dayOfMonth, dayStart, diffDays, eventDays, fmtTime, isBar, shiftDays, weekdayShort } from "./dates.ts";

const MAX_SHOWN = 4;
const DRAG_THRESHOLD_PX = 4;

export type MonthGridProps = {
  days: string[];
  /** Any day inside the month on show; days outside it are dimmed. */
  anchor: string;
  today: string;
  events: CalendarEvent[];
  tasks: Task[];
  projects: TaskProject[];
  onOpenEvent: (event: CalendarEvent) => void;
  onOpenTask: (task: Task) => void;
  onCreate: (range: { start: number; end: number; allDay: boolean }) => void;
  onMoveEvent: (event: CalendarEvent, start: number, end: number) => void;
  onMoveTask: (task: Task, dueDate: string, dueTime: string | null) => void;
  onShowDay: (day: string) => void;
};

type Item =
  | { kind: "event"; key: string; event: CalendarEvent; bar: boolean }
  | { kind: "task"; key: string; task: Task; overdue: boolean };

type Drag = { item: Item; origin: string; over: string };

const replyClass = (event: CalendarEvent) => {
  const reply = replyOf(event);
  return reply && reply !== "accepted" ? reply : "";
};
const tint = (color: string | null): CSSProperties => ({ "--ev": color ?? "var(--accent)" }) as CSSProperties;

export function MonthGrid({ days, anchor, today, events, tasks, projects, onOpenEvent, onOpenTask, onCreate, onMoveEvent, onMoveTask, onShowDay }: MonthGridProps) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const hover = useEventHover();
  const month = anchor.slice(0, 7);

  const itemsByDay = useMemo(() => {
    const map = new Map<string, Item[]>(days.map((day) => [day, []]));
    for (const event of [...events].sort((a, b) => Number(isBar(b)) - Number(isBar(a)) || a.start - b.start)) {
      const [first, last] = eventDays(event);
      for (let day = first < days[0] ? days[0] : first; day <= last; day = addDays(day, 1)) {
        const list = map.get(day);
        if (!list) break;
        list.push({ kind: "event", key: event.key, event, bar: isBar(event) });
      }
    }
    for (const task of tasks) {
      if (task.dueDate === null) continue;
      const overdue = task.completedAt === null && task.dueDate < today;
      map.get(overdue && task.dueTime === null ? today : task.dueDate)?.push({ kind: "task", key: `task-${task.id}`, task, overdue });
    }
    return map;
  }, [days, events, tasks, today]);

  const open = (item: Item) => (item.kind === "event" ? onOpenEvent(item.event) : onOpenTask(item.task));

  const drop = (item: Item, origin: string, over: string) => {
    const delta = diffDays(origin, over);
    if (delta === 0) return;
    if (item.kind === "event") onMoveEvent(item.event, shiftDays(item.event.start, delta), shiftDays(item.event.end, delta));
    else onMoveTask(item.task, over, item.task.dueTime);
  };

  const begin = (e: ReactPointerEvent, item: Item, origin: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    hover.hide();
    const movable = item.kind === "task" || item.event.editable;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let over: string | null = null;
    const move = (ev: PointerEvent) => {
      if (!movable || (over === null && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD_PX)) return;
      const cell = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-day]");
      over = cell?.dataset.day ?? over ?? origin;
      setDrag({ item, origin, over });
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key);
      setDrag(null);
    };
    const up = () => {
      stop();
      if (over === null) open(item);
      else drop(item, origin, over);
    };
    const key = (ev: KeyboardEvent) => ev.key === "Escape" && stop();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
  };

  return (
    <div className={`cal-month ${drag ? "dragging" : ""}`} style={{ "--weeks": days.length / 7 } as CSSProperties}>
      {!drag && hover.card}
      <div className="cal-month-head">
        {days.slice(0, 7).map((day) => (
          <span key={day}>{weekdayShort(day)}</span>
        ))}
      </div>
      <div className="cal-month-grid">
        {days.map((day) => {
          const items = itemsByDay.get(day) ?? [];
          const shown = items.length > MAX_SHOWN ? items.slice(0, MAX_SHOWN - 1) : items;
          const hidden = items.length - shown.length;
          return (
            <div
              className={`cal-cell ${day === today ? "today" : ""} ${day.startsWith(month) ? "" : "outside"} ${drag?.over === day ? "over" : ""}`}
              key={day}
              data-day={day}
              onClick={() => onCreate({ start: dayStart(day), end: dayStart(day), allDay: true })}
            >
              <button
                className="cal-cell-date"
                onClick={(e) => {
                  e.stopPropagation();
                  onShowDay(day);
                }}
              >
                {dayOfMonth(day)}
              </button>
              {shown.map((item) => {
                const lifted = drag?.item.key === item.key ? "ghost" : "";
                if (item.kind === "task") {
                  return (
                    <div
                      className={`cal-chip task ${item.overdue ? "overdue" : ""} ${item.task.completedAt === null ? "" : "done"} ${lifted}`}
                      key={item.key}
                      style={taskTint(projects, item.task)}
                      title={taskTitle(projects, item.task)}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => begin(e, item, day)}
                    >
                      <TaskMark task={item.task} />
                      <span>{item.task.content}</span>
                    </div>
                  );
                }
                return (
                  <div
                    className={`cal-chip ${item.bar ? "bar" : ""} ${item.event.other ? "other" : ""} ${item.event.draft ? "draft" : ""} ${item.event.status ? `status ${item.event.status.kind}` : ""} ${replyClass(item.event)} ${lifted}`}
                    key={item.key}
                    style={tint(item.event.color)}
                    {...hover.bind(item.event)}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => begin(e, item, day)}
                  >
                    {!item.bar && !item.event.status && <i className="cal-dot" />}
                    <StatusMark status={item.event.status} />
                    {!item.bar && <time>{fmtTime(item.event.start)}</time>}
                    <span>{item.event.title}</span>
                  </div>
                );
              })}
              {hidden > 0 && (
                <button
                  className="cal-more"
                  onClick={(e) => {
                    e.stopPropagation();
                    onShowDay(day);
                  }}
                >
                  {hidden} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
