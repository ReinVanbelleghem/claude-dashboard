/**
 * Inline SVG icons, in one outline style: 24-unit grid, 1.75 stroke, round caps
 * and joins, `currentColor` throughout so they follow the theme. Hand-written and
 * inlined, so the dashboard stays dependency-free and offline.
 */
import type { ReactNode } from "react";

function I({ children, className = "", style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      {children}
    </svg>
  );
}

export function FolderIcon({ open = false }: { open?: boolean }) {
  return (
    <I>
      {open ? (
        <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
      ) : (
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      )}
    </I>
  );
}

export function GitIcon() {
  return (
    <I>
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </I>
  );
}

export function SearchIcon() {
  return (
    <I>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </I>
  );
}

export function WorktreeIcon() {
  return (
    <I>
      <circle cx="12" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
      <path d="M12 12v3" />
    </I>
  );
}

export function PullRequestIcon() {
  return (
    <I>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <path d="M6 9v12" />
    </I>
  );
}

export function StarIcon({ filled = false }: { filled?: boolean }) {
  return (
    <I>
      <path
        d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"
        fill={filled ? "currentColor" : "none"}
      />
    </I>
  );
}

export function TrashIcon() {
  return (
    <I>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </I>
  );
}

export function RefreshIcon() {
  return (
    <I>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </I>
  );
}

export function PlusIcon() {
  return (
    <I>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </I>
  );
}

export function EditorIcon() {
  return (
    <I>
      <path d="m16 18 6-6-6-6" />
      <path d="m8 6-6 6 6 6" />
    </I>
  );
}

export function PencilIcon() {
  return (
    <I>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </I>
  );
}

/**
 * A file's type, as a small tinted tag: TSX, PY, JSON.
 *
 * Deliberately letters rather than brand logos. The rest of this set is hand-written
 * monochrome line work, so twenty vendor marks would be both a lot of drawing and a
 * different visual language — and at 15px a logo reads as a smudge while three
 * letters read as three letters. The colour does the sorting-at-a-glance; the hues
 * come from the syntax palette, so they follow the theme.
 */
const FILE_TYPES: Record<string, { label: string; hue: string }> = {
  ts: { label: "TS", hue: "var(--syn-fn)" },
  tsx: { label: "TSX", hue: "var(--syn-fn)" },
  mts: { label: "TS", hue: "var(--syn-fn)" },
  cts: { label: "TS", hue: "var(--syn-fn)" },
  js: { label: "JS", hue: "var(--syn-num)" },
  mjs: { label: "JS", hue: "var(--syn-num)" },
  cjs: { label: "JS", hue: "var(--syn-num)" },
  jsx: { label: "JSX", hue: "var(--syn-num)" },
  py: { label: "PY", hue: "var(--syn-str)" },
  pyi: { label: "PYI", hue: "var(--syn-str)" },
  go: { label: "GO", hue: "var(--syn-type)" },
  rs: { label: "RS", hue: "var(--serious)" },
  rb: { label: "RB", hue: "var(--syn-del)" },
  java: { label: "JAVA", hue: "var(--serious)" },
  kt: { label: "KT", hue: "var(--syn-kw)" },
  php: { label: "PHP", hue: "var(--syn-kw)" },
  c: { label: "C", hue: "var(--series-1)" },
  h: { label: "H", hue: "var(--series-1)" },
  cpp: { label: "C++", hue: "var(--series-1)" },
  cs: { label: "C#", hue: "var(--syn-kw)" },
  swift: { label: "SWFT", hue: "var(--serious)" },
  md: { label: "MD", hue: "var(--text-muted)" },
  mdx: { label: "MDX", hue: "var(--text-muted)" },
  txt: { label: "TXT", hue: "var(--text-muted)" },
  json: { label: "JSON", hue: "var(--syn-num)" },
  yaml: { label: "YML", hue: "var(--syn-type)" },
  yml: { label: "YML", hue: "var(--syn-type)" },
  toml: { label: "TOML", hue: "var(--text-muted)" },
  ini: { label: "INI", hue: "var(--text-muted)" },
  cfg: { label: "CFG", hue: "var(--text-muted)" },
  conf: { label: "CONF", hue: "var(--text-muted)" },
  env: { label: "ENV", hue: "var(--warning)" },
  lock: { label: "LOCK", hue: "var(--text-muted)" },
  css: { label: "CSS", hue: "var(--series-1)" },
  scss: { label: "SCSS", hue: "var(--series-1)" },
  less: { label: "LESS", hue: "var(--series-1)" },
  html: { label: "HTML", hue: "var(--series-2)" },
  htm: { label: "HTML", hue: "var(--series-2)" },
  xml: { label: "XML", hue: "var(--series-2)" },
  svg: { label: "SVG", hue: "var(--syn-kw)" },
  png: { label: "IMG", hue: "var(--syn-kw)" },
  jpg: { label: "IMG", hue: "var(--syn-kw)" },
  jpeg: { label: "IMG", hue: "var(--syn-kw)" },
  gif: { label: "IMG", hue: "var(--syn-kw)" },
  webp: { label: "IMG", hue: "var(--syn-kw)" },
  ico: { label: "IMG", hue: "var(--syn-kw)" },
  sh: { label: "SH", hue: "var(--syn-str)" },
  bash: { label: "SH", hue: "var(--syn-str)" },
  zsh: { label: "SH", hue: "var(--syn-str)" },
  fish: { label: "SH", hue: "var(--syn-str)" },
  sql: { label: "SQL", hue: "var(--syn-kw)" },
  csv: { label: "CSV", hue: "var(--syn-type)" },
  tsv: { label: "TSV", hue: "var(--syn-type)" },
  pdf: { label: "PDF", hue: "var(--critical)" },
  zip: { label: "ZIP", hue: "var(--text-muted)" },
};

