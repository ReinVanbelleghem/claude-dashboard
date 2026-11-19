import { useEffect, useState, type ReactNode } from "react";
import { settingsApi, type NotifyEventKind, type Settings, type SettingsPatch } from "../api.ts";
import { CheckIcon } from "./Icons.tsx";

type EventDef = { kind: NotifyEventKind; label: string; help: string };

const GROUPS: { key: string; label: string; events: EventDef[] }[] = [
  {
    key: "sessions",
    label: "Sessions",
    events: [
      {
        kind: "awaitingPermission",
        label: "Permission request",
        help: "A dashboard session is waiting for you to allow or deny a tool call. Nothing proceeds until you answer.",
      },
      {
        kind: "needsInput",
        label: "Terminal session needs input",
        help: "A session started outside the dashboard is blocked and waiting on you in its own terminal.",
      },
      {
        kind: "turnComplete",
        label: "Reply finished",
        help: "A dashboard session finished its turn and is idle. The most useful signal when you walk away, and the loudest.",
      },
      {
        kind: "sessionError",
        label: "Session error",
        help: "A session stopped unexpectedly or reported an error.",
      },
    ],
  },
  {
    key: "reviews",
    label: "Pull requests",
    events: [
      {
        kind: "prReviewRequested",
        label: "Asked to review",
        help: "Someone requested your review, personally or through a team. Once per request; what else happens is set under Reviews → Watching.",
      },
      {
        kind: "prWatch",
        label: "Watched pull request changed",
        help: "A commit, review, comment, CI verdict, conflict, merge or close on a pull request you watch. One alert per pull request per check.",
      },
    ],
  },
  {
    key: "calendar",
    label: "Calendar",
    events: [
      {
        kind: "calendarInvite",
        label: "Invited to a meeting",
        help: "A new invitation you have not answered yet, once per meeting or repeating series.",
      },
      {
        kind: "calendarStarting",
        label: "A meeting is about to start",
        help: "Timed meetings on the calendars you show. All-day events and meetings you declined are left out.",
      },
    ],
  },
  {
    key: "tasks",
    label: "Tasks",
    events: [
      {
        kind: "taskDue",
        label: "A task is due",
        help: "A task with a time, when that time comes.",
      },
    ],
  },
];

/** Short names for the muted-sessions list, where the full wording is a paragraph. */
const MUTE_KIND_LABEL: Record<NotifyEventKind, string> = {
  needsInput: "Needs you",
  awaitingPermission: "Permission needed",
  turnComplete: "Done",
  sessionError: "Error",
  prWatch: "PR activity",
  prReviewRequested: "Review requested",
  taskDue: "Task due",
  calendarInvite: "New invite",
  calendarStarting: "Meeting starting",
};

const CHANNELS: { key: keyof Settings["notifications"]["channels"]; label: string; help: string }[] = [
  {
    key: "native",
    label: "macOS notification",
    help: "A banner in the notification centre, clickable through to what it is about. The only channel that works with the browser closed.",
  },
  {
    key: "browser",
    label: "Browser notification",
    help: "Raised by the dashboard tab. Only fires while a tab is open, and needs the browser's permission once.",
  },
  {
    key: "inApp",
    label: "Dashboard toast",
    help: "A small card in the bottom right corner of the dashboard. Waits for you when the tab is in the background.",
  },
  {
    key: "googleChat",
    label: "Google Chat",
    help: "Posts to a webhook, so alerts reach you away from this machine.",
  },
];

const DEFAULT_DIGEST_TIME = "09:00";
const DEFAULT_REMINDER_MINUTES = 10;

