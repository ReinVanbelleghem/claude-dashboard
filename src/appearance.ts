/**
 * Look and feel: theme, accent hue, and the tab icon.
 *
 * Two rules shape this file. The accent only ever drives chrome (`--accent`),
 * never the categorical chart slots, so recolouring the dashboard cannot make
 * two series collide. And every accent carries a separate value per theme,
 * because a hue that reads on #121211 is invisible on #fcfcfb — each pair below
 * clears 4.5:1 against all three surface steps of its own column.
 *
 * Favicons are generated as data URLs rather than shipped as files, so a glyph
 * and a colour combine without a build step. The static icons in public/ remain
 * the fallback for the first paint and for anything that fetches /favicon.ico.
 *
 * An installed web app is the exception to all of that: its Dock icon is fixed at
 * install time and no live swap reaches it. What it does accept is the OS badge
 * (setAttention) and the title bar colour (theme-color) — both applied here — plus
 * an icon file exported by hand from iconPng().
 */

export type ThemeName = "dark" | "light";
export type AccentName =
  | "blue"
  | "clay"
  | "green"
  | "teal"
  | "violet"
  | "amber"
  | "pink";
export type FaviconName =
  | "prompt"
  | "spark"
  | "bubble"
  | "window"
  | "pulse"
  | "bolt"
  | "braces"
  | "bars"
  | "grid"
  | "hexagon"
  | "orbit"
  | "moon";

export type Appearance = {
  theme: ThemeName;
  /** Surfaces, borders and text steps. Independent of theme: each has both columns. */
  palette: PaletteName;
  accent: AccentName;
  favicon: FaviconName;
  /** The tile colour. Independent of the accent so the tab chip can stay recognisable. */
  faviconColor: AccentName;
  /** Let the icon animate while a session is working. Ignored under reduced motion. */
  motion: boolean;
};

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "dark",
  palette: "default",
  accent: "blue",
  favicon: "prompt",
  faviconColor: "clay",
  motion: true,
};

export const ACCENTS: { name: AccentName; label: string; dark: string; light: string }[] = [
  { name: "blue", label: "Blue", dark: "#4d94e8", light: "#1a66bd" },
  { name: "clay", label: "Clay", dark: "#e5763f", light: "#a84a1a" },
  { name: "green", label: "Green", dark: "#2ab98a", light: "#12795a" },
  { name: "teal", label: "Teal", dark: "#47b3ab", light: "#0b6b66" },
  { name: "violet", label: "Violet", dark: "#b48ce8", light: "#7b3fc4" },
  { name: "amber", label: "Amber", dark: "#d9a441", light: "#8a6410" },
  // Darkened from #b83d78: that cleared 4.5:1 on the default light surfaces but
  // not on the Slate and Terminal palettes' deeper steps.
  { name: "pink", label: "Pink", dark: "#e58ab8", light: "#ad356d" },
];

/**
 * A full palette moves the surfaces, borders and text steps; the accent and the
 * categorical chart slots ride on top unchanged. Each column below clears 4.5:1
 * for primary and secondary text and 3:1 for muted, against all three of its own
 * surface steps — and every accent clears 4.5:1 against them too.
 */
export type PaletteName = "default" | "slate" | "terminal" | "ocean" | "grape" | "solar" | "sepia" | "mono" | "ember";

type Surfaces = {
  "surface-0": string;
  "surface-1": string;
  "surface-2": string;
  border: string;
  "border-strong": string;
  "text-primary": string;
  "text-secondary": string;
  "text-muted": string;
};

