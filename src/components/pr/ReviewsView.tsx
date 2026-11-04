import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { prApi, prKey, settingsApi, type Person, type PrFilter, type PrState, type PrSummary, type PrWatch, type SavedView, type Settings } from "../../api.ts";
import { EyeOffIcon, RefreshIcon, TrashIcon, GripIcon, ChevronIcon, CheckIcon } from "../Icons.tsx";
import { Select } from "../Select.tsx";
import { useSortable } from "../../useSortable.ts";
import { CiDot, DraftBadge, ReviewBadge, StateBadge } from "./PrBadges.tsx";
import { ActivityChips, WatchToggle } from "./PrWatchBits.tsx";
import { isTyping, prHash, relativeTime, useHiddenPrs } from "./prState.ts";

/**
 * The pull request list: saved views down the side, a filter bar, and one row per
 * open PR. Views are saved filters in settings.json, so the same set shows up in
 * every browser. j/k move, Enter opens, r refreshes, x selects for a bulk action,
 * h hides a PR that matches the view but is not worth bothering with. Hidden PRs
 * are remembered per view and per browser, not in settings, and can be shown again
 * from the toolbar. w watches a PR; watched PRs with unseen activity float to the
 * top so what moved is what you see first.
 */
const EMPTY: PrFilter = { repos: [] };
const same = (a: PrFilter, b: PrFilter) => JSON.stringify(a) === JSON.stringify(b);
const VIEW_KEY = "reviews-view";
/** A list older than this is shown at once and refreshed behind it. */
const FRESH_MS = 45_000;

