import { useEffect, useState } from "react";
import { MOTION_PERIOD_MS, motionPhase, prefersReducedMotion } from "./appearance.ts";

/**
 * The current frame of the icon animation, for the in-page copies of the glyph
 * (the header mark, the picker tiles, the tab preview).
 *
 * These could have been animated declaratively with SMIL inside the SVG, which does
 * run in an `<img>`. They are driven from the same clock as the favicon instead so
 * the header mark and the tab icon are never a few frames apart — seeing them
 * disagree is worse than either being slightly less smooth.
 *
 * Returns undefined when it should not animate, which is also the value that makes
 * faviconDataUrl draw the still glyph, so callers never branch.
 */
export function useIconPhase(active: boolean): number | undefined {
  const run = active && !prefersReducedMotion();
  const [phase, setPhase] = useState(() => (run ? motionPhase() : undefined));

  useEffect(() => {
    if (!run) {
      setPhase(undefined);
      return;
    }
    let raf = 0;
    // rAF rather than an interval: this only matters while the page is visible, and
    // rAF already stops when it is not. The favicon has the opposite requirement and
    // so uses a timer. Phase is quantised, so most rAF ticks resolve to the frame
    // already on screen — setting the same value skips the re-render.
    const tick = () => {
      setPhase(motionPhase());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [run]);

  return phase;
}

/** One full turn, in ms — for CSS-driven copies that want to match the glyph. */
export { MOTION_PERIOD_MS };
