import { useCallback, useEffect, useMemo, useState } from "react";
import { gitApi, type GitWriteResult, type RepoStatus } from "../api.ts";

/**
 * One repository's state, shared by the two places that show it.
 *
 * The controls (branch, pull, push, commit) live in the sidebar and the diff lives
 * at the bottom of the page, so neither can own this: a commit made in one has to
 * empty the file list in the other. Rather than have both poll, the state is lifted
 * to their common parent and handed down.
 *
 * The returned object is memoised on the state it carries, not rebuilt per render.
 * The page it hangs off re-renders many times a second while a session is running,
 * and both consumers are memoised components — a fresh object every render would
 * defeat that and re-render a large diff for every timeline event.
 */

export type GitNotice = { ok: boolean; text: string; hint: string | null };

export type GitRepo = {
  cwd: string;
  status: RepoStatus | null;
  /** Label of the write in flight, so only its own button shows as busy. */
  busy: string | null;
  /** What the last write did, or why git refused it. */
  notice: GitNotice | null;
  dismiss: () => void;
  refresh: () => void;
  /** Draft commit message. Held here so it survives the panel scrolling out of view. */
  message: string;
  setMessage: (v: string) => void;
  pull: () => Promise<GitWriteResult>;
  push: () => Promise<GitWriteResult>;
  stage: (opts: { paths?: string[]; all?: boolean }) => Promise<GitWriteResult>;
  unstage: (opts: { paths?: string[]; all?: boolean }) => Promise<GitWriteResult>;
  /** Destroys uncommitted work — the caller is expected to have confirmed it. */
  discard: (paths: string[]) => Promise<GitWriteResult>;
  commit: () => Promise<GitWriteResult | null>;
  /** Adopt the status a branch switch returned — the popover makes that write itself. */
  applySwitch: (next: RepoStatus) => void;
  /**
   * Bumped whenever HEAD moves — a switch, a pull, a commit. Anything derived from a
   * commit that is no longer current watches this and throws its copy away.
   */
  moved: number;
};

/**
 * Badges are scattered across the page — one per session card — and none of them
 * know that the sidebar just switched branch. Rather than give each one a poll, the
 * write path drops the shared cache and bumps a counter they all watch.
 */
const statusCache = new Map<string, Promise<RepoStatus>>();
const watchers = new Set<() => void>();

export function cachedStatus(cwd: string): Promise<RepoStatus> {
  let p = statusCache.get(cwd);
  if (!p) {
    p = gitApi.status(cwd);
    statusCache.set(cwd, p);
    // Short-lived: a branch switch or a new edit should show up without a reload.
    setTimeout(() => statusCache.delete(cwd), 5_000);
  }
  return p;
}

export function invalidateStatusCache(): void {
  statusCache.clear();
  for (const w of watchers) w();
}

/** Subscribe to "something wrote to a repo", for the badges. */
export function watchStatus(fn: () => void): () => void {
  watchers.add(fn);
  return () => {
    watchers.delete(fn);
  };
}

export function useGitRepo(cwd: string): GitRepo {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<GitNotice | null>(null);
  const [message, setMessage] = useState("");
  const [moved, setMoved] = useState(0);

  useEffect(() => {
    let alive = true;
    setStatus(null);
    // The page calls this before it knows the session's directory; there is nothing
    // to ask about until it does.
    if (!cwd) return;
    gitApi
      .status(cwd)
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus(null));
    return () => {
      alive = false;
    };
  }, [cwd]);

  const refresh = useCallback(() => {
    gitApi
      .status(cwd, true)
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [cwd]);

  /**
   * Run one write and report what it did.
   *
   * Every git write has the same shape — it either happened, with something worth
   * saying about it, or git refused with a message better than anything we would
   * write ourselves. `movedHead` says whether the commit under everyone's feet
   * changed, which is what invalidates the file selection, the history and the base
   * comparison currently on screen.
   */
  const write = useCallback(
    async (label: string, call: () => Promise<GitWriteResult>, movedHead = false) => {
      setBusy(label);
      setNotice(null);
      const r = await call().catch((e: Error) => ({
        ok: false,
        status: null,
        error: e.message,
        hint: null,
        note: null,
      }));
      setBusy(null);
      setNotice({
        ok: r.ok,
        text: (r.ok ? r.note : r.error) ?? (r.ok ? `${label} done.` : `${label} failed.`),
        hint: r.hint ?? null,
      });
      if (r.status) {
        // The badge on every session card counts the files this just changed.
        invalidateStatusCache();
        setStatus(r.status);
      }
      if (r.ok && movedHead) setMoved((n) => n + 1);
      return r;
    },
    [],
  );

  const pull = useCallback(() => write("Pull", () => gitApi.pull(cwd), true), [cwd, write]);
  const push = useCallback(() => write("Push", () => gitApi.push(cwd)), [cwd, write]);

  const stage = useCallback(
    (opts: { paths?: string[]; all?: boolean }) => write("Stage", () => gitApi.stage(cwd, opts)),
    [cwd, write],
  );
  const unstage = useCallback(
    (opts: { paths?: string[]; all?: boolean }) => write("Unstage", () => gitApi.unstage(cwd, opts)),
    [cwd, write],
  );

  /**
   * Counts as HEAD moving even though it doesn't: the file may no longer exist, and
   * its patch is gone either way, so anything derived from it has to be thrown away.
   */
  const discard = useCallback(
    (paths: string[]) => write("Discard", () => gitApi.discard(cwd, paths), true),
    [cwd, write],
  );

  /**
   * Commit the staged files. The message is only cleared on success, so a commit a
   * hook rejected can be retried without retyping it.
   */
  const commit = useCallback(async () => {
    const text = message.trim();
    if (!text) return null;
    const r = await write("Commit", () => gitApi.createCommit(cwd, text), true);
    if (r.ok) setMessage("");
    return r;
  }, [cwd, message, write]);

  const dismiss = useCallback(() => setNotice(null), []);

  /**
   * A branch switch is a write like any other, but it is made by the branch popover
   * rather than by one of the calls above, so it hands the resulting status back here.
   */
  const applySwitch = useCallback((next: RepoStatus) => {
    invalidateStatusCache();
    setStatus(next);
    setNotice(null);
    setMoved((n) => n + 1);
  }, []);

  return useMemo(
    () => ({
      cwd,
      status,
      busy,
      notice,
      dismiss,
      refresh,
      message,
      setMessage,
      pull,
      push,
      stage,
      unstage,
      discard,
      commit,
      moved,
      applySwitch,
    }),
    [cwd, status, busy, notice, dismiss, refresh, message, pull, push, stage, unstage, discard, commit, moved, applySwitch],
  );
}
