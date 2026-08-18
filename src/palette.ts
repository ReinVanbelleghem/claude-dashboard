import type { ThemeName } from "./appearance.ts";

export type Surfaces = {
  "surface-0": string;
  "surface-1": string;
  "surface-2": string;
  border: string;
  "border-strong": string;
  "text-primary": string;
  "text-secondary": string;
  "text-muted": string;
};

/**
 * A generated palette, as four numbers rather than sixteen hex values.
 *
 * OKLCH is the working space because its L is perceptual: stepping L by a fixed
 * amount looks like an even step, which is exactly what a surface ramp needs and
 * what HSL fails at — HSL lightness 50% yellow and 50% blue are nowhere near the
 * same brightness, so a hue slider over HSL would change the contrast as it moved.
 */
export type CustomPalette = {
  /** Degrees, 0–360. The tint carried by every surface and, faintly, by the text. */
  hue: number;
  /**
   * How far the page background sits from the extreme, 0–1. 0 is pure black on a
   * dark theme and pure white on a light one; 0.5 is the shipped Default. Its own
   * axis because the ramp's floor was previously fixed, which put an OLED-black
   * theme out of reach entirely.
   */
  depth: number;
  /** Chroma of the surfaces, 0 (neutral grey) to ~0.09 (as saturated as sRGB allows). */
  tint: number;
  /** Multiplies the gap between the surface steps and pushes the text steps apart. */
  contrast: number;
  /**
   * Curvature of the surface ramp. 1 is even steps; below 1 bunches the steps near
   * the page background (panels barely lift), above 1 spreads them out (panels sit
   * clearly above the page). The nearest thing here to a gamma control.
   */
  gamma: number;
};

export const DEFAULT_CUSTOM_PALETTE: CustomPalette = {
  hue: 265,
  depth: 0.5,
  tint: 0.035,
  contrast: 1,
  gamma: 1,
};