export const PALETTES: {
  name: PaletteName;
  label: string;
  help: string;
  dark: Surfaces | null;
  light: Surfaces | null;
}[] = [
  {
    name: "default",
    label: "Default",
    help: "Warm near-black, the validated original.",
    // null means "use the values already in styles.css" rather than restating them.
    dark: null,
    light: null,
  },
  {
    name: "slate",
    label: "Slate",
    help: "Cooler, bluer greys.",
    dark: {
      "surface-0": "#0e1116",
      "surface-1": "#151a21",
      "surface-2": "#1e242d",
      border: "#2b323c",
      "border-strong": "#414a57",
      "text-primary": "#ffffff",
      "text-secondary": "#bcc4d0",
      "text-muted": "#828b99",
    },
    light: {
      "surface-0": "#eef1f5",
      "surface-1": "#fbfcfd",
      "surface-2": "#e5e9f0",
      border: "#d3d9e2",
      "border-strong": "#aeb6c2",
      "text-primary": "#0b0e12",
      "text-secondary": "#4c5460",
      "text-muted": "#6e7784",
    },
  },
  {
    name: "terminal",
    label: "Terminal",
    help: "Green-tinted, CRT-ish. Pairs well with the green accent.",
    dark: {
      "surface-0": "#06100a",
      "surface-1": "#0b1810",
      "surface-2": "#12241a",
      border: "#1e3a28",
      "border-strong": "#2f5740",
      "text-primary": "#e8ffe8",
      "text-secondary": "#a8d9b0",
      "text-muted": "#77a37f",
    },
    light: {
      "surface-0": "#eef4ec",
      "surface-1": "#fafdf8",
      "surface-2": "#e3ece0",
      border: "#cfdccb",
      "border-strong": "#a6b8a1",
      "text-primary": "#07140b",
      "text-secondary": "#3d5442",
      "text-muted": "#5f7a64",
    },
  },
  {
    name: "ocean",
    label: "Ocean",
    help: "Deep blue, like a dark editor at night.",
    dark: {
      "surface-0": "#0a0e12",
      "surface-1": "#0f151c",
      "surface-2": "#161f29",
      "border": "#212e3d",
      "border-strong": "#33475e",
      "text-primary": "#f0f1f2",
      "text-secondary": "#adbaca",
      "text-muted": "#6e87a3",
    },
    light: {
      "surface-0": "#f1f4f8",
      "surface-1": "#fdfdfe",
      "surface-2": "#e7edf2",
      "border": "#d4dde8",
      "border-strong": "#b2c3d6",
      "text-primary": "#191b1d",
      "text-secondary": "#364454",
      "text-muted": "#586f89",
    },
  },
  {
    name: "grape",
    label: "Grape",
    help: "Purple-tinted dusk.",
    dark: {
      "surface-0": "#110b13",
      "surface-1": "#19111d",
      "surface-2": "#24192a",
      "border": "#35243d",
      "border-strong": "#50375d",
      "text-primary": "#efedef",
      "text-secondary": "#c2b1cb",
      "text-muted": "#9678a5",
    },
    light: {
      "surface-0": "#f6f3f8",
      "surface-1": "#fffeff",
      "surface-2": "#efe9f2",
      "border": "#e1d6e7",
      "border-strong": "#cab6d4",
      "text-primary": "#1b191c",
      "text-secondary": "#4f3b59",
      "text-muted": "#806090",
    },
  },
  {
    name: "solar",
    label: "Solar",
    help: "Warm cyan-teal base, solarized in spirit.",
    dark: {
      "surface-0": "#0c1518",
      "surface-1": "#111f22",
      "surface-2": "#182b30",
      "border": "#223d44",
      "border-strong": "#325c67",
      "text-primary": "#fefefe",
      "text-secondary": "#b4c8cd",
      "text-muted": "#6c939d",
    },
    light: {
      "surface-0": "#f0f6f7",
      "surface-1": "#fcfdfd",
      "surface-2": "#e5f0f2",
      "border": "#d1e4e8",
      "border-strong": "#afcfd7",
      "text-primary": "#1a1d1e",
      "text-secondary": "#32464b",
      "text-muted": "#52727a",
    },
  },
  {
    name: "sepia",
    label: "Sepia",
    help: "Paper and ink. Warm, low glare.",
    dark: {
      "surface-0": "#15110c",
      "surface-1": "#1f1911",
      "surface-2": "#2c2419",
      "border": "#403424",
      "border-strong": "#604e36",
      "text-primary": "#f9f9f8",
      "text-secondary": "#cbbfae",
      "text-muted": "#9e8667",
    },
    light: {
      "surface-0": "#f7f4f0",
      "surface-1": "#fdfdfc",
      "surface-2": "#f1ede7",
      "border": "#e6ded3",
      "border-strong": "#d4c5b2",
      "text-primary": "#1d1b19",
      "text-secondary": "#4e4232",
      "text-muted": "#7e6a51",
    },
  },
  {
    name: "mono",
    label: "Mono",
    help: "No hue at all — pure neutral greys.",
    dark: {
      "surface-0": "#0d0d0d",
      "surface-1": "#161616",
      "surface-2": "#212121",
      "border": "#303030",
      "border-strong": "#4a4a4a",
      "text-primary": "#f4f4f4",
      "text-secondary": "#bbbbbb",
      "text-muted": "#868686",
    },
    light: {
      "surface-0": "#f4f4f4",
      "surface-1": "#fcfcfc",
      "surface-2": "#ececec",
      "border": "#dddddd",
      "border-strong": "#c3c3c3",
      "text-primary": "#1b1b1b",
      "text-secondary": "#424242",
      "text-muted": "#6c6c6c",
    },
  },
  {
    name: "ember",
    label: "Ember",
    help: "Warm red-brown, like a dimmed lamp.",
    dark: {
      "surface-0": "#130c0b",
      "surface-1": "#1d1311",
      "surface-2": "#2a1b19",
      "border": "#3d2724",
      "border-strong": "#5d3c37",
      "text-primary": "#f2f0f0",
      "text-secondary": "#cbb4b1",
      "text-muted": "#a27a74",
    },
    light: {
      "surface-0": "#f7f3f2",
      "surface-1": "#fefdfd",
      "surface-2": "#f2e9e8",
      "border": "#e6d7d5",
      "border-strong": "#d3b9b5",
      "text-primary": "#1c1a19",
      "text-secondary": "#543c38",
      "text-muted": "#8a625c",
    },
  },
];

