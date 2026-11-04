import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type MenuItem = { label: string; icon: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean };

/**
 * A small overflow menu. Portaled and fixed-positioned so a scrollable table
 * wrapper cannot clip it; closes on outside click, Escape, or picking an item —
 * except an item named in `keepOpenFor`, for two-step confirmations.
 */
export function RowMenu({
  items,
  onClose,
  anchor,
  heading,
  keepOpenFor,
}: {
  items: MenuItem[];
  onClose: () => void;
  anchor: HTMLElement;
  heading?: string;
  keepOpenFor?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = ref.current?.offsetWidth ?? 190;
    const h = ref.current?.offsetHeight ?? 120;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    const top = r.bottom + 6 + h > window.innerHeight - 8 ? r.top - 6 - h : r.bottom + 6;
    setPos({ top, left });
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
    <div ref={ref} className="svc-menu" role="menu" style={{ top: pos.top, left: pos.left }}>
      {heading && <div className="svc-menu-heading">{heading}</div>}
      {items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          className={it.danger ? "danger" : ""}
          disabled={it.disabled}
          onClick={() => {
            if (it.label !== keepOpenFor) onClose();
            it.onClick();
          }}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
