import { useEffect, useRef, useState } from "react";

/**
 * Scrolling helpers shared by the conversation pane and the page.
 *
 * Two rules throughout: opening something long lands you at the newest content
 * without an animation (a smooth scroll through 2,000 lines is a nuisance, not a
 * flourish), and once you scroll up to read, nothing yanks you back.
 */

/** Jump a container to its end the first time it has content. */
export function useJumpToEnd(
  ref: React.RefObject<HTMLElement | null>,
  ready: boolean,
  key: unknown,
) {
  const done = useRef<unknown>(Symbol("unset"));
  useEffect(() => {
    if (!ready || done.current === key) return;
    const el = ref.current;
    if (!el) return;
    done.current = key;
    // Instant, and on the container only — scrollIntoView would drag the whole
    // window along with it.
    el.scrollTop = el.scrollHeight;
  }, [ref, ready, key]);
}

/** Tracks how far a scrollable element is from each end. */
export function useScrollEdges(ref: React.RefObject<HTMLElement | null>, watch: unknown) {
  const [state, setState] = useState({ atTop: true, atBottom: true, scrollable: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const scrollable = el.scrollHeight - el.clientHeight > 40;
      setState({
        scrollable,
        atTop: el.scrollTop < 24,
        atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 24,
      });
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [ref, watch]);

  return state;
}

export function ScrollJump({
  target,
  atTop,
  atBottom,
  scrollable,
  label = "latest",
  variant = "float",
}: {
  target: React.RefObject<HTMLElement | null>;
  atTop: boolean;
  atBottom: boolean;
  scrollable: boolean;
  label?: string;
  /**
   * "float" positions inside a wrapper that does not scroll. Use "fixed" when the
   * scroll container *is* the element the control lives in — an absolutely placed
   * child of a scroller is laid out against the scrolled content, so it rides up
   * and down with it instead of staying put.
   */
  variant?: "float" | "fixed";
}) {
  if (!scrollable || (atTop && atBottom)) return null;
  const to = (top: number) => target.current?.scrollTo({ top, behavior: "smooth" });
  return (
    <div className={`scroll-jump ${variant}`}>
      {!atTop && (
        <button className="jump-btn" onClick={() => to(0)} title="Scroll to the top">
          ↑ top
        </button>
      )}
      {!atBottom && (
        <button
          className="jump-btn"
          onClick={() => to(target.current?.scrollHeight ?? 0)}
          title={`Scroll to the ${label}`}
        >
          ↓ {label}
        </button>
      )}
    </div>
  );
}

/**
 * The same control for the window, which is what the full-page views scroll.
 * Appears only once there is enough page to make it worth having.
 */
export function PageScrollJump() {
  const [show, setShow] = useState({ up: false, down: false });

  useEffect(() => {
    const measure = () => {
      const el = document.documentElement;
      const far = el.scrollHeight - window.innerHeight > 600;
      setShow({
        up: far && window.scrollY > 400,
        down: far && el.scrollHeight - window.scrollY - window.innerHeight > 400,
      });
    };
    measure();
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, []);

  if (!show.up && !show.down) return null;
  return (
    <div className="page-jump">
      {show.up && (
        <button
          className="jump-btn"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          title="Back to top"
        >
          ↑
        </button>
      )}
      {show.down && (
        <button
          className="jump-btn"
          onClick={() =>
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })
          }
          title="Jump to the bottom"
        >
          ↓
        </button>
      )}
    </div>
  );
}