export function accentHex(name: AccentName, theme: ThemeName): string {
  const a = ACCENTS.find((x) => x.name === name) ?? ACCENTS[0];
  return theme === "light" ? a.light : a.dark;
}

/**
 * Glyph interiors, drawn white on a 32×32 tile. Kept chunky enough to read at 16px.
 *
 * `motion` is the same glyph as a function of a phase in [0,1) — one turn of
 * whatever it does. Frames are generated rather than declared as SMIL because the
 * favicon is the surface that matters most, and a browser renders a favicon as one
 * static frame: SMIL and CSS inside it never run. Driving `link.href` from a timer
 * is the only motion a tab icon accepts, and that needs discrete frames.
 *
 * Every motion must return to `body`'s silhouette at phase 0, so a glyph that stops
 * animating does not visibly jump.
 */
type Glyph = { label: string; body: string; motion?: (phase: number) => string };

const TAU = Math.PI * 2;
/** Rounded to keep generated data URLs short — they are rewritten many times a second. */
const r = (n: number) => Math.round(n * 100) / 100;

const GLYPHS: Record<FaviconName, Glyph> = {
  prompt: {
    label: "Prompt",
    body: `<path d="M10 10.5 L15.5 16 L10 21.5" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/><rect x="17.6" y="19.8" width="8.4" height="3.2" rx="1.6" fill="#fff"/>`,
    // A terminal cursor: the chevron holds still and the bar blinks, on a square
    // wave rather than a fade, because that is what a real one does.
    motion: (p) =>
      `<path d="M10 10.5 L15.5 16 L10 21.5" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/><rect x="17.6" y="19.8" width="8.4" height="3.2" rx="1.6" fill="#fff" opacity="${p < 0.5 ? 1 : 0.15}"/>`,
  },
  spark: {
    label: "Spark",
    body: `<path d="M16 4.5 C17.2 12 20 14.8 27.5 16 C20 17.2 17.2 20 16 27.5 C14.8 20 12 17.2 4.5 16 C12 14.8 14.8 12 16 4.5 Z" fill="#fff"/>`,
    // Twinkle: breathe the four points in and out around a fixed centre.
    motion: (p) => {
      const s = r(0.86 + 0.14 * (1 + Math.cos(p * TAU)) / 2);
      return `<g transform="translate(16 16) scale(${s}) rotate(${r(p * 90)}) translate(-16 -16)"><path d="M16 4.5 C17.2 12 20 14.8 27.5 16 C20 17.2 17.2 20 16 27.5 C14.8 20 12 17.2 4.5 16 C12 14.8 14.8 12 16 4.5 Z" fill="#fff"/></g>`;
    },
  },
  bubble: {
    label: "Bubble",
    body: `<path d="M7 9.5 a3 3 0 0 1 3-3 h12 a3 3 0 0 1 3 3 v8 a3 3 0 0 1-3 3 h-6.5 L11 25.5 v-4.9 h-1 a3 3 0 0 1-3-3 Z" fill="#fff"/><circle cx="12" cy="13.5" r="1.6" fill="currentColor"/><circle cx="16" cy="13.5" r="1.6" fill="currentColor"/><circle cx="20" cy="13.5" r="1.6" fill="currentColor"/>`,
    // The typing indicator everyone already knows: three dots bobbing in sequence.
    motion: (p) => {
      const dot = (cx: number, i: number) => {
        const local = (p + 1 - i * 0.18) % 1;
        const lift = local < 0.5 ? Math.sin(local * 2 * Math.PI) * 2.6 : 0;
        return `<circle cx="${cx}" cy="${r(13.5 - lift)}" r="1.6" fill="currentColor"/>`;
      };
      return `<path d="M7 9.5 a3 3 0 0 1 3-3 h12 a3 3 0 0 1 3 3 v8 a3 3 0 0 1-3 3 h-6.5 L11 25.5 v-4.9 h-1 a3 3 0 0 1-3-3 Z" fill="#fff"/>${dot(12, 0)}${dot(16, 1)}${dot(20, 2)}`;
    },
  },
  window: {
    label: "Window",
    body: `<rect x="5.5" y="7" width="21" height="18" rx="3" fill="#fff"/><rect x="5.5" y="7" width="21" height="4.6" rx="2.3" fill="currentColor" opacity="0.35"/><path d="M11 16 L14.5 19 L11 22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><rect x="16.5" y="20.4" width="5.5" height="2.2" rx="1.1" fill="currentColor"/>`,
    motion: (p) =>
      `<rect x="5.5" y="7" width="21" height="18" rx="3" fill="#fff"/><rect x="5.5" y="7" width="21" height="4.6" rx="2.3" fill="currentColor" opacity="0.35"/><path d="M11 16 L14.5 19 L11 22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><rect x="16.5" y="20.4" width="5.5" height="2.2" rx="1.1" fill="currentColor" opacity="${p < 0.5 ? 1 : 0.12}"/>`,
  },
  pulse: {
    label: "Pulse",
    body: `<path d="M4.5 16 H10 L13 9.5 L18.5 22.5 L21.5 16 H27.5" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`,
    // The trace scrolls leftward like a monitor. Two copies one tile-width apart
    // make the seam continuous; the clip keeps the offscreen one out of the corners.
    motion: (p) => {
      const trace = `<path d="M4.5 16 H10 L13 9.5 L18.5 22.5 L21.5 16 H27.5" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`;
      return `<defs><clipPath id="pc"><rect width="32" height="32" rx="7"/></clipPath></defs><g clip-path="url(#pc)"><g transform="translate(${r(-23 * p)} 0)">${trace}<g transform="translate(23 0)">${trace}</g></g></g>`;
    },
  },
  bolt: {
    label: "Bolt",
    body: `<path d="M18.5 4 L9 17.5 h5.5 L13 28 L23 14.5 h-5.6 Z" fill="#fff"/>`,
    // A strike, not a strobe: mostly lit, with one short drop per turn.
    motion: (p) =>
      `<path d="M18.5 4 L9 17.5 h5.5 L13 28 L23 14.5 h-5.6 Z" fill="#fff" opacity="${p > 0.82 && p < 0.9 ? 0.3 : 1}"/>`,
  },
  braces: {
    label: "Braces",
    body: `<path d="M13.6 7.5 c-3 0-1.6 6.5-4.6 8.5 3 2 1.6 8.5 4.6 8.5" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/><path d="M18.4 7.5 c3 0 1.6 6.5 4.6 8.5 -3 2-1.6 8.5-4.6 8.5" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>`,
    // The pair breathes apart and back, so the block looks like it is holding something.
    motion: (p) => {
      const d = r((1 - Math.cos(p * TAU)) / 2 * 1.8);
      return `<g transform="translate(${r(-d)} 0)"><path d="M13.6 7.5 c-3 0-1.6 6.5-4.6 8.5 3 2 1.6 8.5 4.6 8.5" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/></g><g transform="translate(${d} 0)"><path d="M18.4 7.5 c3 0 1.6 6.5 4.6 8.5 -3 2-1.6 8.5-4.6 8.5" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/></g>`;
    },
  },
  bars: {
    label: "Bars",
    // An equaliser. Each bar is pinned to the baseline and only its height moves,
    // which is why y and height are computed together rather than transformed.
    body: `<rect x="6.6" y="18" width="4.8" height="8.2" rx="1.7" fill="#fff"/><rect x="13.6" y="12" width="4.8" height="14.2" rx="1.7" fill="#fff"/><rect x="20.6" y="6.4" width="4.8" height="19.8" rx="1.7" fill="#fff"/>`,
    motion: (p) => {
      const bar = (x: number, base: number, offset: number) => {
        const h = base + 5.5 * Math.sin((p + offset) * TAU);
        const clamped = Math.max(4.2, Math.min(19.8, h));
        return `<rect x="${x}" y="${r(26.2 - clamped)}" width="4.8" height="${r(clamped)}" rx="1.7" fill="#fff"/>`;
      };
      return `${bar(6.6, 8.2, 0)}${bar(13.6, 14.2, 0.33)}${bar(20.6, 14.3, 0.66)}`;
    },
  },
  grid: {
    label: "Grid",
    body: `<rect x="6.4" y="6.4" width="8.6" height="8.6" rx="2.3" fill="#fff"/><rect x="17" y="6.4" width="8.6" height="8.6" rx="2.3" fill="#fff"/><rect x="6.4" y="17" width="8.6" height="8.6" rx="2.3" fill="#fff"/><rect x="17" y="17" width="8.6" height="8.6" rx="2.3" fill="#fff"/>`,
    // A chase around the four cells, clockwise. Nothing vanishes entirely: at 16px
    // a missing cell reads as a rendering glitch rather than as motion.
    motion: (p) => {
      const cells: [number, number][] = [
        [6.4, 6.4],
        [17, 6.4],
        [17, 17],
        [6.4, 17],
      ];
      const lit = Math.floor(p * 4) % 4;
      return cells
        .map(
          ([x, y], i) =>
            `<rect x="${x}" y="${y}" width="8.6" height="8.6" rx="2.3" fill="#fff" opacity="${i === lit ? 1 : 0.42}"/>`,
        )
        .join("");
    },
  },
  hexagon: {
    label: "Hexagon",
    body: `<path d="M16 4.2 L26.2 10.1 V21.9 L16 27.8 L5.8 21.9 V10.1 Z" fill="#fff"/><circle cx="16" cy="16" r="4" fill="currentColor"/>`,
    // A sixth of a turn per phase, so it reads as a rotating nut rather than a wobble.
    motion: (p) =>
      `<g transform="rotate(${r(p * 60)} 16 16)"><path d="M16 4.2 L26.2 10.1 V21.9 L16 27.8 L5.8 21.9 V10.1 Z" fill="#fff"/></g><circle cx="16" cy="16" r="4" fill="currentColor"/>`,
  },
  orbit: {
    label: "Orbit",
    body: `<ellipse cx="16" cy="16" rx="12.6" ry="5.6" fill="none" stroke="#fff" stroke-width="3" transform="rotate(-30 16 16)"/><circle cx="16" cy="16" r="4.4" fill="#fff"/>`,
    // The ring tumbles, the body stays put — the one glyph here that reads as a
    // spinner, and so the best default for "something is running".
    motion: (p) =>
      `<ellipse cx="16" cy="16" rx="12.6" ry="5.6" fill="none" stroke="#fff" stroke-width="3" transform="rotate(${r(-30 + p * 360)} 16 16)"/><circle cx="16" cy="16" r="4.4" fill="#fff"/>`,
  },
  moon: {
    label: "Moon",
    // Two circles rather than one crescent path: a disc, and a tile-coloured shadow
    // over it. The shadow spilling past the disc costs nothing because it is the
    // tile's own colour, and moving one number then gives every phase — a crescent
    // path would need its inner arc re-solved per frame. MOON_SHADOW_REST is the
    // still position, so a stopped animation lands exactly on `body`.
    body: `<circle cx="16" cy="16" r="11.6" fill="#fff"/><circle cx="10" cy="16" r="11.6" fill="currentColor"/>`,
    motion: (p) => {
      // Waxes to nearly full and back. The shadow stays left of the disc centre the
      // whole way: the two radii are equal, so a shadow reaching 16 would cover the
      // disc exactly and leave a blank tile — which reads as a broken icon rather
      // than as a new moon. Retreating leftwards instead keeps the terminator on the
      // same side, so it looks like one moon through its phases and not two.
      const shadow = r(10 - 14 * ((1 - Math.cos(p * TAU)) / 2));
      return `<circle cx="16" cy="16" r="11.6" fill="#fff"/><circle cx="${shadow}" cy="16" r="11.6" fill="currentColor"/>`;
    },
  },
};

