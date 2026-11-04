import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronIcon, SearchIcon } from "./Icons.tsx";

export type SelectOption = {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** CSS color for a small swatch before the label, e.g. "var(--series-1)". */
  dot?: string;
  /** An icon before the label, for options that read faster as a picture. */
  icon?: ReactNode;
};

const MARGIN = 8;

type Pos = { top: number; left: number; width?: number; maxHeight: number };

function computePos(trigger: HTMLElement, menu: HTMLElement | null, compact: boolean, align: "start" | "end"): Pos {
  const t = trigger.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const menuW = menu?.offsetWidth || (compact ? 220 : Math.max(t.width, 240));
  const menuH = menu?.scrollHeight || 260;

  let left = align === "end" ? t.right - menuW : t.left;
  if (left + menuW > vw - MARGIN) left = t.right - menuW;
  if (left < MARGIN) left = MARGIN;
  if (left + menuW > vw - MARGIN) left = Math.max(MARGIN, vw - MARGIN - menuW);

  const spaceBelow = vh - t.bottom - MARGIN;
  const spaceAbove = t.top - MARGIN;
  const below = spaceBelow >= Math.min(menuH, 200) || spaceBelow >= spaceAbove;
  const maxHeight = Math.max(120, Math.min(380, (below ? spaceBelow : spaceAbove) - 6));
  const top = below ? t.bottom + 6 : t.top - 6 - Math.min(menuH, maxHeight);

  return { top, left, width: compact ? undefined : Math.max(t.width, 240), maxHeight };
}

type Common = {
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  /** A small trigger that hugs its content, with the menu hanging off its right edge. */
  compact?: boolean;
  ariaLabel?: string;
  title?: string;
  /** A filter box at the top of the menu. With `onSearch`, the text is also handed out for async lookups. */
  searchable?: boolean;
  onSearch?: (text: string) => void;
  searchPlaceholder?: string;
  /** Text above the options. */
  heading?: ReactNode;
  /** Shown under the options, e.g. bulk actions; gets a close function. */
  footer?: (close: () => void) => ReactNode;
  /** Replaces the default trigger. Gets the open state and the toggle. */
  renderTrigger?: (props: { open: boolean; toggle: () => void }) => ReactNode;
  /** What an empty list says. */
  emptyText?: string;
};

type Single = Common & { multiple?: false; value: string; onChange: (v: string) => void };
type Multi = Common & { multiple: true; values: string[]; onChange: (v: string[]) => void };

/**
 * The one dropdown. Single or multi select, optional search, icons, hints, a
 * heading and a footer — so every "pick one of these" and "tick some of these"
 * in the app looks and behaves the same, and none of them can be clipped by a
 * panel: the menu is portaled to <body> and positioned against the trigger.
 */
