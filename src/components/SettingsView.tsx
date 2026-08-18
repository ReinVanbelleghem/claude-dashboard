import { useEffect, useState } from "react";
import { settingsApi, type NotifyEventKind, type Settings, type SettingsPatch } from "../api.ts";
import type { Appearance } from "../appearance.ts";
import { AppearancePanel } from "./AppearancePanel.tsx";
import { CheckIcon } from "./Icons.tsx";

/**
 * Preferences, saved on change.
 *
 * Notifications are the substance here: which states are worth interrupting you
 * for, through which channel, and when to stay quiet. Everything writes straight
 * to the daemon's settings.json, so a reload or another tab sees the same state.
 */

const EVENTS: { kind: NotifyEventKind; label: string; help: string }[] = [
  {
    kind: "needsInput",
    label: "Terminal session needs input",
    help: "A session started outside the dashboard reported a blocked status — it is waiting on you in its own terminal.",
  },
  {
    kind: "awaitingPermission",
    label: "Permission request",
    help: "A dashboard session is parked waiting for you to allow or deny a tool call. Nothing proceeds until you answer.",
  },
  {
    kind: "turnComplete",
    label: "Reply finished",
    help: "A dashboard session finished its turn and is idle. The most useful signal if you walk away mid-task, and the loudest.",
  },
  {
    kind: "sessionError",
    label: "Session error",
    help: "A session stopped unexpectedly or reported an error.",
  },
];

/**
 * Sections are one panel each, reached from the left rail rather than by
 * scrolling: notifications alone is longer than a screen, and the three short
 * panels were disappearing under it.
 */
type SectionKey = "appearance" | "notifications" | "sessions" | "diffs";

const SECTIONS: { key: SectionKey; label: string; help: string }[] = [
  { key: "appearance", label: "Appearance", help: "Theme, accent, tab icon" },
  { key: "notifications", label: "Notifications", help: "What interrupts you" },
  { key: "sessions", label: "Sessions", help: "Where a card opens" },
  { key: "diffs", label: "Diffs", help: "Defaults for the git views" },
];

const SECTION_KEY = "settings-section";

const CHANNELS: { key: keyof Settings["notifications"]["channels"]; label: string; help: string }[] = [
  {
    key: "native",
    label: "macOS notification",
    help: "A real notification centre banner, clickable through to the session. Works with the browser closed — the only channel that does.",
  },
  {
    key: "browser",
    label: "Browser notification",
    help: "Raised by the dashboard tab. Only fires while a tab is open, and needs permission from the browser once.",
  },
  {
    key: "googleChat",
    label: "Google Chat",
    help: "Posts to a webhook, so alerts reach you away from this machine.",
  },
];

