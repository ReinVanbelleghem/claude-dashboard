import { useEffect } from "react";
import type { AgentSummary } from "../api.ts";

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

/** The "a" key hands over the session that has been blocked on you longest. */
export function useAnswerNextKey(queue: AgentSummary[], openId: string | null, onOpen: (id: string) => void) {
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
}
