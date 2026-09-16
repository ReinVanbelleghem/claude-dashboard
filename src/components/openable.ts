import type { KeyboardEvent, MouseEvent } from "react";

export type OpenOpts = { full?: boolean; tile?: boolean; drawer?: boolean };

/**
 * Props for a container whose whole surface opens something — a session card, a
 * history row. Four gestures, one definition, because they were previously all
 * plain `onClick` and so the grid was mouse-only and had no way to ask for the
 * full view.
 *
 * - plain click / Enter / Space → whatever Settings → Sessions has "Click" set to
 * - ⌘/Ctrl-click, ⌘/Ctrl-Enter, middle click → whatever "⌘/Ctrl-click" is set to
 * - ⌥/Option-click, ⌥-Enter → whatever "⌥/Option-click" is set to
 *
 * `drawer` isn't a gesture — nothing here ever sets it — it's read by the
 * dedicated drawer button next to the tile/full-page ones. With all three
 * gestures independently reconfigurable, none of them is guaranteed to still
 * point at the drawer, so a card needs its own explicit way to reach it that
 * doesn't depend on what anyone has the gestures mapped to.
 *
 * The keydown guard matters: the card contains a rename input and real buttons, and
 * without it every Space typed into a title would also try to open the session.
 */
export function openable(open: (opts: OpenOpts) => void) {
  return {
    role: "button",
    tabIndex: 0,
    onClick: (e: MouseEvent) => open({ full: e.metaKey || e.ctrlKey, tile: e.altKey }),
    onAuxClick: (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      open({ full: true });
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget) return;
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      open({ full: e.metaKey || e.ctrlKey, tile: e.altKey });
    },
  } as const;
}