export function ReviewsView({
  settings,
  watches,
  onSettings,
  onOpenSettings,
}: {
  settings: Settings | null;
  watches: PrWatch[];
  onSettings: (s: Settings) => void;
  onOpenSettings: () => void;
}) {
  const watchByKey = useMemo(() => new Map(watches.map((w) => [prKey(w), w])), [watches]);
  const views = settings?.reviews.views ?? [];
  const [viewId, setViewId] = useState<string | null>(() => localStorage.getItem(VIEW_KEY));
  const active = views.find((v) => v.id === viewId) ?? views[0] ?? null;
  useEffect(() => {
    if (active) localStorage.setItem(VIEW_KEY, active.id);
  }, [active?.id]);

  /** Edits to the active view's filter, before they are saved (or discarded by switching view). */
  const [draft, setDraft] = useState<{ viewId: string | null; filter: PrFilter }>({ viewId: null, filter: EMPTY });
  const filter = active && draft.viewId === active.id ? draft.filter : (active?.filter ?? EMPTY);
  const dirty = !!active && !same(filter, active.filter);

  const [allPrs, setPrs] = useState<PrSummary[]>([]);
  const { hidden, hide, unhide, clear: clearHidden } = useHiddenPrs(active?.id ?? null);
  const [showHidden, setShowHidden] = useState(false);
  const hiddenCount = useMemo(() => allPrs.filter((p) => hidden.has(prKey(p))).length, [allPrs, hidden]);
  const prs = useMemo(() => {
    const shown = showHidden ? allPrs : allPrs.filter((p) => !hidden.has(prKey(p)));
    const unseen = (p: PrSummary) => (watchByKey.get(prKey(p))?.unseen.length ?? 0) > 0;
    return [...shown.filter(unseen), ...shown.filter((p) => !unseen(p))];
  }, [allPrs, hidden, showHidden, watchByKey]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; login: string | null; repos: string[]; error?: string } | null>(null);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    prApi.status().then(setStatus).catch(() => setStatus({ ok: false, login: null, repos: [] }));
  }, []);

  const filterKey = JSON.stringify(filter);
  /**
   * The daemon answers from its cache first, so a view switch paints at once; when
   * that copy is older than FRESH_MS a refresh follows and replaces it quietly.
   * Only a request for the filter still on screen may land — a slow answer for
   * the previous view must not overwrite the current one.
   */
  const load = useCallback(
    (refresh = false) => {
      if (!active) return;
      const mine = filterKey;
      setLoading(true);
      setError(null);
      prApi
        .list(filter, refresh)
        .then((r) => {
          if (mine !== filterKeyRef.current) return;
          setPrs(r.prs);
          setLoading(false);
          if (!refresh && Date.now() - r.fetchedAt > FRESH_MS) {
            setRefreshing(true);
            prApi
              .list(filter, true)
              .then((fresh) => mine === filterKeyRef.current && setPrs(fresh.prs))
              .catch(() => {})
              .finally(() => mine === filterKeyRef.current && setRefreshing(false));
          }
        })
        .catch((e: Error) => {
          if (mine !== filterKeyRef.current) return;
          setError(e.message);
          setLoading(false);
        });
    },
    [filterKey, active?.id],
  );
  const filterKeyRef = useRef(filterKey);
  filterKeyRef.current = filterKey;
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    setPrs([]);
    load();
  }, [load]);
  useEffect(() => {
    const t = setInterval(() => load(true), 60_000);
    return () => clearInterval(t);
  }, [load]);
  // Warm the daemon's cache for the other views, so switching to one is instant.
  useEffect(() => {
    if (!active || loading) return;
    for (const v of views) if (v.id !== active.id) prApi.list(v.filter).catch(() => {});
  }, [active?.id, loading]);

  const open = useCallback((pr: PrSummary) => {
    window.location.hash = prHash(pr);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j") setCursor((c) => Math.min(c + 1, prs.length - 1));
      else if (e.key === "k") setCursor((c) => Math.max(c - 1, 0));
      else if (e.key === "Enter" && prs[cursor]) open(prs[cursor]);
      else if (e.key === "r") load(true);
      else if (e.key === "x" && prs[cursor]) toggle(prs[cursor]);
      else if (e.key === "h" && prs[cursor]) toggleHidden(prs[cursor]);
      else if (e.key === "w" && prs[cursor]) {
        const pr = prs[cursor];
        void (watchByKey.has(prKey(pr)) ? prApi.unwatch(pr) : prApi.watch(pr)).catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    document.querySelector(`[data-pr-row="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const toggle = (pr: PrSummary) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const k = prKey(pr);
      if (!next.delete(k)) next.add(k);
      return next;
    });
  const picked = prs.filter((p) => selected.has(prKey(p)));

  const toggleHidden = (pr: PrSummary) => {
    const k = prKey(pr);
    if (hidden.has(k)) unhide([k]);
    else hide([k]);
    setCursor((c) => Math.min(c, Math.max(0, prs.length - 2)));
  };
  const hidePicked = () => {
    hide(picked.map(prKey));
    setSelected(new Set());
    setCursor(0);
  };

  const saveViews = (next: SavedView[]) =>
    settingsApi
      .save({ reviews: { views: next } })
      .then((r) => onSettings(r.settings))
      .catch(() => {});

  const saveView = () => {
    if (!active) return;
    void saveViews(views.map((v) => (v.id === active.id ? { ...v, filter } : v)));
    setDraft({ viewId: null, filter: EMPTY });
  };
  const saveAsNew = () => {
    const name = window.prompt("View name")?.trim();
    if (!name) return;
    const id = `view-${Date.now().toString(36)}`;
    void saveViews([...views, { id, name, filter }]);
    setDraft({ viewId: null, filter: EMPTY });
    setViewId(id);
  };

  const actions = settings?.reviews.actions ?? [];
  const runBulk = async (actionId: string) => {
    setStarting(true);
    try {
      for (const pr of picked) await prApi.startRun(pr, actionId);
      setSelected(new Set());
      setBulkOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  if (status && !status.ok) {
    return (
      <div className="panel">
        <h2>Pull requests</h2>
        <p className="hint">The daemon could not reach GitHub.</p>
        <pre className="pr-error">{status.error ?? "Unknown error"}</pre>
        <p className="hint">
          Sign in with <code>gh auth login</code> in a terminal, then try again. The dashboard uses the token the <code>gh</code> CLI holds; nothing
          else is stored.
        </p>
        <button
          className="icon-btn"
          onClick={() => {
            prApi.reset().then(() => prApi.status().then(setStatus)).catch(() => {});
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  const noRepos = !filter.repos?.length && (status?.repos.length ?? 0) === 0 && !loading && prs.length === 0;
  /** Repositories the list came from, so the author picker knows people even with none configured. */
  const seenRepos = useMemo(() => [...new Set(prs.map((p) => `${p.owner}/${p.repo}`))], [prs]);

  return (
    <div className="pr-layout">
      <ViewSidebar
        views={views}
        activeId={active?.id ?? null}
        onSelect={(id) => {
          setViewId(id);
          setCursor(0);
          setSelected(new Set());
          setDraft({ viewId: null, filter: EMPTY });
          setShowHidden(false);
        }}
        onSave={saveViews}
        login={status?.login ?? null}
      />
      <div className="pr-main">
        <FilterBar
          filter={filter}
          repos={seenRepos}
          onChange={(next) => setDraft({ viewId: active?.id ?? null, filter: next })}
          dirty={dirty}
          onSave={saveView}
          onSaveAsNew={saveAsNew}
        />
        <div className="pr-toolbar">
          <input
            type="checkbox"
            checked={prs.length > 0 && picked.length === prs.length}
            ref={(el) => {
              if (el) el.indeterminate = picked.length > 0 && picked.length < prs.length;
            }}
            onChange={() => setSelected(picked.length === prs.length ? new Set() : new Set(prs.map(prKey)))}
            title="Select all"
          />
          <span>{loading ? "Loading…" : `${prs.length} pull request${prs.length === 1 ? "" : "s"}`}</span>
          <button className="icon-btn tiny" onClick={() => load(true)} title="Refresh (r)">
            <RefreshIcon /> {refreshing || (loading && prs.length > 0) ? "Refreshing…" : "Refresh"}
          </button>
          {hiddenCount > 0 && (
            <span className="pr-hidden-note">
              <button className="link-btn inline" onClick={() => setShowHidden((v) => !v)}>
                {showHidden ? "Hide" : "Show"} {hiddenCount} hidden
              </button>
              {showHidden && (
                <>
                  {" · "}
                  <button className="link-btn inline" onClick={clearHidden}>
                    unhide all
                  </button>
                </>
              )}
            </span>
          )}
          <span className="pr-keys">j/k move · enter open · x select · w watch · h hide · r refresh</span>
        </div>
        {picked.length > 0 && (
          <div className="pr-bulk">
            <span>{picked.length} selected</span>
            <div className="pr-bulk-menu-wrap">
              <button className="icon-btn primary tiny" disabled={starting || actions.length === 0} onClick={() => setBulkOpen((o) => !o)}>
                {starting ? "Starting…" : `Run an action on ${picked.length} PR${picked.length === 1 ? "" : "s"}`}
              </button>
              {bulkOpen && (
                <div className="pr-menu">
                  {actions.map((a) => (
                    <button key={a.id} className="pr-menu-item" onClick={() => void runBulk(a.id)}>
                      {a.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className="icon-btn tiny" onClick={hidePicked} title="Hide these from this view in this browser">
              <EyeOffIcon /> Hide {picked.length}
            </button>
            <button className="link-btn inline" onClick={() => setSelected(new Set())}>
              clear
            </button>
          </div>
        )}
        {error && <div className="pr-error">{error}</div>}
        {noRepos && (
          <div className="empty">
            No repositories to search yet.{" "}
            <button className="link-btn inline" onClick={onOpenSettings}>
              Add one in Settings → Reviews
            </button>
            , or type <code>repo:owner/name</code> in the query above.
          </div>
        )}
        <div className={`pr-rows ${loading && prs.length === 0 ? "loading" : ""}`}>
          {loading && prs.length === 0 && (
            <>
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="pr-row pr-row-skeleton" aria-hidden="true">
                  <span className="pr-skel" style={{ width: 14 }} />
                  <span className="pr-skel" style={{ width: 120 }} />
                  <span className="pr-skel" style={{ flex: 1, maxWidth: 360 + ((i * 97) % 240) }} />
                  <span className="pr-skel" style={{ width: 90 }} />
                  <span className="pr-skel" style={{ width: 120 }} />
                </div>
              ))}
            </>
          )}
          {prs.map((pr, i) => (
            <PrRow
              key={prKey(pr)}
              pr={pr}
              index={i}
              active={i === cursor}
              checked={selected.has(prKey(pr))}
              hidden={hidden.has(prKey(pr))}
              watch={watchByKey.get(prKey(pr)) ?? null}
              onCheck={() => toggle(pr)}
              onToggleHidden={() => toggleHidden(pr)}
              onOpen={() => {
                setCursor(i);
                open(pr);
              }}
            />
          ))}
          {!loading && !error && prs.length === 0 && !noRepos && (
            <div className="empty">
              {hiddenCount > 0 ? (
                <>
                  All {hiddenCount} matching pull request{hiddenCount === 1 ? " is" : "s are"} hidden.{" "}
                  <button className="link-btn inline" onClick={() => setShowHidden(true)}>
                    Show them
                  </button>
                </>
              ) : (
                "No pull requests match this view."
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PrRow({
  pr,
  index,
  active,
  checked,
  hidden,
  watch,
  onCheck,
  onToggleHidden,
  onOpen,
}: {
  pr: PrSummary;
  index: number;
  active: boolean;
  checked: boolean;
  hidden: boolean;
  watch: PrWatch | null;
  onCheck: () => void;
  onToggleHidden: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      data-pr-row={index}
      className={`pr-row ${active ? "active" : ""} ${hidden ? "hidden-pr" : ""} ${watch?.unseen.length ? "unseen" : ""}`}
      onClick={onOpen}
      role="link"
      tabIndex={-1}
    >
      <input type="checkbox" checked={checked} onClick={(e) => e.stopPropagation()} onChange={onCheck} />
      <CiDot state={pr.ciState} />
      <span className="pr-row-ref">
        {pr.repo}#{pr.number}
      </span>
      <span className="pr-row-title" title={pr.title}>
        {pr.title}
      </span>
      {pr.reviewRequestedFromMe && <span className="pr-badge pending">requested from you</span>}
      <StateBadge state={pr.state} />
      <DraftBadge isDraft={pr.isDraft} />
      <span className="pr-row-labels">
        {pr.labels.slice(0, 3).map((l) => (
          <span key={l.name} className="pr-label" style={{ borderColor: `#${l.color}99`, color: `#${l.color}` }}>
            {l.name}
          </span>
        ))}
      </span>
      <ReviewBadge decision={pr.reviewDecision} />
      <span className="pr-row-activity">
        {watch && <ActivityChips watch={watch} />}
        {watch && watch.unseen.length > 0 && (
          <button
            className="pr-row-seen"
            title="Mark these changes as seen"
            onClick={(e) => {
              e.stopPropagation();
              void prApi.markSeen(pr).catch(() => {});
            }}
          >
            <CheckIcon /> seen
          </button>
        )}
      </span>
      <span className="pr-row-stat">
        <span className="tok-add">+{pr.additions}</span> <span className="tok-del">−{pr.deletions}</span>{" "}
        <span className="pr-row-files">{pr.changedFiles}f</span>
      </span>
      <span className="pr-row-author" title={pr.authorName ? `${pr.authorName} (${pr.author})` : pr.author}>
        {pr.authorAvatarUrl && <img src={pr.authorAvatarUrl} alt="" />}
        <span>{pr.authorName ?? pr.author}</span>
      </span>
      <span className="pr-row-age">{relativeTime(pr.updatedAt)}</span>
      <WatchToggle pr={pr} watched={!!watch} compact />
      <button
        className={`pr-row-hide ${hidden ? "on" : ""}`}
        title={hidden ? "Show this PR again" : "Hide this PR (h)"}
        aria-label={hidden ? "Unhide" : "Hide"}
        onClick={(e) => {
          e.stopPropagation();
          onToggleHidden();
        }}
      >
        <EyeOffIcon />
      </button>
    </div>
  );
}

