import { NineDotsIcon } from "./Icons.tsx";

/**
 * Deliberately empty. Every other tab has its own content competing with a
 * floating tile for the same visual space — a KPI row, a card grid, a form.
 * This one exists purely as a calm backdrop to arrange tiles against, the
 * same way a real desktop is mostly empty space behind whatever windows are
 * open on it. The hint fades into the background once you actually have
 * something arranged; it's not meant to be a permanent fixture.
 */
export function DesktopView() {
  return (
    <div className="desktop-view">
      <div className="desktop-hint">
        <NineDotsIcon />
        <p>
          This is Desktop — an empty space for arranging tiles.
          <br />
          Open a session as a tile, or pick one up from the dock below.
        </p>
      </div>
    </div>
  );
}
