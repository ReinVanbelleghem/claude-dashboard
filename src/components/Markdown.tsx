import { useCallback, useRef, useState, type ReactNode } from "react";
import { highlight } from "./highlight.tsx";
import { CheckIcon, CopyIcon } from "./Icons.tsx";

/**
 * A small, dependency-free Markdown renderer for transcript text.
 *
 * It emits React elements rather than HTML, so nothing here can inject markup —
 * transcripts contain arbitrary model and tool output and are never trusted.
 * The supported subset is what Claude actually writes: headings, fenced code,
 * lists, tables, blockquotes, rules, and inline code/bold/italic/links.
 */

/**
 * A fenced code block. The language tag and the copy button live on the wrapper
 * rather than inside the <pre>, so they stay pinned to the top-right corner
 * instead of scrolling away with long lines.
 */
function CodeBlock({ source, lang }: { source: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(source);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1400);
  }, [source]);

  return (
    <div className="md-code-wrap">
      <div className="md-code-tools">
        {lang && <span className="md-lang">{lang}</span>}
        <button
          type="button"
          className={`md-copy${copied ? " copied" : ""}`}
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy code"}
          title={copied ? "Copied" : "Copy code"}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
      <pre className="md-code">
        <code>{highlight(source, lang)}</code>
      </pre>
    </div>
  );
}

// ── inline ────────────────────────────────────────────────────────────────────
// One alternation pass keeps precedence explicit: code spans win over emphasis,
// so `**not bold**` inside backticks stays literal.
const INLINE =
  /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|(?<![\w*])\*([^*\n]+?)\*(?![\w*])|(?<![\w_])_([^_\n]+?)_(?![\w_])|~~([\s\S]+?)~~|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()"']+)/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyPrefix}-${i++}`;
    const [, , code, strong1, strong2, em1, em2, strike, linkText, linkHref, bareUrl] = m;
    if (code !== undefined) out.push(<code key={key}>{code.trim()}</code>);
    else if (strong1 ?? strong2) out.push(<strong key={key}>{inline(strong1 ?? strong2, key)}</strong>);
    else if (em1 ?? em2) out.push(<em key={key}>{inline(em1 ?? em2, key)}</em>);
    else if (strike !== undefined) out.push(<s key={key}>{inline(strike, key)}</s>);
    else if (linkHref !== undefined)
      out.push(
        <a key={key} href={safeHref(linkHref)} target="_blank" rel="noreferrer">
          {linkText}
        </a>,
      );
    else if (bareUrl !== undefined)
      out.push(
        <a key={key} href={safeHref(bareUrl)} target="_blank" rel="noreferrer">
          {bareUrl}
        </a>,
      );
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Only http(s) links are followed; anything else renders as plain text href-less. */
function safeHref(href: string): string {
  return /^https?:\/\//i.test(href) ? href : "#";
}

// ── blocks ────────────────────────────────────────────────────────────────────
type Row = string[];

function splitRow(line: string): Row {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

const isTableDivider = (line: string) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const k = () => `b${key++}`;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code. An unterminated fence (a truncated turn) runs to the end.
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/);
    if (fence) {
      const marker = fence[1][0].repeat(3);
      const lang = fence[2];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) body.push(lines[i++]);
      i++;
      blocks.push(<CodeBlock key={k()} source={body.join("\n")} lang={lang} />);
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${Math.min(6, level + 2)}` as "h3";
      blocks.push(
        <Tag className={`md-h md-h${level}`} key={k()}>
          {inline(heading[2], k())}
        </Tag>,
      );
      i++;
      continue;
    }

    if (/^\s*(-\s*){3,}$|^\s*(\*\s*){3,}$|^\s*(_\s*){3,}$/.test(line)) {
      blocks.push(<hr className="md-hr" key={k()} />);
      i++;
      continue;
    }

    // Table: a header row followed by a --- divider.
    if (line.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const body: Row[] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) body.push(splitRow(lines[i++]));
      blocks.push(
        <div className="md-table-wrap" key={k()}>
          <table className="md-table">
            <thead>
              <tr>
                {head.map((c, n) => (
                  <th key={n}>{inline(c, `${k()}-h${n}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, r) => (
                <tr key={r}>
                  {row.map((c, n) => (
                    <td key={n}>{inline(c, `${k()}-c${r}-${n}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push(
        <blockquote className="md-quote" key={k()}>
          <Markdown text={body.join("\n")} />
        </blockquote>,
      );
      continue;
    }

    // Lists. Indentation is preserved as a depth class rather than real nesting:
    // flat output with an inset reads the same and cannot mis-nest.
    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: { depth: number; text: string }[] = [];
      while (i < lines.length) {
        const m = lines[i].match(bullet);
        if (m) {
          items.push({ depth: Math.min(3, Math.floor(m[1].length / 2)), text: m[3] });
          i++;
        } else if (/^\s{2,}\S/.test(lines[i]) && items.length > 0) {
          // Continuation line of the previous item.
          items[items.length - 1].text += `\n${lines[i].trim()}`;
          i++;
        } else break;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List className="md-list" key={k()}>
          {items.map((it, n) => (
            <li className={`md-d${it.depth}`} key={n}>
              {inline(it.text, `${k()}-i${n}`)}
            </li>
          ))}
        </List>,
      );
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1]))
    ) {
      para.push(lines[i++]);
    }
    if (para.length > 0) {
      blocks.push(
        <p className="md-p" key={k()}>
          {inline(para.join("\n"), k())}
        </p>,
      );
      continue;
    }
    i++;
  }

  return <div className="md">{blocks}</div>;
}
