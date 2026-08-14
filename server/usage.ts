import type { Database } from "bun:sqlite";
import { costOf, normalizeModel, type Config } from "./config.ts";

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
};

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
    }, cfg);
  }
  b.total = b.input + b.output + b.cacheRead + b.cacheWrite;
  b.fresh = b.input + b.output + b.cacheWrite;
  return b;
}

function since(db: Database, fromMs: number): Row[] {
  return db
    .query<Row, [number]>(
      `SELECT model, input_tokens, output_tokens, cache_read, cache_write
         FROM usage_events WHERE ts >= ?`,
    )
    .all(fromMs);
}

export function usageSummary(db: Database, cfg: Config, now: number) {
  const hour = 3_600_000;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const fiveHour = fold(since(db, now - 5 * hour), cfg);
  const day = fold(since(db, startOfToday.getTime()), cfg);
  const week = fold(since(db, now - 7 * 24 * hour), cfg);
  const allTime = fold(
    db
      .query<Row, []>(
        "SELECT model, input_tokens, output_tokens, cache_read, cache_write FROM usage_events",
      )
      .all(),
    cfg,
  );

  // Per-model split over the last 7 days — enough to see what you actually run.
  const byModelRows = db
    .query<Row & { model: string | null }, [number]>(
      `SELECT model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write
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
    budgets: cfg.budgets,
    fiveHour,
    day,
    week,
    allTime,
    byModel,
    hourly,
    daily,
    // Fractions of the configured budget — see README on why these are local,
    // user-set numbers rather than your real subscription quota.
    remaining: {
      fiveHourPct: pct(fiveHour.fresh, cfg.budgets.fiveHourTokens),
      weeklyPct: pct(week.fresh, cfg.budgets.weeklyTokens),
      dailyCostPct: pct(day.costUsd, cfg.budgets.dailyCostUsd),
    },
  };
}

function pct(used: number, budget: number): number {
  if (!budget || budget <= 0) return 0;
  return Math.min(100, (used / budget) * 100);
}
