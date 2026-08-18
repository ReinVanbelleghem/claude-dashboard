import { useCallback, useEffect, useRef, useState } from "react";
import { fmtAgo, gitApi, type Branch, type BranchList } from "../api.ts";
import { PlusIcon, WorktreeIcon } from "./Icons.tsx";

/**
 * The branch a worktree will hold: one that already exists, or a new one.
 *
 * `name` is always the local branch name — a remote row reports "feat/x", not
 * "origin/feat/x", because that is the branch the checkout ends up on. `create` is
 * what tells the daemon which of the two this is, and getting it wrong is exactly the
 * failure this picker exists to remove: asking to create a name the remote already
 * publishes is refused, and there was no way to say "the existing one" from a plain
 * text field.
 */
export type BranchChoice = { name: string; create: boolean; from: string | null };

/** The local name a checkout would take for this row. */
function localName(b: Branch): string {
  return b.remote ? b.name.slice(b.remote.length + 1) : b.name;
}

/**
 * Filter box over the repository's branches, sharing the branch switcher's server-side
 * search: a repo with thousands of remote branches cannot be filtered in the browser,
 * and picking a branch by memory-and-typing is what made existing branches hard to
 * reach in the first place.
 */
export function BranchPicker({
  cwd,
  from,
  value,
  onChange,
  onOpenWorktree,
  disabled = false,
  autoFocus = false,
}: {
  cwd: string;
  /** What a new branch would be cut from, named in the create row. */
  from: string;
  value: BranchChoice | null;
  onChange: (choice: BranchChoice | null) => void;
  /**
   * Where to send someone who picks a branch git already has open. A branch can only be
   * checked out once, so those rows offer that checkout rather than a click that is
   * guaranteed to fail. Without this they are inert.
   */
  onOpenWorktree?: (path: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [list, setList] = useState<BranchList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  /** Discards responses to superseded keystrokes, which can land out of order. */
  const seq = useRef(0);

  const load = useCallback(
    (q: string) => {
      if (!cwd) return;
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

  // Debounced, so a typed branch name is one or two requests rather than one per letter.
  useEffect(() => {
    if (value) return;
    const t = setTimeout(() => load(query), query ? 140 : 0);
    return () => clearTimeout(t);
  }, [query, load, value]);

  const doFetch = async () => {
    setFetching(true);
    await gitApi.fetch(cwd).catch(() => {});
    setFetching(false);
    load(query);
  };

  if (value) {
    return (
      <div className="branch-picked">
        <span className="branch-row-main">
          <span className="branch-row-name">{value.name}</span>
          <span className="branch-row-sub">
            {value.create ? `new branch off ${value.from ?? from}` : "existing branch"}
          </span>
        </span>
        <button className="link-btn inline" disabled={disabled} onClick={() => onChange(null)}>
          change
        </button>
      </div>
    );
  }

  const shown = list?.branches ?? [];
  const hidden = Math.max(0, (list?.matched ?? 0) - shown.length);
  const wanted = query.trim();
  /**
   * Creation is offered only for a name nothing already answers to. The daemon refuses
   * the other case anyway; offering it here is how you get an error message instead of
   * a worktree.
   */
  const exact = list?.exact ?? null;
  const canCreate = !!wanted && !!list && !exact;

  const pick = (b: Branch) => {
    if (b.worktreePath) {
      onOpenWorktree?.(b.worktreePath);
      return;
    }
    onChange({ name: localName(b), create: false, from: null });
  };

  return (
    <div className="branch-pick">
      <div className="branch-pop-head">
        <input
          className="search"
          autoFocus={autoFocus}
          disabled={disabled}
          placeholder="Filter branches, or type a new name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            if (exact) pick(exact);
            else if (shown.length === 1) pick(shown[0]);
            else if (canCreate) onChange({ name: wanted, create: true, from });
          }}
        />
        <button
          className="icon-btn tiny"
          onClick={doFetch}
          disabled={fetching || disabled}
          title="git fetch --all --prune — refreshes this list without touching your files"
        >
          {fetching ? "Fetching…" : "Fetch"}
        </button>
      </div>

      <div className="branch-list">
        {list === null ? (
          loadError ? (
            <div className="branch-error">
              <pre>{loadError}</pre>
            </div>
          ) : (
            <div className="hint branch-empty">Reading branches…</div>
          )
        ) : (
          <>
            {exact && !shown.some((b) => b.name === exact.name) && (
              <Row key={exact.name} branch={exact} onPick={pick} canOpen={!!onOpenWorktree} />
            )}
            {shown.map((b) => (
              <Row key={b.name} branch={b} onPick={pick} canOpen={!!onOpenWorktree} />
            ))}

            {canCreate && (
              <button
                className="branch-row create"
                disabled={disabled}
                onClick={() => onChange({ name: wanted, create: true, from })}
              >
                <span className="branch-row-mark">
                  <PlusIcon />
                </span>
                <span className="branch-row-main">
                  <span className="branch-row-name">{wanted}</span>
                  <span className="branch-row-sub">new branch off {from}</span>
                </span>
                <span className="branch-row-meta">create</span>
              </button>
            )}

            {shown.length === 0 && !canCreate && <div className="hint branch-empty">No branch matches.</div>}
          </>
        )}
      </div>

      {list && (
        <div className="branch-foot">
          {hidden > 0
            ? `${shown.length} of ${list.matched} matches — keep typing to narrow it down.`
            : `${list.total.local} local, ${list.total.remote} remote.`}
        </div>
      )}
    </div>
  );
}

/**
 * One branch. A branch held by another checkout cannot be checked out again, so it
 * offers that checkout instead of a worktree it cannot create.
 */
function Row({
  branch: b,
  onPick,
  canOpen,
}: {
  branch: Branch;
  onPick: (b: Branch) => void;
  canOpen: boolean;
}) {
  const held = b.worktreePath;
  const name = (
    <span className="branch-row-name">
      {b.remote && <span className="branch-remote">{b.remote}/</span>}
      {localName(b)}
    </span>
  );

  if (held) {
    const dir = held.split("/").filter(Boolean).pop() ?? held;
    return (
      <button
        className="branch-row held"
        disabled={!canOpen}
        onClick={() => onPick(b)}
        title={`${b.name} is checked out in ${held}. A branch can only be checked out once.`}
      >
        <span className="branch-row-mark">
          <WorktreeIcon />
        </span>
        <span className="branch-row-main">
          {name}
          <span className="branch-row-sub">in {dir}</span>
        </span>
        <span className="branch-row-meta">{canOpen ? "use it" : "in use"}</span>
      </button>
    );
  }

  return (
    <button className="branch-row" onClick={() => onPick(b)} title={`${b.head} · ${b.subject}`}>
      <span className="branch-row-mark" />
      <span className="branch-row-main">
        {name}
        <span className="branch-row-sub">{b.subject || "no commits"}</span>
      </span>
      <span className="branch-row-meta">
        {b.ahead > 0 && <span className="tok-add">↑{b.ahead}</span>}
        {b.behind > 0 && <span className="tok-del">↓{b.behind}</span>}
        {b.ts > 0 && <span className="branch-age">{fmtAgo(b.ts)}</span>}
      </span>
    </button>
  );
}
