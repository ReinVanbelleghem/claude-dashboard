import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { AgentMeter, PlanLimit } from "../api.ts";

const ENTER_MS = 500;
const STAGGER_MS = 80;
const SWEEP_AT_MS = ENTER_MS * 0.6;
const UP_MS = 700;
const HOLD_MS = 120;
const DOWN_MS = 800;
const INTRO_MS = SWEEP_AT_MS + 2 * STAGGER_MS + UP_MS + HOLD_MS + DOWN_MS;

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const springOut = (t: number, bounce = 1.15) => 1 + (bounce + 1) * Math.pow(t - 1, 3) + bounce * Math.pow(t - 1, 2);

function sweep(t: number, target: number): number {
  let value = target;
  if (t <= 0) value = 0;
  else if (t < UP_MS) value = 100 * easeOutCubic(t / UP_MS);
  else if (t < UP_MS + HOLD_MS) value = 100;
  else if (t < UP_MS + HOLD_MS + DOWN_MS) value = 100 + (target - 100) * springOut((t - UP_MS - HOLD_MS) / DOWN_MS);
  return Math.min(100, Math.max(0, value));
}

function level(pct: number) {
  return pct >= 95 ? "over" : pct >= 80 ? "warn" : "";
}

function untilReset(at: number, now: number) {
  const min = Math.max(0, Math.round((at - now) / 60_000));
  if (min >= 24 * 60) return `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`;
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
}

function kTokens(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function millions(n: number) {
  return `${+(n / 1_000_000).toFixed(n >= 1_000_000 ? 1 : 2)}M`;
}

function useIntro(ready: boolean, ref: React.RefObject<HTMLElement | null>): number | null {
  const [elapsed, setElapsed] = useState<number | null>(null);
  const played = useRef(false);
  const running = elapsed !== null;

  useLayoutEffect(() => {
    if (!ready || played.current) return;
    played.current = true;
    const el = ref.current;
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || document.hidden || !el || el.getClientRects().length === 0) return;
    setElapsed(0);
  }, [ready, ref]);

  useEffect(() => {
    if (!running) return;
    const start = performance.now();
    let frame = requestAnimationFrame(function tick() {
      const t = performance.now() - start;
      if (t >= INTRO_MS) return setElapsed(null);
      setElapsed(t);
      frame = requestAnimationFrame(tick);
    });
    const stop = () => {
      if (!document.hidden) return;
      cancelAnimationFrame(frame);
      setElapsed(null);
    };
    document.addEventListener("visibilitychange", stop);
    return () => {
      document.removeEventListener("visibilitychange", stop);
      cancelAnimationFrame(frame);
    };
  }, [running]);

  return elapsed;
}

type RingIntro = { index: number; t: number };

