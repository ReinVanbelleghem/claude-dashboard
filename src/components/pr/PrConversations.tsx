import { useEffect, useRef, useState } from "react";
import type { DraftComment, PrRef, ReviewThread } from "../../api.ts";
import { DraftItem, ThreadItem, type ReviewHandlers } from "./PrComments.tsx";

/**
 * Every review thread on the PR in one column, with the hunk it was written on, so a
 * review's discussion can be read top to bottom without scrolling the diff. Hovering
 * a thread here highlights its marker in the diff; locating jumps the diff to it.
 */
export function PrConversations({
  pr,
  threads,
  drafts,
  handlers,
  onLocate,
  onLocateDraft,
}: {
  pr: PrRef;
  threads: ReviewThread[];
  /** Your pending comments: not on GitHub yet, but part of the conversation you are having. */
  drafts: DraftComment[];
  handlers: ReviewHandlers;
  onLocate: (t: ReviewThread) => void;
  onLocateDraft: (d: DraftComment) => void;
}) {
  const unresolved = threads.filter((t) => !t.isResolved);
  const [filter, setFilter] = useState<"unresolved" | "all">(unresolved.length ? "unresolved" : "all");
  const shown = filter === "unresolved" ? unresolved : threads;
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = handlers.activeThread;
    if (!id) return;
    if (!shown.some((t) => t.id === id) && threads.some((t) => t.id === id)) {
      setFilter("all");
      return;
    }
    list.current?.querySelector(`[data-panel-thread="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [handlers.activeThread]);

  return (
    <aside className="pr-panel pr-conversations">
      <div className="pr-panel-head">
        <strong>Conversations</strong>
        <div className="seg">
          <button className={filter === "unresolved" ? "active" : ""} onClick={() => setFilter("unresolved")}>
            Unresolved ({unresolved.length})
          </button>
          <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
            All ({threads.length})
          </button>
        </div>
      </div>
      <div ref={list} className="pr-panel-body">
        {drafts.length > 0 && (
          <div className="pr-pending-group">
            <div className="pr-pending-head">
              <span className="pr-badge pending">Pending</span>
              <span>
                {drafts.length} comment{drafts.length === 1 ? "" : "s"} waiting for your review to be submitted
              </span>
            </div>
            {drafts.map((d) => (
              <div key={d.id} className="pr-pending-item">
                <button className="link-btn inline pr-thread-where" title={d.path} onClick={() => onLocateDraft(d)}>
                  {d.path.split("/").pop()}:{d.startLine != null ? `${d.startLine}-${d.line}` : d.line}
                </button>
                <DraftItem pr={pr} draft={d} handlers={handlers} />
              </div>
            ))}
          </div>
        )}
        {shown.map((t) => (
          <div key={t.id} data-panel-thread={t.id} onMouseEnter={() => handlers.setActiveThread(t.id)}>
            <ThreadItem
              pr={pr}
              thread={t}
              handlers={handlers}
              showLocation
              onLocate={() => {
                handlers.setActiveThread(t.id);
                onLocate(t);
              }}
            />
          </div>
        ))}
        {shown.length === 0 && drafts.length === 0 && <div className="empty">No {filter === "unresolved" ? "unresolved " : ""}conversations.</div>}
      </div>
    </aside>
  );
}
