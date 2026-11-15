import { useEffect, useState } from "react";
import { calendarApi, type GoogleStatus } from "../../api.ts";
import { ExternalIcon, TrashIcon, XIcon } from "../Icons.tsx";

const GUIDE_URL = "https://github.com/ReinVanbelleghem/claude-dashboard#google-for-guests-rooms-and-other-calendars";

/**
 * Where you give the dashboard your own Google client. Nothing ships with one:
 * the client decides whose Google Cloud project a sign-in goes through, so each
 * person brings theirs and it stays on their machine.
 */
export function GoogleSetup({ google, onGoogle, onClose }: { google: GoogleStatus; onGoogle: (g: GoogleStatus) => void; onClose: () => void }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [replacing, setReplacing] = useState(!google.hasClient);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = (work: Promise<GoogleStatus>, then: () => void) => {
    setBusy(true);
    setError(null);
    work
      .then((next) => {
        onGoogle(next);
        then();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const save = () => run(calendarApi.saveGoogleClient(clientId, clientSecret), () => setReplacing(false));
  const remove = () => run(calendarApi.removeGoogleClient(), () => setReplacing(true));

  return (
    <>
      <div className="scrim stacked" onClick={onClose} />
      <form
        className="modal stacked cal-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Google setup"
        onSubmit={(e) => {
          e.preventDefault();
          if (replacing) save();
        }}
      >
        <div className="cal-modal-head">
          <h3>Google, for guests and rooms</h3>
          <button type="button" className="icon-btn square" aria-label="Close" onClick={onClose}><XIcon /></button>
        </div>
        <p className="hint">
          Inviting guests, booking rooms, adding a Meet link and showing other people's calendars go through Google.
          That needs a Google client of your own, which takes about fifteen minutes to create once. Your calendar itself
          keeps working without it.
        </p>

        {google.clientSource === "environment" && (
          <p className="cal-setup-state">A client is provided to the daemon through its environment. Saving one here takes its place.</p>
        )}
        {google.clientSource === "saved" && !replacing && (
          <>
            <p className="cal-setup-state">
              A client is saved on this computer.
              {google.accounts.length > 0 ? ` Signed in: ${google.accounts.join(", ")}.` : " No Google account is signed in yet; choose Connect a Google account in the menu."}
            </p>
            <div className="modal-actions">
              <button type="button" className="icon-btn danger" disabled={busy} onClick={remove}><TrashIcon /> Remove client</button>
              <button type="button" className="icon-btn" onClick={() => setReplacing(true)}>Replace</button>
              <button type="button" className="icon-btn primary" onClick={onClose}>Done</button>
            </div>
          </>
        )}

        {(replacing || google.clientSource !== "saved") && (
          <>
            <ol className="cal-setup-steps">
              <li>In Google Cloud, create a project and enable the Google Calendar API.</li>
              <li>Set up the consent screen and add yourself as a test user, or publish it.</li>
              <li>Create an OAuth client of type <b>Desktop app</b> and paste its ID and secret here.</li>
            </ol>
            <a className="cal-setup-guide" href={GUIDE_URL} target="_blank" rel="noreferrer"><ExternalIcon /> Step-by-step guide</a>
            <label className="field">
              <span>Client ID</span>
              <input className="search" autoFocus value={clientId} placeholder="…apps.googleusercontent.com" onChange={(e) => setClientId(e.target.value)} />
            </label>
            <label className="field">
              <span>Client secret</span>
              <input className="search" type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
            </label>
            <p className="hint">Both are stored only on this computer, in a file readable by your user account. Replacing a client signs out the accounts connected through the old one.</p>
            {error && <p className="cal-error">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="icon-btn" onClick={google.clientSource === "saved" ? () => setReplacing(false) : onClose}>Cancel</button>
              <button type="submit" className="icon-btn primary" disabled={busy || !clientId.trim() || !clientSecret.trim()}>Save client</button>
            </div>
          </>
        )}
        {!replacing && error && <p className="cal-error">{error}</p>}
      </form>
    </>
  );
}