export const CUSTOM_RANGES = {
  hue: { min: 0, max: 360, step: 1 },
  depth: { min: 0, max: 1, step: 0.01 },
  tint: { min: 0, max: 0.09, step: 0.002 },
  contrast: { min: 0.6, max: 1.6, step: 0.02 },
  gamma: { min: 0.6, max: 1.8, step: 0.02 },
} as const;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function encode(v: number): number {
  const c = clamp01(v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  return Math.round(c * 255);
}

/**
 * Unclamped linear-sRGB for an OKLCH triple, plus whether it actually fits in the
 * gamut. The picker needs the flag: OKLCH describes colours sRGB cannot show, and
 * silently clamping them paints a large flat region that looks like a broken
 * gradient. Knowing it is out of range lets the field leave those pixels empty.
 */
export function oklchToRgbRaw(L: number, C: number, H: number): { rgb: number[]; inGamut: boolean } {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const inGamut = rgb.every((v) => v >= -0.001 && v <= 1.001);
  return { rgb, inGamut };
}

/** OKLCH for an existing hex, so the picker can open on the current colour. */
export function hexToOklch(hex: string): { L: number; C: number; H: number } {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const lin = [0, 1, 2].map((i) => {
    const v = parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const [r, g, b] = lin;

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  const H = (Math.atan2(B, A) * 180) / Math.PI;
  return { L, C: Math.hypot(A, B), H: H < 0 ? H + 360 : H };
}

/** The chroma axis the picker spans. Beyond this everything is out of gamut anyway. */
export const MAX_CHROMA = 0.33;

export function oklchToHex(L: number, C: number, H: number): string {
  const { rgb } = oklchToRgbRaw(L, C, H);
  return `#${rgb.map((v) => encode(v).toString(16).padStart(2, "0")).join("")}`;
}

export function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const channel = (i: number) => {
    const v = parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The two candidates for text and marks sitting *on* the accent — a button label,
 * a find highlight, a favicon glyph. Not white and black: near-black keeps the
 * same warmth as the dark surfaces, and pure black on a mid accent reads as a hole.
 */
export const INKS = ["#ffffff", "#14140f"];

/**
 * The ink to draw on a background, whichever of the two separates further. The
 * accent is user-chosen and spans the whole lightness range, so a fixed white
 * label goes unreadable the moment someone picks a pastel — this measures instead.
 */
export function inkOn(bg: string): string {
  return INKS.reduce((best, candidate) => (contrast(candidate, bg) > contrast(best, bg) ? candidate : best));
}

/** The floors the built-in palettes are held to, so a generated one matches them. */
export const TEXT_FLOORS = { "text-primary": 4.5, "text-secondary": 4.5, "text-muted": 3 } as const;

/**
 * Walk a colour's lightness until it clears `min` against every background, moving
 * away from them (up on a dark theme, down on a light one). Returns the input
 * unchanged when it already passes, and gives up at the end of the range rather
 * than looping — pure white on white has no solution.
 */
function toContrast(
  L: number,
  C: number,
  H: number,
  backgrounds: string[],
  min: number,
  theme: ThemeName,
): { hex: string; clamped: boolean } {
  const step = theme === "dark" ? 0.01 : -0.01;
  const worst = (hex: string) => Math.min(...backgrounds.map((bg) => contrast(hex, bg)));

  let hex = oklchToHex(L, C, H);
  if (worst(hex) >= min) return { hex, clamped: false };

  for (let l = L + step; l >= 0 && l <= 1; l += step) {
    hex = oklchToHex(l, C, H);
    if (worst(hex) >= min) return { hex, clamped: true };
  }
  return { hex, clamped: true };
}

/**
 * Build the eight surface variables from the four sliders.
 *
 * Text is generated last and, unless `unsafe`, pulled until it clears the same
 * floors the shipped palettes meet. That is what keeps the sliders playable: you
 * can drag contrast to its minimum and get a flat, moody look without ever landing
 * on a dashboard you cannot read.
 */
export function buildSurfaces(
  p: CustomPalette,
  theme: ThemeName,
  unsafe = false,
): { surfaces: Surfaces; clamped: (keyof typeof TEXT_FLOORS)[] } {
  const dark = theme === "dark";
  const tint = Math.max(0, p.tint);
  const spread = 0.05 * p.contrast;

  const depth = Math.min(1, Math.max(0, p.depth ?? 0.5));
  const floor = dark ? depth * 0.34 : 1 - depth * 0.14;
  const stepL = (i: number) => {
    const eased = i === 0 ? 0 : (i / 2) ** p.gamma * 2;
    return dark ? floor + eased * spread : floor - eased * spread * 0.55;
  };

  const surfaceHexes = [0, 1, 2].map((i) => oklchToHex(stepL(i), tint, p.hue));
  const surfaces = {
    "surface-0": surfaceHexes[0],
    "surface-1": surfaceHexes[1],
    "surface-2": surfaceHexes[2],
    border: oklchToHex(dark ? stepL(2) + spread * 1.1 : stepL(2) - spread * 0.5, tint * 0.9, p.hue),
    "border-strong": oklchToHex(
      dark ? stepL(2) + spread * 2.4 : stepL(2) - spread * 1.4,
      tint * 0.8,
      p.hue,
    ),
  } as Surfaces;

  // Text carries a trace of the hue rather than none: a fully neutral grey on a
  // strongly tinted surface reads as a different design system bolted on.
  const textChroma = Math.min(tint * 0.5, 0.03);
  const backgrounds = surfaceHexes;
  const baseL = {
    "text-primary": dark ? 0.99 : 0.17,
    "text-secondary": dark ? 0.84 - 0.06 * p.contrast : 0.36 + 0.05 * p.contrast,
    "text-muted": dark ? 0.72 - 0.08 * p.contrast : 0.5 + 0.07 * p.contrast,
  };

  const clamped: (keyof typeof TEXT_FLOORS)[] = [];
  for (const key of ["text-primary", "text-secondary", "text-muted"] as const) {
    if (unsafe) {
      surfaces[key] = oklchToHex(baseL[key], textChroma, p.hue);
      continue;
    }
    const r = toContrast(baseL[key], textChroma, p.hue, backgrounds, TEXT_FLOORS[key], theme);
    surfaces[key] = r.hex;
    if (r.clamped) clamped.push(key);
  }

  return { surfaces, clamped };
}

/** Worst ratio an accent achieves against a column's three surfaces. */
export function accentWorst(hex: string, s: Surfaces): number {
  return Math.min(
    contrast(hex, s["surface-0"]),
    contrast(hex, s["surface-1"]),
    contrast(hex, s["surface-2"]),
  );
}

/**
 * Approximate slider values for an existing surface table, so a shipped palette can
 * seed the builder and then be tweaked.
 *
 * This is a fit, not a round trip: the shipped palettes were hand-tuned per step and
 * the generator moves all three together, so a seeded palette lands close to its
 * namesake rather than on it. Inverts the same arithmetic buildSurfaces uses.
 */
export function fitPalette(s: Surfaces, theme: ThemeName): CustomPalette {
  const mid = hexToOklch(s["surface-1"]);
  const L0 = hexToOklch(s["surface-0"]).L;
  const L2 = hexToOklch(s["surface-2"]).L;
  const dark = theme === "dark";

  const spread = Math.max(0.005, dark ? (L2 - L0) / 2 : (L0 - L2) / 1.1);
  const eased1 = dark ? (mid.L - L0) / spread : (L0 - mid.L) / (spread * 0.55);
  const gamma = eased1 > 0 ? Math.log(Math.min(1.999, Math.max(0.001, eased1 / 2))) / Math.log(0.5) : 1;

  const bound = (v: number, r: { min: number; max: number }) => Math.min(r.max, Math.max(r.min, v));
  return {
    hue: bound(mid.H, CUSTOM_RANGES.hue),
    depth: bound(dark ? L0 / 0.34 : (1 - L0) / 0.14, CUSTOM_RANGES.depth),
    tint: bound(mid.C, CUSTOM_RANGES.tint),
    contrast: bound(spread / 0.05, CUSTOM_RANGES.contrast),
    gamma: bound(gamma, CUSTOM_RANGES.gamma),
  };
}
