import { useEffect } from "react";
import { fmtAgo, shortPath, type AgentSummary } from "../api.ts";

/**
 * Which blocked session to hand over next, given what is already on screen.
 *
 * The one you are looking at is not the next one — otherwise a second press just
 * re-opens what you are already answering and the queue never advances. With a
 * single blocked session it stays the target, so the key re-focuses it rather than
 * doing nothing at all.
 *
 * Exported for its own sake: this is the whole behaviour of the feature, and it is
 * far easier to check here than through two keystrokes and a router.
 */
export function nextInQueue(queue: AgentSummary[], openId: string | null): AgentSummary | null {
  return queue.find((a) => (a.sessionId ?? a.key) !== openId) ?? queue[0] ?? null;
}

/**
 * The blocked count, as a verb.
 *
 * The favicon, the tab title and the Dock badge already say how many sessions are
 * waiting on you — but knowing the number and clearing the queue are different jobs,
 * and the second one meant scanning the grid for amber cards. This walks them
 * oldest-first: the session that has been blocked longest is the one wasting time.
 *
 * Only dashboard-owned sessions are walkable. An externally started one reports that
 * it is blocked but its input belongs to whatever launched it, so it is counted in a
 * trailing note rather than offered as somewhere to go.
 */
export function AnswerNext({
  queue,
  external,
  openId,
  onOpen,
}: {
  queue: AgentSummary[];
  external: number;
  openId: string | null;
  onOpen: (id: string) => void;
}) {
  const next = nextInQueue(queue, openId);

  useEffect(() => {
    if (!next) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "a" || e.metaKey || e.ctrlKey || e.altKey) return;
      // A single letter has to yield to anything you could be typing into, or it
      // eats the "a" out of a prompt.
      const el = e.target as HTMLElement | null;
      if (el?.isContentEditable) return;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      onOpen(next.sessionId ?? next.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, onOpen]);

  if (queue.length === 0 && external === 0) return null;

  return (
    <div className="answer-bar" role="status">
      <span className="answer-dot" aria-hidden="true" />
      <span className="answer-count">
        {queue.length + external} waiting on you
      </span>
      {next && (
        <>
          <span className="answer-sep">·</span>
          <span className="answer-who">
            {next.title ?? shortPath(next.cwd, 1)}
            <span className="answer-since"> blocked {fmtAgo(next.updatedAt)}</span>
          </span>
          <button className="icon-btn primary answer-go" onClick={() => onOpen(next.sessionId ?? next.key)}>
            Answer next <kbd>a</kbd>
          </button>
        </>
      )}
      {external > 0 && (
        <span className="answer-ext">
          {external} started elsewhere — answer {external === 1 ? "it" : "them"} where{" "}
          {external === 1 ? "it" : "they"} {external === 1 ? "was" : "were"} started
        </span>
      )}
    </div>
  );
}
