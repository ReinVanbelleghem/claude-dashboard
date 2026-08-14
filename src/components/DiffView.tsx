import { useEffect, useMemo, useRef, useState } from "react";
import type { ReviewComment } from "../api.ts";
import { CommentThread, NewComment, type CommentHandlers } from "./ReviewComments.tsx";
import { highlight } from "./highlight.tsx";

/** Everything the diff needs to host a review, or nothing to stay read-only. */
export type ReviewProps = {
  comments: ReviewComment[];
  handlers: CommentHandlers;
  showResolved: boolean;
};

/**
 * Render a unified patch as either a unified or a side-by-side view.
 *
 * git only speaks unified, so split mode is derived here: each hunk's removed and
 * added runs are paired up row by row, which is what makes a changed line legible
 * next to what it replaced. Content is highlighted with the same lexer the
 * markdown code blocks use, keyed off the file extension.
 */

type Line = { kind: "ctx" | "add" | "del"; text: string; oldNo: number | null; newNo: number | null };
type Hunk = { header: string; lines: Line[] };
export type FilePatch = {
  path: string;
  from: string | null;
  hunks: Hunk[];
  binary: boolean;
  /** Set for a file with a mode/rename change and no textual hunks. */
  note: string | null;
  insertions: number;
  deletions: number;
};

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript",
  py: "python", sh: "bash", bash: "bash", zsh: "bash", go: "go", rs: "rust", sql: "sql",
  json: "json", yaml: "yaml", yml: "yaml", css: "css", scss: "css", html: "html", md: "markdown",
};

function langOf(path: string): string | undefined {
  return LANG_BY_EXT[path.split(".").pop()?.toLowerCase() ?? ""];
}

/** Split a multi-file patch into per-file structures with line numbers. */
export function parsePatch(patch: string): FilePatch[] {
  const files: FilePatch[] = [];
  let file: FilePatch | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const pushFile = () => {
    if (file) files.push(file);
  };

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      pushFile();
      // "diff --git a/x b/y" — take the b-side, which is the current name.
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(raw);
      file = {
        path: m?.[2] ?? raw.slice("diff --git ".length),
        from: null,
        hunks: [],
        binary: false,
        note: null,
        insertions: 0,
        deletions: 0,
      };
      hunk = null;
      continue;
    }
    if (!file) {
      // A single-file diff (git diff --no-index) has no "diff --git" header.
      if (raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("@@")) {
        file = { path: "", from: null, hunks: [], binary: false, note: null, insertions: 0, deletions: 0 };
      } else continue;
    }

    if (raw.startsWith("rename from ")) file.from = raw.slice("rename from ".length);
    else if (raw.startsWith("rename to ")) file.path = raw.slice("rename to ".length);
    else if (raw.startsWith("new file")) file.note = "new file";
    else if (raw.startsWith("deleted file")) file.note = "deleted";
    else if (raw.startsWith("Binary files")) file.binary = true;
    else if (raw.startsWith("+++ ")) {
      if (!file.path) file.path = raw.slice(6) || raw.slice(4);
    } else if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
      oldNo = Number(m?.[1] ?? 1);
      newNo = Number(m?.[3] ?? 1);
      hunk = { header: (m?.[5] ?? "").trim(), lines: [] };
      file.hunks.push(hunk);
    } else if (hunk) {
      // Every line inside a hunk carries a prefix character, so a truly empty
      // string is the artefact of splitting on a trailing newline — not a blank
      // context line, which git emits as a single space.
      if (raw === "") continue;
      if (raw.startsWith("+")) {
        hunk.lines.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
        file.insertions++;
      } else if (raw.startsWith("-")) {
        hunk.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null });
        file.deletions++;
      } else if (raw.startsWith("\\")) {
        // "\ No newline at end of file" — metadata, not content.
      } else {
        hunk.lines.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
      }
    }
  }
  pushFile();
  return files.filter((f) => f.path || f.hunks.length > 0);
}

const countLines = (f: FilePatch) => f.hunks.reduce((n, h) => n + h.lines.length, 0);

/** Beyond this many files, a diff is something you navigate rather than read. */
const AUTO_COLLAPSE_FILES = 5;
/** A single file this large buries whatever follows it. */
const AUTO_COLLAPSE_LINES = 300;