/** Files that carry their type in the name instead of an extension. */
const FILE_NAMES: Record<string, { label: string; hue: string }> = {
  dockerfile: { label: "DOCK", hue: "var(--series-1)" },
  makefile: { label: "MAKE", hue: "var(--text-muted)" },
  license: { label: "LIC", hue: "var(--text-muted)" },
  ".gitignore": { label: "GIT", hue: "var(--serious)" },
  ".gitattributes": { label: "GIT", hue: "var(--serious)" },
  ".env": { label: "ENV", hue: "var(--warning)" },
};

function fileType(name: string): { label: string; hue: string } | null {
  const lower = name.toLowerCase();
  const named = FILE_NAMES[lower];
  if (named) return named;

  const dot = lower.lastIndexOf(".");
  // A leading dot is not an extension separator: ".eslintrc" is all name.
  const ext = dot > 0 ? lower.slice(dot + 1) : "";
  if (ext) return FILE_TYPES[ext] ?? { label: ext.slice(0, 4).toUpperCase(), hue: "var(--text-muted)" };

  // A dotfile with no extension labels itself from the name after the dot.
  if (lower.startsWith(".") && lower.length > 1)
    return { label: lower.slice(1, 4).toUpperCase(), hue: "var(--text-muted)" };
  return null;
}

export function FileTypeIcon({ name }: { name: string }) {
  const type = fileType(name);
  // Extensionless and unrecognised: a page, rather than a made-up label.
  if (!type) return <DocIcon />;
  return (
    <span className="ftype" style={{ color: type.hue }} aria-hidden="true">
      {type.label}
    </span>
  );
}

export function DocIcon() {
  return (
    <I>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </I>
  );
}

export function CheckIcon() {
  return (
    <I>
      <path d="M20 6 9 17l-5-5" />
    </I>
  );
}

/** Sun and moon stacked; CSS cross-fades them with the theme. */
export function SunMoonIcon() {
  return (
    <I className="sun-moon">
      <g className="sm-sun">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2m-7.07-15.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41" />
      </g>
      <path className="sm-moon" d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </I>
  );
}

/**
 * Notification state for one session. The struck-through bell is the muted face:
 * a bell alone cannot say whether it means "notifying" or "click to notify", and
 * the slash is the one convention everyone already reads correctly.
 */
