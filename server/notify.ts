import { existsSync } from "node:fs";
import { join } from "node:path";
import { getSettings, inQuietHours, type NotifyEventKind } from "./settings.ts";

/**
 * The dashboard's own icon on the banner, so a Claude Sessions alert is not
 * dressed as a generic terminal. Falls back to no override when unbuilt.
 */
const APP_ICON = ((): string | null => {
  for (const dir of ["dist", "public"]) {
    const p = join(import.meta.dir, "..", dir, "apple-touch-icon.png");
    if (existsSync(p)) return p;
  }
  return null;
})();

/**
 * One thing that currently wants your attention. The caller builds these from the
 * registry and the agent roster; this module owns only the decision of whether,
 * when and where to say something about them.
 */
export type NotifySubject = {
  kind: NotifyEventKind;
  /** Stable across polls — the dedupe identity. Usually kind + session id. */
  key: string;
  /** Deep-link target. Null for a session with no transcript id yet. */
  sessionId: string | null;
  /**
   * Every id this session could have been muted under — its transcript id and its
   * agent key. Both, because a session is muted from the UI by whichever of the two
   * that view has, and a fresh session acquires its transcript id part-way through.
   */
  muteIds: string[];
  /** Session title, or the folder name when it has none. */
  label: string;
  /** Where it is: "org/repo · feat/points". */
  context: string;
  /** What it wants, in plain words: "Wants to run a command: bun test". */
  detail: string;
};

type Tracked = {
  /** Timer that fires the notification once the delay has elapsed. */
  timer: ReturnType<typeof setTimeout> | null;
  /** When we last actually sent something for this key. */
  firedAt: number | null;
  subject: NotifySubject;
};

const tracked = new Map<string, Tracked>();

/** Which session the browser is looking at, so we don't notify about it. */
let focus: { sessionId: string | null; visible: boolean } = { sessionId: null, visible: false };

export function setFocus(sessionId: string | null, visible: boolean) {
  focus = { sessionId, visible };
}

let emit: (event: string, data: unknown) => void = () => {};
export function setNotifyEmitter(fn: (event: string, data: unknown) => void) {
  emit = fn;
}

/**
 * How each kind presents itself. The icon and headline lead the banner so the
 * *type* of interruption is readable before you read a word of it; the sound
 * distinguishes "come back now" from "that one's done".
 */
const KIND: Record<NotifyEventKind, { icon: string; headline: string; sound: string; urgent: boolean }> = {
  awaitingPermission: { icon: "🔐", headline: "Permission needed", sound: "Ping", urgent: true },
  needsInput: { icon: "💬", headline: "Needs you", sound: "Ping", urgent: true },
  turnComplete: { icon: "✅", headline: "Done", sound: "Glass", urgent: false },
  sessionError: { icon: "⚠️", headline: "Error", sound: "Basso", urgent: false },
};

/**
 * Bring the tracked set in line with what is currently true.
 *
 * A subject that has just appeared starts a delay timer; if it is still present
 * when the timer fires, it notifies. A subject that has gone away clears its
 * timer and forgets it fired, so the *next* time it happens you hear about it
 * again. That edge-triggering is what stops a session parked on a permission
 * prompt from notifying on every 3-second poll.
 */
export function reconcile(subjects: NotifySubject[]) {
  const s = getSettings();
  const seen = new Set<string>();

  for (const subject of subjects) {
    seen.add(subject.key);
    const existing = tracked.get(subject.key);

    if (existing) {
      // Keep the newest wording — a permission prompt's tool name can change
      // while the session stays blocked.
      existing.subject = subject;
      continue;
    }

    const entry: Tracked = { timer: null, firedAt: null, subject };
    tracked.set(subject.key, entry);

    // Enablement is checked at fire time rather than here, so toggling a setting
    // on mid-delay behaves the way you would expect.
    entry.timer = setTimeout(
      () => {
        entry.timer = null;
        // Still tracked means still true: the reconcile that would have removed
        // it never came.
        if (tracked.get(subject.key) === entry) void fire(entry);
      },
      Math.max(0, s.notifications.delaySeconds * 1000),
    );
  }

  for (const [key, entry] of tracked) {
    if (seen.has(key)) continue;
    if (entry.timer) clearTimeout(entry.timer);
    tracked.delete(key);
  }
}

