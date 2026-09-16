import { useEffect, useRef, useState } from "react";
import { DrawerOpenIcon, FullPageIcon, TileWindowIcon } from "./Icons.tsx";

export type OpenTarget = "drawer" | "page" | "tile";

const OPTIONS: { value: OpenTarget; label: string; hint: string; icon: () => React.ReactNode }[] = [
  {
    value: "drawer",
    label: "Side drawer",
    hint: "Keeps you on the list",
    icon: () => <DrawerOpenIcon />,
  },
  {
    value: "page",
    label: "Full page",
    hint: "Room for the transcript, git and review",
    icon: () => <FullPageIcon />,
  },
  {
    value: "tile",
    label: "Floating tile",
    hint: "A movable, resizable window",
    icon: () => <TileWindowIcon />,
  },
];

/**
 * A native `<select>` can't put an icon next to an option, and the three
 * destinations read a lot faster as a little picture each (a docked panel, a
 * full square, a floating window) than as three sentences that all start with
 * "the". Same click-outside/Escape popover shape as `MuteMenu`.
 */
export function OpenTargetPicker({
  value,
  onChange,
}: {
  value: OpenTarget;
  onChange: (v: OpenTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const current = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="open-target-picker" ref={wrap}>
      <button
        type="button"
        className="open-target-trigger"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {current.icon()}
        <span>{current.label}</span>
        <span className="open-target-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="open-target-menu" role="listbox">
          {OPTIONS.map((o) => (
            <button
              type="button"
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`open-target-option ${o.value === value ? "on" : ""}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.icon()}
              <span className="open-target-option-text">
                <span className="open-target-option-label">{o.label}</span>
                <span className="open-target-option-hint">{o.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
