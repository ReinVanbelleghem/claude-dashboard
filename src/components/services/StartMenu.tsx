import { useState } from "react";
import { servicesApi } from "../../api.ts";
import type { CheckoutView, ServiceView } from "../../../shared/services.ts";
import { GitIcon } from "../Icons.tsx";

/**
 * Pick the checkout to start in.
 *
 * The service is already chosen by the row the button sits in, so this is one
 * decision: which checkout, with the ones that cannot work called out rather than
 * silently failing on start.
 */
export function StartMenu({
  service,
  onClose,
  onStarted,
  onOpenRunning,
}: {
  service: ServiceView;
  onClose: () => void;
  onStarted: (session: string) => void;
  onOpenRunning: (session: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(c: CheckoutView) {
    if (c.running) return onOpenRunning(c.session);
    if (c.missing.length) return setError(`${c.label} is missing ${c.missing.join(", ")}`);
    setBusy(c.path);
    setError(null);
    try {
      const r = await servicesApi.start(service.key, c.path);
      if (r.ok && r.session) onStarted(r.session);
      else setError([r.error, ...(r.missing ?? [])].filter(Boolean).join(" · ") || "could not start");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="svc-scrim" onClick={onClose} role="dialog" aria-modal="true" aria-label={`Start ${service.label}`}>
      <div className="svc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="svc-modal-head">
          <strong>Start {service.label}</strong>
          <span className="hint">Which checkout?</span>
        </div>
        {error && <div className="chat-error">{error}</div>}
        <div className="svc-pick">
          {service.checkouts.length === 0 && (
            <p className="hint">
              No checkout found for the {service.repo} repository. Check its path under Settings → Services.
            </p>
          )}
          {service.checkouts.map((c) => (
            <button
              key={c.path}
              className={`svc-pick-item ${c.missing.length ? "blocked" : ""}`}
              disabled={busy !== null}
              onClick={() => void start(c)}
            >
              <span className="svc-pick-label">
                <span className={`svc-pick-branch ${c.branch === "not a checkout" ? "warn" : ""}`}>
                  <GitIcon />
                  <span className="mono">{c.branch === undefined ? c.label : (c.branch ?? "detached")}</span>
                </span>
                {c.main && <span className="svc-tag">main checkout</span>}
                {c.running && <span className="svc-tag on">running — open it</span>}
              </span>
              <span className="svc-pick-path mono">{c.path}</span>
              {c.missing.length > 0 && <span className="svc-pick-missing">missing: {c.missing.join(", ")}</span>}
            </button>
          ))}
        </div>
        <div className="svc-modal-foot">
          <button className="icon-btn tiny" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
