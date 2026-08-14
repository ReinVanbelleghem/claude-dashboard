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
export type FaviconName = "prompt" | "spark" | "bubble" | "window" | "pulse" | "bolt";

export type Appearance = {
  theme: ThemeName;
  /** Surfaces, borders and text steps. Independent of theme: each has both columns. */
  palette: PaletteName;
  accent: AccentName;
  favicon: FaviconName;
  /** The tile colour. Independent of the accent so the tab chip can stay recognisable. */
  faviconColor: AccentName;
};

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "dark",
  palette: "default",
  accent: "blue",
  favicon: "prompt",
  faviconColor: "clay",
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

/** Glyph interiors, drawn white on a 32×32 tile. Kept chunky enough to read at 16px. */
const GLYPHS: Record<FaviconName, { label: string; body: string }> = {
  prompt: {
    label: "Prompt",
    body: `<path d="M10 10.5 L15.5 16 L10 21.5" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/><rect x="17.6" y="19.8" width="8.4" height="3.2" rx="1.6" fill="#fff"/>`,
  },
  spark: {
    label: "Spark",
    body: `<path d="M16 4.5 C17.2 12 20 14.8 27.5 16 C20 17.2 17.2 20 16 27.5 C14.8 20 12 17.2 4.5 16 C12 14.8 14.8 12 16 4.5 Z" fill="#fff"/>`,
  },
  bubble: {
    label: "Bubble",
    body: `<path d="M7 9.5 a3 3 0 0 1 3-3 h12 a3 3 0 0 1 3 3 v8 a3 3 0 0 1-3 3 h-6.5 L11 25.5 v-4.9 h-1 a3 3 0 0 1-3-3 Z" fill="#fff"/><circle cx="12" cy="13.5" r="1.6" fill="currentColor"/><circle cx="16" cy="13.5" r="1.6" fill="currentColor"/><circle cx="20" cy="13.5" r="1.6" fill="currentColor"/>`,
  },
  window: {
    label: "Window",
    body: `<rect x="5.5" y="7" width="21" height="18" rx="3" fill="#fff"/><rect x="5.5" y="7" width="21" height="4.6" rx="2.3" fill="currentColor" opacity="0.35"/><path d="M11 16 L14.5 19 L11 22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><rect x="16.5" y="20.4" width="5.5" height="2.2" rx="1.1" fill="currentColor"/>`,
  },
  pulse: {
    label: "Pulse",
    body: `<path d="M4.5 16 H10 L13 9.5 L18.5 22.5 L21.5 16 H27.5" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  bolt: {
    label: "Bolt",
    body: `<path d="M18.5 4 L9 17.5 h5.5 L13 28 L23 14.5 h-5.6 Z" fill="#fff"/>`,
  },
};

export const FAVICONS = (Object.keys(GLYPHS) as FaviconName[]).map((name) => ({
  name,
  label: GLYPHS[name].label,
}));

/**
 * The attention badge: amber, matching `.card.attention` and the Live tab count,
 * ringed in the tile colour so it still separates when it lands on a white part
 * of the glyph. Drawn past the tile edge deliberately — at 16px an inset dot
 * turns into a smudge.
 */
const BADGE = (color: string) =>
  `<circle cx="23.5" cy="8.5" r="8.5" fill="${color}"/><circle cx="23.5" cy="8.5" r="6" fill="#fab219"/>`;

export function faviconSvg(name: FaviconName, color: string, badge = false): string {
  const g = GLYPHS[name] ?? GLYPHS.prompt;
  // `currentColor` inside a glyph resolves to the tile colour, which is how the
  // cut-out marks (window chrome, bubble dots) punch back through to the tile.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" color="${color}"><rect width="32" height="32" rx="7" fill="${color}"/>${g.body}${badge ? BADGE(color) : ""}</svg>`;
}

export function faviconDataUrl(
  name: FaviconName,
  accent: AccentName,
  theme: ThemeName,
  badge = false,
): string {
  const svg = faviconSvg(name, accentHex(accent, theme), badge);
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

let iconUrl = "/favicon.ico";
let current: Appearance = DEFAULT_APPEARANCE;
let badged = false;

/**
 * The plain, un-badged icon. Notification banners use this: the badge means
 * "something is waiting in a tab you cannot see", and a banner is already the
 * thing telling you that.
 */
export function currentIconUrl(): string {
  return iconUrl;
}

function applyIcon() {
  iconUrl = faviconDataUrl(current.favicon, current.faviconColor, current.theme);
  const href = badged
    ? faviconDataUrl(current.favicon, current.faviconColor, current.theme, true)
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
  applyIcon();

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