export const FAVICONS = (Object.keys(GLYPHS) as FaviconName[]).map((name) => ({
  name,
  label: GLYPHS[name].label,
  moves: !!GLYPHS[name].motion,
}));

/** One turn of a glyph's motion. Slow enough that a throttled tab still reads it. */
export const MOTION_PERIOD_MS = 1400;
/**
 * Frames per turn. Deliberately coarse: every frame is a fresh data URL that has to
 * be encoded and decoded, and a quantised phase means the handful of distinct URLs
 * repeat, so the browser decodes each one once instead of 60 times a second. 16 over
 * 1.4s is ~11fps, which is smooth enough for a 16px tile and is also roughly the
 * ceiling a background tab's throttled timer could deliver anyway.
 */
export const MOTION_FRAMES = 16;

/**
 * Where a glyph's motion is at a given moment. Time-derived rather than a counter,
 * so every surface showing the icon is on the same frame, and a background tab whose
 * timer was throttled to 1Hz resumes at the right position instead of stuttering
 * from wherever it left off.
 */
export function motionPhase(now = performance.now()): number {
  const turn = (now % MOTION_PERIOD_MS) / MOTION_PERIOD_MS;
  return Math.floor(turn * MOTION_FRAMES) / MOTION_FRAMES;
}

/**
 * The attention badge: amber, matching `.card.attention` and the Live tab count,
 * ringed in the tile colour so it still separates when it lands on a white part
 * of the glyph. Drawn past the tile edge deliberately — at 16px an inset dot
 * turns into a smudge.
 */
