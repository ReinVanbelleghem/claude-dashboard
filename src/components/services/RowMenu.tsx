import { type ReactNode } from "react";
import { Popover } from "../Popover.tsx";

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
  return (
    <Popover anchor={anchor} onClose={onClose}>
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
    </Popover>
  );
}
