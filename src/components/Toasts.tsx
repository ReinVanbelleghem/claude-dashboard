import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "./Icons.tsx";

export type ToastTone = "calm" | "urgent" | "error" | "success";

export type OpenGesture = { metaKey: boolean; ctrlKey: boolean; altKey: boolean };

export type ToastInput = {
  title: string;
  kicker?: string;
  description?: string;
  meta?: string;
  tone?: ToastTone;
  icon?: ReactNode;
  /** A newer toast with the same key replaces the one on screen. */
  key?: string;
  /** Milliseconds on screen; 0 keeps it until dismissed. */
  duration?: number;
  onOpen?: (gesture: OpenGesture) => void;
  action?: { label: string; run: () => void };
};

type Toast = ToastInput & { id: number; leaving: boolean };

const DEFAULT_MS = 6_000;
const LEAVE_MS = 220;
const SHOWN = 3;
const KEPT = 6;
const GAP = 10;

let nextId = 1;
let toasts: Toast[] = [];
const listeners = new Set<() => void>();

function set(next: Toast[]) {
  toasts = next;
  for (const fn of listeners) fn();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export function toast(input: ToastInput): number {
  const id = nextId++;
  const rest = input.key ? toasts.filter((t) => t.key !== input.key) : toasts;
  set([...rest, { ...input, id, leaving: false }].slice(-KEPT));
  return id;
}

export function dismissToast(id: number) {
  if (!toasts.some((t) => t.id === id && !t.leaving)) return;
  set(toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
  setTimeout(() => set(toasts.filter((t) => t.id !== id)), LEAVE_MS);
}

function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return hidden;
}

export function Toaster() {
  const list = useSyncExternalStore(subscribe, () => toasts);
  const [expanded, setExpanded] = useState(false);
  const [heights, setHeights] = useState<Record<number, number>>({});
  const hidden = useDocumentHidden();

  const newestFirst = [...list].reverse();
  useEffect(() => {
    if (list.length === 0) setExpanded(false);
  }, [list.length]);

  if (list.length === 0) return null;

  const frontHeight = heights[newestFirst[0]!.id] ?? 0;
  const offsets: number[] = [];
  let total = 0;
  for (const t of newestFirst) {
    offsets.push(total);
    total += (heights[t.id] ?? frontHeight) + GAP;
  }
  const stackHeight = expanded ? total - GAP : frontHeight + Math.min(newestFirst.length - 1, SHOWN - 1) * GAP;

  return createPortal(
    <ol
      className="toaster"
      aria-label="Notifications"
      data-expanded={expanded || undefined}
      style={{ height: stackHeight }}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
    >
      {newestFirst.map((t, index) => (
        <ToastCard
          key={t.id}
          toast={t}
          index={index}
          offset={offsets[index]!}
          frontHeight={frontHeight}
          expanded={expanded}
          paused={expanded || hidden}
          onHeight={(h) => setHeights((prev) => (prev[t.id] === h ? prev : { ...prev, [t.id]: h }))}
        />
      ))}
    </ol>,
    document.body,
  );
}

function ToastCard({
  toast: t,
  index,
  offset,
  frontHeight,
  expanded,
  paused,
  onHeight,
}: {
  toast: Toast;
  index: number;
  offset: number;
  frontHeight: number;
  expanded: boolean;
  paused: boolean;
  onHeight: (height: number) => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const remaining = useRef(t.duration ?? DEFAULT_MS);

  useLayoutEffect(() => {
    if (body.current) onHeight(body.current.offsetHeight);
  });

  useEffect(() => {
    if (paused || t.leaving || remaining.current <= 0) return;
    const started = Date.now();
    const timer = setTimeout(() => dismissToast(t.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(1, remaining.current - (Date.now() - started));
    };
  }, [paused, t.leaving, t.id]);

  const open = (gesture: OpenGesture) => {
    t.onOpen?.(gesture);
    dismissToast(t.id);
  };
  const front = index === 0;
  const buried = !expanded && index >= SHOWN;
  const clipped = !expanded && !front && frontHeight > 0;

  return (
    <li
      className={`toast ${t.tone ?? "calm"}`}
      data-front={front || undefined}
      data-leaving={t.leaving || undefined}
      data-buried={buried || undefined}
      style={{ "--i": index, "--offset": offset, height: clipped ? frontHeight : undefined } as CSSProperties}
    >
      <div
        ref={body}
        className="toast-body"
        role={t.onOpen ? "button" : "status"}
        tabIndex={t.onOpen ? 0 : undefined}
        onClick={t.onOpen ? open : undefined}
        onKeyDown={(e) => t.onOpen && e.target === e.currentTarget && e.key === "Enter" && open(e)}
      >
        {t.icon && <span className="toast-icon">{t.icon}</span>}
        <span className="toast-text">
          {t.kicker && <span className="toast-kicker">{t.kicker}</span>}
          <span className="toast-title">{t.title}</span>
          {t.description && <span className="toast-desc">{t.description}</span>}
          {t.meta && <span className="toast-meta">{t.meta}</span>}
        </span>
        {t.action && (
          <button
            className="toast-action"
            onClick={(e) => {
              e.stopPropagation();
              t.action!.run();
              dismissToast(t.id);
            }}
          >
            {t.action.label}
          </button>
        )}
      </div>
      <button
        className="toast-close"
        title="Dismiss"
        aria-label="Dismiss notification"
        onClick={() => dismissToast(t.id)}
      >
        <XIcon />
      </button>
    </li>
  );
}