function Card({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return (
    <section className="panel ntf-card">
      <header className="ntf-card-head">
        <h3>{title}</h3>
        {help && <p>{help}</p>}
      </header>
      {children}
    </section>
  );
}

function Toggle({
  label,
  help,
  note,
  checked,
  onChange,
  children,
}: {
  label: string;
  help?: string;
  note?: ReactNode;
  checked: boolean;
  onChange: (on: boolean) => void;
  /** Options that only matter while the toggle is on. */
  children?: ReactNode;
}) {
  return (
    <div className="ntf-item">
      <label className="ntf-row">
        <span className="set-text">
          <span className="set-label">
            {label}
            {note}
          </span>
          {help && <span className="set-help">{help}</span>}
        </span>
        <span className="switch">
          <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        </span>
      </label>
      {checked && children && <div className="ntf-sub">{children}</div>}
    </div>
  );
}

function NumberField({
  value,
  min,
  max,
  unit,
  ariaLabel,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  unit: string;
  ariaLabel: string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    const next = draft.trim() === "" || !Number.isFinite(parsed) ? value : Math.min(max, Math.max(min, Math.round(parsed)));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <span className="with-unit">
      <input
        className="search"
        type="number"
        aria-label={ariaLabel}
        min={min}
        max={max}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      <span>{unit}</span>
    </span>
  );
}

function Option({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="ntf-option">
      <span className="set-text">
        <span className="ntf-option-label">{label}</span>
        {help && <span className="set-help">{help}</span>}
      </span>
      {children}
    </div>
  );
}

/** Which things interrupt you, through which channel, and when to stay quiet. */
export function NotificationsPanel({
  settings,
  saving,
  save,
  onSettings,
}: {
  settings: Settings;
  saving: boolean;
  save: (patch: SettingsPatch) => void;
  onSettings: (s: Settings) => void;
}) {
  const n = settings.notifications;
  const [tested, setTested] = useState<string | null>(null);
  const [webhook, setWebhook] = useState(n.googleChatWebhook);
  const [url, setUrl] = useState(n.dashboardUrl);
  const [browserPerm, setBrowserPerm] = useState<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );

  useEffect(() => {
    setWebhook(n.googleChatWebhook);
    setUrl(n.dashboardUrl);
  }, [n.googleChatWebhook, n.dashboardUrl]);

  const askBrowser = async () => {
    if (typeof Notification === "undefined") return;
    setBrowserPerm(await Notification.requestPermission());
  };

  const test = () =>
    settingsApi
      .test()
      .then((r) => {
        const on = Object.entries(r.channels)
          .filter(([, v]) => v)
          .map(([k]) => k);
        setTested(
          on.length === 0
            ? "No channel is enabled, so nothing was sent."
            : `Sent via ${on.join(", ")}${r.notifier ? "" : " — terminal-notifier not found, used osascript"}.`,
        );
      })
      .catch((e: Error) => setTested(e.message));

  const digestTime = settings.ui.taskDigestTime ?? DEFAULT_DIGEST_TIME;
  const mutes = Object.entries(n.mutes ?? {});
  const onCount = Object.values(n.events).filter(Boolean).length;

  const extras: Partial<Record<NotifyEventKind, ReactNode>> = {
    calendarStarting: (
      <Option label="How long before it starts">
        <NumberField
          ariaLabel="Minutes before a meeting starts"
          value={settings.ui.calendarReminderMinutes ?? DEFAULT_REMINDER_MINUTES}
          min={1}
          max={240}
          unit="minutes"
          onCommit={(v) => save({ ui: { calendarReminderMinutes: v } })}
        />
      </Option>
    ),
  };

  const channelExtras: Partial<Record<keyof Settings["notifications"]["channels"], ReactNode>> = {
    browser:
      browserPerm === "default" ? (
        <Option label="The browser has not been asked yet" help="Without permission this channel stays silent.">
          <button className="icon-btn" onClick={() => void askBrowser()}>
            Grant permission
          </button>
        </Option>
      ) : undefined,
    googleChat: (
      <label className="field ntf-wide">
        <span>Webhook address</span>
        <input
          className="search"
          value={webhook}
          placeholder="https://chat.googleapis.com/v1/spaces/…"
          onChange={(e) => setWebhook(e.target.value)}
          onBlur={() => webhook !== n.googleChatWebhook && save({ notifications: { googleChatWebhook: webhook } })}
        />
      </label>
    ),
  };

  const browserNote =
    browserPerm === "granted" ? (
      <span className="set-ok">
        <CheckIcon /> allowed
      </span>
    ) : browserPerm === "denied" ? (
      <span className="set-warn">blocked by the browser</span>
    ) : null;

  return (
    <div className="ntf">
      <section className="panel ntf-master">
        <div className="ntf-master-text">
          <h2>Notifications</h2>
          <p>
            {n.enabled ? `On · ${onCount} of ${Object.keys(n.events).length} kinds of alert` : "Off · nothing interrupts you"}
            {saving ? " · saving…" : ""}
          </p>
        </div>
        <div className="ntf-master-actions">
          <button className="icon-btn" onClick={test}>
            Send a test
          </button>
          <label className="switch">
            <input type="checkbox" checked={n.enabled} onChange={(e) => save({ notifications: { enabled: e.target.checked } })} />
            <span>{n.enabled ? "On" : "Off"}</span>
          </label>
        </div>
        {tested && <p className="ntf-tested">{tested}</p>}
      </section>

      <div className={`ntf-body ${n.enabled ? "" : "disabled"}`}>
        <Card title="What to tell me about" help="Each kind of alert, by where it comes from.">
          {GROUPS.map((g) => (
            <div className="ntf-group" key={g.key}>
              <h4>{g.label}</h4>
              {g.events.map((e) => (
                <Toggle
                  key={e.kind}
                  label={e.label}
                  help={e.help}
                  checked={n.events[e.kind]}
                  onChange={(on) => save({ notifications: { events: { [e.kind]: on } } })}
                >
                  {extras[e.kind]}
                </Toggle>
              ))}
              {g.key === "tasks" && (
                <Toggle
                  label="Morning summary"
                  help="Once a day, a count of what is due today and what is overdue."
                  checked={n.events.taskDue && digestTime !== ""}
                  onChange={(on) => save({ ui: { taskDigestTime: on ? DEFAULT_DIGEST_TIME : "" } })}
                >
                  <Option label="Not before">
                    <input
                      className="search ntf-time"
                      type="time"
                      aria-label="Morning summary time"
                      value={digestTime}
                      onChange={(e) => e.target.value && save({ ui: { taskDigestTime: e.target.value } })}
                    />
                  </Option>
                </Toggle>
              )}
            </div>
          ))}
        </Card>

        <Card title="How to tell me" help="Every alert goes out through each channel that is on.">
          <div className="ntf-group">
            {CHANNELS.map((c) => (
              <Toggle
                key={c.key}
                label={c.label}
                help={c.help}
                note={c.key === "browser" ? browserNote : undefined}
                checked={n.channels[c.key]}
                onChange={(on) => save({ notifications: { channels: { [c.key]: on } } })}
              >
                {channelExtras[c.key]}
              </Toggle>
            ))}
          </div>
        </Card>

        <Card title="When to stay quiet" help="Timing that keeps a busy session from turning into noise.">
          <div className="ntf-group">
            <div className="ntf-item">
              <Option label="Wait before notifying" help="A prompt you answer inside this window never interrupts you.">
                <NumberField
                  ariaLabel="Seconds to wait before notifying"
                  value={n.delaySeconds}
                  min={0}
                  max={600}
                  unit="seconds"
                  onCommit={(v) => save({ notifications: { delaySeconds: v } })}
                />
              </Option>
            </div>
            <div className="ntf-item">
              <Option label="Then stay quiet for" help="Per session and kind of alert, so one blocked session cannot spam you.">
                <NumberField
                  ariaLabel="Seconds to stay quiet after an alert"
                  value={n.cooldownSeconds}
                  min={0}
                  max={3600}
                  unit="seconds"
                  onCommit={(v) => save({ notifications: { cooldownSeconds: v } })}
                />
              </Option>
            </div>
            <Toggle
              label="Skip the session I am looking at"
              help="No point telling you about a permission prompt already on your screen."
              checked={n.suppressWhenFocused}
              onChange={(on) => save({ notifications: { suppressWhenFocused: on } })}
            />
            <Toggle
              label="Quiet hours"
              help="No banners between two local times. Alerts from that window still wait under the bell."
              checked={n.quietHours.enabled}
              onChange={(on) => save({ notifications: { quietHours: { enabled: on } } })}
            >
              <Option label="Between">
                <span className="ntf-range">
                  <input
                    className="search ntf-time"
                    type="time"
                    aria-label="Quiet hours start"
                    value={n.quietHours.from}
                    onChange={(e) => e.target.value && save({ notifications: { quietHours: { from: e.target.value } } })}
                  />
                  <span>and</span>
                  <input
                    className="search ntf-time"
                    type="time"
                    aria-label="Quiet hours end"
                    value={n.quietHours.to}
                    onChange={(e) => e.target.value && save({ notifications: { quietHours: { to: e.target.value } } })}
                  />
                </span>
              </Option>
            </Toggle>
          </div>
        </Card>

        <Card
          title="Muted sessions"
          help="Mute a session from the bell beside its title, to silence some kinds of alert for that session alone."
        >
          {mutes.length === 0 ? (
            <p className="ntf-empty">No session is muted.</p>
          ) : (
            <div className="mute-list">
              {mutes.map(([id, m]) => (
                <div className="mute-item" key={id}>
                  <span className="mute-item-label" title={id}>
                    {m.label}
                  </span>
                  <span className="mute-item-kinds">{m.kinds.map((k) => MUTE_KIND_LABEL[k] ?? k).join(", ")}</span>
                  <button className="icon-btn tiny" onClick={() => settingsApi.mute(id, [], m.label).then((r) => onSettings(r.settings))}>
                    Unmute
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Where a notification opens" help="Clicking an alert opens this address at the session, pull request or page it is about.">
          <label className="field ntf-wide">
            <span>Dashboard address</span>
            <input
              className="search"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => url !== n.dashboardUrl && save({ notifications: { dashboardUrl: url } })}
              placeholder="http://localhost:5758"
            />
            <span className="set-help">The dev UI runs on 5758; the built one is served by the daemon on 5757.</span>
          </label>
        </Card>
      </div>
    </div>
  );
}