export function UsageRings({ meter, compact = false }: { meter: AgentMeter; compact?: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const { context, fiveHour, sevenDay } = meter;
  const ready = !!(context || fiveHour || sevenDay);
  const ref = useRef<HTMLDivElement>(null);
  const elapsed = useIntro(ready, ref);
  if (!ready) return null;

  let next = 0;
  const step = (): RingIntro | undefined => {
    const index = next++;
    return elapsed === null ? undefined : { index, t: elapsed - SWEEP_AT_MS - index * STAGGER_MS };
  };
  const contextIntro = context ? step() : undefined;
  const fiveIntro = fiveHour ? step() : undefined;
  const sevenIntro = sevenDay ? step() : undefined;

  return (
    <div ref={ref} className={`usage-rings ${compact ? "compact" : ""} ${elapsed !== null ? "intro" : ""}`.trim()}>
      {context && (
        <Ring
          intro={contextIntro}
          compact={compact}
          pct={context.pct}
          label="ctx"
          sub={`of ${millions(context.max)}`}
          tip={[`Context of this session: ${Math.round(context.pct)}% used`, `${kTokens(context.tokens)} of ${kTokens(context.max)} tokens`]}
        />
      )}
      {!compact && context && (fiveHour || sevenDay) && <span className="usage-rings-sep" aria-hidden />}
      {fiveHour && <LimitRing intro={fiveIntro} compact={compact} limit={fiveHour} label="5h" name="5-hour limit" windowMin={300} now={now} />}
      {sevenDay && <LimitRing intro={sevenIntro} compact={compact} limit={sevenDay} label="7d" name="Weekly limit" windowMin={7 * 24 * 60} now={now} />}
    </div>
  );
}

function LimitRing({
  intro,
  compact,
  limit,
  label,
  name,
  windowMin,
  now,
}: {
  intro?: RingIntro;
  compact: boolean;
  limit: PlanLimit;
  label: string;
  name: string;
  windowMin: number;
  now: number;
}) {
  const minutesLeft = limit.resetsAt ? Math.max(0, (limit.resetsAt - now) / 60_000) : null;
  const windowElapsed = minutesLeft === null ? null : Math.min(1, Math.max(0, 1 - minutesLeft / windowMin));
  const ahead = windowElapsed !== null && limit.pct / 100 > windowElapsed + 0.02;
  const paceLines =
    windowElapsed === null
      ? []
      : [
          ahead ? "Faster than the clock: at this rate you hit the limit before the reset" : "On pace: it lasts until the reset",
          `The tick marks how much of the ${label} window has gone by (${Math.round(windowElapsed * 100)}%)`,
        ];
  return (
    <Ring
      intro={intro}
      compact={compact}
      ahead={ahead}
      pct={limit.pct}
      label={label}
      sub={limit.resetsAt ? `${untilReset(limit.resetsAt, now).replace(/\s+/g, "")} left` : undefined}
      pace={windowElapsed}
      tip={[
        `${name}: ${Math.round(limit.pct)}% used (all sessions)`,
        ...(limit.resetsAt ? [`Resets in ${untilReset(limit.resetsAt, now)}`] : []),
        ...paceLines,
      ]}
    />
  );
}

function paceTick(pace: number, size: number, radius: number, reach: number) {
  const angle = pace * 2 * Math.PI;
  const center = size / 2;
  return {
    x1: center + (radius - reach) * Math.cos(angle),
    y1: center + (radius - reach) * Math.sin(angle),
    x2: center + (radius + reach) * Math.cos(angle),
    y2: center + (radius + reach) * Math.sin(angle),
  };
}

function Ring({
  intro,
  compact,
  ahead = false,
  pct,
  label,
  sub,
  pace,
  tip,
}: {
  intro?: RingIntro;
  compact: boolean;
  ahead?: boolean;
  pct: number;
  label: string;
  sub?: string;
  pace?: number | null;
  tip: string[];
}) {
  const size = compact ? 15 : 26;
  const stroke = compact ? 2 : 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const real = Math.min(100, Math.max(0, pct));
  const value = intro ? sweep(intro.t, real) : real;
  const paceAt = pace != null && intro ? sweep(intro.t, pace * 100) / 100 : pace;
  const tick = paceAt != null && (!compact || ahead) ? paceTick(paceAt, size, radius, compact ? 2 : 3.5) : null;
  return (
    <span
      className={`ur-ring ${level(pct)} ${intro ? "enter" : ""}`.trim()}
      style={intro ? ({ "--ur-i": intro.index } as CSSProperties) : undefined}
      tabIndex={0}
      aria-label={tip.join(". ")}
    >
      <span className="ur-dial">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
          <circle className="ur-track" cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} />
          <circle
            className="ur-fill"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            strokeDasharray={`${(circumference * value) / 100} ${circumference}`}
          />
          {tick && <line className="ur-pace" {...tick} strokeWidth={compact ? 1.2 : 1.6} />}
        </svg>
        {!compact && <span className="ur-num">{Math.round(value)}</span>}
      </span>
      {!compact && (
        <span className="ur-label">
          <b>{label}</b>
          {sub && <span>{sub}</span>}
        </span>
      )}
      <span className="ur-tip" role="tooltip">
        {tip.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </span>
    </span>
  );
}
