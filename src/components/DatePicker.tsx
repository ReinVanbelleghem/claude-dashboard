import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { addDays, addMonths, localDay, parseDue, weekdayOf } from "../../shared/taskDates.ts";
import { CalendarIcon, ChevronIcon } from "./Icons.tsx";

export const WeekStartContext = createContext<number>(1);

const MARGIN = 8;
const GAP = 6;

const asDate = (day: string) => new Date(`${day}T00:00:00`);
const firstOfMonth = (day: string) => `${day.slice(0, 8)}01`;

function displayDay(day: string, today: string): string {
  if (!day) return "";
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return asDate(day).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
  });
}

function monthGrid(month: string, weekStart: number): string[] {
  const first = addDays(month, -((weekdayOf(month) - weekStart + 7) % 7));
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

type Pos = { top: number; left: number };

function place(trigger: HTMLElement, panel: HTMLElement): Pos {
  const t = trigger.getBoundingClientRect();
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  const left = Math.max(MARGIN, Math.min(t.left, window.innerWidth - w - MARGIN));
  const fitsBelow = t.bottom + GAP + h <= window.innerHeight - MARGIN;
  const top = fitsBelow || t.top - GAP - h < MARGIN ? t.bottom + GAP : t.top - GAP - h;
  return { top: Math.max(MARGIN, Math.min(top, window.innerHeight - h - MARGIN)), left };
}

/**
 * The one date field. A text box you can type into ("fri", "19/11", "morgen") with
 * a month grid hanging off it, so every date in the app reads and behaves the same.
 */
export function DatePicker({
  value,
  onChange,
  min,
  ariaLabel,
  placeholder = "No date",
  className = "",
}: {
  /** YYYY-MM-DD, or empty for no date. */
  value: string;
  onChange: (day: string) => void;
  /** The earliest day that can be picked, YYYY-MM-DD. */
  min?: string;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
}) {
  const weekStart = useContext(WeekStartContext);
  const today = localDay(new Date());
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [cursor, setCursor] = useState(value || today);
  const [month, setMonth] = useState(firstOfMonth(value || today));
  const [pos, setPos] = useState<Pos | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const allowed = (day: string) => !min || day >= min;
  const typed = draft !== null && draft.trim() ? (parseDue(draft)?.date ?? null) : null;

  const show = (day: string) => {
    setCursor(day);
    setMonth(firstOfMonth(day));
  };

  const openPanel = () => {
    if (open) return;
    show(value || today);
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setDraft(null);
  };

  const commit = (day: string) => {
    if (!allowed(day)) return;
    if (day !== value) onChange(day);
    close();
  };

  const state = useRef({ close, open });
  state.current = { close, open };

  useEffect(() => {
    if (typed) show(typed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const recompute = () => {
      if (wrapRef.current && panelRef.current) setPos(place(wrapRef.current, panelRef.current));
    };
    recompute();
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    return () => {
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) {
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      if (wrapRef.current?.contains(target)) {
        e.stopPropagation();
        return;
      }
      state.current.close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      state.current.close();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const move = (day: string) => {
    if (!open) setOpen(true);
    show(day);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const editing = draft !== null;
    const steps: Record<string, () => string> = {
      ArrowDown: () => addDays(cursor, 7),
      ArrowUp: () => addDays(cursor, -7),
      PageDown: () => addMonths(cursor, 1),
      PageUp: () => addMonths(cursor, -1),
      ...(editing ? {} : { ArrowRight: () => addDays(cursor, 1), ArrowLeft: () => addDays(cursor, -1) }),
    };
    const step = steps[e.key];
    if (step) {
      e.preventDefault();
      if (!open) openPanel();
      else move(step());
      return;
    }
    if (e.key === "Enter") {
      if (!open) return;
      e.preventDefault();
      if (editing && draft.trim() && !typed) return;
      commit(typed ?? cursor);
    }
  };

  const onBlur = () => {
    if (!open) return;
    if (typed && allowed(typed)) commit(typed);
    else close();
  };

  const days = useMemo(() => monthGrid(month, weekStart), [month, weekStart]);
  const monthLabel = asDate(month).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const unreadable = draft !== null && draft.trim() !== "" && !typed;

  return (
    <div ref={wrapRef} className={`dp ${open ? "open" : ""} ${unreadable ? "bad" : ""} ${className}`.trim()}>
      <input
        className="dp-input"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={draft ?? displayDay(value, today)}
        onChange={(e) => {
          setDraft(e.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={(e) => e.target.select()}
        onClick={openPanel}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      <span className="dp-icon" aria-hidden>
        <CalendarIcon />
      </span>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="dp-panel"
            role="dialog"
            aria-label={ariaLabel ?? "Choose a date"}
            style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
          >
            <div className="dp-head">
              <span className="dp-month">{monthLabel}</span>
              <button type="button" className="dp-nav" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
                <span className="dp-prev">
                  <ChevronIcon />
                </span>
              </button>
              <button type="button" className="dp-nav" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}>
                <span className="dp-next">
                  <ChevronIcon />
                </span>
              </button>
            </div>
            <div className="dp-grid">
              {days.slice(0, 7).map((d) => (
                <span key={d} className="dp-dow">
                  {asDate(d).toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2)}
                </span>
              ))}
              {days.map((d) => (
                <button
                  type="button"
                  key={d}
                  tabIndex={-1}
                  disabled={!allowed(d)}
                  aria-label={asDate(d).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                  aria-pressed={d === value}
                  className={[
                    "dp-day",
                    d.slice(0, 7) !== month.slice(0, 7) ? "out" : "",
                    d === today ? "today" : "",
                    d === value ? "on" : "",
                    d === cursor ? "cursor" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onMouseEnter={() => setCursor(d)}
                  onClick={() => commit(d)}
                >
                  {Number(d.slice(8))}
                </button>
              ))}
            </div>
            <div className="dp-foot">
              <button type="button" disabled={!allowed(today)} onClick={() => commit(today)}>
                Today
              </button>
              <button type="button" disabled={!allowed(addDays(today, 1))} onClick={() => commit(addDays(today, 1))}>
                Tomorrow
              </button>
              <span className={`dp-tip ${unreadable ? "bad" : ""}`.trim()}>{unreadable ? "Not a date I can read" : "Type a date, or use the arrow keys"}</span>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
