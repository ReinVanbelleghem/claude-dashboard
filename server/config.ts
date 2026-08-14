import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./paths.ts";

/**
 * Per-million-token list prices. Cache reads bill at ~0.1x input, cache writes at
 * 1.25x (5m TTL) or 2x (1h TTL) — we can't tell the TTL apart reliably from the
 * transcript, so `cacheWriteMultiplier` is a single blended knob you can tune.
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

export type Config = {
  /**
   * Ceilings for the "how much is left" gauges, counted in FRESH tokens (uncached
   * input + cache writes + output; cache reads excluded — see usage.ts).
   *
   * Your real subscription quota is not published in a form we can read, so these
   * are local guesses. The defaults were calibrated by comparing this dashboard
   * against Claude Code's own reported window utilisation on one machine; tune
   * them until the gauges agree with `/usage`.
   */
  budgets: { fiveHourTokens: number; weeklyTokens: number; dailyCostUsd: number };
  pricing: Record<string, Pricing>;
  cacheReadMultiplier: number;
  cacheWriteMultiplier: number;
};

const DEFAULTS: Config = {
  budgets: { fiveHourTokens: 35_000_000, weeklyTokens: 700_000_000, dailyCostUsd: 250 },
  pricing: DEFAULT_PRICING,
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
};

const CONFIG_PATH = join(DATA_DIR, "config.json");

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
      budgets: { ...DEFAULTS.budgets, ...(user.budgets ?? {}) },
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
  cacheWrite: number;
};

export function costOf(model: string, t: TokenCounts, cfg: Config): number {
  const p = cfg.pricing[normalizeModel(model)];
  if (!p) return 0;
  const perM = 1_000_000;
  return (
    (t.input / perM) * p.input +
    (t.output / perM) * p.output +
    (t.cacheRead / perM) * p.input * cfg.cacheReadMultiplier +
    (t.cacheWrite / perM) * p.input * cfg.cacheWriteMultiplier
  );
}
