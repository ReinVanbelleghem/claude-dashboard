/**
 * Handing text to a session's composer from somewhere else on the page.
 *
 * The git panel and the conversation are siblings, and the draft belongs to the
 * composer — lifting it into every parent that renders both (the session page and
 * the drawer) would spread one textarea's state across three components. This is the
 * smaller seam: the panel announces text for a session, the composer picks it up if
 * it is mounted, and nothing happens if it isn't.
 *
 * Review comment ids travel with the text so that "Claude has seen these" can be
 * recorded when the message is actually sent, rather than when it was drafted — the
 * whole point of drafting is that you may still edit or abandon it.
 */
export type ComposeRequest = { text: string; commentIds: string[] };

type Listener = (req: ComposeRequest) => void;

const listeners = new Map<string, Set<Listener>>();
const waiting = new Map<string, ComposeRequest>();

/** Subscribe a composer. Returns its unsubscribe. */
export function onCompose(agentKey: string, fn: Listener): () => void {
  const set = listeners.get(agentKey) ?? new Set<Listener>();
  set.add(fn);
  listeners.set(agentKey, set);
  const held = waiting.get(agentKey);
  if (held) {
    waiting.delete(agentKey);
    queueMicrotask(() => fn(held));
  }
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(agentKey);
  };
}

/**
 * Offer text to a session's composer. Returns false when nothing is listening —
 * the session isn't on screen — so the caller can fall back to the clipboard
 * instead of dropping the text on the floor.
 */
export function requestCompose(agentKey: string, req: ComposeRequest): boolean {
  const set = listeners.get(agentKey);
  if (!set?.size) return false;
  for (const fn of set) fn(req);
  return true;
}

/**
 * Offer text to a session whose composer may not be on screen yet: it is
 * delivered now when one is listening, and otherwise held until that session is
 * opened. For a caller that is about to open the session itself.
 */
export function composeWhenOpen(agentKey: string, req: ComposeRequest): void {
  if (!requestCompose(agentKey, req)) waiting.set(agentKey, req);
}
