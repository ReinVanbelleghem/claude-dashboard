/**
 * Validates the appearance palette against the promises made in appearance.ts:
 * primary and secondary text clear 4.5:1 and muted clears 3:1 against all three
 * surface steps of their own column, and every accent clears 4.5:1 against those
 * same three steps in every palette.
 *
 * Run: bun run scripts/check-contrast.ts
 */
const stubMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
(globalThis as Record<string, unknown>).window = { matchMedia: stubMedia };
(globalThis as Record<string, unknown>).document = {
  documentElement: { style: { setProperty() {}, removeProperty() {} }, dataset: {} },
  querySelector: () => null,
};

const { ACCENTS, PALETTES } = await import("../src/appearance.ts");

const CSS_PATH = new URL("../src/styles.css", import.meta.url);
const css = await Bun.file(CSS_PATH).text();

const SURFACE_KEYS = [
  "surface-0",
  "surface-1",
  "surface-2",
  "border",
  "border-strong",
  "text-primary",
  "text-secondary",
  "text-muted",
] as const;

type Surfaces = Record<(typeof SURFACE_KEYS)[number], string>;

function block(selector: string): Surfaces {
  const at = css.indexOf(selector);
  if (at === -1) throw new Error(`no ${selector} block in styles.css`);
  const body = css.slice(at, css.indexOf("}", at));
  const out = {} as Surfaces;
  for (const key of SURFACE_KEYS) {
    const m = body.match(new RegExp(`--${key}:\\s*(#[0-9a-fA-F]{3,8})`));
    if (!m) throw new Error(`no --${key} in ${selector}`);
    out[key] = m[1];
  }
  return out;
}

const DEFAULTS = { dark: block(":root {"), light: block(':root[data-theme="light"]') };

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const channel = (i: number) => {
    const v = parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function ratio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const TEXT_RULES = [
  { key: "text-primary", min: 4.5 },
  { key: "text-secondary", min: 4.5 },
  { key: "text-muted", min: 3 },
] as const;

const SURFACES = ["surface-0", "surface-1", "surface-2"] as const;

let failures = 0;
const report = (ok: boolean, line: string) => {
  if (!ok) failures++;
  if (!ok) console.log(`  FAIL ${line}`);
};

for (const palette of PALETTES) {
  for (const theme of ["dark", "light"] as const) {
    const s: Surfaces = palette[theme] ?? DEFAULTS[theme];
    console.log(`${palette.label} / ${theme}`);

    for (const rule of TEXT_RULES) {
      for (const surface of SURFACES) {
        const r = ratio(s[rule.key], s[surface]);
        report(
          r >= rule.min,
          `${rule.key} on ${surface}: ${r.toFixed(2)} < ${rule.min} (${s[rule.key]} on ${s[surface]})`,
        );
      }
    }

    for (const accent of ACCENTS) {
      const hex = theme === "light" ? accent.light : accent.dark;
      for (const surface of SURFACES) {
        const r = ratio(hex, s[surface]);
        report(
          r >= 4.5,
          `accent ${accent.name} on ${surface}: ${r.toFixed(2)} < 4.5 (${hex} on ${s[surface]})`,
        );
      }
    }
  }
}

console.log(
  failures === 0
    ? `\nAll clear: ${PALETTES.length} palettes x 2 columns x (${TEXT_RULES.length} text steps + ${ACCENTS.length} accents).`
    : `\n${failures} failing pair(s).`,
);

/**
 * --tune: for every accent, print the nearest hex that clears 4.5:1 against all
 * surface steps of every palette, walking it toward white (dark column) or black
 * (light column) one step at a time. Suggestions only; nothing is written.
 */
if (process.argv.includes("--tune")) {
  const mix = (hex: string, toward: number, t: number) => {
    const h = hex.replace("#", "");
    const parts = [0, 1, 2].map((i) => parseInt(h.slice(i * 2, i * 2 + 2), 16));
    return (
      "#" +
      parts
        .map((v) => Math.round(v + (toward - v) * t).toString(16).padStart(2, "0"))
        .join("")
    );
  };

  const columns = (theme: "dark" | "light") =>
    PALETTES.map((p) => p[theme] ?? DEFAULTS[theme]);

  console.log("\n--- accent suggestions ---");
  for (const accent of ACCENTS) {
    for (const theme of ["dark", "light"] as const) {
      const start = theme === "light" ? accent.light : accent.dark;
      const backgrounds = columns(theme).flatMap((s) => SURFACES.map((k) => s[k]));
      const worst = (hex: string) => Math.min(...backgrounds.map((bg) => ratio(hex, bg)));
      if (worst(start) >= 4.5) continue;
      let fixed = start;
      for (let t = 0.02; t <= 1; t += 0.02) {
        fixed = mix(start, theme === "light" ? 0 : 255, t);
        if (worst(fixed) >= 4.5) break;
      }
      console.log(
        `${accent.name}.${theme}: ${start} (${worst(start).toFixed(2)}) -> ${fixed} (${worst(fixed).toFixed(2)})`,
      );
    }
  }
}

/**
 * The generated palette makes the same promise as the shipped ones, so sweep the
 * whole slider space rather than spot-checking: every combination must clear the
 * floors while clamping is on, or the "you cannot make it unreadable" claim in the
 * panel is false.
 */
const { buildSurfaces, TEXT_FLOORS, contrast } = await import("../src/palette.ts");

let swept = 0;
let customFails = 0;
for (const hue of [0, 45, 90, 140, 200, 265, 310, 355]) {
  for (const tint of [0, 0.02, 0.05, 0.09]) {
    for (const contrastMul of [0.6, 0.8, 1, 1.3, 1.6]) {
      for (const gamma of [0.6, 1, 1.4, 1.8]) {
       for (const depth of [0, 0.25, 0.5, 0.75, 1]) {
        for (const theme of ["dark", "light"] as const) {
          const { surfaces } = buildSurfaces({ hue, depth, tint, contrast: contrastMul, gamma }, theme);
          swept++;
          for (const [key, min] of Object.entries(TEXT_FLOORS)) {
            for (const surface of SURFACES) {
              const r = contrast(surfaces[key as keyof typeof surfaces], surfaces[surface]);
              if (r < min) {
                customFails++;
                console.log(
                  `  FAIL custom h${hue} d${depth} t${tint} c${contrastMul} g${gamma} ${theme}: ${key} on ${surface} ${r.toFixed(2)} < ${min}`,
                );
              }
            }
          }
        }
       }
      }
    }
  }
}
console.log(
  customFails === 0
    ? `Custom palette: ${swept} slider combinations, all text steps clear their floor.`
    : `Custom palette: ${customFails} failures across ${swept} combinations.`,
);

process.exit(failures === 0 && customFails === 0 ? 0 : 1);
