/**
 * Keeps idle motion cheap. A running CSS animation makes the compositor draw a
 * frame on every refresh whether or not anyone is looking, and a working
 * session's spinner can run for hours.
 *
 * - `data-window-hidden` on <html> while the document is hidden; styles.css
 *   pauses every animation under it.
 * - `data-animation-offscreen` on an element running an infinite animation while
 *   it is outside the viewport. Elements are picked up from `animationstart`, so
 *   no component has to register.
 * - The stepped spinners (`spin-steps`) all start their phase at time 0, so
 *   several on screen step on the same frames instead of each on its own.
 */
const OFFSCREEN_ATTR = "data-animation-offscreen";
const HIDDEN_ATTR = "data-window-hidden";
const SHARED_PHASE = "spin-steps";

let observer: IntersectionObserver | null = null;

function offscreenObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver !== "function") return null;
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.target.isConnected) {
        observer?.unobserve(e.target);
        continue;
      }
      e.target.toggleAttribute(OFFSCREEN_ATTR, !e.isIntersecting);
    }
  });
  return observer;
}

function onAnimationStart(e: AnimationEvent) {
  const el = e.target;
  if (!(el instanceof Element)) return;
  const running = el.getAnimations?.(e.pseudoElement ? { subtree: true } : undefined) ?? [];
  let loops = false;
  for (const a of running) {
    if (a.effect?.getComputedTiming().iterations !== Infinity) continue;
    loops = true;
    if ((a as CSSAnimation).animationName === SHARED_PHASE) a.startTime = 0;
  }
  if (loops) offscreenObserver()?.observe(el);
}

export function installWindowActivity() {
  const reconcile = () => document.documentElement.toggleAttribute(HIDDEN_ATTR, document.visibilityState === "hidden");
  reconcile();
  document.addEventListener("visibilitychange", reconcile);
  document.addEventListener("animationstart", onAnimationStart, true);
}