export function DiffView({
  patch,
  mode,
  emptyLabel = "No changes.",
  review,
}: {
  patch: string;
  mode: "unified" | "split";
  emptyLabel?: string;
  review?: ReviewProps;
}) {
  const files = useMemo(() => parsePatch(patch), [patch]);

  /**
   * Which files are folded. Seeded per patch: a small diff opens fully, while a
   * long one opens as a list of headers you can pick through — the same instinct
   * as a review UI, and it keeps a 4-file commit from becoming a scroll marathon.
   */
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const seeded = useRef<string>("");
  const keyOf = (f: FilePatch, i: number) => `${i}:${f.path}`;

  useEffect(() => {
    if (seeded.current === patch) return;
    seeded.current = patch;
    const many = files.length > AUTO_COLLAPSE_FILES;
    setClosed(
      new Set(
        files.flatMap((f, i) =>
          many || countLines(f) > AUTO_COLLAPSE_LINES ? [keyOf(f, i)] : [],
        ),
      ),
    );
  }, [patch, files]);

  if (files.length === 0) return <div className="empty">{emptyLabel}</div>;

  const total = files.reduce(
    (acc, f) => ({ add: acc.add + f.insertions, del: acc.del + f.deletions }),
    { add: 0, del: 0 },
  );
  const allClosed = closed.size === files.length;

  return (
    <div className="diff">
      {files.length > 1 && (
        <div className="diff-summary">
          <span>
            {files.length} files
            {total.add > 0 && <span className="tok-add"> +{total.add}</span>}
            {total.del > 0 && <span className="tok-del"> −{total.del}</span>}
          </span>
          <button
            className="link-btn inline"
            onClick={() =>
              setClosed(allClosed ? new Set() : new Set(files.map((f, i) => keyOf(f, i))))
            }
          >
            {allClosed ? "Expand all" : "Collapse all"}
          </button>
        </div>
      )}
      {files.map((f, i) => {
        const k = keyOf(f, i);
        return (
          <FileDiff
            key={k}
            file={f}
            mode={mode}
            review={review}
            open={!closed.has(k)}
            onToggle={() =>
              setClosed((prev) => {
                const next = new Set(prev);
                if (next.has(k)) next.delete(k);
                else next.add(k);
                return next;
              })
            }
          />
        );
      })}
    </div>
  );
}

function FileDiff({
  file,
  mode,
  open,
  onToggle,
  review,
}: {
  file: FilePatch;
  mode: "unified" | "split";
  open: boolean;
  onToggle: () => void;
  review?: ReviewProps;
}) {
  const lang = langOf(file.path);
  const lines = countLines(file);
  const [fileComment, setFileComment] = useState(false);
  const mine = review?.comments.filter((c) => c.path === file.path) ?? [];
  const openCount = mine.filter((c) => c.status === "open").length;
  return (
    <div className={`diff-file ${open ? "" : "closed"}`}>
      {/* The whole header toggles: a 3px chevron would be a silly click target. */}
      <button className="diff-file-head" onClick={onToggle} aria-expanded={open}>
        <span className={`diff-caret ${open ? "open" : ""}`} aria-hidden="true" />
        <span className="diff-path">
          {file.from && file.from !== file.path && <span className="diff-from">{file.from} → </span>}
          {file.path}
        </span>
        {file.note && <span className="chip muted">{file.note}</span>}
        <span className="diff-stat">
          {openCount > 0 && <span className="diff-comments">{openCount} 💬</span>}
          {!open && lines > 0 && <span className="diff-folded">{lines} lines</span>}
          {file.insertions > 0 && <span className="tok-add">+{file.insertions}</span>}
          {file.deletions > 0 && <span className="tok-del">−{file.deletions}</span>}
        </span>
      </button>

      {open && review && (
        <div className="file-review">
          {mine
            .filter((c) => c.line === null && (review.showResolved || c.status === "open"))
            .map((c) => (
              <CommentThread key={c.id} comment={c} handlers={review.handlers} />
            ))}
          {fileComment ? (
            <NewComment
              placeholder={`Comment on ${file.path}`}
              onCancel={() => setFileComment(false)}
              onSubmit={async (body) => {
                await review.handlers.add({ path: file.path, line: null, side: "new", anchorText: null, body });
                setFileComment(false);
              }}
            />
          ) : (
            <button className="link-btn inline" onClick={() => setFileComment(true)}>
              + comment on this file
            </button>
          )}
        </div>
      )}

      {!open ? null : file.binary ? (
        <div className="hint" style={{ padding: "10px 12px" }}>
          Binary file — no textual diff.
        </div>
      ) : file.hunks.length === 0 ? (
        <div className="hint" style={{ padding: "10px 12px" }}>
          No line changes{file.note ? ` (${file.note})` : ""}.
        </div>
      ) : mode === "split" ? (
        <SplitHunks file={file} lang={lang} review={review} />
      ) : (
        <UnifiedHunks file={file} lang={lang} review={review} />
      )}
    </div>
  );
}

