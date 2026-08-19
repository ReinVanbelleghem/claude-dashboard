import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./paths.ts";

/**
 * Per-million-token list prices. Cache reads bill at ~0.1x input, cache writes at
 * 1.25x (5m TTL) or 2x (1h TTL). The transcript reports the two separately under
 * `usage.cache_creation`, so they are priced separately; `cacheWriteMultiplier` is
 * only the fallback for older records that gave a lump sum with no split.
 *
 * These are Anthropic first-party API rates as of 2026-06. Edit config.json to
 * override — the dashboard never phones home to check them.
 */
export type Pricing = { input: number; output: number };

const DEFAULT_PRICING: Record<string, Pricing> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/**
 * Ceilings for the usage gauges, in FRESH tokens, named after the limits Claude
 * shows in `/usage`: a "current session" (a fixed 5-hour window) and two weekly
 * limits, one for all models and a separate one for Fable.
 */
export type Budgets = {
  sessionTokens: number;
  weeklyTokens: number;
  weeklyFableTokens: number;
  dailyCostUsd: number;
};

export type Config = {
  budgets: Budgets;
  /**
   * Any past weekly reset, as an ISO timestamp. The cycle repeats every 7 days from
   * it, which is how Claude meters the weekly limits — read the next reset off
   * `claude /usage` and put it here. Null falls back to a rolling 7-day sum, which
   * runs high because it never drops a whole week at once.
   */
  weeklyResetAnchor: string | null;
  /**
   * Promotional uplift on the weekly limits, e.g. the +50% Claude Code boost. Both
   * weekly budgets are multiplied by it until `until` passes, after which the
   * standard numbers apply again with no code change.
   */
  weeklyBoost: { multiplier: number; until: string } | null;
  pricing: Record<string, Pricing>;
  cacheReadMultiplier: number;
  /** Fallback rate for cache writes whose TTL the transcript didn't record. */
  cacheWriteMultiplier: number;
  cacheWrite5mMultiplier: number;
  cacheWrite1hMultiplier: number;
};

const DEFAULTS: Config = {
  // Calibrated against a Team plan by solving the percentages `claude /usage`
  // reported for the same two windows: a 28% session bar over 1,358,351 fresh tokens
  // implies ~4.85M, and a 36% weekly bar over 18,824,760 implies ~52.3M boosted,
  // i.e. ~34.86M standard. Re-derive yours the same way if the gauges disagree —
  // and derive them from de-duplicated data, or the budgets come out ~1.6x high.
  budgets: {
    sessionTokens: 4_850_000,
    weeklyTokens: 34_860_000,
    weeklyFableTokens: 34_860_000,
    dailyCostUsd: 250,
  },
  weeklyResetAnchor: null,
  weeklyBoost: null,
  pricing: DEFAULT_PRICING,
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
  cacheWrite5mMultiplier: 1.25,
  cacheWrite1hMultiplier: 2,
};

const CONFIG_PATH = join(DATA_DIR, "config.json");

/** `fiveHourTokens` was the old name for what Claude calls the current session. */
function migrateBudgets(b: (Partial<Budgets> & { fiveHourTokens?: number }) | undefined) {
  if (!b) return {};
  const { fiveHourTokens, ...rest } = b;
  return fiveHourTokens !== undefined && rest.sessionTokens === undefined
    ? { ...rest, sessionTokens: fiveHourTokens }
    : rest;
}

/**
 * Budgets with any live promotional boost folded in. Only the weekly limits are
 * boosted; the session limit and the cost ceiling are untouched.
 */
export function effectiveBudgets(cfg: Config, now: number): Budgets {
  const boost = cfg.weeklyBoost;
  if (!boost) return cfg.budgets;
  const until = Date.parse(boost.until);
  if (Number.isNaN(until) || now > until) return cfg.budgets;
  return {
    ...cfg.budgets,
    weeklyTokens: cfg.budgets.weeklyTokens * boost.multiplier,
    weeklyFableTokens: cfg.budgets.weeklyFableTokens * boost.multiplier,
  };
}

/** Claude meters Fable against its own weekly limit, separate from all models. */
export function isFableModel(model: string | null | undefined): boolean {
  return /fable|mythos/i.test(normalizeModel(model));
}

export function loadConfig(): Config {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2));
    return DEFAULTS;
  }
  try {
    const user = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
    return {
      ...DEFAULTS,
      ...user,
      budgets: { ...DEFAULTS.budgets, ...migrateBudgets(user.budgets) },
      pricing: { ...DEFAULTS.pricing, ...(user.pricing ?? {}) },
    };
  } catch {
    return DEFAULTS;
  }
}

/** Strip a [1m]-style context suffix so `claude-opus-5[1m]` prices as `claude-opus-5`. */
export function normalizeModel(model: string | null | undefined): string {
  if (!model) return "unknown";
  return model.replace(/\[.*\]$/, "").trim();
}

export type TokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  /** Total cache writes, including whatever the 5m/1h fields already account for. */
  cacheWrite: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
};

/**
 * Find the price for a model id. Transcripts carry dated ids like
 * `claude-haiku-4-5-20251001` and bare aliases like `haiku`, neither of which is a
 * table key — an exact-match lookup silently priced both at zero. Fall back to the
 * longest table key the id starts with, then to any key containing the alias.
 */
export function priceOf(model: string, cfg: Config): Pricing | null {
  const m = normalizeModel(model);
  const exact = cfg.pricing[m];
  if (exact) return exact;
  const keys = Object.keys(cfg.pricing).sort((a, b) => b.length - a.length);
  const prefixed = keys.find((k) => m.startsWith(k));
  if (prefixed) return cfg.pricing[prefixed]!;
  const alias = keys.find((k) => k.includes(m));
  return alias ? cfg.pricing[alias]! : null;
}

export function costOf(model: string, t: TokenCounts, cfg: Config): number {
  const p = priceOf(model, cfg);
  if (!p) return 0;
  const perM = 1_000_000;
  const split5m = t.cacheWrite5m ?? 0;
  const split1h = t.cacheWrite1h ?? 0;
  // Records that predate `usage.cache_creation` report only the lump sum; price
  // whatever the split didn't cover at the blended fallback rate.
  const unsplit = Math.max(0, t.cacheWrite - split5m - split1h);
  return (
    (t.input / perM) * p.input +
    (t.output / perM) * p.output +
    (t.cacheRead / perM) * p.input * cfg.cacheReadMultiplier +
    (split5m / perM) * p.input * cfg.cacheWrite5mMultiplier +
    (split1h / perM) * p.input * cfg.cacheWrite1hMultiplier +
    (unsplit / perM) * p.input * cfg.cacheWriteMultiplier
  );
}
