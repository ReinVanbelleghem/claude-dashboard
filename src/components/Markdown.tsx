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

// ── copy-as-markdown ─────────────────────────────────────────────────────────
// A plain browser copy of rendered output yields flattened text: the `**`/`` ` ``/`#`
// syntax never existed in the DOM, only its visual effect. Intercepting `copy` and
// re-serializing the selected DOM subtree back into literal Markdown means a paste
// into Slack/Notion/a markdown file gets the real syntax instead of stripped prose.

// A fence has to be longer than the longest backtick run already inside the
// content, or the delimiters and the content merge into one indistinguishable
// run (CommonMark's rule for code spans/fences containing literal backticks).
function backtickFence(content: string, minLen = 1): string {
  const runs = content.match(/`+/g) ?? [];
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
  return "`".repeat(Math.max(minLen, longest + 1));
}

// Renders one node (text or element) by its own tag — as opposed to inlineToMd,
// which renders a node's children. Both a top-level selected child (handled here
// directly) and a nested child (reached via inlineToMd's loop) must resolve to
// the same wrapping, so this is the single place that switches on tag name.
function inlineNodeToMd(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  const el = node as HTMLElement;
  switch (el.tagName) {
    case "BR":
      return "\n";
    case "STRONG":
    case "B":
      return `**${inlineToMd(el)}**`;
    case "EM":
    case "I":
      return `*${inlineToMd(el)}*`;
    case "S":
    case "STRIKE":
    case "DEL":
      return `~~${inlineToMd(el)}~~`;
    case "CODE": {
      const content = el.textContent ?? "";
      const fence = backtickFence(content);
      const pad = content.startsWith("`") || content.endsWith("`") || content === "" ? " " : "";
      return `${fence}${pad}${content}${pad}${fence}`;
    }
    case "A":
      return `[${inlineToMd(el)}](${el.getAttribute("href") ?? ""})`;
    default: {
      const block = elementToBlockMd(el);
      return block !== null ? `\n${block}\n` : inlineToMd(el);
    }
  }
}

function inlineToMd(node: Node): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) out += inlineNodeToMd(child);
  return out;
}

// Ordered-ness can't be recovered once a selection has clipped off the `<ol>`
// wrapper and left only bare `<li>` siblings (see nodesToMarkdown) — those fall
// back to `-` markers, a safe approximation rather than a perfect round-trip.
function renderListItems(items: HTMLElement[], ordered: boolean): string {
  return items
    .map((li, idx) => {
      const depthMatch = (li.className || "").match(/md-d(\d)/);
      const depth = depthMatch ? Number(depthMatch[1]) : 0;
      const indent = "  ".repeat(depth);
      const marker = ordered ? `${idx + 1}.` : "-";
      const text = inlineToMd(li).split("\n").join(`\n${indent}  `);
      return `${indent}${marker} ${text}`;
    })
    .join("\n");
}

function elementToBlockMd(el: HTMLElement): string | null {
  const tag = el.tagName;
  const cls = el.className || "";

  if (/^H[1-6]$/.test(tag)) {
    const m = cls.match(/md-h(\d)/);
    const level = m ? Math.max(1, Math.min(6, Number(m[1]))) : Number(tag[1]);
    return `${"#".repeat(level)} ${inlineToMd(el)}`;
  }
  if (tag === "HR") return "---";
  if (tag === "P") return inlineToMd(el);
  if (tag === "BLOCKQUOTE") {
    return nodesToMarkdown(el)
      .split("\n")
      .map((l) => (l ? `> ${l}` : ">"))
      .join("\n");
  }
  if (tag === "UL" || tag === "OL") {
    const items = Array.from(el.children).filter((c) => c.tagName === "LI") as HTMLElement[];
    return renderListItems(items, tag === "OL");
  }
  if (cls.includes("md-code-wrap")) {
    const source = el.querySelector("code")?.textContent ?? "";
    const lang = el.querySelector(".md-lang")?.textContent ?? "";
    const fence = backtickFence(source, 3);
    return `${fence}${lang}\n${source}\n${fence}`;
  }
  if (cls.includes("md-table-wrap") || tag === "TABLE") {
    const table = tag === "TABLE" ? el : el.querySelector("table");
    const rows = table ? Array.from(table.querySelectorAll("tr")) : [];
    if (rows.length === 0) return "";
    const rowToCells = (row: Element) =>
      Array.from(row.children).map((cell) => inlineToMd(cell as HTMLElement).trim() || " ");
    const header = rowToCells(rows[0]);
    const body = rows.slice(1).map(rowToCells);
    const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
    return [line(header), line(header.map(() => "---")), ...body.map(line)].join("\n");
  }
  if (cls.split(/\s+/).includes("md")) return nodesToMarkdown(el);

  return null;
}

function nodesToMarkdown(container: Node): string {
  const parts: string[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer.trim()) parts.push(buffer);
    buffer = "";
  };
  const children = Array.from(container.childNodes);
  let i = 0;
  while (i < children.length) {
    const child = children[i];
    if (child.nodeType === Node.TEXT_NODE) {
      buffer += child.textContent ?? "";
      i++;
      continue;
    }
    const el = child as HTMLElement;
    // A selection can clip off the `<ul>`/`<ol>` wrapper, leaving bare `<li>`
    // siblings as direct children here — group them back into one list.
    if (el.tagName === "LI") {
      flush();
      const items: HTMLElement[] = [];
      while (i < children.length && (children[i] as HTMLElement).tagName === "LI") {
        items.push(children[i] as HTMLElement);
        i++;
      }
      parts.push(renderListItems(items, false));
      continue;
    }
    const block = elementToBlockMd(el);
    if (block !== null) {
      flush();
      if (block.trim()) parts.push(block);
    } else {
      buffer += inlineNodeToMd(el);
    }
    i++;
  }
  flush();
  return parts.join("\n\n");
}

/**
 * Attach to the outermost scroll/message container, not to each individual
 * `.md` block — a selection often starts outside rendered markdown (e.g. in a
 * turn's timestamp header) and the native `copy` event only bubbles through
 * the DOM ancestors of wherever the selection actually lives. Serializing
 * from a container above everything means the reconstruction always runs,
 * regardless of where the selection starts or ends.
 */
export function handleMdCopy(e: React.ClipboardEvent<HTMLDivElement>) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !e.clipboardData) return;
  const container = document.createElement("div");
  container.appendChild(selection.getRangeAt(0).cloneContents());
  const md = nodesToMarkdown(container).trim();
  if (!md) return;
  e.preventDefault();
  e.clipboardData.setData("text/plain", md);
}

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