function ViewSidebar({
  views,
  activeId,
  onSelect,
  onSave,
  login,
}: {
  views: SavedView[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onSave: (views: SavedView[]) => Promise<void>;
  login: string | null;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const listRef = useRef<HTMLElement>(null);
  const drag = useSortable({
    count: views.length,
    listRef,
    itemSelector: ".pr-view",
    onMove: (from, to) => {
      const next = [...views];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      void onSave(next);
    },
  });
  return (
    <aside className="pr-side" ref={listRef}>
      <div className="pr-side-label">Views</div>
      {views.map((v, i) => (
        <div
          key={v.id}
          className={`pr-view ${v.id === activeId ? "on" : ""} ${drag.active === i ? "dragging" : ""}`}
          style={drag.itemStyle(i)}
        >
          <button className="sort-grip" data-sort-handle aria-label={`Drag to reorder ${v.name}`} {...drag.handleProps(i)}>
            <GripIcon />
          </button>
          {renaming === v.id ? (
            <input
              autoFocus
              className="search"
              defaultValue={v.name}
              onBlur={() => setRenaming(null)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setRenaming(null);
                if (e.key === "Enter") {
                  const name = e.currentTarget.value.trim();
                  if (name) void onSave(views.map((x) => (x.id === v.id ? { ...x, name } : x)));
                  setRenaming(null);
                }
              }}
            />
          ) : (
            <button className="pr-view-name" onClick={() => onSelect(v.id)} onDoubleClick={() => setRenaming(v.id)}>
              {v.name}
            </button>
          )}
          <span className="pr-view-tools">
            <button title="Rename" onClick={() => setRenaming(v.id)}>
              ✎
            </button>
            <button
              title="Delete view"
              onClick={() => {
                if (window.confirm(`Delete view “${v.name}”?`)) void onSave(views.filter((x) => x.id !== v.id));
              }}
            >
              <TrashIcon />
            </button>
          </span>
        </div>
      ))}
      {login && <div className="pr-side-foot">Signed in as {login}</div>}
    </aside>
  );
}

const STATES: { value: PrState; label: string; hint: string }[] = [
  { value: "open", label: "Open", hint: "Still being worked on" },
  { value: "merged", label: "Merged", hint: "Landed on the base branch" },
  { value: "closed", label: "Closed", hint: "Closed without merging" },
  { value: "all", label: "Any state", hint: "Open, merged and closed" },
];

function FilterBar({
  filter,
  repos,
  onChange,
  dirty,
  onSave,
  onSaveAsNew,
}: {
  filter: PrFilter;
  repos: string[];
  onChange: (f: PrFilter) => void;
  dirty: boolean;
  onSave: () => void;
  onSaveAsNew: () => void;
}) {
  const [query, setQuery] = useState(filter.query ?? "");
  useEffect(() => setQuery(filter.query ?? ""), [filter.query]);
  const commit = () => {
    if (query.trim() !== (filter.query ?? "").trim()) onChange({ ...filter, query: query.trim() });
  };
  /**
   * Applied as you type, after a pause, so the list answers the field rather than
   * waiting for a blur nobody knows to do. Enter skips the pause.
   */
  const pending = query.trim() !== (filter.query ?? "").trim();
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(commit, 500);
    return () => clearTimeout(t);
  }, [query]);
  return (
    <div className="pr-filters">
      <div className="pr-state">
        <Select
          compact
          value={filter.state ?? "open"}
          onChange={(v) => onChange({ ...filter, state: v === "open" ? undefined : (v as PrState) })}
          options={STATES}
          ariaLabel="Pull request state"
          renderTrigger={({ open }) => (
            <span className={`icon-btn tiny ${filter.state && filter.state !== "open" ? "on" : ""} ${open ? "open" : ""}`}>
              {STATES.find((o) => o.value === (filter.state ?? "open"))?.label}
              <ChevronIcon />
            </span>
          )}
        />
      </div>
      <label className="check">
        <input type="checkbox" checked={!!filter.reviewRequestedFromMe} onChange={(e) => onChange({ ...filter, reviewRequestedFromMe: e.target.checked })} />
        <span>Review requested from me</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={!!filter.hideApproved} onChange={(e) => onChange({ ...filter, hideApproved: e.target.checked })} />
        <span>Hide approved</span>
      </label>
      <AuthorPicker authors={filter.authors ?? []} repos={repos} onChange={(authors) => onChange({ ...filter, authors })} />
      <label className="check">
        <input type="checkbox" checked={!!filter.includeDrafts} onChange={(e) => onChange({ ...filter, includeDrafts: e.target.checked })} />
        <span>Drafts</span>
      </label>
      <span className={`pr-query-wrap ${pending ? "pending" : ""}`}>
        <input
          className="search pr-query"
          value={query}
          placeholder="GitHub query, e.g. label:bug -author:app/dependabot is:merged"
          title="GitHub search qualifiers. is:, state:, draft: and review: here override the switches."
          onChange={(e) => setQuery(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
        {pending && <span className="pr-query-hint">applying…</span>}
      </span>
      {dirty && (
        <button className="icon-btn primary tiny" onClick={onSave}>
          Save view
        </button>
      )}
      <button className="icon-btn tiny" onClick={onSaveAsNew}>
        Save as new view
      </button>
    </div>
  );
}

function AuthorPicker({ authors, repos, onChange }: { authors: string[]; repos: string[]; onChange: (a: string[]) => void }) {
  const [text, setText] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repoKey = repos.join(",");
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      prApi
        .people(text, repos)
        .then((r) => setPeople(r.people))
        .catch(() => setPeople([]));
    }, 150);
  }, [text, repoKey]);
  const byLogin = useMemo(() => new Map(people.map((p) => [p.login, p])), [people]);
  const options = useMemo(() => {
    const me = "@me".includes(text.toLowerCase()) ? [{ login: "@me", name: "Me", avatarUrl: "" }] : [];
    // Chosen authors stay listed (ticked) even when the search no longer matches them.
    const chosen = authors.filter((a) => a !== "@me" && !people.some((p) => p.login === a)).map((a) => ({ login: a, name: null as string | null, avatarUrl: "" }));
    return [...me, ...people, ...chosen].map((p) => ({
      value: p.login,
      label: p.login === "@me" ? "me" : (p.name ?? p.login),
      hint: p.name ? p.login : undefined,
      icon: p.avatarUrl ? <img className="dd-avatar" src={p.avatarUrl} alt="" /> : <span className="pr-avatar-blank" />,
    }));
  }, [people, text, authors]);
  return (
    <div className="pr-authors">
      <Select
        multiple
        compact
        values={authors}
        options={options}
        onChange={onChange}
        searchable
        onSearch={setText}
        searchPlaceholder="Search people…"
        emptyText={text ? "Nobody matches." : "Type to search."}
        placeholder="Author"
        ariaLabel="Filter by author"
        renderTrigger={({ open }) => (
          <span className={`icon-btn tiny ${authors.length ? "on" : ""} ${open ? "open" : ""}`}>
            Author{authors.length > 0 && `: ${authors.map((a) => (a === "@me" ? "me" : (byLogin.get(a)?.name ?? a))).join(", ")}`}
            <ChevronIcon />
          </span>
        )}
      />
    </div>
  );
}
