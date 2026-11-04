import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { prApi, type Explanation, type ExplainPart, type ExplainTarget, type PrRef } from "../../api.ts";
import { Markdown } from "../Markdown.tsx";
import { TrashIcon } from "../Icons.tsx";

/**
 * Explain: select code in the diff, press ⌘⇧E (or the floating button), and a
 * session explains it as a summary plus a few parts. Drill into a part, ask a
 * question, or select text inside an explanation and explain that — each is one
 * more turn in the same session, shown as a child node.
 */
export type Anchor = { x: number; y: number };

export function anchorFromRange(range: Range): Anchor {
  const rects = range.getClientRects();
  const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
  return { x: Math.min(last.right, window.innerWidth - 140), y: Math.min(last.bottom + 6, window.innerHeight - 48) };
}

export function FloatingButton({ anchor, onClick, children }: { anchor: Anchor; onClick: () => void; children: ReactNode }) {
  return (
    <div data-explain-float className="pr-float" style={{ left: anchor.x, top: anchor.y }}>
      <button className="icon-btn primary tiny" onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
        {children}
      </button>
    </div>
  );
}

const elementOf = (n: Node | null) => (n instanceof Element ? n : (n?.parentElement ?? null));

/**
 * What is selected in the diff, as a file, side and line range. Works off the
 * `data-side` / `data-line` marks each code span carries, so it does not care
 * whether the view is split or unified.
 */
export function readDiffSelection(): { target: ExplainTarget; anchor: Anchor } | null {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const text = sel.toString();
  if (!text.trim()) return null;
  const range = sel.getRangeAt(0);
  const card = elementOf(range.commonAncestorContainer)?.closest<HTMLElement>("[data-file-path]");
  if (!card) return null;
  const anchorSide = elementOf(sel.anchorNode)?.closest<HTMLElement>("[data-side]")?.dataset.side;
  const spans = [...card.querySelectorAll<HTMLElement>(".diff-code[data-side]")].filter((el) => range.intersectsNode(el) && el.dataset.line);
  if (!spans.length) return null;
  const side = anchorSide === "old" ? "old" : spans.some((s) => s.dataset.side === "new") ? "new" : "old";
  const lines = spans.filter((s) => s.dataset.side === side).map((s) => Number(s.dataset.line));
  if (!lines.length) return null;
  const head = side === "new";
  return {
    anchor: anchorFromRange(range),
    target: {
      side: head ? "head" : "base",
      path: (head ? card.dataset.filePath : card.dataset.basePath) ?? "",
      startLine: Math.min(...lines),
      endLine: Math.max(...lines),
      code: text,
    },
  };
}

export function useDiffSelection(onExplain: (t: ExplainTarget) => void) {
  const [selection, setSelection] = useState<{ target: ExplainTarget; anchor: Anchor } | null>(null);
  useEffect(() => {
    const onUp = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.("[data-explain-float]")) return;
      setTimeout(() => setSelection(readDiffSelection()), 0);
    };
    const onChange = () => {
      if (document.getSelection()?.isCollapsed) setSelection(null);
    };
    const onScroll = () => setSelection(null);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "e") {
        const current = readDiffSelection();
        if (!current) return;
        e.preventDefault();
        onExplain(current.target);
        setSelection(null);
      }
    };
    document.addEventListener("mouseup", onUp);
    document.addEventListener("selectionchange", onChange);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("selectionchange", onChange);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onExplain]);
  const explain = useCallback(() => {
    if (!selection) return;
    onExplain(selection.target);
    setSelection(null);
  }, [selection, onExplain]);
  return { selection, explain };
}

const lineLabel = (a: number, b: number) => (a === b ? `${a}` : `${a}-${b}`);
const COLLAPSED_CODE = 8;

