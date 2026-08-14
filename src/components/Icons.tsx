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

export function CheckIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4.5 10.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