function UnifiedHunks({
  file,
  lang,
  review,
}: {
  file: FilePatch;
  lang?: string;
  review?: ReviewProps;
}) {
  // Which line the composer is open on, keyed by side+number so the same number
  // on each side of a split cannot collide.
  const [adding, setAdding] = useState<string | null>(null);

  return (
    <div className="diff-body">
      {file.hunks.map((h, hi) => (
        <div key={hi}>
          <div className="diff-hunk">@@ {h.header || `hunk ${hi + 1}`}</div>
          {h.lines.map((l, li) => {
            const side: "old" | "new" = l.newNo !== null ? "new" : "old";
            const no = l.newNo ?? l.oldNo;
            const key = `${side}:${no}`;
            return (
              <div key={li}>
                <div className={`diff-line ${l.kind} ${review ? "commentable" : ""}`}>
                  <span className="diff-no">{l.oldNo ?? ""}</span>
                  <span className="diff-no">{l.newNo ?? ""}</span>
                  {review && no !== null ? (
                    <button
                      className="diff-add-comment"
                      title="Comment on this line"
                      onClick={() => setAdding(adding === key ? null : key)}
                    >
                      +
                    </button>
                  ) : (
                    <span className="diff-sign">
                      {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                    </span>
                  )}
                  <span className="diff-code">{highlight(l.text, lang)}</span>
                </div>
                {review && (
                  <LineReview
                    review={review}
                    path={file.path}
                    line={no}
                    side={side}
                    text={l.text}
                    composing={adding === key}
                    onDone={() => setAdding(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * Threads and the composer for one line. A comment is matched on line number and
 * side; if the line's text has changed since it was written, it is flagged rather
 * than quietly re-pointed at whatever now occupies that number.
 */
function LineReview({
  review,
  path,
  line,
  side,
  text,
  composing,
  onDone,
}: {
  review: ReviewProps;
  path: string;
  line: number | null;
  side: "old" | "new";
  text: string;
  composing: boolean;
  onDone: () => void;
}) {
  const here = review.comments.filter(
    (c) =>
      c.path === path &&
      c.line === line &&
      c.side === side &&
      (review.showResolved || c.status === "open"),
  );
  if (here.length === 0 && !composing) return null;

  return (
    <div className="line-review">
      {here.map((c) => (
        <CommentThread
          key={c.id}
          comment={c}
          handlers={review.handlers}
          adrift={!!c.anchorText && c.anchorText.trim() !== text.trim()}
        />
      ))}
      {composing && (
        <NewComment
          placeholder={`Comment on line ${line}`}
          onCancel={onDone}
          onSubmit={async (body) => {
            await review.handlers.add({ path, line, side, anchorText: text, body });
            onDone();
          }}
        />
      )}
    </div>
  );
}

/**
 * Pair each hunk's deletions against its insertions. Runs of equal length line up
 * one-to-one, which is the common case for an edited line; anything left over
 * becomes a row with one side blank.
 */
function pair(lines: Line[]): { left: Line | null; right: Line | null }[] {
  const rows: { left: Line | null; right: Line | null }[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === "ctx") {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    const dels: Line[] = [];
    const adds: Line[] = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}

function SplitHunks({
  file,
  lang,
  review,
}: {
  file: FilePatch;
  lang?: string;
  review?: ReviewProps;
}) {
  const [adding, setAdding] = useState<string | null>(null);
  return (
    <div className="diff-body split">
      {file.hunks.map((h, hi) => (
        <div key={hi}>
          <div className="diff-hunk">@@ {h.header || `hunk ${hi + 1}`}</div>
          {pair(h.lines).map((r, ri) => (
            <div key={ri}>
            <div className="diff-row">
              <span className={`diff-side ${r.left ? (r.left.kind === "ctx" ? "ctx" : "del") : "blank"}`}>
                <span className="diff-no">{r.left?.oldNo ?? ""}</span>
                <span className="diff-code">{r.left ? highlight(r.left.text, lang) : ""}</span>
              </span>
              <span className={`diff-side ${r.right ? (r.right.kind === "ctx" ? "ctx" : "add") : "blank"}`}>
                <span className="diff-no">{r.right?.newNo ?? ""}</span>
                {review && r.right && (
                  <button
                    className="diff-add-comment"
                    title="Comment on this line"
                    onClick={() =>
                      setAdding(adding === `new:${r.right!.newNo}` ? null : `new:${r.right!.newNo}`)
                    }
                  >
                    +
                  </button>
                )}
                <span className="diff-code">{r.right ? highlight(r.right.text, lang) : ""}</span>
              </span>
            </div>
            {/* Threads span the full width: a comment is about the change, not one column. */}
            {review && r.right && (
              <LineReview
                review={review}
                path={file.path}
                line={r.right.newNo}
                side="new"
                text={r.right.text}
                composing={adding === `new:${r.right.newNo}`}
                onDone={() => setAdding(null)}
              />
            )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
