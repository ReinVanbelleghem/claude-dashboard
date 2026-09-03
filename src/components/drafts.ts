/**
 * Unsent composer text, kept per session.
 *
 * Closing a session used to throw away whatever was half-typed in it: the drawer
 * unmounts the conversation, and the draft lived in its state. Two stores, because
 * the two things you can have pending want different lifetimes:
 *
 * - text goes to localStorage, so it survives a reload and another tab
 * - attachments stay in memory, because they are base64 image bytes and belong
 *   nowhere near a 5MB storage quota
 *
 * Keyed by agent key rather than session id: the key exists from the moment a
 * session starts, while the session id only arrives after the CLI reports it.
 */
const KEY = "claude-dashboard:drafts";

function read(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function loadDraft(agentKey: string): string {
  return read()[agentKey] ?? "";
}

export function saveDraft(agentKey: string, text: string) {
  const all = read();
  // An empty draft is deleted rather than stored: otherwise the map grows a key
  // for every session ever opened, and "no draft" and "draft of nothing" differ.
  if (text.trim()) all[agentKey] = text;
  else delete all[agentKey];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // A full quota must not take the composer down with it.
  }
}

const pendingAttachments = new Map<string, unknown[]>();

export function loadAttachments<T>(agentKey: string): T[] {
  return (pendingAttachments.get(agentKey) as T[]) ?? [];
}

export function saveAttachments<T>(agentKey: string, items: T[]) {
  if (items.length) pendingAttachments.set(agentKey, items);
  else pendingAttachments.delete(agentKey);
}
