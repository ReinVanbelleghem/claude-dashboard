import { useEffect, useMemo, useRef, useState } from "react";
import { prApi, type DiffSide, type DraftComment, type PrRef, type ReviewFile, type ReviewThread } from "../../api.ts";
import { langOf, pair, parsePatch, type FilePatch, type Line } from "../DiffView.tsx";
import { highlight } from "../highlight.tsx";
import { CommentEditor, LineComments, ThreadItem, ThreadMarker, type LineAnnotations, type ReviewHandlers } from "./PrComments.tsx";

/**
 * One changed file of a PR: the same hunk rendering as the git panel's DiffView,
 * with GitHub's review threads and your pending comments attached to their lines.
 *
 * GitHub hands out three lines of context per hunk. "More context" asks the daemon
 * for the same file's diff with more, cut from its local clone, and the card
 * re-renders from that patch instead — up to the whole file.
 */
const CONTEXT_STEPS = [3, 10, 30, 100_000];

type Composer = { side: DiffSide; line: number; startLine: number | null };

export type FileCardProps = {
  pr: PrRef;
  file: ReviewFile;
  index: number;
  baseSha: string;
  headSha: string;
  collapsed: boolean;
  mode: "unified" | "split";
  threads: ReviewThread[];
  drafts: DraftComment[];
  handlers: ReviewHandlers;
  onToggleCollapsed: () => void;
  onToggleViewed: () => void;
};

const sideOf = (l: Line, forced?: DiffSide): DiffSide => forced ?? (l.newNo !== null ? "RIGHT" : "LEFT");
const lineNo = (l: Line, side: DiffSide) => (side === "RIGHT" ? l.newNo : l.oldNo) as number;

