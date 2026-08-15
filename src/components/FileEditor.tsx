import { useEffect, useMemo, useRef, useState } from "react";
import { fileApi } from "../api.ts";
import { highlight } from "./highlight.tsx";

/**
 * Edit one file from inside a diff.
 *
 * It edits the file on disk, not the patch: a diff is a description of a change, and
 * the only thing both scopes agree on is the working tree. That is what makes an edit
 * made from the whole-branch view show up as an uncommitted change a moment later —
 * there is one file, and both views are reading it.
 *
 * It stays a real <textarea> — every editing behaviour the OS gives you for free,
 * and no contenteditable selection bugs. The colour comes from the same lexer the
 * diffs use, painted on a <pre> directly underneath: the textarea's own text is
 * transparent, only its caret and selection show, and the two are kept in step by
 * sharing a font, a padding and a scroll position.
 */

/**
 * Past this, re-tokenising the whole file on every keystroke is felt. A file that
 * large is being edited by accident, so it drops to plain text rather than to lag.
 */
const HIGHLIGHT_MAX = 100_000;

const lineCountOf = (text: string) => (text ? text.split("\n").length : 1);

export function FileEditor({
  cwd,
  path,
  lang,
  changedLines,
  onClose,
  onSaved,
}: {
  cwd: string;
  path: string;
  /** Language for the highlighter, as worked out from the file extension. */
  lang?: string;
  /**
   * Lines this file's diff shows as added or modified, in current-file numbering.
   * They are marked in the gutter, the way an editor marks what a commit would take.
   */
  changedLines?: Set<number>;
  onClose: () => void;
  /** Called after the file is written, so the diff around it can be re-read. */
  onSaved: () => void;
}) {
  /** What was loaded: the text, and the hash the save is made against. */
  const [base, setBase] = useState<{ content: string; hash: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<{ text: string; hint: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const painted = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  /** Widen the gutter for a file long enough to need more digits. */
  const gutterWidth = `${Math.max(52, 26 + String(Math.max(1, lineCountOf(draft))).length * 8)}px`;

  /**
   * The trailing newline is deliberate: a textarea keeps a blank last line for the
   * caret when the content ends in one, and without the same line the painted layer
   * is a row short at the bottom of a scrolled file.
   */
  const coloured = useMemo(
    () => (draft.length > HIGHLIGHT_MAX ? [`${draft}\n`] : highlight(`${draft}\n`, lang)),
    [draft, lang],
  );

  useEffect(() => {
    let alive = true;
    setBase(null);
    setError(null);
    fileApi
      .read(cwd, path)
      .then((r) => {
        if (!alive) return;
        if (!r.ok) {
          setError({ text: r.error ?? "could not read this file", hint: null });
          return;
        }
        setBase({ content: r.content, hash: r.hash });
        setDraft(r.content);
      })
      .catch((e: Error) => alive && setError({ text: e.message, hint: null }));
    return () => {
      alive = false;
    };
  }, [cwd, path]);

  const dirty = !!base && draft !== base.content;

  const save = async () => {
    if (!base || !dirty || saving) return;
    setSaving(true);
    setError(null);
    const r = await fileApi
      .save(cwd, path, draft, base.hash)
      .catch((e: Error) => ({ ok: false, hash: null, error: e.message, hint: null }));
    setSaving(false);
    if (!r.ok) {
      setError({ text: r.error ?? "could not save", hint: r.hint ?? null });
      return;
    }
    onSaved();
    onClose();
  };

  /** Closing throws away unsaved text, so it is asked about rather than assumed. */
  const close = () => {
    if (dirty && !confirmClose) {
      setConfirmClose(true);
      return;
    }
    onClose();
  };

  const lines = lineCountOf(draft);

  /**
   * Change marks are the diff's line numbers, which only line up while the file has
   * the same number of lines it was read with. Add a line and every number below it
   * has moved, so the marks are dropped rather than shown against the wrong code —
   * saving re-reads the diff and brings back the true ones.
   */
  const baseLines = base ? lineCountOf(base.content) : 0;
  const marksValid = !!changedLines?.size && lines === baseLines;

  return (
    <div className="file-editor">
      <div className="file-editor-bar">
        <span className="file-editor-name">{path}</span>
        {base && (
          <span className="hint">
            {lines} line{lines === 1 ? "" : "s"}
            {dirty ? " · unsaved" : " · saved"}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {confirmClose ? (
          <>
            <span className="hint">Throw away your edits?</span>
            <button className="icon-btn tiny danger" onClick={onClose}>
              discard
            </button>
            <button className="icon-btn tiny" onClick={() => setConfirmClose(false)}>
              keep editing
            </button>
          </>
        ) : (
          <>
            <button className="icon-btn tiny" onClick={close} disabled={saving}>
              Close
            </button>
            <button className="icon-btn tiny primary" onClick={save} disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </>
        )}
      </div>

      {error && (
        <div className="git-msg bad">
          <pre>{error.text}</pre>
          {error.hint && <p>{error.hint}</p>}
        </div>
      )}

      {base === null ? (
        !error && <div className="empty">Reading file…</div>
      ) : (
        <div className="file-editor-code">
          {/* Numbers and change marks. Scrolls with the text vertically and never
              horizontally, which is the whole reason it is its own column. */}
          <div className="file-editor-gutter" aria-hidden="true" style={{ width: gutterWidth }}>
            <div className="file-editor-gutter-inner" ref={gutter}>
              {Array.from({ length: lines }, (_, i) => (
                <div
                  className={`gl ${marksValid && changedLines?.has(i + 1) ? "changed" : ""}`}
                  key={i}
                >
                  {i + 1}
                </div>
              ))}
            </div>
          </div>

          <div className="file-editor-text">
            {/* Underneath, and inert: it is the same text, painted. */}
            <pre className="file-editor-paint" ref={painted} aria-hidden="true">
              {coloured}
            </pre>
            <textarea
              ref={area}
              className="file-editor-area"
              value={draft}
              spellCheck={false}
              autoFocus
              // Whatever moves the text has to move the paint with it, including the
              // browser scrolling the caret into view on its own.
              onScroll={(e) => {
                const { scrollTop, scrollLeft } = e.currentTarget;
                if (painted.current) {
                  painted.current.scrollTop = scrollTop;
                  painted.current.scrollLeft = scrollLeft;
                }
                // Vertically only: the numbers stay put while the code slides sideways.
                if (gutter.current) gutter.current.style.transform = `translateY(${-scrollTop}px)`;
              }}
              onChange={(e) => {
                setDraft(e.target.value);
                setConfirmClose(false);
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "Enter")) {
                  e.preventDefault();
                  void save();
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  close();
                  return;
                }
                /**
                 * Tab indents instead of leaving the field. In a box you are editing code
                 * in, moving focus is never what Tab was meant to do — and losing the
                 * caret mid-line is worse than the accessibility cost, which Escape and
                 * the buttons still cover.
                 */
                if (e.key === "Tab") {
                  e.preventDefault();
                  const el = e.currentTarget;
                  const { selectionStart: a, selectionEnd: b } = el;
                  const next = `${draft.slice(0, a)}  ${draft.slice(b)}`;
                  setDraft(next);
                  requestAnimationFrame(() => {
                    el.selectionStart = el.selectionEnd = a + 2;
                  });
                }
              }}
              rows={Math.min(40, Math.max(8, lines + 1))}
            />
          </div>
        </div>
      )}
    </div>
  );
}