export function BellIcon({ muted = false }: { muted?: boolean }) {
  return muted ? (
    <I>
      <path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <path d="M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742" />
      <path d="m2 2 20 20" />
      <path d="M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05" />
    </I>
  ) : (
    <I>
      <path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
    </I>
  );
}

export function CopyIcon() {
  return (
    <I>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </I>
  );
}

export function ClipIcon() {
  return (
    <I>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </I>
  );
}

export function TerminalIcon() {
  return (
    <I>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="m7 11 2-2-2-2" />
      <path d="M11 13h4" />
    </I>
  );
}

export function DrawerOpenIcon() {
  return (
    <I>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
    </I>
  );
}

export function FullPageIcon() {
  return (
    <I>
      <path d="M15 3h6v6" />
      <path d="m21 3-7 7" />
      <path d="m3 21 7-7" />
      <path d="M9 21H3v-6" />
    </I>
  );
}

export function TileWindowIcon() {
  return (
    <I>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M10 4v4" />
      <path d="M2 8h20" />
      <path d="M6 4v4" />
    </I>
  );
}

export function PulseIcon() {
  return (
    <I>
      <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
    </I>
  );
}

export function ClockIcon() {
  return (
    <I>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </I>
  );
}

export function ArtifactIcon() {
  return (
    <I>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M9 21V9" />
    </I>
  );
}

export function ChartIcon() {
  return (
    <I>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <path d="M18 17V9" />
      <path d="M13 17V5" />
      <path d="M8 17v-3" />
    </I>
  );
}

export function GearIcon() {
  return (
    <I>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </I>
  );
}

export function NineDotsIcon() {
  return (
    <I>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </I>
  );
}

export function ShowDesktopIcon() {
  return (
    <I>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </I>
  );
}

export function CommentIcon() {
  return (
    <I>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </I>
  );
}

export function EyeIcon() {
  return (
    <I>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </I>
  );
}

export function EyeOffIcon() {
  return (
    <I>
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
      <path d="m2 2 20 20" />
    </I>
  );
}

export function PlayIcon() {
  return (
    <I>
      <path d="M6 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L7.5 3.64A1 1 0 0 0 6 4.5z" />
    </I>
  );
}

export function StopIcon() {
  return (
    <I>
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
    </I>
  );
}

export function PromptIcon() {
  return (
    <I>
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </I>
  );
}

export function MoreIcon() {
  return (
    <I>
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="19" cy="12" r="1" fill="currentColor" />
      <circle cx="5" cy="12" r="1" fill="currentColor" />
    </I>
  );
}

export function LogsIcon() {
  return (
    <I>
      <path d="M15 12h-5" />
      <path d="M15 8h-5" />
      <path d="M19 17V5a2 2 0 0 0-2-2H4" />
      <path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" />
    </I>
  );
}

export function ChevronIcon({ dir = "down" }: { dir?: "up" | "down" }) {
  return (
    <I style={dir === "up" ? { transform: "rotate(180deg)" } : undefined}>
      <path d="m6 9 6 6 6-6" />
    </I>
  );
}

export function GripIcon() {
  return (
    <I>
      {[5, 12, 19].flatMap((y) =>
        [9, 15].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1" fill="currentColor" />),
      )}
    </I>
  );
}

export function PanelLeftIcon() {
  return (
    <I>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </I>
  );
}

export function HomeIcon() {
  return (
    <I>
      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
      <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </I>
  );
}

export function ArrowUpIcon() {
  return (
    <I>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </I>
  );
}

export function TagIcon() {
  return (
    <I>
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
      <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
    </I>
  );
}

export function XIcon() {
  return (
    <I>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </I>
  );
}

export function PinIcon({ filled = false }: { filled?: boolean }) {
  return (
    <I>
      <path d="M12 17v5" />
      <path
        d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"
        fill={filled ? "currentColor" : "none"}
      />
    </I>
  );
}

export function ExternalIcon() {
  return (
    <I>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </I>
  );
}
