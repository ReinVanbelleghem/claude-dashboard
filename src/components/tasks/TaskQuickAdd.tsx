import { useState, type ReactNode } from "react";
import { addDays, describeRecurrence, localDay, parseQuickAdd } from "../../../shared/taskDates.ts";
import { CalendarIcon, PlusIcon, RepeatIcon } from "../Icons.tsx";

export type QuickAdd = ReturnType<typeof parseQuickAdd>;

export function dayLabel(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === addDays(today, 1)) return "Tomorrow";
  if (day === addDays(today, -1)) return "Yesterday";
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y!, m! - 1, d!);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(y !== Number(today.slice(0, 4)) ? { year: "numeric" } : {}),
  });
}

/**
 * The line a task is typed into, wherever tasks are added: it reads the date,
 * priority, list and labels out of the text as you type and shows what it
 * understood before anything is saved.
 */
export function TaskQuickAdd({
  placeholder = "Add a task…  review PR friday 9:00 p1 #backend",
  label = "Add a task",
  extra,
  draftKey,
  onAdd,
}: {
  /** Where a half-typed task is remembered across a reload, for the lines that keep one. */
  draftKey?: string;
  placeholder?: string;
  label?: string;
  /** A control that sits in the line, before the add button. */
  extra?: ReactNode;
  /** Save the task. `read` is what the line made of the text. A refusal is shown under the line and the text is kept. */
  onAdd: (text: string, read: QuickAdd) => Promise<unknown>;
}) {
  const [draft, setDraftState] = useState(() => {
    try {
      return (draftKey && localStorage.getItem(draftKey)) || "";
    } catch {
      return "";
    }
  });
  const setDraft = (next: string) => {
    setDraftState(next);
    if (!draftKey) return;
    try {
      if (next) localStorage.setItem(draftKey, next);
      else localStorage.removeItem(draftKey);
    } catch {
      return;
    }
  };
  const [error, setError] = useState<string | null>(null);
  const today = localDay(new Date());
  const preview = draft.trim() ? parseQuickAdd(draft.trim()) : null;

  const add = async () => {
    const text = draft.trim();
    if (!text || !preview) return;
    setError(null);
    try {
      await onAdd(text, preview);
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className={`tasks-add${draft.trim() ? " filled" : ""}`}>
        <span className="tasks-add-icon">
          <PlusIcon />
        </span>
        <input
          value={draft}
          placeholder={placeholder}
          aria-label={label}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        {extra}
        {draft.trim() ? (
          <button className="icon-btn primary tiny" onClick={() => void add()}>
            Add task
          </button>
        ) : (
          <kbd>↵</kbd>
        )}
      </div>
      {preview && (preview.due || preview.priority || preview.project || preview.labels.length > 0) && (
        <div className="tasks-preview">
          <span className="tasks-preview-text">{preview.content || "…"}</span>
          {preview.due && (
            <span className="task-chip due">
              <CalendarIcon />
              {dayLabel(preview.due.date, today)}
              {preview.due.time ? ` ${preview.due.time}` : ""}
            </span>
          )}
          {preview.due?.recurrence && (
            <span className="task-chip">
              <RepeatIcon />
              {describeRecurrence(preview.due.recurrence)}
            </span>
          )}
          {preview.priority && <span className={`task-chip tasks-p${preview.priority}`}>P{preview.priority}</span>}
          {preview.project && <span className="task-chip">#{preview.project}</span>}
          {preview.labels.map((l) => (
            <span key={l} className="task-chip">
              @{l}
            </span>
          ))}
        </div>
      )}
      {error && <div className="chat-error">{error}</div>}
    </>
  );
}
