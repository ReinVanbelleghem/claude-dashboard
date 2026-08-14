import { useCallback, useEffect, useRef, useState } from "react";
import {
  fmtAgo,
  gitApi,
  type Branch,
  type BranchList,
  type GitWriteResult,
  type RepoStatus,
} from "../api.ts";
import { CheckIcon, GitIcon, PlusIcon } from "./Icons.tsx";

/**
 * Switch branch from the dashboard.
 *
 * The list is deliberately not a plain <select>: which branch you want depends on
 * how recently it moved, whether it is ahead of its upstream and what its last
 * commit said, none of which fits in an option label. It is a filter box over a
 * ranked list — type to narrow, type something new to create it.
 *
 * The filter runs on the server, not over a list held here. A repo a few years old
 * has thousands of remote branches (the TMS backend has ~5,800), which is a
 * megabyte of JSON and thousands of unread DOM nodes if you fetch them all to
 * filter three of them out.
 *
 * Switching is the one place the dashboard changes a repo out from under whatever
 * is working in it, so the risks are stated before the click rather than after:
 * uncommitted work that git may refuse to carry, and any session running here.
 */
export function BranchSwitcher({
  cwd,
  status,
  onSwitched,
  /** Set when the dashboard owns a session working in this directory. */
  sessionHere = false,
}: {
  cwd: string;
  status: RepoStatus;
  onSwitched: (next: RepoStatus) => void;
  sessionHere?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<BranchList | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ error: string; hint: string | null } | null>(null);
  const [fetching, setFetching] = useState(false);
  /**
   * Set when the branch list itself failed to load. Without it a failed fetch is
   * indistinguishable from a slow one — the panel just says "Reading branches…"
   * forever, which is exactly how a stale daemon presented itself.
   */
  const [loadError, setLoadError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  /** Discards responses to superseded keystrokes, which can land out of order. */
  const seq = useRef(0);

  const load = useCallback(
    (q: string) => {
      const mine = ++seq.current;
      gitApi
        .branches(cwd, { q })
        .then((r) => {
          if (seq.current !== mine) return;
          setList(r);
          setLoadError(r.ok ? null : (r.error ?? "could not read branches"));
        })
        .catch((e: Error) => {
          if (seq.current !== mine) return;
          setList(null);
          setLoadError(e.message);
        });
    },
    [cwd],
  );

  // Loaded when the popover opens, not on mount: for-each-ref on a large repo is
  // not free and most renders of this control are never clicked. Debounced on
  // keystrokes so a typed branch name is one or two requests, not one per letter.
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const wait = query ? 140 : 0;
    const t = setTimeout(() => load(query), wait);
    return () => clearTimeout(t);
  }, [open, query, load]);

  // Click-outside and Escape both close it, which is what a popover has to do to
  // not feel like a stuck modal.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const dirty = status.counts.staged + status.counts.unstaged + status.counts.untracked;

  /** Already ranked and deduplicated by the server. */
  const shown = list?.branches ?? [];
  /** How many matches the page leaves out. */
  const hidden = Math.max(0, (list?.matched ?? 0) - shown.length);

  const wanted = query.trim();
  /**
   * Offer creation only for a name nothing already answers to. The server reports an
   * exact match separately from the page precisely for this: paging can hide one
   * behind sixty substring matches, and offering "create feat/x" while origin/feat/x
   * exists is how you end up with a branch that shares a name with someone's work
   * and none of its commits.
   */
  const exact = list?.exact ?? null;
  const canCreate = !!wanted && !!list && !exact;

  const run = async (branch: string, opts: { create?: boolean; from?: string } = {}) => {
    setBusy(branch);
    setFailure(null);
    const r = await gitApi.checkout(cwd, branch, opts).catch((e: Error) => ({
      ok: false,
      status: null,
      error: e.message,
      hint: null,
    }));
    setBusy(null);
    if (r.ok) {
      setOpen(false);
      setQuery("");
      if (r.status) onSwitched(r.status);
      return;
    }
    setFailure({ error: r.error ?? "git refused the switch", hint: r.hint });
    // A refusal usually means the repo moved under us; re-read so the list and the
    // dirty-file warning describe what is actually there now.
    if (r.status) onSwitched(r.status);
    load(query);
  };

  /** Refresh remote refs so the list reflects what has been pushed since. */
  const doFetch = async () => {
    setFetching(true);
    setFailure(null);
    const r: GitWriteResult = await gitApi.fetch(cwd).catch((e: Error) => ({
      ok: false,
      error: e.message,
      hint: null,
      status: null,
    }));
    setFetching(false);
    if (!r.ok) setFailure({ error: r.error ?? "fetch failed", hint: r.hint ?? null });
    if (r.status) onSwitched(r.status);
    load(query);
  };

  const label = status.detached ? `detached at ${status.head?.slice(0, 8)}` : status.branch;

  return (
    <div className="branch-switch" ref={wrap}>
      <button
        className={`branch-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen(!open)}
        title="Switch branch"
      >
        <GitIcon />
        <span className="branch-trigger-name">{label}</span>
        <span className="branch-caret" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className="branch-pop">
          <div className="branch-pop-head">
            <input
              ref={input}
              className="search"
              placeholder="Filter branches, or type a new name…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                // Enter takes the obvious action: the name typed in full, the only
                // match if there is one, or otherwise the new branch.
                if (exact) void run(exact.name);
                else if (shown.length === 1) void run(shown[0].name);
                else if (canCreate) void run(wanted, { create: true });
              }}
            />
            {/* Fetch belongs here because it refreshes *this list* and touches no
                files. Pull acts on the branch you are on, so it lives in the panel
                header instead. */}
            <button
              className="icon-btn tiny"
              onClick={doFetch}
              disabled={fetching}
              title="git fetch --all --prune — refreshes this list without touching your files"
            >
              {fetching ? "Fetching…" : "Fetch"}
            </button>
          </div>

          {(dirty > 0 || sessionHere) && (
            <div className="branch-warn">
              {dirty > 0 && (
                <span>
                  {dirty} uncommitted change{dirty === 1 ? "" : "s"} — git carries them across when it
                  can and refuses the switch when it can't.
                </span>
              )}
              {sessionHere && <span>A session is running here; switching moves the files under it.</span>}
            </div>
          )}

          {failure && (
            <div className="branch-error">
              <pre>{failure.error}</pre>
              {failure.hint && <p>{failure.hint}</p>}
            </div>
          )}

          <div className="branch-list">
            {list === null ? (
              loadError ? (
                <div className="branch-error">
                  <pre>{loadError}</pre>
                  <p>The dashboard daemon could not list branches for this repository.</p>
                </div>
              ) : (
                <div className="hint branch-empty">Reading branches…</div>
              )
            ) : (
              <>
                {/* The exact match is pinned when paging left it out, so a name you
                    typed in full is always one click away. */}
                {exact && !shown.some((b) => b.name === exact.name) && (
                  <Row branch={exact} busy={busy} onPick={run} />
                )}
                {shown.map((b) => (
                  <Row key={b.name} branch={b} busy={busy} onPick={run} />
                ))}

                {canCreate && (
                  <button
                    className="branch-row create"
                    disabled={!!busy}
                    onClick={() => void run(wanted, { create: true })}
                    title={`Branch off ${status.branch ?? status.head ?? "HEAD"}`}
                  >
                    <span className="branch-row-mark">
                      <PlusIcon />
                    </span>
                    <span className="branch-row-main">
                      <span className="branch-row-name">{wanted}</span>
                      <span className="branch-row-sub">
                        new branch off {status.detached ? status.head : status.branch}
                      </span>
                    </span>
                    <span className="branch-row-meta">
                      {busy === wanted ? "creating…" : "create"}
                    </span>
                  </button>
                )}

                {shown.length === 0 && !canCreate && (
                  <div className="hint branch-empty">No branch matches.</div>
                )}
              </>
            )}
          </div>

          {/* What the page leaves out, said plainly: a list that silently stops at
              sixty of five thousand reads as "that's all there is". */}
          {list && (
            <div className="branch-foot">
              {hidden > 0
                ? `${shown.length} of ${list.matched} matches — keep typing to narrow it down.`
                : `${list.total.local} local, ${list.total.remote} remote.`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One branch in the list. */
function Row({
  branch: b,
  busy,
  onPick,
}: {
  branch: Branch;
  busy: string | null;
  onPick: (name: string) => void;
}) {
  return (
    <button
      className={`branch-row ${b.current ? "current" : ""}`}
      disabled={b.current || !!busy}
      onClick={() => onPick(b.name)}
      title={`${b.head} · ${b.subject}`}
    >
      <span className="branch-row-mark">{b.current ? <CheckIcon /> : null}</span>
      <span className="branch-row-main">
        <span className="branch-row-name">
          {b.remote && <span className="branch-remote">{b.remote}/</span>}
          {b.remote ? b.name.slice(b.remote.length + 1) : b.name}
        </span>
        <span className="branch-row-sub">{b.subject || "no commits"}</span>
      </span>
      <span className="branch-row-meta">
        {busy === b.name ? (
          "switching…"
        ) : (
          <>
            {b.ahead > 0 && <span className="tok-add">↑{b.ahead}</span>}
            {b.behind > 0 && <span className="tok-del">↓{b.behind}</span>}
            {b.ts > 0 && <span className="branch-age">{fmtAgo(b.ts)}</span>}
          </>
        )}
      </span>
    </button>
  );
}
