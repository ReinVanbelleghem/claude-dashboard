import { useEffect, useState, type CSSProperties } from "react";
import { modelApi, type CalendarInfo, type OtherCalendar, type PermissionMode, type Settings } from "../../api.ts";
import { MODES, MODE_HELP, MODE_LABEL, STARTER_MODELS } from "../Conversation.tsx";
import { Select } from "../Select.tsx";
import { permissionModeOr } from "../../../shared/templates.ts";
import { BuildingIcon, ClaudeMark, XIcon } from "../Icons.tsx";

/**
 * Describe the meetings you want in words; a session works out the times and
 * books them. The dialog only collects the request and shows what the session
 * will be told about the screen.
 */
export function PlanDialog({
  rangeLabel,
  onShow,
  calendars,
  canInvite,
  standing,
  onStanding,
  settings,
  onRemember,
  onClose,
  onPlan,
}: {
  settings: Settings | null;
  /** Keep the model and permission mode for the next plan. */
  onRemember: (choice: { calendarPlanModel: string; calendarPlanMode: string }) => void;
  /** Instructions kept between sessions, and what to do when they are edited. */
  standing: string;
  onStanding: (text: string) => void;
  rangeLabel: string;
  onShow: OtherCalendar[];
  /** The calendars a meeting can be booked into. */
  calendars: CalendarInfo[];
  /** Whether guests and rooms are possible in a given calendar. */
  canInvite: (calendar: CalendarInfo) => boolean;
  onClose: () => void;
  onPlan: (request: string, askFirst: boolean, calendar: CalendarInfo | null, session: { model: string | undefined; permissionMode: PermissionMode }) => Promise<void>;
}) {
  const [request, setRequest] = useState("");
  const [askFirst, setAskFirst] = useState(true);
  const [model, setModel] = useState(settings?.ui.calendarPlanModel || settings?.ui.defaultModel || "default");
  const [mode, setMode] = useState<PermissionMode>(() => {
    const saved = settings?.ui.calendarPlanMode as PermissionMode | undefined;
    return permissionModeOr(saved, permissionModeOr(settings?.ui.defaultPermissionMode));
  });
  const [models, setModels] = useState<{ value: string; label: string; hint?: string }[]>(STARTER_MODELS);
  const disabledModels = settings?.ui.disabledModels ?? [];
  const customModels = settings?.ui.customModels ?? [];

  useEffect(() => {
    modelApi
      .list()
      .then((r) => {
        const offered = r.models.map((m) => ({ value: m.value, label: m.displayName, hint: m.description }));
        const all = [...offered, ...customModels.filter((c) => !offered.some((m) => m.value === c.value)).map((c) => ({ value: c.value, label: c.label, hint: c.value }))];
        const enabled = all.filter((m) => !disabledModels.includes(m.value));
        if (enabled.length > 0) setModels(enabled);
      })
      .catch(() => {});
  }, []);

  const pickModel = (value: string) => {
    setModel(value);
    onRemember({ calendarPlanModel: value, calendarPlanMode: mode });
  };
  const pickMode = (value: PermissionMode) => {
    setMode(value);
    onRemember({ calendarPlanModel: model, calendarPlanMode: value });
  };
  const [always, setAlways] = useState(standing);
  const keepAlways = () => {
    if (always.trim() !== standing.trim()) onStanding(always.trim());
  };
  const [calendarId, setCalendarId] = useState(() => (calendars.find((c) => canInvite(c)) ?? calendars.find((c) => c.isDefault) ?? calendars[0])?.id ?? "");
  const calendar = calendars.find((c) => c.id === calendarId) ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const plan = () => {
    if (!request.trim() || busy) return;
    setBusy(true);
    setError(null);
    keepAlways();
    onPlan(request, askFirst, calendar, { model: model === "default" ? undefined : model, permissionMode: mode }).catch((e: Error) => {
      setError(e.message);
      setBusy(false);
    });
  };

  return (
    <>
      <div className="scrim stacked" onClick={onClose} />
      <form
        className="modal stacked cal-modal cal-plan"
        role="dialog"
        aria-modal="true"
        aria-label="Plan with Claude"
        onSubmit={(e) => {
          e.preventDefault();
          plan();
        }}
      >
        <div className="cal-modal-head">
          <span className="cal-plan-mark"><ClaudeMark /></span>
          <div className="cal-modal-title">
            <h3>Plan with Claude</h3>
            <p>Say what you need. A session finds the times and books them.</p>
          </div>
          <button type="button" className="icon-btn square" aria-label="Close" onClick={onClose}><XIcon /></button>
        </div>

        <textarea
          className="search cal-plan-input"
          autoFocus
          rows={4}
          value={request}
          placeholder="A 45-minute sync with Pieterjan and Amir next week, in a free room…"
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) plan();
          }}
        />

        <div className="field cal-plan-for">
          <span>Book in</span>
          <Select
            ariaLabel="Calendar to book in"
            value={calendarId}
            onChange={setCalendarId}
            options={calendars.map((c) => ({ value: c.id, label: c.account !== c.title ? `${c.title} · ${c.account}` : c.title, dot: c.color ?? "var(--accent)" }))}
          />
        </div>

        <div className="modal-cols cal-plan-session">
          <div className="field">
            <span>Model</span>
            <Select ariaLabel="Model" value={model} options={models.some((m) => m.value === model) ? models : [{ value: model, label: model }, ...models]} onChange={pickModel} />
          </div>
          <div className="field" title={MODE_HELP[mode]}>
            <span>Permissions</span>
            <Select ariaLabel="Permissions" value={mode} onChange={(v) => pickMode(v as PermissionMode)} options={MODES.map((m) => ({ value: m, label: MODE_LABEL[m], hint: MODE_HELP[m] }))} />
          </div>
        </div>

        <label className="field cal-plan-always">
          <span>
            Always keep in mind
            <em>{always.trim() === standing.trim() ? "saved for every plan" : "saves when you leave the box"}</em>
          </span>
          <textarea
            className="search"
            rows={2}
            value={always}
            placeholder="Only book between 09:00 and 17:00. Nothing on Friday afternoons."
            onChange={(e) => setAlways(e.target.value)}
            onBlur={keepAlways}
          />
        </label>

        <div className="cal-plan-context">
          <span className="cal-plan-label">Claude will know</span>
          <span className="cal-plan-chip">{rangeLabel}</span>
          {onShow.map((o) => (
            <span className="cal-plan-chip" key={o.email} style={{ "--ev": o.color } as CSSProperties}>
              {o.room ? <BuildingIcon /> : <i />}
              {o.name}
            </span>
          ))}
          {calendar && !canInvite(calendar) && <span className="cal-plan-chip">No guests or rooms in this calendar</span>}
        </div>

        {error && <p className="cal-error">{error}</p>}

        <div className="cal-plan-foot">
          <label className="switch" title="Invitations reach real people. With this on, the session puts its plan on the calendar as drafts for you to approve.">
            <input type="checkbox" checked={askFirst} onChange={(e) => setAskFirst(e.target.checked)} />
            <span>Draft first, I approve in the calendar</span>
          </label>
          <button type="button" className="icon-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="icon-btn primary" disabled={busy || !request.trim()}>{busy ? "Starting…" : "Plan it"}</button>
        </div>
      </form>
    </>
  );
}