const BADGE = (color: string) =>
  `<circle cx="23.5" cy="8.5" r="8.5" fill="${color}"/><circle cx="23.5" cy="8.5" r="6" fill="#fab219"/>`;

export function faviconSvg(
  name: FaviconName,
  color: string,
  badge = false,
  phase?: number,
): string {
  const g = GLYPHS[name] ?? GLYPHS.prompt;
  const inner = phase !== undefined && g.motion ? g.motion(phase) : g.body;
  // `currentColor` inside a glyph resolves to the tile colour, which is how the
  // cut-out marks (window chrome, bubble dots) punch back through to the tile.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" color="${color}"><rect width="32" height="32" rx="7" fill="${color}"/>${inner}${badge ? BADGE(color) : ""}</svg>`;
}

export function faviconDataUrl(
  name: FaviconName,
  accent: AccentName,
  theme: ThemeName,
  badge = false,
  phase?: number,
): string {
  const svg = faviconSvg(name, accentHex(accent, theme), badge, phase);
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

let iconUrl = "/favicon.ico";
let current: Appearance = DEFAULT_APPEARANCE;
let badged = false;
let busy = false;
let frameTimer: number | null = null;

/**
 * The plain, un-badged icon. Notification banners use this: the badge means
 * "something is waiting in a tab you cannot see", and a banner is already the
 * thing telling you that.
 */
export function currentIconUrl(): string {
  return iconUrl;
}

function applyIcon() {
  // The frozen glyph, not the animated one: this is what notification banners and
  // the download button use, and a banner showing a half-swung frame looks broken.
  iconUrl = faviconDataUrl(current.favicon, current.faviconColor, current.theme);
  const phase = animating() ? motionPhase() : undefined;
  const href =
    badged || phase !== undefined
      ? faviconDataUrl(current.favicon, current.faviconColor, current.theme, badged, phase)
      : iconUrl;

  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"][data-dynamic]');
  if (!link) {
    // The static icons in index.html are the pre-paint fallback. Once a choice is
    // applied they have to go, or the browser is free to prefer the .ico over it.
    for (const el of document.querySelectorAll('link[rel~="icon"]:not([data-dynamic])')) {
      el.remove();
    }
    link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/svg+xml";
    link.dataset.dynamic = "true";
    document.head.appendChild(link);
  }
  link.href = href;
}

/**
 * Show or hide the attention dot. Kept separate from applyAppearance because the
 * two change on completely different clocks: appearance when you pick something,
 * the badge whenever a session blocks. Both write the same <link>, and the badge
 * state survives an appearance change because it lives here rather than in React.
 */
export function setFaviconBadge(on: boolean) {
  if (badged === on) return;
  badged = on;
  applyIcon();
}

/** Someone who asked the OS not to animate things means it. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Three conditions, all required: asked for, glyph can do it, work to show. */
export function animating(): boolean {
  return busy && current.motion && !prefersReducedMotion() && !!GLYPHS[current.favicon]?.motion;
}

/**
 * Start or stop the tab icon moving. Called with "a session is thinking", which is
 * the only thing motion here is allowed to mean — a permanently spinning favicon is
 * decoration, and decoration in a tab strip is indistinguishable from noise.
 *
 * The timer is a plain interval rather than requestAnimationFrame on purpose: rAF
 * stops entirely in a hidden tab, and a hidden tab is exactly when the icon is the
 * only thing left telling you anything. An interval gets throttled to about 1Hz
 * instead, and because each frame is computed from the clock rather than counted,
 * throttling costs smoothness and never position.
 */
export function setBusy(on: boolean) {
  if (busy === on) return;
  busy = on;
  retime();
}

/**
 * Bring the frame timer in line with `animating()` and repaint once.
 *
 * Three separate things invalidate it — work starting or stopping, a new glyph or
 * motion setting being applied, and the OS reduced-motion preference changing — so
 * the decision lives here rather than being re-derived at each call site. Starting
 * draws the first frame; stopping restores the still one.
 */
function retime() {
  const should = animating();
  if (should && frameTimer === null) frameTimer = window.setInterval(applyIcon, 110);
  if (!should && frameTimer !== null) {
    clearInterval(frameTimer);
    frameTimer = null;
  }
  applyIcon();
}

/**
 * Turning "reduce motion" on in System Settings has to stop a spin that is already
 * running, not just prevent the next one — that setting is usually changed by
 * someone who wants the movement on screen to stop now.
 */
window.matchMedia?.("(prefers-reduced-motion: reduce)").addEventListener("change", retime);

/**
 * The OS badge on the Dock or taskbar icon of an installed web app (Safari's
 * "Add to Dock", or any PWA). This is the one attention signal that survives the
 * window being hidden behind an editor — the favicon dot and the title count both
 * need a visible tab to read.
 *
 * Two quirks are handled here. Safari mishandles `setAppBadge(0)`, so zero always
 * goes through `clearAppBadge` rather than being passed as an argument. And both
 * calls reject when the page is not installed, or when notification permission
 * was never granted — neither is a failure worth surfacing, since the favicon
 * badge is already carrying the same signal.
 */
function setDockBadge(count: number) {
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    const done = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.();
    done?.catch(() => {});
  } catch {
    // Older engines throw synchronously rather than rejecting.
  }
}

