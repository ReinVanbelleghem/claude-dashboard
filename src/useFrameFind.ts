import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Find inside an open artifact.
 *
 * Same shape as `useFind`, so the find bar does not care which one is driving it —
 * but the search cannot happen here. An artifact is a cross-origin document on
 * purpose, which is what keeps its scripts away from the API, and the cost of that
 * is that this window cannot read a single node of it. So the query is posted into
 * the frame, a bridge script searches and highlights in there, and only a count
 * comes back.
 */
export function useFrameFind(frame: HTMLIFrameElement | null) {
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const ready = useRef(false);

  const post = useCallback(
    (msg: Record<string, unknown>) => {
      const win = frame?.contentWindow;
      if (!win) return;
      // "*" because the frame has an opaque origin — it is sandboxed without
      // allow-same-origin, so there is no origin string to target. Nothing
      // sensitive travels this way: it is a search term.
      win.postMessage({ __artifactFind: "query", ...msg }, "*");
    },
    [frame],
  );

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Identity, not origin: an opaque origin reports itself as "null", so the
      // only meaningful check is that this really is the frame we are driving.
      if (!frame?.contentWindow || e.source !== frame.contentWindow) return;
      const m = e.data as { __artifactFind?: string; count?: number; index?: number };
      if (m?.__artifactFind === "ready") {
        ready.current = true;
        if (query.trim()) post({ query });
        return;
      }
      if (m?.__artifactFind !== "result") return;
      setCount(m.count ?? 0);
      setIndex(m.index ?? 0);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frame, post, query]);

  useEffect(() => {
    post({ query });
    if (!query.trim()) {
      setCount(0);
      setIndex(0);
    }
  }, [query, post]);

  const step = useCallback((delta: number) => post({ step: delta }), [post]);

  return { query, setQuery, count, index, step };
}