export function SettingsView({
  settings,
  onSettings,
  appearance,
  onAppearance,
}: {
  settings: Settings | null;
  onSettings: (s: Settings) => void;
  appearance: Appearance;
  onAppearance: (patch: Partial<Appearance>) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [tested, setTested] = useState<string | null>(null);
  const [webhook, setWebhook] = useState("");
  const [url, setUrl] = useState("");
  const [browserPerm, setBrowserPerm] = useState<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  // Remembered, because settings is a place you come back to for one thing.
  const [section, setSection] = useState<SectionKey>(() => {
    const saved = localStorage.getItem(SECTION_KEY);
    return SECTIONS.some((s) => s.key === saved) ? (saved as SectionKey) : "appearance";
  });

  useEffect(() => {
    localStorage.setItem(SECTION_KEY, section);
  }, [section]);

  useEffect(() => {
    if (!settings) return;
    setWebhook(settings.notifications.googleChatWebhook);
    setUrl(settings.notifications.dashboardUrl);
  }, [settings]);

  const nav = (
    <nav className="settings-nav" aria-label="Settings sections">
      {SECTIONS.map((s) => (
        <button
          key={s.key}
          className={`settings-nav-item ${section === s.key ? "on" : ""}`}
          aria-current={section === s.key ? "page" : undefined}
          onClick={() => setSection(s.key)}
        >
          <span className="settings-nav-label">{s.label}</span>
          <span className="settings-nav-help">{s.help}</span>
        </button>
      ))}
    </nav>
  );

  // Appearance renders either way: it is local state, so there is nothing to wait
  // for, and it is the panel you are most likely here to play with.
  if (!settings) {
    return (
      <div className="settings-layout">
        {nav}
        <div className="settings-body">
          {section === "appearance" ? (
            <AppearancePanel appearance={appearance} onChange={onAppearance} />
          ) : (
            <div className="empty">Loading settings…</div>
          )}
        </div>
      </div>
    );
  }
  const n = settings.notifications;

  const save = (patch: SettingsPatch) => {
    setSaving(true);
    settingsApi
      .save(patch)
      .then((r) => onSettings(r.settings))
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  const askBrowser = async () => {
    if (typeof Notification === "undefined") return;
    setBrowserPerm(await Notification.requestPermission());
  };

  return (
    <div className="settings-layout">
      {nav}
      <div className="settings-body">
        {section === "appearance" && (
          <AppearancePanel
            appearance={appearance}
            onChange={onAppearance}
            themes={settings.ui.themes ?? []}
            onThemes={(themes) => save({ ui: { themes } })}
          />
        )}

        {section === "notifications" && (
          <div className="panel">
            <div className="panel-head">
              <h2>Notifications</h2>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={n.enabled}
                  onChange={(e) => save({ notifications: { enabled: e.target.checked } })}
                />
                <span>{n.enabled ? "On" : "Off"}</span>
              </label>
            </div>
            <p className="hint">
              Told when a session wants you, so you can leave the dashboard closed. Nothing fires while
              the master switch is off{saving ? " · saving…" : ""}.
            </p>

            <div className={`set-group ${n.enabled ? "" : "disabled"}`}>
              <h3 className="set-h">What to tell me about</h3>
              {EVENTS.map((e) => (
                <label className="set-row" key={e.kind}>
                  <input
                    type="checkbox"
                    checked={n.events[e.kind]}
                    disabled={!n.enabled}
                    onChange={(ev) =>
                      save({ notifications: { events: { [e.kind]: ev.target.checked } } })
                    }
                  />
                  <span className="set-text">
                    <span className="set-label">{e.label}</span>
                    <span className="set-help">{e.help}</span>
                  </span>
                </label>
              ))}

              <h3 className="set-h">How to tell me</h3>
              {CHANNELS.map((c) => (
                <label className="set-row" key={c.key}>
                  <input
                    type="checkbox"
                    checked={n.channels[c.key]}
                    disabled={!n.enabled}
                    onChange={(ev) =>
                      save({ notifications: { channels: { [c.key]: ev.target.checked } } })
                    }
                  />
                  <span className="set-text">
                    <span className="set-label">
                      {c.label}
                      {c.key === "browser" && browserPerm === "granted" && (
                        <span className="set-ok">
                          <CheckIcon /> allowed
                        </span>
                    )}
                    {c.key === "browser" && browserPerm === "default" && n.channels.browser && (
                      <button
                        className="link-btn inline"
                        onClick={(e) => {
                          e.preventDefault();
                          void askBrowser();
                        }}
                      >
                        grant permission
                      </button>
                    )}
                    {c.key === "browser" && browserPerm === "denied" && (
                      <span className="set-warn">blocked by the browser</span>
                    )}
                  </span>
                  <span className="set-help">{c.help}</span>
                </span>
              </label>
            ))}

            {n.channels.googleChat && (
              <label className="field indented">
                <span>Google Chat webhook</span>
                <input
                  className="search"
                  value={webhook}
                  placeholder="https://chat.googleapis.com/v1/spaces/…"
                  onChange={(e) => setWebhook(e.target.value)}
                  onBlur={() => save({ notifications: { googleChatWebhook: webhook } })}
                />
              </label>
            )}

            <h3 className="set-h">When</h3>
            <div className="set-grid">
              <label className="field">
                <span>Wait before notifying</span>
                <div className="with-unit">
                  <input
                    className="search"
                    type="number"
                    min={0}
                    max={600}
                    value={n.delaySeconds}
                    disabled={!n.enabled}
                    onChange={(e) =>
                      save({ notifications: { delaySeconds: Number(e.target.value) } })
                    }
                  />
                  <span>seconds</span>
                </div>
                <span className="set-help">
                  A prompt you answer inside this window never interrupts you.
                </span>
              </label>
              <label className="field">
                <span>Then stay quiet for</span>
                <div className="with-unit">
                  <input
                    className="search"
                    type="number"
                    min={0}
                    max={3600}
                    value={n.cooldownSeconds}
                    disabled={!n.enabled}
                    onChange={(e) =>
                      save({ notifications: { cooldownSeconds: Number(e.target.value) } })
                    }
                  />
                  <span>seconds</span>
                </div>
                <span className="set-help">Per session and event, so one blocked session cannot spam you.</span>
              </label>
            </div>

            <label className="set-row">
              <input
                type="checkbox"
                checked={n.suppressWhenFocused}
                disabled={!n.enabled}
                onChange={(e) =>
                  save({ notifications: { suppressWhenFocused: e.target.checked } })
                }
              />
              <span className="set-text">
                <span className="set-label">Stay quiet about the session I am looking at</span>
                <span className="set-help">
                  No point telling you about a permission prompt already on your screen.
                </span>
              </span>
            </label>

            <label className="set-row">
              <input
                type="checkbox"
                checked={n.quietHours.enabled}
                disabled={!n.enabled}
                onChange={(e) =>
                  save({ notifications: { quietHours: { enabled: e.target.checked } } })
                }
              />
              <span className="set-text">
                <span className="set-label">Quiet hours</span>
                <span className="set-help">Silence everything between two local times.</span>
              </span>
            </label>

            {n.quietHours.enabled && (
              <div className="set-grid indented">
                <label className="field">
                  <span>From</span>
                  <input
                    className="search"
                    type="time"
                    value={n.quietHours.from}
                    onChange={(e) =>
                      save({ notifications: { quietHours: { from: e.target.value } } })
                    }
                  />
                </label>
                <label className="field">
                  <span>To</span>
                  <input
                    className="search"
                    type="time"
                    value={n.quietHours.to}
                    onChange={(e) => save({ notifications: { quietHours: { to: e.target.value } } })}
                  />
                </label>
              </div>
            )}

            <h3 className="set-h">Where a notification opens</h3>
            <label className="field">
              <span>Dashboard URL</span>
              <input
                className="search"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onBlur={() => save({ notifications: { dashboardUrl: url } })}
                placeholder="http://localhost:5758"
              />
              <span className="set-help">
                Clicking a notification opens this address at the session. The dev UI runs on 5758; the
                built one is served by the daemon on 5757.
              </span>
            </label>

              <div className="set-actions">
                <button
                  className="icon-btn"
                  onClick={() =>
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
                      .catch((e: Error) => setTested(e.message))
                  }
                >
                  Send a test notification
                </button>
                {tested && <span className="set-help">{tested}</span>}
              </div>
            </div>
          </div>
        )}

        {section === "sessions" && (
          <div className="panel">
            <h2>Sessions</h2>
            <p className="hint">
              Every card also carries an ↗ that always opens the full page, whatever this is set to.
            </p>
            <label className="field" style={{ maxWidth: 280 }}>
              <span>Clicking a session opens</span>
              <span className="select-wrap">
                <select
                  className="search select"
                  value={settings.ui.openSessionsIn}
                  onChange={(e) =>
                    save({ ui: { openSessionsIn: e.target.value as "drawer" | "page" } })
                  }
                >
                  <option value="drawer">The side drawer</option>
                  <option value="page">The full page</option>
                </select>
              </span>
            </label>
          </div>
        )}

        {section === "diffs" && (
          <div className="panel">
            <h2>Diffs</h2>
            <p className="hint">Defaults for the git views. Changing them here or there is the same thing.</p>
            <div className="set-grid">
              <label className="field">
                <span>Default layout</span>
                <span className="select-wrap">
                  <select
                    className="search select"
                    value={settings.ui.diffMode}
                    onChange={(e) => save({ ui: { diffMode: e.target.value as "unified" | "split" } })}
                  >
                    <option value="unified">Unified</option>
                    <option value="split">Split</option>
                  </select>
                </span>
              </label>
              <label className="set-row" style={{ alignSelf: "end" }}>
                <input
                  type="checkbox"
                  checked={settings.ui.diffIgnoreWhitespace}
                  onChange={(e) => save({ ui: { diffIgnoreWhitespace: e.target.checked } })}
                />
                <span className="set-text">
                  <span className="set-label">Ignore whitespace</span>
                  <span className="set-help">Hide changes that only reindent.</span>
                </span>
              </label>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