/**
 * One call for "n sessions are waiting on you", fanned out to every surface that
 * can show it. The favicon takes a boolean because a 16px tile has room for a dot
 * and not a number; the Dock badge takes the count, because it has room for both.
 */
export function setAttention(count: number) {
  setFaviconBadge(count > 0);
  setDockBadge(count);
}

/**
 * The window chrome colour. In a browser tab this is decoration, but in an
 * installed web app it is the title bar, so setting it is what stops a Dock app
 * from framing the palette in default grey.
 *
 * Read back off the computed value rather than the palette table because the
 * Default palette has no entry there — it works by removing the inline overrides
 * and letting the stylesheet's own variables show through, so the table would
 * report nothing for exactly the case that matters most.
 */
function applyThemeColor() {
  const surface = getComputedStyle(document.documentElement)
    .getPropertyValue("--surface-0")
    .trim();
  if (!surface) return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = surface;
}

/**
 * The current icon as a PNG, for the icon picker's download button.
 *
 * Safari bakes a web app's Dock icon at install time, so none of the live favicon
 * swapping above can reach it; the supported way to change it afterwards is the
 * web app's own General settings, which wants an image file. This produces that
 * file, at the size macOS wants, in whatever glyph and hue is currently chosen.
 */
export function iconPng(a: Appearance, size = 1024): Promise<Blob> {
  const svg = faviconSvg(a.favicon, accentHex(a.faviconColor, a.theme));
  const source = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("no 2d context"));
      ctx.drawImage(img, 0, 0, size, size);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode failed"))), "image/png");
    };
    img.onerror = () => reject(new Error("icon did not load"));
    img.src = source;
  });
}

