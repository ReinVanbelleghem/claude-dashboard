import type { Database } from "bun:sqlite";
import {
  costOf,
  effectiveBudgets,
  isFableModel,
  normalizeModel,
  type Config,
} from "./config.ts";

const HOUR = 3_600_000;
const SESSION_MS = 5 * HOUR;
const WEEK_MS = 7 * 24 * HOUR;

export type Window = { start: number; end: number; resetsInMs: number };

export type Bucket = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Every component summed. Dominated by cache reads, so poor for budgets. */
  total: number;
  /**
   * Tokens the model actually processed for the first time: uncached input, cache
   * writes, and output. Cache reads are excluded — re-reading a cached prompt is
   * billed at a tenth of the input rate and would otherwise swamp the figure
   * (typically ~97% of raw volume), making every gauge read as maxed out.
   */
  fresh: number;
  costUsd: number;
};

const EMPTY = (): Bucket => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  fresh: 0,
  costUsd: 0,
});

type Row = {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  cache_write_5m: number;
  cache_write_1h: number;
};

const COLS = `model, input_tokens, output_tokens, cache_read, cache_write,
              cache_write_5m, cache_write_1h`;

function fold(rows: Row[], cfg: Config): Bucket {
  const b = EMPTY();
  for (const r of rows) {
    b.input += r.input_tokens;
    b.output += r.output_tokens;
    b.cacheRead += r.cache_read;
    b.cacheWrite += r.cache_write;
    b.costUsd += costOf(r.model ?? "", {
      input: r.input_tokens,
      output: r.output_tokens,
      cacheRead: r.cache_read,
      cacheWrite: r.cache_write,
      cacheWrite5m: r.cache_write_5m,
      cacheWrite1h: r.cache_write_1h,
    }, cfg);
  }
  b.total = b.input + b.output + b.cacheRead + b.cacheWrite;
  b.fresh = b.input + b.output + b.cacheWrite;
  return b;
}

/**
 * The window Claude labels "current session". It is a fixed 5 hours anchored on the
 * first message after an idle gap, not a rolling sum of the last 5 hours — the two
 * differ sharply, because an anchored window drops its whole total at the reset
 * while a rolling one keeps bleeding old traffic in.
 *
 * Anchors are found by walking events forward: the first one opens a window, and the
 * first event at or after that window closes opens the next. Starting the walk mid
 * history could pick the wrong phase, so it starts a month back — any idle gap of 5
 * hours in that span resynchronises it, and a month without one is not a real
 * usage pattern.
 */
export function sessionWindow(db: Database, now: number): Window {
  // Bounded at both ends: an event later than `now` cannot have opened the window
  // `now` falls in, and leaving it out keeps the answer reproducible for any past
  // instant rather than only the present one.
  const rows = db
    .query<{ ts: number }, [number, number]>(
      "SELECT ts FROM usage_events WHERE ts >= ? AND ts <= ? ORDER BY ts",
    )
    .all(now - 30 * 24 * HOUR, now);
  let anchor = rows.length > 0 ? rows[0]!.ts : now;
  for (const r of rows) if (r.ts - anchor >= SESSION_MS) anchor = r.ts;
  // An anchor older than the window length means the last session already expired
  // and the next message will start a fresh one.
  if (now - anchor >= SESSION_MS) anchor = now;
  return { start: anchor, end: anchor + SESSION_MS, resetsInMs: anchor + SESSION_MS - now };
}

/**
 * The weekly window, derived from a known past reset by stepping forward in 7-day
 * strides. Without a configured anchor there is nothing to phase-align to, so this
 * degrades to a rolling week and says so via `resetsInMs: -1`.
 */
export function weeklyWindow(cfg: Config, now: number): Window {
  const anchorIso = cfg.weeklyResetAnchor;
  const anchor = anchorIso ? Date.parse(anchorIso) : Number.NaN;
  if (Number.isNaN(anchor)) {
    return { start: now - WEEK_MS, end: now, resetsInMs: -1 };
  }
  const elapsed = now - anchor;
  const start = anchor + Math.floor(elapsed / WEEK_MS) * WEEK_MS;
  return { start, end: start + WEEK_MS, resetsInMs: start + WEEK_MS - now };
}

