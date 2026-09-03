import { fmtDuration, fmtTokens, fmtUsd, type SessionReceipt } from "../api.ts";

/**
 * What one session cost.
 *
 * Deliberately not just a cost: the number on its own invites the wrong conclusion.
 * Requests says whether it was one long turn or two hundred, cached says how much of
 * the prompt was free, and the model split says which of them spent it — a Haiku
 * session and an Opus session with the same token count differ by an order of
 * magnitude.
 */
export function Receipt({ receipt }: { receipt: SessionReceipt }) {
  const span =
    receipt.firstTs && receipt.lastTs && receipt.lastTs > receipt.firstTs
      ? fmtDuration(receipt.lastTs - receipt.firstTs)
      : null;
  return (
    <div className="panel">
      <h2>What this session cost</h2>
      <div className="receipt">
        <div className="receipt-total">
          <span className="receipt-usd">{fmtUsd(receipt.costUsd)}</span>
          <span className="receipt-cap">API-equivalent</span>
        </div>
        <div className="receipt-stats">
          <Stat label="requests" value={String(receipt.requests)} />
          <Stat label="fresh tokens" value={fmtTokens(receipt.fresh)} />
          <Stat
            label="from cache"
            value={`${Math.round(receipt.cachedPct)}%`}
            title="Share of the prompt served from the cache, billed at a fraction of the input rate"
          />
          {span && <Stat label="span" value={span} />}
        </div>
      </div>
      {/* Only when it is actually a mix: one row restating the total is noise. */}
      {receipt.byModel.length > 1 && (
        <div className="receipt-models">
          {receipt.byModel.map((m) => (
            <div key={m.model} className="receipt-model">
              <span className="receipt-model-name">{m.model}</span>
              <span className="receipt-model-bar">
                <i
                  style={{
                    width: `${receipt.costUsd > 0 ? (m.costUsd / receipt.costUsd) * 100 : 0}%`,
                  }}
                />
              </span>
              <span className="receipt-model-req">{m.requests}×</span>
              <span className="receipt-model-usd">{fmtUsd(m.costUsd)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="receipt-stat" title={title}>
      <span className="receipt-stat-v">{value}</span>
      <span className="receipt-stat-l">{label}</span>
    </div>
  );
}
