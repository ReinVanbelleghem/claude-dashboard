import type { Database } from "bun:sqlite";
import type { NotifyEventKind } from "./settings.ts";

export type InboxItem = {
  id: number;
  kind: NotifyEventKind;
  /** What it is about: a session's title, a meeting, a pull request. */
  label: string;
  detail: string;
  context: string;
  /** The in-app route a click lands on. */
  href: string;
  at: number;
  readAt: number | null;
  /** How many times it fired while unread, when the same thing kept asking. */
  count: number;
};

export type InboxPayload = { items: InboxItem[]; unread: number };

type Row = {
  id: number;
  kind: string;
  label: string;
  detail: string;
  context: string;
  href: string;
  at: number;
  read_at: number | null;
  count: number;
};

const KEEP = 300;
const KEEP_MS = 30 * 24 * 60 * 60_000;
const LIST = 200;

let db: Database;
let emit: (payload: InboxPayload) => void = () => {};

/** Every notification the dashboard raised, kept so a missed banner can be found again. */
export function initInbox(database: Database, onChange: (payload: InboxPayload) => void) {
  db = database;
  emit = onChange;
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      key     TEXT NOT NULL,
      kind    TEXT NOT NULL,
      label   TEXT NOT NULL,
      detail  TEXT NOT NULL,
      context TEXT NOT NULL,
      href    TEXT NOT NULL,
      at      INTEGER NOT NULL,
      read_at INTEGER,
      count   INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_at ON notifications(at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_key ON notifications(key, read_at);
  `);
}

const toItem = (r: Row): InboxItem => ({
  id: r.id,
  kind: r.kind as NotifyEventKind,
  label: r.label,
  detail: r.detail,
  context: r.context,
  href: r.href,
  at: r.at,
  readAt: r.read_at,
  count: r.count,
});

export function inboxPayload(): InboxPayload {
  const items = db.query<Row, [number]>("SELECT * FROM notifications ORDER BY at DESC, id DESC LIMIT ?").all(LIST).map(toItem);
  const unread = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL").get()?.n ?? 0;
  return { items, unread };
}

const changed = () => emit(inboxPayload());

/**
 * Keeps one notification. The same thing asking again while its last notice is
 * still unread refreshes that notice instead of stacking another under it.
 */
export function recordNotification(n: { key: string; kind: NotifyEventKind; label: string; detail: string; context: string; href: string }, now = Date.now()) {
  const open = db.query<{ id: number }, [string]>("SELECT id FROM notifications WHERE key = ? AND read_at IS NULL ORDER BY at DESC LIMIT 1").get(n.key);
  if (open) {
    db.query("UPDATE notifications SET label = ?, detail = ?, context = ?, href = ?, at = ?, count = count + 1 WHERE id = ?").run(n.label, n.detail, n.context, n.href, now, open.id);
  } else {
    db.query("INSERT INTO notifications (key, kind, label, detail, context, href, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(n.key, n.kind, n.label, n.detail, n.context, n.href, now);
  }
  db.query("DELETE FROM notifications WHERE at < ? OR id NOT IN (SELECT id FROM notifications ORDER BY at DESC, id DESC LIMIT ?)").run(now - KEEP_MS, KEEP);
  changed();
}

/** Marks the given notifications read, or every one when no ids are named. */
export function markNotificationsRead(ids: number[] | null, now = Date.now()): InboxPayload {
  if (ids === null) db.query("UPDATE notifications SET read_at = ? WHERE read_at IS NULL").run(now);
  else for (const id of ids) db.query("UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL").run(now, id);
  changed();
  return inboxPayload();
}

/** Removes one notification, or every one when no id is named. */
export function clearNotifications(id: number | null): InboxPayload {
  if (id === null) db.exec("DELETE FROM notifications");
  else db.query("DELETE FROM notifications WHERE id = ?").run(id);
  changed();
  return inboxPayload();
}