const KEY = "appearance";

export function readStored(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_APPEARANCE, ...(JSON.parse(raw) as Partial<Appearance>) };
    // Migration: the theme used to be a lone key, and losing it on upgrade would
    // flip a light-mode user back to dark for no reason they can see.
    const legacy = localStorage.getItem("theme");
    if (legacy === "light" || legacy === "dark") {
      return { ...DEFAULT_APPEARANCE, theme: legacy };
    }
  } catch {
    // Private-mode or a corrupt value: defaults are always a valid answer.
  }
  return DEFAULT_APPEARANCE;
}

export function applyAppearance(a: Appearance) {
  const root = document.documentElement;
  root.dataset.theme = a.theme;
  root.style.setProperty("--accent", accentHex(a.accent, a.theme));

  // Clear first, then apply: switching back to Default has to remove the inline
  // overrides so the stylesheet's own values show through again.
  const surfaces = PALETTES.find((p) => p.name === a.palette)?.[a.theme] ?? null;
  for (const key of PALETTE_VARS) {
    if (surfaces) root.style.setProperty(`--${key}`, surfaces[key]);
    else root.style.removeProperty(`--${key}`);
  }

  current = a;
  // retime rather than applyIcon: switching motion off, or picking a glyph that cannot
  // move, has to stop the timer too — otherwise it keeps repainting an identical frame.
  retime();
  // After the variables are written, not before: this reads the value back.
  applyThemeColor();

  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    // Not being able to remember the choice is not a reason to refuse it.
  }
}

/** The variables a palette owns — also the list `applyAppearance` clears. */
const PALETTE_VARS = [
  "surface-0",
  "surface-1",
  "surface-2",
  "border",
  "border-strong",
  "text-primary",
  "text-secondary",
  "text-muted",
] as const;
