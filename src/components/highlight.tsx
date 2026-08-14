import { type ReactNode } from "react";

/**
 * Syntax highlighting for fenced code blocks.
 *
 * Hand-written for the same reason the markdown renderer is: it emits React
 * elements rather than HTML, so nothing in a transcript can inject markup, and it
 * costs no dependency, no WASM download and no async load. The trade is depth —
 * this is a lexer, not a parser, so it colours comments, strings, numbers,
 * keywords and call sites, and does not attempt semantic accuracy.
 *
 * Unknown languages still get comments, strings and numbers, which is most of the
 * benefit for the price of nothing.
 */

type Spec = {
  /** Line-comment prefixes, longest first so `///` beats `//`. */
  line: string[];
  block?: [string, string];
  quotes: string[];
  /** Triple-quoted strings (Python docstrings, template blocks). */
  triple?: string[];
  keywords: Set<string>;
  builtins?: Set<string>;
  /** SQL keywords are conventionally written in either case. */
  fold?: boolean;
};

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const PY = words(`
  and as assert async await break class continue def del elif else except finally for from global
  if import in is lambda match nonlocal not or pass raise return try while with yield case
`);
const PY_BUILTINS = words(`
  self cls True False None print len range dict list set tuple str int float bool bytes type
  isinstance issubclass super property staticmethod classmethod enumerate zip map filter sorted
  any all sum min max abs open Exception ValueError TypeError KeyError RuntimeError
`);

const JS = words(`
  as async await break case catch class const continue debugger default delete do else enum export
  extends finally for from function get if implements import in instanceof interface let new of
  private protected public readonly return satisfies set static super switch this throw try type
  typeof var void while with yield declare namespace keyof infer asserts abstract override
`);
const JS_BUILTINS = words(`
  true false null undefined NaN Infinity console window document globalThis process Promise Array
  Object String Number Boolean Symbol Map Set WeakMap Date JSON Math RegExp Error require module
`);

const SH = words(`
  if then else elif fi for while until do done case esac function in select time coproc return
  export local readonly declare unset shift source alias set trap exit break continue
`);
const SH_BUILTINS = words(`
  echo cd ls cat grep sed awk curl git npm bun node python python3 mkdir rm cp mv touch chmod
  kill sleep test printf read pwd sudo docker jq xargs find sort uniq head tail wc which
`);

const GO = words(`
  break case chan const continue default defer else fallthrough for func go goto if import
  interface map package range return select struct switch type var
`);
const RUST = words(`
  as async await break const continue crate dyn else enum extern false fn for if impl in let loop
  match mod move mut pub ref return self Self static struct super trait true type unsafe use where
  while
`);
const SQL = words(`
  select from where group by having order limit offset join left right inner outer full cross on
  as and or not null is in like between exists union all insert into values update set delete
  create table alter drop index view with distinct case when then else end asc desc count sum avg
  min max coalesce cast returning primary key foreign references default constraint
`);
const CSS_KW = words(`
  important media supports keyframes import font-face root from to and not only
`);

const SPECS: Record<string, Spec> = {
  python: { line: ["#"], quotes: ['"', "'"], triple: ['"""', "'''"], keywords: PY, builtins: PY_BUILTINS },
  javascript: { line: ["//"], block: ["/*", "*/"], quotes: ['"', "'", "`"], keywords: JS, builtins: JS_BUILTINS },
  typescript: { line: ["//"], block: ["/*", "*/"], quotes: ['"', "'", "`"], keywords: JS, builtins: JS_BUILTINS },
  bash: { line: ["#"], quotes: ['"', "'"], keywords: SH, builtins: SH_BUILTINS },
  go: { line: ["//"], block: ["/*", "*/"], quotes: ['"', "`"], keywords: GO },
  rust: { line: ["//"], block: ["/*", "*/"], quotes: ['"'], keywords: RUST },
  sql: { line: ["--"], block: ["/*", "*/"], quotes: ["'", '"'], keywords: SQL, fold: true },
  json: { line: [], quotes: ['"'], keywords: words("true false null") },
  yaml: { line: ["#"], quotes: ['"', "'"], keywords: words("true false null yes no on off") },
  css: { line: [], block: ["/*", "*/"], quotes: ['"', "'"], keywords: CSS_KW },
  html: { line: [], block: ["<!--", "-->"], quotes: ['"', "'"], keywords: new Set() },
};

/** Language names as people write them in fences. */
const ALIASES: Record<string, string> = {
  py: "python",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  golang: "go",
  rs: "rust",
  postgres: "sql",
  psql: "sql",
  yml: "yaml",
  scss: "css",
  xml: "html",
  htm: "html",
};

