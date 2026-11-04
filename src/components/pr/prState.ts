import { useCallback, useEffect, useMemo, useState } from "react";
import { agentBus, prApi, prKey, type Explanation, type PrRef, type PrRun, type PrWatch } from "../../api.ts";

/**
 * Small hooks shared by the review pages. Live data arrives over the one SSE
 * connection App owns, republished on the agent bus; these subscribe to the parts
 * they care about so every panel does not poll the daemon.
 */
export function usePrRuns(pr: PrRef | null): { runs: PrRun[]; reload: () => void } {
  const [runs, setRuns] = useState<PrRun[]>([]);
  const key = pr ? `${pr.owner}/${pr.repo}/${pr.number}` : "";
  const reload = useCallback(() => {
    if (!pr) return;
    prApi
      .runs(pr)
      .then((r) => setRuns(r.runs))
      .catch(() => {});
  }, [key]);
  useEffect(reload, [reload]);
  useEffect(() => {
    const off = agentBus.subscribe((e) => {
        if (e.type !== "pr-run") return;
        setRuns((prev) => {
          if ("deleted" in e.run) return prev.filter((r) => r.id !== e.run.id);
          const run = e.run;
          if (pr && (run.pr.owner !== pr.owner || run.pr.repo !== pr.repo || run.pr.number !== pr.number)) return prev;
          const i = prev.findIndex((r) => r.id === run.id);
          if (i < 0) return [run, ...prev];
          const next = [...prev];
          next[i] = run;
          return next;
        });
      });
    return () => {
      off();
    };
  }, [key]);
  return { runs, reload };
}

/**
 * The daemon's list of watched PRs. Fetched once, then kept current from the
 * `pr-watch` pushes, so every tab and a reload agree on what is unseen.
 */
export function usePrWatches(): { watches: PrWatch[]; byKey: Map<string, PrWatch>; unseenCount: number } {
  const [watches, setWatches] = useState<PrWatch[]>([]);
  useEffect(() => {
    prApi
      .watches()
      .then((r) => setWatches(r.watches))
      .catch(() => {});
    const off = agentBus.subscribe((e) => {
      if (e.type === "pr-watch") setWatches(e.watches);
    });
    return () => {
      off();
    };
  }, []);
  const byKey = useMemo(() => new Map(watches.map((w) => [prKey(w), w])), [watches]);
  const unseenCount = useMemo(() => watches.filter((w) => w.unseen.length > 0).length, [watches]);
  return { watches, byKey, unseenCount };
}

export function useExplanations(pr: PrRef): { explanations: Explanation[]; reload: () => void } {
  const [list, setList] = useState<Explanation[]>([]);
  const key = `${pr.owner}/${pr.repo}/${pr.number}`;
  const reload = useCallback(() => {
    prApi
      .explanations(pr)
      .then((r) => setList(r.explanations))
      .catch(() => {});
  }, [key]);
  useEffect(reload, [reload]);
  useEffect(() => {
    const off = agentBus.subscribe((e) => {
        if (e.type !== "pr-explain") return;
        setList((prev) => {
          if ("deleted" in e.explanation) {
            const gone = new Set(e.explanation.ids);
            return prev.filter((x) => !gone.has(x.id));
          }
          const ex = e.explanation;
          if (ex.owner !== pr.owner || ex.repo !== pr.repo || ex.number !== pr.number) return prev;
          const i = prev.findIndex((x) => x.id === ex.id);
          if (i < 0) return [...prev, ex];
          const next = [...prev];
          next[i] = ex;
          return next;
        });
      });
    return () => {
      off();
    };
  }, [key]);
  return { explanations: list, reload };
}

/** A boolean remembered across reloads — which side panels were open, which layout. */
export function useRemembered(key: string, fallback: boolean): [boolean, () => void] {
  const [on, setOn] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v === "1";
    } catch {
      return fallback;
    }
  });
  const toggle = useCallback(() => {
    setOn((v) => {
      try {
        localStorage.setItem(key, v ? "0" : "1");
      } catch {
        // Private mode: forgetting is fine.
      }
      return !v;
    });
  }, [key]);
  return [on, toggle];
}

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

export const relativeTime = (iso: string) => {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const units: [number, string][] = [
    [60, "s"],
    [60, "m"],
    [24, "h"],
    [30, "d"],
    [12, "mo"],
  ];
  let value = seconds;
  for (const [size, label] of units) {
    if (value < size) return `${Math.floor(value)}${label}`;
    value /= size;
  }
  return `${Math.floor(value)}y`;
};

export const prHash = (pr: PrRef, sub = "") => `#/pr/${pr.owner}/${pr.repo}/${pr.number}${sub}`;

const HIDDEN_KEY = "reviews-hidden";
const HIDDEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
type HiddenStore = Record<string, Record<string, number>>;

function readHiddenStore(): HiddenStore {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "{}") as HiddenStore;
    const cutoff = Date.now() - HIDDEN_TTL_MS;
    const store: HiddenStore = {};
    for (const [view, entries] of Object.entries(raw)) {
      const kept = Object.fromEntries(Object.entries(entries).filter(([, at]) => at > cutoff));
      if (Object.keys(kept).length) store[view] = kept;
    }
    return store;
  } catch {
    return {};
  }
}

/**
 * Pull requests the user dismissed from one view, kept in this browser only. A PR
 * hidden in "Me to review" still shows in "Team's PRs". Each key maps to when it
 * was hidden; entries older than 90 days are dropped on read, so a PR merged long
 * ago does not linger in storage forever.
 */
export function useHiddenPrs(viewId: string | null): {
  hidden: Set<string>;
  hide: (keys: string[]) => void;
  unhide: (keys: string[]) => void;
  clear: () => void;
} {
  const [store, setStore] = useState<HiddenStore>(readHiddenStore);
  const write = useCallback((next: HiddenStore) => {
    setStore(next);
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
    } catch {
      // Private mode: forgetting is fine.
    }
  }, []);
  const patch = useCallback(
    (fn: (entries: Record<string, number>) => Record<string, number>) => {
      if (!viewId) return;
      const next = readHiddenStore();
      next[viewId] = fn(next[viewId] ?? {});
      write(next);
    },
    [viewId, write],
  );
  const hide = useCallback(
    (keys: string[]) => {
      const now = Date.now();
      patch((entries) => ({ ...entries, ...Object.fromEntries(keys.map((k) => [k, now])) }));
    },
    [patch],
  );
  const unhide = useCallback(
    (keys: string[]) =>
      patch((entries) => {
        const next = { ...entries };
        for (const k of keys) delete next[k];
        return next;
      }),
    [patch],
  );
  const clear = useCallback(() => patch(() => ({})), [patch]);
  const hidden = useMemo(() => new Set(Object.keys((viewId && store[viewId]) || {})), [store, viewId]);
  return { hidden, hide, unhide, clear };
}
