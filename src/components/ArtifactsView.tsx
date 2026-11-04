import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { artifactApi, fmtAgo, shortPath, type Artifact, type ArtifactTag } from "../api.ts";
import { FindBar } from "./FindBar.tsx";
import { ArtifactIcon, ExternalIcon, EyeIcon, EyeOffIcon, PinIcon, PlusIcon, PulseIcon, RefreshIcon, TagIcon, TrashIcon, XIcon } from "./Icons.tsx";

/**
 * Every HTML page a session has generated.
 *
 * The preview is the artifact itself, scaled down and live — not a screenshot. That
 * keeps the dashboard free of a headless browser, and it means a card can never show
 * a stale thumbnail of a page that has since been rewritten.
 *
 * Artifacts load from their own port, so a generated page is cross-origin to this
 * one. The sandbox then withholds `allow-same-origin`, which leaves its scripts with
 * an opaque origin and no route to the API behind this tab.
 *
 * Tags come from two places: the page itself (`<meta name="tags">`, shown dashed and
 * not removable here) and the dashboard (added on the card, removable). Filtering is
 * by any text plus any number of tags, and pinned artifacts lead the grid.
 */
export function ArtifactsView({
  onOpenSession,
  reloadKey,
}: {
  onOpenSession: (id: string) => void;
  /** Bumped by the SSE `artifacts` event when the daemon notices a change on disk. */
  reloadKey?: number;
}) {
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [tags, setTags] = useState<ArtifactTag[]>([]);
  const [port, setPort] = useState<number | null>(null);
  const [root, setRoot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [sort, setSort] = useState<SortKey>("recent");
  const [group, setGroup] = useState<GroupKey>("none");
  const [showHidden, setShowHidden] = useState(false);
  const [preview, setPreview] = useState<Artifact | null>(null);

  const load = useCallback(() => {
    artifactApi
      .list()
      .then((r) => {
        // A daemon from before tags existed sends neither field; treat it as untagged
        // rather than crashing the page until the restart.
        setArtifacts(r.artifacts.map((a) => ({ ...a, tags: a.tags ?? [], metaTags: a.metaTags ?? [], pinned: !!a.pinned, hidden: !!a.hidden })));
        setTags(r.tags ?? []);
        setPort(r.port);
        setRoot(r.root);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(load, [load, reloadKey]);

  const patch = (next: Artifact) =>
    setArtifacts((list) =>
      (list ?? []).map((a) =>
        a.slug === next.slug ? { ...next, tags: next.tags ?? [], metaTags: next.metaTags ?? [], pinned: !!next.pinned, hidden: !!next.hidden } : a,
      ),
    );

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matched = (artifacts ?? []).filter((a) => {
      if (a.hidden !== showHidden) return false;
      if (picked.length && !picked.every((t) => a.tags.includes(t))) return false;
      if (!needle) return true;
      return (
        a.title.toLowerCase().includes(needle) ||
        a.slug.toLowerCase().includes(needle) ||
        a.tags.some((t) => t.includes(needle)) ||
        a.sessions.some((s) => (s.title ?? "").toLowerCase().includes(needle))
      );
    });
    // A missing artifact sorts last whatever the key, so the grid always leads
    // with things you can actually open.
    return [...matched].sort(
      (a, b) =>
        Number(a.missing) - Number(b.missing) ||
        (sort === "name"
          ? a.title.localeCompare(b.title)
          : sort === "size"
            ? b.size - a.size
            : (b.modifiedTs ?? 0) - (a.modifiedTs ?? 0)),
    );
  }, [artifacts, q, picked, sort, showHidden]);

  const sections = useMemo(() => {
    const pinned = shown.filter((a) => a.pinned);
    const rest = shown.filter((a) => !a.pinned);
    const out: { key: string; label: string; icon?: "pin"; items: Artifact[] }[] = [];
    if (pinned.length) out.push({ key: "pinned", label: "Pinned", icon: "pin", items: pinned });
    if (group === "none") {
      if (rest.length) out.push({ key: "all", label: pinned.length ? "Everything else" : "", items: rest });
      return out;
    }
    const buckets = new Map<string, Artifact[]>();
    for (const a of rest) {
      const keys = group === "repo" ? [repoOf(a)] : a.tags.length ? a.tags : ["untagged"];
      for (const k of keys) buckets.set(k, [...(buckets.get(k) ?? []), a]);
    }
    for (const [k, items] of [...buckets.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
      out.push({ key: k, label: k, items });
    }
    return out;
  }, [shown, group]);

  const remove = async (a: Artifact) => {
    // A missing artifact has no files left to delete, so the action is only about
    // clearing the entry — say that, rather than warning about deleting nothing.
    const prompt = a.missing
      ? `Forget "${a.title}"?\n\nIt is already gone from disk. This just clears the entry.`
      : `Delete "${a.title}"?\n\nThe folder and its files are removed.`;
    if (!confirm(prompt)) return;
    await artifactApi.remove(a.slug);
    load();
  };

  const saveTags = async (a: Artifact, next: string[]) => {
    const r = await artifactApi.setTags(a.slug, next);
    patch(r.artifact);
    setTags(r.tags);
  };

  if (error)
    return (
      <div className="artifacts">
        <div className="artifacts-head">
          <div>
            <h1>Artifacts</h1>
          </div>
        </div>
        <div className="git-msg bad">
          <pre>{error}</pre>
        </div>
      </div>
    );

  const hiddenCount = (artifacts ?? []).filter((a) => a.hidden).length;
  const total = (artifacts?.length ?? 0) - (showHidden ? 0 : hiddenCount);
  const filtered = q.trim() || picked.length > 0;

  return (
    <div className="artifacts">
      <div className="artifacts-head">
        <div>
          <h1>Artifacts</h1>
          <p className="hint">
            Indexed from <code>{root || "the artifact folder"}</code>
          </p>
        </div>
        <div className="artifacts-tools">
          {hiddenCount > 0 && (
            <button
              className={`icon-btn ${showHidden ? "on" : ""}`}
              title={showHidden ? "Back to the visible artifacts" : `Show the ${hiddenCount} hidden artifact${hiddenCount === 1 ? "" : "s"}`}
              aria-pressed={showHidden}
              onClick={() => setShowHidden((v) => !v)}
            >
              {showHidden ? <EyeIcon /> : <EyeOffIcon />}
              {hiddenCount}
            </button>
          )}
          <button
            className="icon-btn"
            title="Re-read the artifact folder now, instead of waiting for the next pass"
            onClick={() => artifactApi.refresh().then(load)}
          >
            <RefreshIcon />
            Rescan
          </button>
        </div>
      </div>

      <div className="artifacts-bar">
        <input
          className="search"
          placeholder="Filter by title, tag, folder or session…"
          aria-label="Filter artifacts"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="artifacts-bar-spacer" />
        <div className="scope" role="radiogroup" aria-label="Group artifacts">
          {GROUPS.map(([key, label]) => (
            <button key={key} role="radio" aria-checked={group === key} className={`scope-btn ${group === key ? "on" : ""}`} onClick={() => setGroup(key)}>
              {label}
            </button>
          ))}
        </div>
        <div className="scope" role="radiogroup" aria-label="Sort artifacts">
          {SORTS.map(([key, label]) => (
            <button key={key} role="radio" aria-checked={sort === key} className={`scope-btn ${sort === key ? "on" : ""}`} onClick={() => setSort(key)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {tags.length > 0 && (
        <div className="artifacts-tags">
          <span className="artifacts-tags-label">
            <TagIcon />
          </span>
          {tags.map((t) => {
            const on = picked.includes(t.tag);
            return (
              <button
                key={t.tag}
                className={`tag-chip ${on ? "on" : ""}`}
                aria-pressed={on}
                onClick={() => setPicked((p) => (on ? p.filter((x) => x !== t.tag) : [...p, t.tag]))}
              >
                {t.tag}
                <span className="count">{t.count}</span>
              </button>
            );
          })}
          {picked.length > 0 && (
            <button className="tag-chip" onClick={() => setPicked([])}>
              <XIcon />
              clear
            </button>
          )}
        </div>
      )}

      {artifacts === null ? (
        <div className="empty">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="empty">
          {filtered ? "No artifacts match that filter." : showHidden ? "Nothing is hidden." : "Nothing here yet — the next page a session generates will show up."}
        </div>
      ) : (
        <>
          <span className="services-count">
            {showHidden ? "hidden · " : ""}
            {filtered ? `${shown.length} of ${total}` : `${total} artifact${total === 1 ? "" : "s"}`}
          </span>
          {sections.map((sec) => (
            <section key={sec.key} className="artifacts-section">
              {sec.label && (
                <div className="artifacts-section-head">
                  {sec.icon === "pin" && <PinIcon filled />}
                  {sec.label}
                  <span>· {sec.items.length}</span>
                </div>
              )}
              <div className="artifact-grid">
                {sec.items.map((a) => (
                  <ArtifactCard
                    key={`${sec.key}:${a.slug}`}
                    artifact={a}
                    port={port}
                    knownTags={tags.map((t) => t.tag)}
                    onOpenSession={onOpenSession}
                    onPreview={() => setPreview(a)}
                    onDelete={() => remove(a)}
                    onPin={() => artifactApi.pin(a.slug, !a.pinned).then((r) => patch(r.artifact))}
                    onHide={() => artifactApi.hide(a.slug, !a.hidden).then((r) => patch(r.artifact))}
                    onTags={(next) => saveTags(a, next)}
                  />
                ))}
              </div>
            </section>
          ))}
        </>
      )}

      {preview && port !== null && (
        <ArtifactOverlay artifact={preview} port={port} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

type SortKey = "recent" | "name" | "size";
const SORTS: [SortKey, string][] = [
  ["recent", "Recent"],
  ["name", "Name"],
  ["size", "Size"],
];
type GroupKey = "none" | "repo" | "tag";
const GROUPS: [GroupKey, string][] = [
  ["none", "All"],
  ["repo", "By repo"],
  ["tag", "By tag"],
];

const repoOf = (a: Artifact): string => {
  const cwd = a.sessions.find((s) => s.cwd)?.cwd;
  return cwd ? shortPath(cwd, 1) : "no session";
};

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ArtifactCard({
  artifact: a,
  port,
  knownTags,
  onOpenSession,
  onPreview,
  onDelete,
  onPin,
  onHide,
  onTags,
}: {
  artifact: Artifact;
  port: number | null;
  knownTags: string[];
  onOpenSession: (id: string) => void;
  onPreview: () => void;
  onDelete: () => void;
  onPin: () => void;
  onHide: () => void;
  onTags: (tags: string[]) => Promise<void> | void;
}) {
  const href = port !== null && !a.missing ? artifactApi.url(a.slug, port) : null;
  const cwd = a.sessions.find((s) => s.cwd)?.cwd ?? null;
  const session = a.sessions[a.sessions.length - 1] ?? null;
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Page-declared tags are not the dashboard's to remove, so they get a different
  // look and no ×. Saving sends only the user's set; the server keeps the page's.
  const userTags = a.tags.filter((t) => !a.metaTags.includes(t));

  const commitTag = () => {
    const t = draft.trim().toLowerCase().replace(/\s+/g, "-");
    setDraft("");
    setAdding(false);
    if (!t || a.tags.includes(t)) return;
    void onTags([...userTags, t]);
  };

  return (
    <div className={`artifact-card${a.missing ? " missing" : ""}${a.pinned ? " pinned" : ""}`}>
      <button className="artifact-thumb" onClick={onPreview} disabled={a.missing} title={a.missing ? "No longer on disk" : "Preview"}>
        {href ? <ArtifactFrame src={href} title={a.title} /> : <div className="artifact-thumb-gone">gone</div>}
      </button>

      <div className="artifact-body">
        <div className="artifact-title-row">
          <div className="artifact-title" title={a.title}>
            {a.title}
          </div>
          <button className={`artifact-pin ${a.pinned ? "on" : ""}`} title={a.pinned ? "Unpin" : "Pin to the top"} aria-pressed={a.pinned} onClick={onPin}>
            <PinIcon filled={a.pinned} />
          </button>
        </div>
        <div className="artifact-meta">
          {fmtAgo(a.modifiedTs)}
          {!a.missing && ` · ${fmtSize(a.size)}`}
          {a.fileCount > 1 && ` · ${a.fileCount} files`}
          {cwd && (
            <>
              {" · "}
              <code>{shortPath(cwd, 1)}</code>
            </>
          )}
        </div>

        <div className="artifact-tags">
          {a.tags.map((t) => {
            const fromPage = a.metaTags.includes(t);
            return (
              <span key={t} className={`artifact-tag ${fromPage ? "meta" : ""}`} title={fromPage ? "Declared by the page itself" : undefined}>
                {t}
                {!fromPage && (
                  <button className="artifact-tag-x" title={`Remove ${t}`} aria-label={`Remove tag ${t}`} onClick={() => void onTags(userTags.filter((x) => x !== t))}>
                    <XIcon />
                  </button>
                )}
              </span>
            );
          })}
          {adding ? (
            <span className="artifact-tag-editor">
              <input
                ref={inputRef}
                className="artifact-tag-input"
                list={`tags-${a.slug}`}
                value={draft}
                placeholder="Add a tag…"
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitTag();
                  if (e.key === "Escape") {
                    setDraft("");
                    setAdding(false);
                  }
                }}
              />
              <button className="icon-btn tiny primary" onMouseDown={(e) => e.preventDefault()} onClick={commitTag} disabled={!draft.trim()}>
                Add
              </button>
              <button
                className="icon-btn tiny ghost"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setDraft("");
                  setAdding(false);
                }}
                aria-label="Cancel"
              >
                <XIcon />
              </button>
            </span>
          ) : (
            <button className="artifact-tag-add" onClick={() => setAdding(true)} title="Add a tag">
              <PlusIcon />
              tag
            </button>
          )}
          <datalist id={`tags-${a.slug}`}>
            {knownTags.filter((t) => !a.tags.includes(t)).map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </div>

        <div className="artifact-foot">
          {session ? (
            <button className="artifact-session" onClick={() => onOpenSession(session.id)} title={`Open the session that wrote this${session.cwd ? ` · ${session.cwd}` : ""}`}>
              <PulseIcon />
              {session.title ?? session.id.slice(0, 8)}
            </button>
          ) : (
            <span className="artifact-orphan" title="No transcript records writing this file">
              no session
            </span>
          )}
          <div className="artifact-actions">
            {href && (
              <a className="icon-btn" href={href} target="_blank" rel="noreferrer" title="Open in a new tab">
                <ExternalIcon />
              </a>
            )}
            <button className="icon-btn" onClick={onHide} title={a.hidden ? "Show again" : "Hide from the grid"} aria-pressed={a.hidden}>
              {a.hidden ? <EyeIcon /> : <EyeOffIcon />}
            </button>
            <button className="icon-btn danger" onClick={onDelete} title={a.missing ? "Forget" : "Delete"}>
              <TrashIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A card-sized render of the real page.
 *
 * An artifact is authored for a full window, so showing it at card width would
 * reflow it into something that looks nothing like the thing you are looking for.
 * Instead it is laid out at a fixed desktop width and scaled down, which keeps the
 * shape recognisable. Only mounted once scrolled near, so a folder of fifty
 * artifacts does not open fifty documents at once.
 */
const FRAME_WIDTH = 1280;

function ArtifactFrame({ src, title }: { src: string; title: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  /**
   * The scale has to be measured, not guessed: the grid gives each card whatever
   * width is left over, so a hardcoded factor leaves a bare strip down one side at
   * every width but one.
   */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => el.style.setProperty("--thumb-scale", String(el.clientWidth / FRAME_WIDTH));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="artifact-frame" ref={ref}>
      {visible && (
        <iframe
          src={src}
          title={title}
          loading="lazy"
          scrolling="no"
          // No allow-same-origin: the frame gets an opaque origin, so its scripts
          // cannot read this page or reach the daemon that served it.
          sandbox="allow-scripts"
        />
      )}
    </div>
  );
}

function ArtifactOverlay({
  artifact: a,
  port,
  onClose,
}: {
  artifact: Artifact;
  port: number;
  onClose: () => void;
}) {
  const [showFind, setShowFind] = useState(false);
  // Re-render once the frame element exists, so the find bar is handed a real
  // window rather than the null it would capture on first paint.
  const [frameEl, setFrameEl] = useState<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showFind) {
          setShowFind(false);
          return;
        }
        onClose();
      }
      // App's handler stands down while an overlay is open, so this is the only
      // ⌘F in play — and it searches the artifact, not the page behind it.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setShowFind(true);
        window.setTimeout(() => document.querySelector<HTMLInputElement>(".find-input")?.select(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, showFind]);

  const href = artifactApi.url(a.slug, port);

  /**
   * Hand focus to the frame once it has loaded. The browser's find searches the
   * focused frame, and this one is cross-origin — without the focus, ⌘F would
   * search the dashboard behind the overlay and report nothing.
   */
  const frame = useRef<HTMLIFrameElement | null>(null);

  // Portalled to <body> so no ancestor's backdrop-filter can become the containing
  // block for `position: fixed`. Same bug and fix as ThemeStudio and WorktreesPanel.
  return createPortal(
    <div className="artifact-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={a.title}>
      <div className="artifact-overlay-inner" onClick={(e) => e.stopPropagation()}>
        <div className="artifact-overlay-head">
          <strong>{a.title}</strong>
          <span className="artifact-meta">{a.entry}</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn tiny" onClick={() => setShowFind(true)} title="Find in this artifact (⌘F)">
            Find
          </button>
          <a className="icon-btn tiny" href={href} target="_blank" rel="noreferrer">
            Open in tab
          </a>
          <button className="icon-btn tiny" onClick={onClose}>
            Close
          </button>
        </div>
        <iframe
          ref={(el) => {
            frame.current = el;
            setFrameEl(el);
          }}
          // `find=1` asks the artifact server to inject the search bridge. Only the
          // framed preview does; Open in tab gets the file as written.
          src={`${href}?find=1`}
          title={a.title}
          sandbox="allow-scripts allow-popups"
        />
        {showFind && <FindBar frame={frameEl} onClose={() => setShowFind(false)} />}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The artifacts one session produced, for the session page sidebar. Separate from
 * the grid above because the question is different: there you are looking for a
 * page, here you are reading what a session did.
 */
export function SessionArtifacts({ sessionId }: { sessionId: string }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [port, setPort] = useState<number | null>(null);
  const [preview, setPreview] = useState<Artifact | null>(null);

  useEffect(() => {
    let live = true;
    artifactApi
      .list({ sessionId })
      .then((r) => {
        if (!live) return;
        setArtifacts(r.artifacts);
        setPort(r.port);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [sessionId]);

  if (artifacts.length === 0) return null;

  return (
    <div className="panel">
      <h2 className="artifact-panel-head">
        <ArtifactIcon /> Artifacts <span className="artifact-meta">{artifacts.length}</span>
      </h2>
      <div className="artifact-minis">
        {artifacts.map((a) => {
          const href = port !== null && !a.missing ? artifactApi.url(a.slug, port) : null;
          return (
            <div key={a.slug} className={`artifact-mini${a.missing ? " missing" : ""}`}>
              <button className="artifact-thumb" onClick={() => setPreview(a)} disabled={a.missing} title={a.missing ? "No longer on disk" : "Preview"}>
                {href ? <ArtifactFrame src={href} title={a.title} /> : <div className="artifact-thumb-gone">gone</div>}
              </button>
              <div className="artifact-mini-foot">
                <span className="artifact-mini-title" title={a.title}>
                  {a.title}
                </span>
                <span className="artifact-meta">{fmtAgo(a.modifiedTs)}</span>
              </div>
            </div>
          );
        })}
      </div>

      {preview && port !== null && (
        <ArtifactOverlay artifact={preview} port={port} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}