async function fire(entry: Tracked) {
  const s = getSettings();
  const n = s.notifications;
  const { subject } = entry;

  if (!n.enabled) return;
  if (!n.events[subject.kind]) return;
  if (inQuietHours(s, new Date())) return;
  // Muted for this session specifically. Checked per kind, so a session can go quiet
  // about finishing its turns and still shout when it breaks — which is the whole
  // point for something running on a loop.
  if (subject.muteIds.some((id) => n.mutes[id]?.kinds.includes(subject.kind))) return;

  // You are already looking at it, so an alert would only tell you what is on
  // your screen. Matches on the agent key too, since a fresh session has no id.
  if (
    n.suppressWhenFocused &&
    focus.visible &&
    focus.sessionId &&
    (focus.sessionId === subject.sessionId || focus.sessionId === subject.key)
  ) {
    return;
  }

  const now = Date.now();
  if (entry.firedAt && now - entry.firedAt < n.cooldownSeconds * 1000) return;
  entry.firedAt = now;

  const kind = KIND[subject.kind];
  const title = `${kind.icon} ${kind.headline} · ${subject.label}`;
  const url = deepLink(subject.sessionId ?? subject.key);
  const payload = {
    kind: subject.kind,
    title,
    body: subject.detail,
    context: subject.context,
    urgent: kind.urgent,
    sessionId: subject.sessionId,
    key: subject.key,
    url,
    at: now,
  };

  console.log(`[claude-dashboard] notify: ${title} — ${subject.detail} (${subject.context})`);

  if (n.channels.browser) emit("notify", payload);
  // Detail is the subtitle, not the message: terminal-notifier bolds the subtitle,
  // and what the session wants matters more than where it lives.
  if (n.channels.native) native(title, subject.detail, subject.context, url, subject.key, kind.sound);
  if (n.channels.googleChat && n.googleChatWebhook) {
    await googleChat(`*${title}*\n${subject.detail}\n_${subject.context}_\n${url}`);
  }
}

function deepLink(id: string): string {
  const base = getSettings().notifications.dashboardUrl.replace(/\/$/, "");
  return `${base}/#/session/${encodeURIComponent(id)}`;
}

/** Resolved once — an every-notification `which` would be silly. */
let notifierPath: string | null | undefined;

/**
 * macOS notification centre. terminal-notifier is preferred because its banner is
 * clickable and can carry a URL; osascript can only display text, which is still
 * better than nothing when terminal-notifier isn't installed.
 */
function native(
  title: string,
  subtitle: string,
  message: string,
  url: string,
  group: string,
  sound = "Ping",
) {
  if (notifierPath === undefined) notifierPath = Bun.which("terminal-notifier");

  try {
    if (notifierPath) {
      Bun.spawn(
        [
          notifierPath,
          "-title",
          title,
          "-subtitle",
          subtitle,
          "-message",
          message,
          "-open",
          url,
          // Replaces any earlier banner about the same session instead of stacking.
          "-group",
          `claude-dashboard-${group}`,
          "-sound",
          sound,
          ...(APP_ICON ? ["-appIcon", APP_ICON] : []),
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      return;
    }

    const osa = Bun.which("osascript");
    if (!osa) return;
    // Quotes are the only metacharacter that matters inside an AppleScript string.
    const esc = (v: string) => v.replace(/["\\]/g, "\\$&");
    Bun.spawn(
      [
        osa,
        "-e",
        // osascript has no subtitle slot worth wasting: lead with what it wants.
        `display notification "${esc(subtitle)} — ${esc(message)}" with title "${esc(title)}" sound name "${esc(sound)}"`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
  } catch (err) {
    console.error("[claude-dashboard] native notification failed:", err);
  }
}

async function googleChat(text: string) {
  const url = getSettings().notifications.googleChatWebhook;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error("[claude-dashboard] Google Chat notification failed:", err);
  }
}

/**
 * Fire one notification immediately down every enabled channel, bypassing the
 * delay, cooldown and event filters — the Settings page needs to prove the wiring
 * works without waiting for a session to block.
 */
export async function sendTestNotification() {
  const s = getSettings();
  const n = s.notifications;
  const url = deepLink("test");
  const payload = {
    kind: "needsInput" as NotifyEventKind,
    title: `${KIND.needsInput.icon} Test · Claude Sessions`,
    body: "Notifications are working.",
    context: "sent from the Settings page",
    urgent: false,
    sessionId: null,
    key: "test",
    url,
    at: Date.now(),
  };

  if (n.channels.browser) emit("notify", payload);
  if (n.channels.native) native(payload.title, payload.body, payload.context, url, "test", KIND.needsInput.sound);
  if (n.channels.googleChat && n.googleChatWebhook) {
    await googleChat(`*${payload.title}*\n${payload.body}`);
  }

  return {
    ok: true,
    channels: {
      native: n.channels.native,
      browser: n.channels.browser,
      googleChat: n.channels.googleChat && !!n.googleChatWebhook,
    },
    notifier: notifierPath === undefined ? Bun.which("terminal-notifier") : notifierPath,
  };
}