function CodeBlock({ code }: { code: string }) {
  const [open, setOpen] = useState(false);
  const lines = code.replace(/\n+$/, "").split("\n");
  const long = lines.length > COLLAPSED_CODE;
  return (
    <div className="pr-code">
      <pre>{(long && !open ? lines.slice(0, COLLAPSED_CODE) : lines).join("\n")}</pre>
      {long && (
        <button className="link-btn inline" onClick={() => setOpen((o) => !o)}>
          {open ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

type Tree = Map<string | null, Explanation[]>;

function AskBox({ placeholder, onSubmit }: { placeholder: string; onSubmit: (q: string) => void }) {
  const [q, setQ] = useState("");
  return (
    <input
      className="search pr-ask"
      value={q}
      placeholder={placeholder}
      onChange={(e) => setQ(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && q.trim()) {
          onSubmit(q.trim());
          setQ("");
        }
      }}
    />
  );
}

function PartCard({ node, part, index, tree, busy }: { node: Explanation; part: ExplainPart; index: number; tree: Tree; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const children = (tree.get(node.id) ?? []).filter((c) => c.drillPartIndex === index);
  return (
    <div className="pr-part">
      <div className="pr-part-head">
        <button className="pr-part-title" onClick={() => setOpen((o) => !o)}>
          <span className={`diff-caret ${open ? "open" : ""}`} aria-hidden="true" />
          <span>{part.title}</span>
        </button>
        <button className="link-btn inline" onClick={() => setAsking((a) => !a)}>
          Ask
        </button>
        <button className="link-btn inline" disabled={busy} onClick={() => prApi.drill(node.id, { partIndex: index }).catch(() => {})}>
          Drill down
        </button>
      </div>
      {open && (
        <div className="pr-part-body" data-explain-node={node.id}>
          <Markdown text={part.explanation} />
          {part.path && (
            <div className="pr-part-where">
              {part.path}
              {part.startLine ? `:${lineLabel(part.startLine, part.endLine ?? part.startLine)}` : ""}
            </div>
          )}
        </div>
      )}
      {asking && (
        <AskBox
          placeholder={`Ask about “${part.title}” — Enter to send`}
          onSubmit={(q) => {
            prApi.drill(node.id, { partIndex: index, question: q }).catch(() => {});
            setAsking(false);
          }}
        />
      )}
      {children.map((c) => (
        <div key={c.id} className="pr-children">
          <ExplanationNode node={c} tree={tree} />
        </div>
      ))}
    </div>
  );
}

function ExplanationNode({ node, tree }: { node: Explanation; tree: Tree }) {
  const isRoot = !node.parentId;
  const busy = node.status === "queued" || node.status === "running";
  const [asking, setAsking] = useState(false);
  const textChildren = (tree.get(node.id) ?? []).filter((c) => c.drillPartIndex == null);
  const remove = (
    <button className="icon-btn ghost square" title="Delete this explanation and everything under it" onClick={() => prApi.deleteExplanation(node.id).catch(() => {})}>
      <TrashIcon />
    </button>
  );
  return (
    <div className="pr-explanation">
      <div className="pr-explanation-head">
        <div className="pr-explanation-where">
          {isRoot ? (
            <>
              <span className="chip">
                {node.path.split("/").pop()}:{lineLabel(node.startLine, node.endLine)}
              </span>
              <span className={`pr-badge ${node.side === "head" ? "accent" : ""}`}>{node.side}</span>
              <span className="pr-explanation-path" title={node.path}>
                {node.path}
              </span>
            </>
          ) : node.drillText ? (
            <blockquote className="pr-drill-text">{node.drillText}</blockquote>
          ) : null}
          {node.question && <div className="pr-question">“{node.question}”</div>}
        </div>
        {remove}
      </div>
      {isRoot && node.code && <CodeBlock code={node.code} />}
      {busy && (
        <div className="pr-progress">
          <span className="pill thinking">
            <i className="dot" />
          </span>
          {node.status === "queued" ? "Starting a session…" : "Explaining…"}
        </div>
      )}
      {node.status === "failed" && <div className="pr-error">{node.error ?? "Failed"}</div>}
      {node.result && (
        <>
          <div className="pr-summary" data-explain-node={node.id}>
            <Markdown text={node.result.summary} />
          </div>
          <div className="pr-explanation-tools">
            <button className="link-btn inline" onClick={() => setAsking((a) => !a)}>
              Ask a question
            </button>
          </div>
          {asking && (
            <AskBox
              placeholder="Ask or push back — Enter to send"
              onSubmit={(q) => {
                prApi.drill(node.id, { question: q }).catch(() => {});
                setAsking(false);
              }}
            />
          )}
          {node.result.parts.map((part, i) => (
            <PartCard key={i} node={node} part={part} index={i} tree={tree} busy={false} />
          ))}
        </>
      )}
      {textChildren.map((c) => (
        <div key={c.id} className="pr-children">
          <ExplanationNode node={c} tree={tree} />
        </div>
      ))}
    </div>
  );
}

function PendingForm({ target, onSubmit, onCancel }: { target: ExplainTarget; onSubmit: (q: string) => void; onCancel: () => void }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="pr-pending"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        onSubmit(q.trim());
      }}
    >
      <div className="pr-explanation-where">
        <span className="chip">
          {target.path.split("/").pop()}:{lineLabel(target.startLine, target.endLine)}
        </span>
        <span className={`pr-badge ${target.side === "head" ? "accent" : ""}`}>{target.side}</span>
      </div>
      <CodeBlock code={target.code} />
      <input className="search" autoFocus value={q} placeholder="Ask something specific (optional)" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onCancel()} />
      <div className="comment-actions">
        <button type="button" className="icon-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="icon-btn primary" disabled={busy}>
          {busy ? "Starting…" : "Explain"}
        </button>
      </div>
    </form>
  );
}

export function PrExplainPanel({
  pr,
  explanations,
  pending,
  onClearPending,
}: {
  pr: PrRef;
  explanations: Explanation[];
  pending: ExplainTarget | null;
  onClearPending: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ nodeId: string; text: string; anchor: Anchor } | null>(null);

  const { tree, roots } = useMemo(() => {
    const byParent: Tree = new Map();
    for (const e of explanations) byParent.set(e.parentId, [...(byParent.get(e.parentId) ?? []), e]);
    return { tree: byParent, roots: [...(byParent.get(null) ?? [])].reverse() };
  }, [explanations]);

  // Selecting text inside an explanation offers to go one level deeper on just that.
  useEffect(() => {
    const onUp = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.("[data-explain-float]")) return;
      setTimeout(() => {
        const sel = document.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return setSelection(null);
        const range = sel.getRangeAt(0);
        const host = elementOf(range.commonAncestorContainer)?.closest<HTMLElement>("[data-explain-node]");
        const text = sel.toString().trim();
        if (!host || !text) return setSelection(null);
        setSelection({ nodeId: host.dataset.explainNode!, text, anchor: anchorFromRange(range) });
      }, 0);
    };
    const onChange = () => {
      if (document.getSelection()?.isCollapsed) setSelection(null);
    };
    document.addEventListener("mouseup", onUp);
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("selectionchange", onChange);
    };
  }, []);

  return (
    <aside className="pr-panel pr-explain">
      <div className="pr-panel-head">
        <strong>Explain</strong>
        <span className="hint">Select code, then ⌘⇧E</span>
      </div>
      <div className="pr-panel-body">
        {pending && (
          <PendingForm
            target={pending}
            onCancel={onClearPending}
            onSubmit={(q) => {
              setError(null);
              prApi
                .explain(pr, pending, q || undefined)
                .then(onClearPending)
                .catch((e: Error) => {
                  setError(e.message);
                  onClearPending();
                });
            }}
          />
        )}
        {error && <div className="pr-error">{error}</div>}
        {roots.map((root) => (
          <div key={root.id} className="pr-explanation-root">
            <ExplanationNode node={root} tree={tree} />
          </div>
        ))}
        {!roots.length && !pending && <div className="empty">Highlight code in the diff and press ⌘⇧E to get an explanation you can drill into.</div>}
      </div>
      {selection && (
        <FloatingButton
          anchor={selection.anchor}
          onClick={() => {
            prApi.drill(selection.nodeId, { text: selection.text }).catch((e: Error) => setError(e.message));
            setSelection(null);
            document.getSelection()?.removeAllRanges();
          }}
        >
          Explain this
        </FloatingButton>
      )}
    </aside>
  );
}
