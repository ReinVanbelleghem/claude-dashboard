/**
 * Inline SVG icons. Small enough to hand-write, and inlining them keeps the
 * dashboard dependency-free and offline — no icon font, no sprite fetch.
 * All of them inherit `currentColor` so they follow the theme.
 */

export function FolderIcon({ open = false }: { open?: boolean }) {
  return (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
      {open ? (
        <path
          d="M2.5 6.5A1.5 1.5 0 014 5h3.6c.4 0 .78.16 1.06.44L9.9 6.5H16A1.5 1.5 0 0117.5 8H6.8a1.5 1.5 0 00-1.43 1.05L3.6 15H4a1.5 1.5 0 01-1.5-1.5v-7z"
          fill="currentColor"
          opacity="0.9"
        />
      ) : (
        <path
          d="M2.5 6A1.5 1.5 0 014 4.5h3.38c.4 0 .78.16 1.06.44l1.12 1.12H16A1.5 1.5 0 0117.5 7.5v6A1.5 1.5 0 0116 15H4a1.5 1.5 0 01-1.5-1.5V6z"
          fill="currentColor"
          opacity="0.9"
        />
      )}
    </svg>
  );
}

export function GitIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="6" cy="5" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="6" cy="15" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="14" cy="10" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6 7.1v5.8M8.1 14A5 5 0 0012 10.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export function StarIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M10 2.8l2.2 4.5 4.9.7-3.5 3.5.8 4.9L10 14.1l-4.4 2.3.8-4.9L2.9 8l4.9-.7L10 2.8z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M4.5 6.5h11M8 6.5V5a1 1 0 011-1h2a1 1 0 011 1v1.5M6 6.5l.6 8a1.5 1.5 0 001.5 1.4h3.8a1.5 1.5 0 001.5-1.4l.6-8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 4.5v11M4.5 10h11" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

/**
 * "Open this in the editor". Angle brackets rather than the VS Code mark: the logo
 * is a two-tone ribbon that reads as a smudge at 14px in one colour, and the rest of
 * the set is monochrome line work.
 */
export function EditorIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M7.4 6.5L3.5 10l3.9 3.5M12.6 6.5L16.5 10l-3.9 3.5M11.2 4.8l-2.4 10.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PencilIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M4 16l.9-3.3 7.7-7.7a1.6 1.6 0 012.3 0l.1.1a1.6 1.6 0 010 2.3l-7.7 7.7L4 16z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
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
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M5.5 3.5h6l3.5 3.5v9a1 1 0 01-1 1h-8.5a1 1 0 01-1-1v-11a1 1 0 011-1zM11.5 3.5V7H15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4.5 10.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The mode toggle's face: a sun and a moon in one 24×24 box, both always present so
 * CSS can swap them with a transition. Which one shows is decided by the theme on the
 * root element, not by a prop — the swap has to animate, and a remount cannot.
 *
 * The rays are generated rather than written out: eight identical lines differing only
 * by angle is a loop, and hand-rounded coordinates for each would be noise.
 */
export function SunMoonIcon() {
  const rays = Array.from({ length: 8 }, (_, i) => {
    const angle = (i * Math.PI) / 4;
    const at = (r: number) => [12 + Math.cos(angle) * r, 12 + Math.sin(angle) * r] as const;
    const [x1, y1] = at(7.4);
    const [x2, y2] = at(10);
    return { x1, y1, x2, y2 };
  });
  return (
    <svg className="icon sun-moon" viewBox="0 0 24 24" aria-hidden="true">
      <g className="sm-sun">
        <circle cx="12" cy="12" r="4.2" fill="currentColor" />
        <g stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
          {rays.map((r, i) => (
            <line key={i} x1={r.x1.toFixed(2)} y1={r.y1.toFixed(2)} x2={r.x2.toFixed(2)} y2={r.y2.toFixed(2)} />
          ))}
        </g>
      </g>
      <path
        className="sm-moon"
        d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"
        fill="currentColor"
      />
    </svg>
  );
}
