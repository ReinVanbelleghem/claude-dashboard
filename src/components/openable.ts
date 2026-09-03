import type { KeyboardEvent, MouseEvent } from "react";

export type OpenOpts = { full?: boolean };

/**
 * Props for a container whose whole surface opens something — a session card, a
 * history row. Three gestures, one definition, because they were previously all
 * plain `onClick` and so the grid was mouse-only and had no way to ask for the
 * full view.
 *
 * - plain click / Enter / Space → open wherever the preference says
 * - ⌘/Ctrl-click, ⌘/Ctrl-Enter, middle click → open the full view
 *
 * The keydown guard matters: the card contains a rename input and real buttons, and
 * without it every Space typed into a title would also try to open the session.
 */
export function openable(open: (opts: OpenOpts) => void) {
  return {
    role: "button",
    tabIndex: 0,
    onClick: (e: MouseEvent) => open({ full: e.metaKey || e.ctrlKey }),
    onAuxClick: (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      open({ full: true });
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget) return;
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      open({ full: e.metaKey || e.ctrlKey });
    },
  } as const;
}
