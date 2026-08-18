import { useCallback, useEffect, useRef, useState } from "react";
import { clearPaint, expandCollapsed, findRanges, findRoot, paint, reveal } from "./find.ts";

export function useFind(active: boolean) {
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const ranges = useRef<Range[]>([]);
  const at = useRef(0);

  const show = useCallback((next: number, scroll: boolean) => {
    const list = ranges.current;
    if (list.length === 0) {
      at.current = 0;
      setIndex(0);
      clearPaint();
      return;
    }
    const wrapped = ((next % list.length) + list.length) % list.length;
    at.current = wrapped;
    setIndex(wrapped);
    paint(list, wrapped);
    if (scroll) reveal(list[wrapped]);
  }, []);

  const rescan = useCallback(
    (scroll: boolean) => {
      ranges.current = findRanges(findRoot(), query);
      setCount(ranges.current.length);
      show(Math.min(at.current, Math.max(0, ranges.current.length - 1)), scroll);
    },
    [query, show],
  );

  useEffect(() => {
    if (!active) {
      ranges.current = [];
      setCount(0);
      at.current = 0;
      setIndex(0);
      clearPaint();
      return;
    }
    if (!query.trim()) {
      ranges.current = [];
      setCount(0);
      at.current = 0;
      setIndex(0);
      clearPaint();
      return;
    }
    expandCollapsed(findRoot());
    const t = window.setTimeout(() => rescan(true), 0);
    return () => clearTimeout(t);
  }, [active, query, rescan]);

  useEffect(() => {
    if (!active || !query.trim()) return;
    const root = findRoot();
    let pending = 0;
    const observer = new MutationObserver(() => {
      clearTimeout(pending);
      pending = window.setTimeout(() => rescan(false), 400);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      clearTimeout(pending);
      observer.disconnect();
    };
  }, [active, query, rescan]);

  // Closing the bar unmounts it, which is not a state change the effects above can
  // see, so the paint has to be dropped here or the marks outlive the search.
  useEffect(() => clearPaint, []);

  const step = useCallback((delta: number) => show(at.current + delta, true), [show]);

  return { query, setQuery, count, index, step };
}
