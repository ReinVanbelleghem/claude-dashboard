import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { inboxApi, type InboxItem, type InboxPayload, type NotifyEventKind } from "../api.ts";
import {
  BellIcon,
  CalendarIcon,
  CheckIcon,
  CommentIcon,
  EyeIcon,
  GearIcon,
  HelpIcon,
  InboxIcon,
  PullRequestIcon,
  StopIcon,
  TasksIcon,
  XIcon,
} from "./Icons.tsx";

type Tone = "urgent" | "error" | "calm";

export const NOTIFY_KINDS: Record<NotifyEventKind, { label: string; icon: ReactNode; tone: Tone }> = {
  awaitingPermission: { label: "Permission needed", icon: <HelpIcon />, tone: "urgent" },
  needsInput: { label: "Needs you", icon: <CommentIcon />, tone: "urgent" },
  turnComplete: { label: "Done", icon: <CheckIcon />, tone: "calm" },
  sessionError: { label: "Error", icon: <StopIcon />, tone: "error" },
  prWatch: { label: "PR activity", icon: <PullRequestIcon />, tone: "calm" },
  prReviewRequested: { label: "Review requested", icon: <EyeIcon />, tone: "calm" },
  taskDue: { label: "Task due", icon: <TasksIcon />, tone: "calm" },
  calendarInvite: { label: "New invite", icon: <InboxIcon />, tone: "calm" },
  calendarStarting: { label: "Starting soon", icon: <CalendarIcon />, tone: "urgent" },
};

const MAX_BADGE = 9;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

function when(at: number, now: number): string {
  const gone = now - at;
  if (gone < MINUTE) return "now";
  if (gone < HOUR) return `${Math.floor(gone / MINUTE)}m`;
  if (startOfDay(at) === startOfDay(now)) return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function dayLabel(at: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / (24 * HOUR));
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return "Earlier";
}

function byDay(items: InboxItem[], now: number): { label: string; items: InboxItem[] }[] {
  const groups: { label: string; items: InboxItem[] }[] = [];
  for (const item of items) {
    const label = dayLabel(item.at, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/** The top bar's bell, with a count of what has not been read. */
export function NotificationBell({ unread, open, onToggle }: { unread: number; open: boolean; onToggle: () => void }) {
  const title = unread === 0 ? "Notifications" : `Notifications — ${unread} unread`;
  return (
    <button className={`icon-btn square inbox-bell ${open ? "on" : ""}`} title={title} aria-label={title} aria-expanded={open} onClick={onToggle}>
      <BellIcon />
      {unread > 0 && <span className="inbox-badge">{unread > MAX_BADGE ? `${MAX_BADGE}+` : unread}</span>}
    </button>
  );
}

/** Every notification the dashboard raised, newest first, in a panel off the right edge. */
export function NotificationCenter({
  inbox,
  onInbox,
  onClose,
  onOpenSettings,
  onFollow,
}: {
  /** Follows a notification's link; a session opens the way the click settings say. */
  onFollow: (href: string, gesture: { metaKey: boolean; ctrlKey: boolean; altKey: boolean }) => void;
  inbox: InboxPayload;
  onInbox: (payload: InboxPayload) => void;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const shown = useMemo(() => (onlyUnread ? inbox.items.filter((i) => i.readAt === null) : inbox.items), [inbox.items, onlyUnread]);
  const groups = useMemo(() => byDay(shown, now), [shown, now]);
  const apply = (request: Promise<InboxPayload>) => void request.then(onInbox).catch(() => {});

  const open = (item: InboxItem, gesture: { metaKey: boolean; ctrlKey: boolean; altKey: boolean }) => {
    if (item.readAt === null) apply(inboxApi.read([item.id]));
    onClose();
    if (item.href) onFollow(item.href, gesture);
  };

  return createPortal(
    <>
      <div className="scrim inbox-scrim" onClick={onClose} />
      <aside className="inbox" aria-label="Notifications">
        <header className="inbox-head">
          <h3>Notifications</h3>
          <button className="icon-btn square inbox-plain" title="Notification settings" aria-label="Notification settings" onClick={onOpenSettings}>
            <GearIcon />
          </button>
          <button className="icon-btn square inbox-plain" title="Close" aria-label="Close" onClick={onClose}>
            <XIcon />
          </button>
        </header>

        <div className="inbox-bar">
          <div className="inbox-filter" role="tablist">
            <button role="tab" aria-selected={!onlyUnread} className={onlyUnread ? "" : "on"} onClick={() => setOnlyUnread(false)}>
              All
            </button>
            <button role="tab" aria-selected={onlyUnread} className={onlyUnread ? "on" : ""} onClick={() => setOnlyUnread(true)}>
              Unread{inbox.unread > 0 ? ` ${inbox.unread}` : ""}
            </button>
          </div>
          <button className="link-btn" disabled={inbox.unread === 0} onClick={() => apply(inboxApi.read())}>
            Mark all read
          </button>
        </div>

        <div className="inbox-list">
          {shown.length === 0 && (
            <div className="inbox-empty">
              <BellIcon />
              <b>{onlyUnread && inbox.items.length > 0 ? "You are all caught up" : "Nothing yet"}</b>
              <span>Permission prompts, review requests, invites and reminders land here, so a missed banner is not lost.</span>
            </div>
          )}
          {groups.map((g) => (
            <section key={g.label}>
              <h4>{g.label}</h4>
              {g.items.map((item) => {
                const kind = NOTIFY_KINDS[item.kind] ?? NOTIFY_KINDS.needsInput;
                return (
                  <div className={`inbox-item ${item.readAt === null ? "unread" : ""}`} key={item.id}>
                    <button className="inbox-open" onClick={(e) => open(item, e)}>
                      <span className={`inbox-icon ${kind.tone}`}>{kind.icon}</span>
                      <span className="inbox-text">
                        <span className="inbox-kind">
                          {kind.label}
                          {item.count > 1 && <span className="inbox-count">×{item.count}</span>}
                          <time>{when(item.at, now)}</time>
                        </span>
                        <span className="inbox-label">{item.label}</span>
                        {item.detail && <span className="inbox-detail">{item.detail}</span>}
                        {item.context && <span className="inbox-context">{item.context}</span>}
                      </span>
                    </button>
                    <button className="inbox-dismiss" title="Remove" aria-label="Remove notification" onClick={() => apply(inboxApi.clear(item.id))}>
                      <XIcon />
                    </button>
                  </div>
                );
              })}
            </section>
          ))}
        </div>

        {inbox.items.length > 0 && (
          <footer className="inbox-foot">
            <span>Kept for 30 days</span>
            <button className="link-btn" onClick={() => apply(inboxApi.clear())}>
              Clear all
            </button>
          </footer>
        )}
      </aside>
    </>,
    document.body,
  );
}
