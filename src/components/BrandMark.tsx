import { faviconFor, type Appearance } from "../appearance.ts";
import { useIconPhase } from "../useIconPhase.ts";

/**
 * The header glyph, and the only thing that needs the animation clock.
 *
 * It owns `useIconPhase` rather than taking a phase prop on purpose: the hook sets
 * state on every rAF tick, so held one level up in App it re-rendered the KPI tiles,
 * the whole Live grid and every card ~11 times a second for the sake of one `src`
 * attribute. Down here the ticks reconcile a single `<img>`.
 */
export function BrandMark({
  appearance,
  blocked,
  thinking,
}: {
  appearance: Appearance;
  blocked: number;
  thinking: number;
}) {
  const phase = useIconPhase(thinking > 0 && appearance.motion);
  return (
    <span
      className={`brand-mark ${blocked > 0 ? "waiting" : ""}`}
      title={blocked > 0 ? `${blocked} session${blocked > 1 ? "s" : ""} waiting on you` : undefined}
    >
      <img
        className="brand-icon"
        src={faviconFor(appearance, blocked > 0, phase)}
        alt=""
        width={22}
        height={22}
      />
    </span>
  );
}
