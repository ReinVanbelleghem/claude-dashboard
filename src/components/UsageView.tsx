import { useEffect, useState } from "react";
import { api, fmtTokens, fmtUsd, type Overview, type UsagePayload } from "../api.ts";
import { HBars, Sparkline } from "./Charts.tsx";

export function UsageView({ usage }: { usage: UsagePayload | null }) {
  const [overview, setOverview] = useState<Overview | null>(null);

  useEffect(() => {
    api.overview().then(setOverview).catch(() => setOverview(null));
  }, []);

  if (!usage) return <div className="empty">Loading usage…</div>;

  const hourly = usage.hourly.map((h) => {
    const d = new Date(h.bucket * 3_600_000);
    return { label: `${String(d.getHours()).padStart(2, "0")}:00`, value: h.tokens };
  });

  const daily = usage.daily.map((d) => ({
    label: d.day.slice(5),
    value: d.tokens,
    hint: `${d.day}: ${fmtTokens(d.tokens)} fresh tokens over ${d.turns} turns`,
  }));

  const b = usage.allTime;
  const mix = [
    { label: "Cache read", value: b.cacheRead },
    { label: "Cache write", value: b.cacheWrite },
    { label: "Input (uncached)", value: b.input },
    { label: "Output", value: b.output },
  ];

  return (
    <>
      <div className="panel">
        <h2>Fresh tokens per hour, last 24 hours</h2>
        <p className="hint">
          Uncached input, cache writes and output. Cache reads are excluded — they are the same
          context being re-read each turn, bill at a tenth of the input rate, and would flatten
          everything else into the noise.
        </p>
        <Sparkline points={hourly} />
      </div>

      <div className="panel">
        <h2>This window</h2>
        <p className="hint">
          Fresh tokens against your locally configured budget, with the cache traffic behind them.
          Cost is what this traffic would have cost at pay-as-you-go list prices — not what your
          subscription charges, which is flat.
        </p>
        <table>
          <thead>
            <tr>
              <th>Window</th>
              <th className="num">Fresh</th>
              <th className="num">Cache read</th>
              <th className="num">All tokens</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["Last 5 hours", usage.fiveHour],
                ["Today", usage.day],
                ["Last 7 days", usage.week],
                ["All time", usage.allTime],
              ] as const
            ).map(([label, b]) => (
              <tr key={label}>
                <td>{label}</td>
                <td className="num">{fmtTokens(b.fresh)}</td>
                <td className="num" style={{ color: "var(--text-muted)" }}>
                  {fmtTokens(b.cacheRead)}
                </td>
                <td className="num" style={{ color: "var(--text-muted)" }}>
                  {fmtTokens(b.total)}
                </td>
                <td className="num">{fmtUsd(b.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid-2">
        <div className="panel">
          <h2>API-equivalent spend by model, last 7 days</h2>
          <p className="hint">
            What these tokens would cost on pay-as-you-go, at the list prices in your local config.
          </p>
          <HBars
            rows={usage.byModel.map((m) => ({
              label: m.model,
              value: m.costUsd,
              hint: `${m.model}: ${fmtUsd(m.costUsd)} over ${fmtTokens(m.total)} tokens`,
            }))}
            format={fmtUsd}
          />
        </div>

        <div className="panel">
          <h2>Where the tokens go, all time</h2>
          <p className="hint">
            Cache reads usually dominate the count while costing a tenth of the input rate.
          </p>
          <HBars rows={mix} />
        </div>
      </div>

      <div className="panel">
        <h2>Daily fresh tokens, last 30 days</h2>
        <p className="hint">One bar per day you used Claude Code.</p>
        <HBars rows={daily} />
      </div>

      {overview && (
        <div className="grid-2">
          <div className="panel">
            <h2>Projects</h2>
            <p className="hint">{overview.totals.sessions} sessions indexed in total.</p>
            <HBars
              rows={overview.projects.map((p) => ({
                label: p.path.replace(/^\/Users\/[^/]+\//, "~/"),
                value: p.sessions,
                hint: `${p.path}: ${p.sessions} sessions`,
              }))}
              format={(n) => `${n}`}
            />
          </div>
          <div className="panel">
            <h2>Most-used tools</h2>
            <p className="hint">
              {overview.totals.tools.toLocaleString()} tool calls across{" "}
              {overview.totals.prompts.toLocaleString()} prompts.
            </p>
            <HBars
              rows={overview.topTools.slice(0, 10).map((t) => ({
                label: t.name.replace(/^mcp__/, "").replace(/_/g, " "),
                value: t.count,
              }))}
              format={(n) => n.toLocaleString()}
            />
          </div>
        </div>
      )}
    </>
  );
}