function since(db: Database, fromMs: number): Row[] {
  return db
    .query<Row, [number]>(
      `SELECT ${COLS} FROM usage_events WHERE ts >= ?`,
    )
    .all(fromMs);
}

/**
 * Usage booked in a window so far. The upper bound is clamped to `now` because a
 * window extends into the future — the question is always how much of the limit is
 * spent at this instant, not how much the window will eventually hold.
 */
function usedInWindow(db: Database, w: Window, now: number): Row[] {
  return db
    .query<Row, [number, number]>(
      `SELECT ${COLS} FROM usage_events WHERE ts >= ? AND ts < ?`,
    )
    .all(w.start, Math.min(w.end, now));
}

/**
 * What one session cost, and how much of its prompt it got for free.
 *
 * Spend is otherwise only ever aggregated — the Usage tab knows the week and the
 * day, but never which session that was. A session's events span its own transcript
 * plus one file per subagent, and they are all keyed by session_id here, so a
 * session that spawned ten subagents reports what the whole tree cost.
 */
export function sessionReceipt(db: Database, cfg: Config, id: string) {
  const rows = db
    .query<Row, [string]>(`SELECT ${COLS} FROM usage_events WHERE session_id = ?`)
    .all(id);
  if (rows.length === 0) return null;
  const totals = fold(rows, cfg);
  const byModelRows = db
    .query<Row & { model: string | null; n: number }, [string]>(
      `SELECT model, COUNT(*) AS n, SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens, SUM(cache_read) AS cache_read,
              SUM(cache_write) AS cache_write, SUM(cache_write_5m) AS cache_write_5m,
              SUM(cache_write_1h) AS cache_write_1h
         FROM usage_events WHERE session_id = ? GROUP BY model`,
    )
    .all(id);
  const span = db
    .query<{ first: number | null; last: number | null }, [string]>(
      "SELECT MIN(ts) AS first, MAX(ts) AS last FROM usage_events WHERE session_id = ?",
    )
    .get(id);
  // Share of the prompt that came out of the cache. Reads are billed at a tenth of
  // the input rate, so this is the single number that explains a long session
  // costing less than its token count suggests.
  const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
  return {
    requests: rows.length,
    ...totals,
    cachedPct: prompt > 0 ? (totals.cacheRead / prompt) * 100 : 0,
    firstTs: span?.first ?? null,
    lastTs: span?.last ?? null,
    byModel: byModelRows
      .map((r) => ({ model: normalizeModel(r.model), requests: r.n, ...fold([r], cfg) }))
      .sort((a, b) => b.costUsd - a.costUsd),
  };
}

/**
 * The priciest sessions in a window, which is how a runaway loop is found after the
 * fact — the gauges show that the week went badly, not which session did it.
 */
function topSessions(db: Database, cfg: Config, since: number, limit = 8) {
  const rows = db
    .query<Row & { session_id: string; n: number }, [number]>(
      `SELECT session_id, model, COUNT(*) AS n, SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens, SUM(cache_read) AS cache_read,
              SUM(cache_write) AS cache_write, SUM(cache_write_5m) AS cache_write_5m,
              SUM(cache_write_1h) AS cache_write_1h
         FROM usage_events WHERE ts >= ? GROUP BY session_id, model`,
    )
    .all(since);
  const per = new Map<string, { costUsd: number; fresh: number; requests: number }>();
  for (const r of rows) {
    const b = fold([r], cfg);
    const cur = per.get(r.session_id) ?? { costUsd: 0, fresh: 0, requests: 0 };
    cur.costUsd += b.costUsd;
    cur.fresh += b.fresh;
    cur.requests += r.n;
    per.set(r.session_id, cur);
  }
  const top = [...per.entries()]
    .sort((a, b) => b[1].costUsd - a[1].costUsd)
    .slice(0, limit);
  if (top.length === 0) return [];
  const holes = top.map(() => "?").join(",");
  const meta = new Map(
    db
      .query<{ id: string; title: string | null; cwd: string | null }, string[]>(
        `SELECT id, title, cwd FROM sessions WHERE id IN (${holes})`,
      )
      .all(...top.map(([id]) => id))
      .map((r) => [r.id, r]),
  );
  return top.map(([id, v]) => ({
    id,
    title: meta.get(id)?.title ?? null,
    cwd: meta.get(id)?.cwd ?? null,
    ...v,
  }));
}

