import { useEffect, useState } from "react";
import { api, fmtResets, fmtTokens, fmtUsd, type Overview, type UsagePayload } from "../api.ts";
import { HBars, Sparkline } from "./Charts.tsx";

/**
 * One bar per codebase, not per directory.
 *
 * A worktree has its own cwd, so without this a repository worked on across three
 * checkouts contributes three bars that each look like a separate project — and none of
 * them shows the real total. `repos` carries the grouping, so its members collapse into
 * one row and everything else is passed through untouched.
 */
function projectRows(overview: Overview) {
  const tilde = (p: string) => p.replace(/^\/Users\/[^/]+\//, "~/");
  /**
   * A project is already covered when its checkout is one of a grouped repository's.
   * Matched on worktree_root rather than path, since several cwds share one checkout.
   */
  const grouped = new Set(overview.repos.flatMap((r) => r.checkouts.map((c) => c.path)));

  const rows = overview.projects
    .filter((p) => !p.worktree_root || !grouped.has(p.worktree_root))
    .map((p) => ({
      label: tilde(p.path),
      value: p.sessions,
      hint: `${p.path}: ${p.sessions} sessions`,
    }));

  for (const r of overview.repos) {
    rows.push({
      label: `${r.name} (${r.checkouts.length} checkouts)`,
      value: r.sessions,
      hint: r.checkouts
        .map((c) => `${tilde(c.path)}: ${c.sessions}`)
        .join("\n"),
    });
  }

  return rows.sort((a, b) => b.value - a.value);
}

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
        <h2>Your usage limits</h2>
        <p className="hint">
          Named to match <code>claude /usage</code>. The current session is a fixed five-hour
          window anchored on its first message, and the weekly limits run on their own seven-day
          cycle — neither is a rolling sum, so both drop to zero at their reset. Fable is metered
          against a separate weekly limit. Cost is what the traffic would have cost at
          pay-as-you-go list prices, not what your subscription charges, which is flat.
        </p>
        <table>
          <thead>
            <tr>
              <th>Limit</th>
              <th>Resets</th>
              <th className="num">Fresh</th>
              <th className="num">Cache read</th>
              <th className="num">All tokens</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["Current session", usage.session, usage.sessionWindow.resetsInMs],
                ["Weekly · all models", usage.week, usage.weeklyWindow.resetsInMs],
                ["Weekly · Fable", usage.weekFable, usage.weeklyWindow.resetsInMs],
                ["Today", usage.day, null],
                ["All time", usage.allTime, null],
              ] as const
            ).map(([label, b, resetsInMs]) => (
              <tr key={label}>
                <td>{label}</td>
                <td style={{ color: "var(--text-muted)" }}>
                  {resetsInMs === null ? "—" : fmtResets(resetsInMs)}
                </td>
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
            <p className="hint">
              {overview.totals.sessions} sessions indexed in total.
              {overview.repos.length > 0 &&
                ` Worktrees are counted under the repository they belong to.`}
            </p>
            <HBars rows={projectRows(overview)} format={(n) => `${n}`} />
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
