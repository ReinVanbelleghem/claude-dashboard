import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A small panel hung off a trigger element.
 *
 * Portaled to <body> and fixed-positioned so a scrollable table, a drawer or a
 * tile with `overflow: hidden` cannot clip it, flipped above the anchor when
 * there is no room below, and dismissed on an outside click or Escape. The one
 * place that behaviour lives: an overflow menu and a session's artifact list are
 * the same mechanism wearing different contents.
 */
export function Popover({
  anchor,
  onClose,
  className = "",
  role = "menu",
  children,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  className?: string;
  role?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    /**
     * Measured, not guessed, and re-measured whenever the panel's own size
     * changes — switching to a sub-view makes it taller and wider, and a menu
     * placed for the previous contents hangs off the wrong edge.
     *
     * The ResizeObserver is what keeps that honest. Re-running this effect on
     * `children` instead looked equivalent and was not: children are a fresh
     * object every parent render, so each placement set state that triggered
     * the next one.
     */
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const m = el.getBoundingClientRect();
      const w = m.width || 190;
      const h = m.height || 120;
      const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
      const top = r.bottom + 6 + h > window.innerHeight - 8 ? Math.max(8, r.top - 6 - h) : r.bottom + 6;
      setPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      className={`svc-menu ${className}`.trim()}
      role={role}
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