export function usageSummary(db: Database, cfg: Config, now: number) {
  const hour = HOUR;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const budgets = effectiveBudgets(cfg, now);
  const sessionWin = sessionWindow(db, now);
  const weeklyWin = weeklyWindow(cfg, now);

  const session = fold(usedInWindow(db, sessionWin, now), cfg);
  const day = fold(since(db, startOfToday.getTime()), cfg);
  // Claude meters Fable against its own weekly limit, so it is both counted in the
  // all-models total and reported separately.
  const weeklyRows = usedInWindow(db, weeklyWin, now);
  const week = fold(weeklyRows, cfg);
  const weekFable = fold(weeklyRows.filter((r) => isFableModel(r.model)), cfg);
  const allTime = fold(
    db
      .query<Row, []>(
        `SELECT ${COLS} FROM usage_events`,
      )
      .all(),
    cfg,
  );

  // Per-model split over the last 7 days — enough to see what you actually run.
  const byModelRows = db
    .query<Row & { model: string | null }, [number]>(
      `SELECT model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
              SUM(cache_write_5m) AS cache_write_5m, SUM(cache_write_1h) AS cache_write_1h
         FROM usage_events WHERE ts >= ? GROUP BY model`,
    )
    .all(now - 7 * 24 * hour);
  const byModel = byModelRows
    .map((r) => ({ model: normalizeModel(r.model), ...fold([r], cfg) }))
    .sort((a, b) => b.costUsd - a.costUsd);

  // Charts plot fresh tokens for the same reason the gauges do: a cache-read line
  // is just a picture of how big the context is, not of how hard you worked.
  const hourly = db
    .query<{ bucket: number; tokens: number }, [number]>(
      `SELECT (ts / 3600000) AS bucket,
              SUM(input_tokens + output_tokens + cache_write) AS tokens
         FROM usage_events WHERE ts >= ? GROUP BY bucket ORDER BY bucket`,
    )
    .all(now - 24 * hour);

  const daily = db
    .query<{ day: string; tokens: number; turns: number }, [number]>(
      `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day,
              SUM(input_tokens + output_tokens + cache_write) AS tokens,
              COUNT(*) AS turns
         FROM usage_events WHERE ts >= ? GROUP BY day ORDER BY day`,
    )
    .all(now - 30 * 24 * hour);

  return {
    now,
    budgets,
    boostActive: budgets.weeklyTokens !== cfg.budgets.weeklyTokens,
    session,
    sessionWindow: sessionWin,
    weeklyWindow: weeklyWin,
    day,
    week,
    weekFable,
    allTime,
    byModel,
    topSessions: topSessions(db, cfg, now - 7 * 24 * hour),
    hourly,
    daily,
    // Fractions of the configured budget. Anthropic does not publish the real
    // quotas, so these are calibrated locally against what `claude /usage` reports
    // for the same windows — see config.ts.
    remaining: {
      sessionPct: pct(session.fresh, budgets.sessionTokens),
      weeklyPct: pct(week.fresh, budgets.weeklyTokens),
      weeklyFablePct: pct(weekFable.fresh, budgets.weeklyFableTokens),
      dailyCostPct: pct(day.costUsd, budgets.dailyCostUsd),
    },
  };
}

function pct(used: number, budget: number): number {
  if (!budget || budget <= 0) return 0;
  return Math.min(100, (used / budget) * 100);
}
