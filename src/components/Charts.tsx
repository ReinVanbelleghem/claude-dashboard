import { useState } from "react";
import { fmtTokens } from "../api.ts";

/** Budget meter. Colour is state, not identity: blue → warning → critical. */
export function Meter({ pct }: { pct: number }) {
  const cls = pct >= 100 ? "over" : pct >= 80 ? "warn" : "";
  return (
    <div className={`meter ${cls}`} role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

export function Tile({
  label,
  value,
  sub,
  pct,
  note,
}: {
  label: string;
  value: string;
  sub?: string;
  pct?: number;
  note?: [string, string];
}) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
      {pct !== undefined && <Meter pct={pct} />}
      {note && (
        <div className="meter-note">
          <span>{note[0]}</span>
          <span>{note[1]}</span>
        </div>
      )}
    </div>
  );
}

type Point = { label: string; value: number };

/**
 * Single-series area+line over time. One series, so no legend — the panel title
 * names it. Crosshair + tooltip on hover, per the interaction spec.
 */
export function Sparkline({ points, height = 92 }: { points: Point[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) return <div className="empty">No activity in this window.</div>;

  const w = 1000;
  const h = height;
  const pad = 6;
  const max = Math.max(...points.map((p) => p.value), 1);
  const stepX = points.length === 1 ? 0 : (w - pad * 2) / (points.length - 1);
  const x = (i: number) => (points.length === 1 ? w / 2 : pad + i * stepX);
  const y = (v: number) => h - pad - (v / max) * (h - pad * 2);

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`;

  return (
    <div style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height, display: "block" }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const rel = ((e.clientX - r.left) / r.width) * w;
          let best = 0;
          for (let i = 1; i < points.length; i++) {
            if (Math.abs(x(i) - rel) < Math.abs(x(best) - rel)) best = i;
          }
          setHover(best);
        }}
      >
        <defs>
          <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--series-1)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="var(--series-1)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#sparkFill)" />
        <path
          d={line}
          fill="none"
          stroke="var(--series-1)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {hover !== null && (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={pad}
              y2={h - pad}
              stroke="var(--border-strong)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            {/* 2px surface ring keeps the marker readable over the fill. */}
            <circle
              cx={x(hover)}
              cy={y(points[hover].value)}
              r="4.5"
              fill="var(--series-1)"
              stroke="var(--surface-1)"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>
      {hover !== null && (
        <div
          style={{
            position: "absolute",
            left: `${(x(hover) / w) * 100}%`,
            top: -4,
            transform: `translate(${hover > points.length / 2 ? "-105%" : "5%"}, -100%)`,
            background: "var(--surface-2)",
            border: "1px solid var(--border-strong)",
            borderRadius: 7,
            padding: "5px 9px",
            fontSize: 12,
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          <strong style={{ fontFamily: "var(--mono)" }}>{fmtTokens(points[hover].value)}</strong>
          <span style={{ color: "var(--text-muted)" }}> · {points[hover].label}</span>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, font: "500 11px/1 var(--mono)", color: "var(--text-muted)" }}>
        <span>{points[0].label}</span>
        <span>peak {fmtTokens(max)}</span>
        <span>{points[points.length - 1].label}</span>
      </div>
    </div>
  );
}

/** Horizontal magnitude bars: one hue, length carries the value. */
export function HBars({
  rows,
  format = fmtTokens,
}: {
  rows: { label: string; value: number; hint?: string }[];
  format?: (n: number) => string;
}) {
  if (rows.length === 0) return <div className="empty">Nothing recorded yet.</div>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="hbars">
      {rows.map((r) => (
        <div className="hbar" key={r.label} title={r.hint ?? `${r.label}: ${format(r.value)}`}>
          <span className="hb-label">{r.label}</span>
          <span className="hb-value">{format(r.value)}</span>
          <span className="hb-track">
            <span className="hb-fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}
