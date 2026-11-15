import { useState } from "react";
import { settingsApi, type NotifyEventKind, type Settings } from "../api.ts";
import { BellIcon } from "./Icons.tsx";
import { Select } from "./Select.tsx";

/**
 * What this one session is allowed to interrupt you about.
 *
 * The global toggles in Settings answer "is this kind of event worth a banner",
 * which is the wrong question for a session running on a loop: a /loop checking
 * PRs every ten minutes emits a real `turnComplete` every ten minutes, and the
 * only way to stop it used to be switching Done off for every session you own —
 * taking the one you were actually waiting on with it.
 *
 * So the mute is per session and per kind. Silencing "Done" on the loop leaves
 * "Permission needed" and "Error" alone, which is what you want: a loop that has
 * gone quiet because it broke should still be able to say so.
 */

export const MUTE_KINDS: { kind: NotifyEventKind; label: string; hint: string }[] = [
  { kind: "turnComplete", label: "Done", hint: "finished a turn" },
  { kind: "awaitingPermission", label: "Permission needed", hint: "blocked on a decision" },
  { kind: "needsInput", label: "Needs you", hint: "waiting on a reply" },
  { kind: "sessionError", label: "Error", hint: "stopped unexpectedly" },
];

/**
 * The per-session mute state and the one way to write it. Shared so the bell
 * dropdown and the tile's overflow menu cannot drift apart: they are two
 * presentations of the same four checkboxes.
 */
export function useMute(id: string, label: string, settings: Settings | null, onSettings: (s: Settings) => void) {
  const [busy, setBusy] = useState(false);
  const muted = settings?.notifications.mutes?.[id]?.kinds ?? [];

  const write = async (kinds: NotifyEventKind[]) => {
    setBusy(true);
    try {
      const r = await settingsApi.mute(id, kinds, label);
      onSettings(r.settings);
    } catch {
      // A failed write leaves the box where it was; the next settings event from
      // the daemon is the source of truth either way.
    } finally {
      setBusy(false);
    }
  };

  const globallyOff = settings
    ? MUTE_KINDS.filter((k) => !settings.notifications.events[k.kind] && !muted.includes(k.kind)).map((k) => k.label)
    : [];
  const title = muted.length === 0 ? "Notifications on" : `Muted: ${muted.length} of ${MUTE_KINDS.length}`;

  return { muted, busy, write, globallyOff, title };
}

/** The global flags still win: a kind switched off in Settings is off everywhere. */
export function GloballyOffNote({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  return (
    <p className="mute-note">
      {labels.join(", ")} {labels.length === 1 ? "is" : "are"} already off for every session in Settings.
    </p>
  );
}

export function MuteMenu({
  id,
  label,
  settings,
  onSettings,
  compact = false,
}: {
  /** Session id, or the agent key while it has none. */
  id: string;
  /** What to call this session in the Settings list of mutes. */
  label: string;
  settings: Settings | null;
  onSettings: (s: Settings) => void;
  /** Icon only, for a session card that has no room for a word. */
  compact?: boolean;
}) {
  const { muted, busy, write, globallyOff, title } = useMute(id, label, settings, onSettings);
  if (!settings) return null;

  return (
    <div className="mute" onClick={(e) => e.stopPropagation()}>
      <Select
        multiple
        compact
        values={muted}
        disabled={busy}
        options={MUTE_KINDS.map((k) => ({ value: k.kind, label: k.label, hint: k.hint }))}
        onChange={(kinds) => void write(kinds as NotifyEventKind[])}
        heading="Silence for this session"
        ariaLabel={title}
        title={title}
        renderTrigger={({ open }) => (
          <span
            className={`icon-btn ${compact ? "tiny" : ""} mute-btn ${muted.length > 0 ? "on" : ""} ${open ? "open" : ""}`}
          >
            <BellIcon muted={muted.length > 0} />
            {!compact && <span>{muted.length === 0 ? "Notify" : `Muted ${muted.length}`}</span>}
          </span>
        )}
        footer={() => (
          <>
            {/* Both shortcuts, because the two useful states are opposite ends: a loop
                wants everything off, and undoing a mute set weeks ago wants one click. */}
            <div className="mute-foot">
              <button className="icon-btn tiny" disabled={busy || muted.length === MUTE_KINDS.length} onClick={() => void write(MUTE_KINDS.map((k) => k.kind))}>
                Mute all
              </button>
              <button className="icon-btn tiny" disabled={busy || muted.length === 0} onClick={() => void write([])}>
                Unmute
              </button>
            </div>
            <GloballyOffNote labels={globallyOff} />
          </>
        )}
      />
    </div>
  );
}
