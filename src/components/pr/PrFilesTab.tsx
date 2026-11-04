import { ChevronIcon } from "../Icons.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentBus, prApi, settingsApi, type DraftComment, type ExplainTarget, type FilesResponse, type PrRef, type ReviewEvent, type ReviewThread, type Settings } from "../../api.ts";
import { PrConversations } from "./PrConversations.tsx";
import { PrExplainPanel, FloatingButton, useDiffSelection } from "./PrExplainPanel.tsx";
import { PrFileCard } from "./PrFileCard.tsx";
import { PrFileTree } from "./PrFileTree.tsx";
import type { ReviewHandlers } from "./PrComments.tsx";
import { isTyping, useExplanations, useRemembered } from "./prState.ts";

/**
 * "Files changed": the diff with GitHub's threads and your pending comments, a file
 * tree, the Conversations and Explain side panels, and the review menu that submits
 * everything. j/k file, n/p hunk, v viewed, c comment.
 */
/** The app's top bar, read from the CSS variable that sizes it. */
const topBarHeight = (): number => {
  const n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--topbar-h"));
  return Number.isFinite(n) ? n : 0;
};

export function PrFilesTab({ pr, settings, onSettings }: { pr: PrRef; settings: Settings | null; onSettings: (s: Settings) => void }) {
  const [files, setFiles] = useState<FilesResponse | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const [drafts, setDrafts] = useState<DraftComment[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [current, setCurrent] = useState(0);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [showTree, toggleTree] = useRemembered("pr-show-tree", true);
  const [showConversations, toggleConversations] = useRemembered("pr-show-conversations", false);
  const [showExplain, toggleExplain] = useRemembered("pr-show-explain", false);
  const [explainOpen, setExplainOpen] = useState(showExplain);
  const [pendingExplain, setPendingExplain] = useState<ExplainTarget | null>(null);
  const { explanations } = useExplanations(pr);
  const scroller = useRef<HTMLDivElement>(null);
  const filesRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const lastHunk = useRef<HTMLElement | null>(null);

  const mode = settings?.ui.diffMode ?? "unified";
  // The same setting the git panel uses: one preference for how a diff reads.
  const setMode = (m: "unified" | "split") =>
    settingsApi
      .save({ ui: { diffMode: m } })
      .then((r) => onSettings(r.settings))
      .catch(() => {});

  const key = `${pr.owner}/${pr.repo}/${pr.number}`;
  const loadFiles = useCallback(() => {
    setFilesError(null);
    prApi
      .files(pr)
      .then(setFiles)
      .catch((e: Error) => setFilesError(e.message));
  }, [key]);
  const reloadThreads = useCallback(() => {
    prApi
      .threads(pr)
      .then((r) => setThreads(r.threads))
      .catch(() => {});
  }, [key]);
  const reloadDrafts = useCallback(() => {
    prApi
      .drafts(pr)
      .then((r) => setDrafts(r.drafts))
      .catch(() => {});
  }, [key]);
  useEffect(() => {
    setFiles(null);
    loadFiles();
    reloadThreads();
    reloadDrafts();
  }, [loadFiles, reloadThreads, reloadDrafts]);

  // A finding posted from the Runs tab (here or in another browser tab) lands as a draft.
  useEffect(() => {
    const off = agentBus.subscribe((e) => {
      if (e.type === "pr-run" && !("deleted" in e.run) && e.run.pr.number === pr.number && e.run.pr.repo === pr.repo) reloadDrafts();
    });
    return () => {
      off();
    };
  }, [reloadDrafts, key]);

  const list = files?.files ?? [];
  const sortedThreads = useMemo(() => {
    const order = new Map(list.map((f, i) => [f.path, i]));
    return [...threads].sort(
      (a, b) => (order.get(a.path) ?? Infinity) - (order.get(b.path) ?? Infinity) || (a.line ?? a.originalLine ?? 0) - (b.line ?? b.originalLine ?? 0),
    );
  }, [threads, list]);
  const threadsByPath = useMemo(() => {
    const m = new Map<string, ReviewThread[]>();
    for (const t of threads) m.set(t.path, [...(m.get(t.path) ?? []), t]);
    return m;
  }, [threads]);
  const draftsByPath = useMemo(() => {
    const m = new Map<string, DraftComment[]>();
    for (const d of drafts) m.set(d.path, [...(m.get(d.path) ?? []), d]);
    return m;
  }, [drafts]);
  const commentCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const [p, l] of threadsByPath) m.set(p, l.length);
    for (const [p, l] of draftsByPath) m.set(p, (m.get(p) ?? 0) + l.length);
    return m;
  }, [threadsByPath, draftsByPath]);

  const handlers: ReviewHandlers = useMemo(
    () => ({ viewer: files?.viewer ?? null, reloadThreads, reloadDrafts, activeThread, setActiveThread, panelOpen: showConversations }),
    [files?.viewer, reloadThreads, reloadDrafts, activeThread, showConversations],
  );

  const isCollapsed = (path: string, viewed: boolean) => collapsed[path] ?? viewed;

  const toggleViewed = useCallback(
    (path: string, viewed: boolean) => {
      setFiles((f) => (f ? { ...f, files: f.files.map((x) => (x.path === path ? { ...x, viewed } : x)) } : f));
      setCollapsed((c) => ({ ...c, [path]: viewed }));
      prApi.setViewed(pr, path, viewed).catch(() => loadFiles());
    },
    [key, loadFiles],
  );

  const scrollToFile = useCallback((index: number) => {
    setCurrent(index);
    const el = scroller.current?.querySelector(`[data-file-index="${index}"]`);
    const bar = (toolbarRef.current?.offsetHeight ?? 0) + topBarHeight();
    if (el) window.scrollBy({ top: el.getBoundingClientRect().top - bar - 18 });
  }, []);

  /** Open the file, scroll to it, then keep looking for the element until the lazy card has painted it. */
  const revealIn = useCallback(
    (path: string, selector: string | null) => {
      const index = list.findIndex((f) => f.path === path);
      if (index < 0) return;
      setCollapsed((c) => ({ ...c, [path]: false }));
      scrollToFile(index);
      if (!selector) return;
      let tries = 0;
      const reveal = () => {
        const el = scroller.current?.querySelector(`[data-file-index="${index}"] ${selector}`);
        if (el) el.scrollIntoView({ block: "center" });
        else if (++tries < 20) setTimeout(reveal, 150);
      };
      setTimeout(reveal, 150);
    },
    [list, scrollToFile],
  );
  const locateThread = useCallback(
    (t: ReviewThread) => revealIn(t.path, t.isOutdated || t.line == null ? null : `[data-thread-id="${CSS.escape(t.id)}"]`),
    [revealIn],
  );
  const locateDraft = useCallback((d: DraftComment) => revealIn(d.path, `[data-draft-id="${CSS.escape(d.id)}"]`), [revealIn]);

  /**
   * The diff scrolls with the page, so the page's scroll drives the tree highlight
   * and j/k. The anchor is a little below the top of the viewport, where the sticky
   * file header sits. The Conversations panel is deliberately not scroll-synced:
   * it follows a thread only when one is clicked, so reading the diff never moves it.
   */
  // Below the app's top bar and the sticky files bar, where a file header lands.
  const ANCHOR = 56 + topBarHeight();
  useEffect(() => {
    const onScroll = () => {
      const c = scroller.current;
      if (!c) return;
      for (const card of c.querySelectorAll<HTMLElement>("[data-file-index]")) {
        if (card.getBoundingClientRect().bottom > ANCHOR + 8) {
          setCurrent(Number(card.dataset.fileIndex));
          break;
        }
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const hunkStarts = () => [...(scroller.current?.querySelectorAll<HTMLElement>(".diff-hunk") ?? [])];
  const jumpHunk = (dir: 1 | -1) => {
    const starts = hunkStarts();
    const target =
      dir === 1 ? starts.find((el) => el.getBoundingClientRect().top > ANCHOR + 4) : [...starts].reverse().find((el) => el.getBoundingClientRect().top < ANCHOR - 4);
    if (!target) return;
    window.scrollBy({ top: target.getBoundingClientRect().top - ANCHOR });
    lastHunk.current = target;
  };
  const commentOnHunk = () => {
    const anchor = ANCHOR;
    const start = lastHunk.current?.isConnected ? lastHunk.current : (hunkStarts().find((el) => el.getBoundingClientRect().top >= anchor - 4) ?? null);
    const button = start?.parentElement?.querySelector<HTMLElement>(".diff-line.add .diff-add-comment, .diff-side.add .diff-add-comment, .diff-add-comment");
    button?.click();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        (document.activeElement as HTMLElement | null)?.blur?.();
        return;
      }
      if (!list.length) return;
      switch (e.key) {
        case "j":
          scrollToFile(Math.min(list.length - 1, current + 1));
          break;
        case "k":
          scrollToFile(Math.max(0, current - 1));
          break;
        case "n":
          jumpHunk(1);
          break;
        case "p":
          jumpHunk(-1);
          break;
        case "v": {
          const f = list[current];
          if (f) toggleViewed(f.path, !f.viewed);
          break;
        }
        case "c":
          e.preventDefault();
          commentOnHunk();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const requestExplain = useCallback(
    (t: ExplainTarget) => {
      setPendingExplain(t);
      setExplainOpen(true);
      if (!showExplain) toggleExplain();
    },
    [showExplain, toggleExplain],
  );
  const diffSelection = useDiffSelection(requestExplain);
  useEffect(() => setExplainOpen(showExplain), [showExplain]);

  useEffect(() => {
    const bar = toolbarRef.current;
    const host = filesRef.current;
    if (!bar || !host) return;
    const apply = () => host.style.setProperty("--pr-bar", `${bar.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [!!files]);

  if (filesError) return <div className="pr-error">{filesError}</div>;
  if (!files) return <div className="empty">Loading changed files…</div>;

  const viewedCount = list.filter((f) => f.viewed).length;
  const allCollapsed = list.every((f) => isCollapsed(f.path, f.viewed));
  const rootCount = explanations.filter((e) => !e.parentId).length;

  return (
    <div className="pr-files" ref={filesRef}>
      <div className="pr-toolbar pr-files-bar" ref={toolbarRef}>
        <button className={`icon-btn tiny ${showTree ? "on" : ""}`} onClick={toggleTree}>
          Files
        </button>
        <span>
          {list.length} files · {viewedCount} viewed
        </span>
        <button className="link-btn inline" onClick={() => setCollapsed(Object.fromEntries(list.map((f) => [f.path, !allCollapsed])))}>
          {allCollapsed ? "Expand all" : "Collapse all"}
        </button>
        <span className="pr-keys">j/k file · n/p hunk · v viewed · c comment</span>
        <span style={{ flex: 1 }} />
        <div className="seg">
          <button className={mode === "unified" ? "active" : ""} onClick={() => setMode("unified")}>
            Unified
          </button>
          <button className={mode === "split" ? "active" : ""} onClick={() => setMode("split")}>
            Split
          </button>
        </div>
        <button className={`icon-btn tiny ${explainOpen ? "on" : ""}`} onClick={toggleExplain} title="Explain selected code (⌘⇧E)">
          Explain{rootCount ? ` (${rootCount})` : ""}
        </button>
        <button className={`icon-btn tiny ${showConversations ? "on" : ""}`} onClick={toggleConversations}>
          Conversations ({sortedThreads.filter((t) => !t.isResolved).length}/{sortedThreads.length})
        </button>
        <ReviewMenu pr={pr} draftCount={drafts.length} onSubmitted={() => {
          reloadDrafts();
          reloadThreads();
        }} />
      </div>
      <div className="pr-files-body">
        {showTree && (
          <aside className="pr-tree-side">
            <PrFileTree files={list} currentIndex={current} commentCounts={commentCounts} onSelect={scrollToFile} />
          </aside>
        )}
        <div ref={scroller} className="pr-diff-scroll">
          {list.map((file, index) => (
            <PrFileCard
              key={file.path}
              pr={pr}
              file={file}
              index={index}
              baseSha={files.baseSha}
              headSha={files.headSha}
              collapsed={isCollapsed(file.path, file.viewed)}
              mode={mode}
              threads={threadsByPath.get(file.path) ?? []}
              drafts={draftsByPath.get(file.path) ?? []}
              handlers={handlers}
              onToggleCollapsed={() => setCollapsed((c) => ({ ...c, [file.path]: !isCollapsed(file.path, file.viewed) }))}
              onToggleViewed={() => toggleViewed(file.path, !file.viewed)}
            />
          ))}
          {list.length === 0 && <div className="empty">No changed files.</div>}
        </div>
        {explainOpen && <PrExplainPanel pr={pr} explanations={explanations} pending={pendingExplain} onClearPending={() => setPendingExplain(null)} />}
        {showConversations && (
          <PrConversations pr={pr} threads={sortedThreads} drafts={drafts} handlers={handlers} onLocate={locateThread} onLocateDraft={locateDraft} />
        )}
      </div>
      {diffSelection.selection && (
        <FloatingButton anchor={diffSelection.selection.anchor} onClick={diffSelection.explain}>
          Explain
        </FloatingButton>
      )}
    </div>
  );
}

const EVENTS: { event: ReviewEvent; label: string; cls: string }[] = [
  { event: "COMMENT", label: "Comment", cls: "" },
  { event: "APPROVE", label: "Approve", cls: "primary" },
  { event: "REQUEST_CHANGES", label: "Request changes", cls: "danger" },
];

function ReviewMenu({ pr, draftCount, onSubmitted }: { pr: PrRef; draftCount: number; onSubmitted: () => void }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, setPending] = useState<{ comments: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    prApi
      .pendingReview(pr)
      .then((r) => setPending(r.pending))
      .catch(() => setPending(null));
  }, [open]);

  const send = async (event: ReviewEvent) => {
    setBusy(true);
    setError(null);
    const r = await prApi.submit(pr, event, body);
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "GitHub refused the review");
      return;
    }
    setBody("");
    setDone(r.reviewUrl);
    setOpen(false);
    onSubmitted();
  };

  return (
    <div className="pr-review-menu">
      <button
        className="icon-btn primary tiny"
        onClick={() => {
          setOpen((o) => !o);
          setDone(null);
        }}
      >
        Review{draftCount > 0 ? ` (${draftCount})` : ""}
        <ChevronIcon />
      </button>
      {done && !open && (
        <a href={done} target="_blank" rel="noreferrer" className="pr-submitted">
          Review submitted ↗
        </a>
      )}
      {open && (
        <>
          <div className="scrim" onClick={() => setOpen(false)} />
          <div className="pr-menu pr-review-pop">
            <strong>Finish your review</strong>
            <textarea
              className="composer-box"
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
              placeholder="Leave a summary comment (optional)"
            />
            <div className="hint">
              {draftCount} pending comment{draftCount === 1 ? "" : "s"} will be submitted.
              {pending && (
                <>
                  {" "}
                  You also have a pending review on GitHub with {pending.comments} comment{pending.comments === 1 ? "" : "s"}; they go out together as one review.
                </>
              )}
            </div>
            {error && <div className="pr-error">{error}</div>}
            <div className="comment-actions">
              {EVENTS.map((a) => (
                <button key={a.event} className={`icon-btn ${a.cls}`} disabled={busy} onClick={() => void send(a.event)}>
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