const FALLBACK: Spec = { line: ["#", "//"], quotes: ['"', "'", "`"], keywords: new Set() };

type Tok = { text: string; cls?: string };

export function highlight(code: string, lang?: string): ReactNode[] {
  const key = ALIASES[(lang ?? "").toLowerCase()] ?? (lang ?? "").toLowerCase();
  if (key === "diff" || key === "patch") return render(diffTokens(code));
  const spec = SPECS[key] ?? FALLBACK;
  return render(tokenize(code, spec));
}

function render(tokens: Tok[]): ReactNode[] {
  return tokens.map((t, i) =>
    t.cls ? (
      <span key={i} className={t.cls}>
        {t.text}
      </span>
    ) : (
      t.text
    ),
  );
}

/** A diff is coloured by line, so its own pass rather than a lexer. */
function diffTokens(code: string): Tok[] {
  return code.split("\n").flatMap((line, i, arr) => {
    const text = i === arr.length - 1 ? line : `${line}\n`;
    if (/^\+\+\+|^---|^diff |^index /.test(line)) return [{ text, cls: "tok-meta" }];
    if (line.startsWith("@@")) return [{ text, cls: "tok-fn" }];
    if (line.startsWith("+")) return [{ text, cls: "tok-add" }];
    if (line.startsWith("-")) return [{ text, cls: "tok-del" }];
    return [{ text }];
  });
}

const ID_START = /[A-Za-z_$@]/;
const ID_PART = /[A-Za-z0-9_$-]/;

function tokenize(code: string, spec: Spec): Tok[] {
  const out: Tok[] = [];
  let plain = "";
  let i = 0;

  const flush = () => {
    if (plain) {
      out.push({ text: plain });
      plain = "";
    }
  };
  const push = (text: string, cls: string) => {
    flush();
    out.push({ text, cls });
  };

  while (i < code.length) {
    const rest = code.slice(i);

    // Comments first: everything else may legally appear inside one.
    const line = spec.line.find((p) => rest.startsWith(p));
    if (line) {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? code.length : end;
      push(code.slice(i, stop), "tok-com");
      i = stop;
      continue;
    }
    if (spec.block && rest.startsWith(spec.block[0])) {
      const close = code.indexOf(spec.block[1], i + spec.block[0].length);
      const stop = close === -1 ? code.length : close + spec.block[1].length;
      push(code.slice(i, stop), "tok-com");
      i = stop;
      continue;
    }

    // Triple-quoted strings before single, or the first two quotes read as an
    // empty string and the body leaks out unstyled.
    const triple = spec.triple?.find((q) => rest.startsWith(q));
    if (triple) {
      const close = code.indexOf(triple, i + triple.length);
      const stop = close === -1 ? code.length : close + triple.length;
      push(code.slice(i, stop), "tok-str");
      i = stop;
      continue;
    }

    const quote = spec.quotes.find((q) => rest.startsWith(q));
    if (quote) {
      let j = i + quote.length;
      while (j < code.length) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code.startsWith(quote, j)) {
          j += quote.length;
          break;
        }
        // An unterminated quote should not swallow the rest of the file; most
        // languages do not allow a raw newline inside a plain string.
        if (code[j] === "\n" && quote !== "`") break;
        j++;
      }
      push(code.slice(i, j), "tok-str");
      i = j;
      continue;
    }

    // Numbers, including hex, floats and exponents.
    if (/[0-9]/.test(code[i]) && !(i > 0 && ID_PART.test(code[i - 1]))) {
      const m = /^(0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9]+)?)/.exec(rest);
      if (m) {
        push(m[0], "tok-num");
        i += m[0].length;
        continue;
      }
    }

    if (ID_START.test(code[i])) {
      let j = i + 1;
      while (j < code.length && ID_PART.test(code[j])) j++;
      const word = code.slice(i, j);
      const probe = spec.fold ? word.toLowerCase() : word;
      // A trailing "(" makes it a call; that reads better than colouring every
      // identifier the same, and needs no scope analysis.
      const isCall = /^\s*\(/.test(code.slice(j));

      if (spec.keywords.has(probe)) push(word, "tok-kw");
      else if (spec.builtins?.has(word)) push(word, "tok-builtin");
      else if (isCall) push(word, "tok-fn");
      else if (/^[A-Z][A-Za-z0-9_]*$/.test(word)) push(word, "tok-type");
      else if (word.startsWith("@")) push(word, "tok-meta");
      else plain += word;
      i = j;
      continue;
    }

    plain += code[i];
    i++;
  }

  flush();
  return out;
}