export function Select(props: Single | Multi) {
  const {
    options,
    placeholder = "Choose…",
    disabled = false,
    compact = false,
    ariaLabel,
    title,
    searchable = false,
    onSearch,
    searchPlaceholder = "Filter…",
    heading,
    footer,
    renderTrigger,
    emptyText = "Nothing to choose from.",
  } = props;
  const multiple = props.multiple === true;
  const selected = multiple ? (props as Multi).values : [(props as Single).value];

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  // A div rather than a <button>: the select often sits inside a <label>, and a
  // click on the label's text would otherwise be forwarded to the button — which
  // reopened the menu right after the outside-click closed it.
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const current = options.find((o) => o.value === selected[0]);
  const shown = searchable && !onSearch && query.trim()
    ? options.filter((o) => `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()))
    : options;

  const close = () => {
    setOpen(false);
    setQuery("");
    onSearch?.("");
  };
  const toggle = () => !disabled && (open ? close() : setOpen(true));

  const pick = (o: SelectOption) => {
    if (o.disabled) return;
    if (multiple) {
      const vals = (props as Multi).values;
      (props as Multi).onChange(vals.includes(o.value) ? vals.filter((v) => v !== o.value) : [...vals, o.value]);
      return;
    }
    (props as Single).onChange(o.value);
    close();
  };

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const recompute = () => {
      if (!triggerRef.current) return;
      setPos(computePos(triggerRef.current, menuRef.current, compact, compact ? "end" : "start"));
    };
    recompute();
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    return () => {
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
    };
  }, [open, compact, shown.length]);

  useEffect(() => {
    if (!open) return;
    setCursor(Math.max(0, shown.findIndex((o) => o.value === selected[0])));
    if (searchable) requestAnimationFrame(() => searchRef.current?.focus());
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      triggerRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(shown.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = shown[cursor];
      if (o) pick(o);
    }
  };

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor, open]);

  const triggerLabel = multiple
    ? selected.length === 0
      ? placeholder
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? selected[0])
        : `${selected.length} selected`
    : (current?.label ?? placeholder);

  return (
    <div className={`dd ${compact ? "compact" : ""}`}>
      <div
        ref={triggerRef}
        role="button"
        tabIndex={disabled ? -1 : 0}
        className={`dd-trigger ${compact ? "compact" : ""} ${disabled ? "disabled" : ""} ${open ? "open" : ""} ${renderTrigger ? "custom" : ""}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={disabled || undefined}
        title={title ?? (multiple ? undefined : current?.hint)}
        onClick={toggle}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {renderTrigger ? (
          renderTrigger({ open, toggle })
        ) : (
          <>
            {!multiple && current?.dot && <span className="dd-dot" style={{ background: current.dot }} />}
            {!multiple && current?.icon && <span className="dd-icon">{current.icon}</span>}
            <span className="dd-trigger-text">
              <span className="dd-trigger-label">{triggerLabel}</span>
              {!compact && !multiple && current?.hint && <span className="dd-trigger-hint">{current.hint}</span>}
            </span>
            <span className="dd-caret" aria-hidden>
              <ChevronIcon />
            </span>
          </>
        )}
      </div>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="dd-menu"
            role="listbox"
            aria-multiselectable={multiple || undefined}
            onKeyDown={onMenuKey}
            style={{
              position: "fixed",
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              width: pos?.width,
              maxHeight: pos?.maxHeight,
              visibility: pos ? "visible" : "hidden",
            }}
          >
            {heading && <div className="dd-heading">{heading}</div>}
            {searchable && (
              <div className="dd-search">
                <SearchIcon />
                <input
                  ref={searchRef}
                  value={query}
                  placeholder={searchPlaceholder}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setCursor(0);
                    onSearch?.(e.target.value);
                  }}
                />
              </div>
            )}
            <div className="dd-options">
              {shown.length === 0 && <div className="dd-empty">{emptyText}</div>}
              {shown.map((o, i) => {
                const on = selected.includes(o.value);
                return (
                  <button
                    type="button"
                    key={o.value}
                    role="option"
                    data-index={i}
                    aria-selected={on}
                    disabled={o.disabled}
                    title={o.hint}
                    className={`dd-option ${on ? "on" : ""} ${i === cursor ? "cursor" : ""}`}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => pick(o)}
                  >
                    {multiple && (
                      <span className={`dd-box ${on ? "on" : ""}`} aria-hidden>
                        {on && <CheckIcon />}
                      </span>
                    )}
                    {o.dot && <span className="dd-dot" style={{ background: o.dot }} />}
                    {o.icon && <span className="dd-icon">{o.icon}</span>}
                    <span className="dd-option-text">
                      <span className="dd-option-label">{o.label}</span>
                      {o.hint && <span className="dd-option-hint">{o.hint}</span>}
                    </span>
                    {!multiple && on && (
                      <span className="dd-check" aria-hidden>
                        <CheckIcon />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {footer && <div className="dd-footer">{footer(close)}</div>}
          </div>,
          document.body,
        )}
    </div>
  );
}