export function PrFileCard({ pr, file, index, baseSha, headSha, collapsed, mode, threads, drafts, handlers, onToggleCollapsed, onToggleViewed }: FileCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [contextStep, setContextStep] = useState(0);
  const [expanded, setExpanded] = useState<{ step: number; patch: string } | null>(null);
  const [expandError, setExpandError] = useState<string | null>(null);
  const [loadingContext, setLoadingContext] = useState(false);
  const [outdatedOpen, setOutdatedOpen] = useState(false);
  const [composer, setComposer] = useState<Composer | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "1200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const oldPath = file.previousFilename ?? file.path;

  useEffect(() => {
    if (contextStep === 0 || expanded?.step === contextStep) return;
    let stale = false;
    setLoadingContext(true);
    setExpandError(null);
    prApi
      .fileDiff(pr, { base: baseSha, head: headSha, path: file.path, previous: file.previousFilename, context: CONTEXT_STEPS[contextStep] })
      .then((r) => {
        if (stale) return;
        if (r.ok) setExpanded({ step: contextStep, patch: r.patch });
        else setExpandError(r.error ?? "could not expand");
      })
      .catch((e: Error) => !stale && setExpandError(e.message))
      .finally(() => !stale && setLoadingContext(false));
    return () => {
      stale = true;
    };
  }, [contextStep]);

  const parsed: FilePatch | null = useMemo(() => {
    const source = expanded && expanded.step === contextStep ? expanded.patch : file.patch ? `--- a/${oldPath}\n+++ b/${file.path}\n${file.patch}` : null;
    if (!source) return null;
    return parsePatch(source)[0] ?? null;
  }, [file.patch, oldPath, file.path, expanded, contextStep]);

  const { byLine, outdated } = useMemo(() => {
    const map = new Map<string, LineAnnotations>();
    const slot = (side: DiffSide, line: number) => {
      const k = `${side}:${line}`;
      let v = map.get(k);
      if (!v) map.set(k, (v = { drafts: [], threads: [] }));
      return v;
    };
    const out: ReviewThread[] = [];
    for (const t of threads) {
      if (t.isOutdated || t.line == null) out.push(t);
      else slot(t.diffSide, t.line).threads.push(t);
    }
    for (const d of drafts) slot(d.side, d.line).drafts.push(d);
    return { byLine: map, outdated: out };
  }, [threads, drafts]);

  const lang = langOf(file.path);
  const commentCount = threads.length + drafts.length;

  /**
   * A click on a line's "+" opens the composer there; a shift-click on a later line
   * while it is open turns it into a range ending at the original line.
   */
  const startComment = (side: DiffSide, line: number, shift: boolean) => {
    setComposer((prev) => {
      if (prev && shift && prev.side === side && line !== prev.line) {
        return { side, line: Math.max(prev.line, line), startLine: Math.min(prev.line, line) };
      }
      if (prev && prev.side === side && prev.line === line && !shift) return null;
      return { side, line, startLine: null };
    });
  };

  const saveDraft = async (body: string) => {
    if (!composer) return;
    await prApi.addDraft(pr, { path: composer.side === "LEFT" ? oldPath : file.path, side: composer.side, line: composer.line, startLine: composer.startLine, body });
    handlers.reloadDrafts();
    setComposer(null);
  };

  const under = (l: Line, forced?: DiffSide) => {
    const side = sideOf(l, forced);
    const no = lineNo(l, side);
    const ann = byLine.get(`${side}:${no}`);
    const here = composer && composer.side === side && composer.line === no;
    if (!ann && !here) return null;
    return (
      <>
        {ann && <LineComments pr={pr} data={ann} handlers={handlers} />}
        {here && composer && (
          <div className="line-review">
            <CommentEditor
              submitLabel="Add review comment"
              placeholder={composer.startLine != null ? `Comment on lines ${composer.startLine}-${composer.line}` : `Comment on line ${composer.line}`}
              onCancel={() => setComposer(null)}
              onSubmit={saveDraft}
            />
          </div>
        )}
      </>
    );
  };

  const addButton = (l: Line, forced?: DiffSide) => {
    const side = sideOf(l, forced);
    return (
      <button
        className="diff-add-comment"
        title="Comment on this line (shift-click a later line for a range)"
        onClick={(e) => startComment(side, lineNo(l, side), e.shiftKey)}
      >
        +
      </button>
    );
  };

  const code = (l: Line, side: "old" | "new") => (
    <span className="diff-code" data-side={side} data-line={side === "new" ? l.newNo : l.oldNo}>
      {highlight(l.text, lang)}
    </span>
  );

  return (
    <div
      ref={ref}
      data-file-index={index}
      data-file-path={file.path}
      data-base-path={oldPath}
      className={`diff-file pr-file ${collapsed ? "closed" : ""}`}
      style={!visible ? { minHeight: Math.min(600, 60 + file.changes * 8) } : undefined}
    >
      <div className="diff-file-head-row pr-file-head">
        <button className="diff-file-head" onClick={onToggleCollapsed} aria-expanded={!collapsed}>
          <span className={`diff-caret ${collapsed ? "" : "open"}`} aria-hidden="true" />
          <span className="diff-path">
            {file.previousFilename && <span className="diff-from">{file.previousFilename} → </span>}
            {file.path}
          </span>
          <span className="diff-stat">
            {commentCount > 0 && <span className="diff-comments">{commentCount} 💬</span>}
            {file.additions > 0 && <span className="tok-add">+{file.additions}</span>}
            {file.deletions > 0 && <span className="tok-del">−{file.deletions}</span>}
          </span>
        </button>
        <div className="diff-actions pr-file-actions">
          {outdated.length > 0 && (
            <button className={`diff-act ${outdatedOpen ? "on" : ""}`} onClick={() => setOutdatedOpen((o) => !o)}>
              Outdated ({outdated.length})
            </button>
          )}
          {!collapsed && file.patch && (
            <button
              className="diff-act"
              disabled={loadingContext || contextStep === CONTEXT_STEPS.length - 1}
              onClick={() => setContextStep((s) => Math.min(s + 1, CONTEXT_STEPS.length - 1))}
              title="Show more lines around each change"
            >
              {loadingContext ? "…" : contextStep === CONTEXT_STEPS.length - 1 ? "whole file" : "more context"}
            </button>
          )}
          <label className="check pr-viewed">
            <input type="checkbox" checked={file.viewed} onChange={onToggleViewed} />
            <span>Viewed</span>
          </label>
        </div>
      </div>

      {outdatedOpen && outdated.length > 0 && (
        <div className="file-review">
          {outdated.map((t) =>
            handlers.panelOpen ? <ThreadMarker key={t.id} thread={t} handlers={handlers} /> : <ThreadItem key={t.id} pr={pr} thread={t} handlers={handlers} showLocation />,
          )}
        </div>
      )}

      {collapsed || !visible ? null : expandError ? (
        <div className="hint pr-file-note">
          Could not load more context: {expandError}
          <button className="link-btn inline" onClick={() => { setExpandError(null); setContextStep(0); }}>
            back to GitHub's hunks
          </button>
        </div>
      ) : !parsed ? (
        <div className="hint pr-file-note">
          {file.patchOmitted
            ? "GitHub did not include a patch for this file (too large)."
            : file.status === "renamed" || file.status === "copied"
              ? "File moved without changes."
              : "No textual changes (binary or empty file)."}
          {file.patchOmitted && (
            <button className="link-btn inline" onClick={() => setContextStep(1)}>
              load it from the local clone
            </button>
          )}
        </div>
      ) : parsed.binary ? (
        <div className="hint pr-file-note">Binary file — no textual diff.</div>
      ) : mode === "split" ? (
        <div className="diff-body split">
          {parsed.hunks.map((h, hi) => (
            <div key={hi}>
              <div className="diff-hunk">@@ {h.header || `hunk ${hi + 1}`}</div>
              {pair(h.lines).map((r, ri) => (
                <div key={ri}>
                  <div className="diff-row">
                    <span className={`diff-side ${r.left ? (r.left.kind === "ctx" ? "ctx" : "del") : "blank"} commentable`}>
                      <span className="diff-no">{r.left?.oldNo ?? ""}</span>
                      {r.left ? addButton(r.left, "LEFT") : <span className="diff-sign" />}
                      {r.left ? code(r.left, "old") : <span className="diff-code" />}
                    </span>
                    <span className={`diff-side ${r.right ? (r.right.kind === "ctx" ? "ctx" : "add") : "blank"} commentable`}>
                      <span className="diff-no">{r.right?.newNo ?? ""}</span>
                      {r.right ? addButton(r.right, "RIGHT") : <span className="diff-sign" />}
                      {r.right ? code(r.right, "new") : <span className="diff-code" />}
                    </span>
                  </div>
                  {r.left && under(r.left, "LEFT")}
                  {r.right && under(r.right, "RIGHT")}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="diff-body">
          {parsed.hunks.map((h, hi) => (
            <div key={hi}>
              <div className="diff-hunk">@@ {h.header || `hunk ${hi + 1}`}</div>
              {h.lines.map((l, li) => (
                <div key={li}>
                  <div className={`diff-line ${l.kind} commentable`}>
                    <span className="diff-no">{l.oldNo ?? ""}</span>
                    <span className="diff-no">{l.newNo ?? ""}</span>
                    {addButton(l)}
                    {code(l, l.newNo !== null ? "new" : "old")}
                  </div>
                  {under(l)}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
