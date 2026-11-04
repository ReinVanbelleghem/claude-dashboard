import { useState, type ReactNode } from "react";
import { fmtAgo, prApi, type CommentKind, type DraftComment, type PrRef, type ReviewThread } from "../../api.ts";
import { Markdown } from "../Markdown.tsx";
import { TrashIcon } from "../Icons.tsx";

/**
 * Comments inside a PR diff: GitHub review threads, and the pending comments you are
 * collecting locally before submitting them as one review.
 */
export type LineAnnotations = { drafts: DraftComment[]; threads: ReviewThread[] };

const WEEK_MS = 7 * 86_400_000;

/** "3m ago" while it is recent, the date once it is not; the exact time sits in the tooltip. */
export function commentTime(iso: string): string {
  const ms = new Date(iso).getTime();
  return Date.now() - ms < WEEK_MS ? fmtAgo(ms) : new Date(ms).toLocaleDateString();
}

export type ReviewHandlers = {
  /** The GitHub login looking at the page, so their own comments offer edit and delete. */
  viewer: string | null;
  reloadThreads: () => void;
  reloadDrafts: () => void;
  /** Which thread is highlighted, shared with the Conversations panel. */
  activeThread: string | null;
  setActiveThread: (id: string | null) => void;
  /** With the Conversations panel open, threads show as one-line markers in the diff. */
  panelOpen: boolean;
};

export function CommentEditor({
  initial = "",
  submitLabel,
  placeholder,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  submitLabel: string;
  placeholder?: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initial);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const can = body.trim().length > 0 && !busy;
  const submit = async () => {
    if (!can) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="comment new pr-editor" onMouseDown={(e) => e.stopPropagation()}>
      <div className="seg pr-editor-tabs">
        <button className={preview ? "" : "active"} onClick={() => setPreview(false)}>
          Write
        </button>
        <button className={preview ? "active" : ""} onClick={() => setPreview(true)}>
          Preview
        </button>
      </div>
      {preview ? (
        <div className="comment-body pr-preview">{body.trim() ? <Markdown text={body} /> : <span className="hint">Nothing to preview</span>}</div>
      ) : (
        <textarea
          className="composer-box"
          rows={4}
          autoFocus
          value={body}
          placeholder={`${placeholder ?? "Leave a comment (markdown)"} — ⌘↵ to save`}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onCancel();
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
        />
      )}
      {error && <div className="pr-error">{error}</div>}
      <div className="comment-actions">
        <button className="icon-btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="icon-btn primary" disabled={!can} onClick={() => void submit()}>
          {busy ? "Saving…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

export function DraftItem({ pr, draft, handlers }: { pr: PrRef; draft: DraftComment; handlers: ReviewHandlers }) {
  const [editing, setEditing] = useState(false);
  const range = draft.startLine != null ? `lines ${draft.startLine}-${draft.line}` : `line ${draft.line}`;
  return (
    <div className="comment pr-draft" data-draft-id={draft.id}>
      <div className="comment-head">
        <span className="pr-badge pending">Pending</span>
        <span className="comment-where">{range}</span>
        <span style={{ flex: 1 }} />
        {!editing && (
          <>
            <button className="icon-btn ghost square" title="Edit" onClick={() => setEditing(true)}>
              ✎
            </button>
            <button
              className="icon-btn ghost square"
              title="Delete this pending comment"
              onClick={() => prApi.deleteDraft(pr, draft.id).then(handlers.reloadDrafts)}
            >
              <TrashIcon />
            </button>
          </>
        )}
      </div>
      {editing ? (
        <CommentEditor
          initial={draft.body}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={async (body) => {
            await prApi.updateDraft(pr, draft.id, body);
            handlers.reloadDrafts();
            setEditing(false);
          }}
        />
      ) : (
        <div className="comment-body">
          <Markdown text={draft.body} />
        </div>
      )}
    </div>
  );
}

/** The last few lines of the hunk a thread was written on, for the Conversations panel. */
export function HunkSnippet({ hunk, rangeLines, maxLines = 6 }: { hunk: string; rangeLines: number; maxLines?: number }) {
  const [header, ...body] = hunk.split("\n");
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(header);
  let oldNo = m ? Number(m[1]) : 0;
  let newNo = m ? Number(m[2]) : 0;
  const lines = body
    .filter((raw) => !raw.startsWith("\\"))
    .map((raw) => {
      const kind = raw[0] === "+" ? "add" : raw[0] === "-" ? "del" : "ctx";
      const line = { kind, oldNo: kind === "add" ? null : oldNo++, newNo: kind === "del" ? null : newNo++, text: raw.slice(1) };
      return line;
    })
    .slice(-Math.max(maxLines, rangeLines));
  return (
    <div className="pr-snippet">
      {lines.map((l, i) => (
        <div key={i} className={`diff-line ${l.kind} ${i >= lines.length - rangeLines ? "pr-snippet-hit" : ""}`}>
          <span className="diff-no">{l.oldNo ?? ""}</span>
          <span className="diff-no">{l.newNo ?? ""}</span>
          <span className="diff-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
          <span className="diff-code">{l.text}</span>
        </div>
      ))}
    </div>
  );
}

export function ThreadItem({
  pr,
  thread,
  handlers,
  showLocation,
  onLocate,
}: {
  pr: PrRef;
  thread: ReviewThread;
  handlers: ReviewHandlers;
  showLocation?: boolean;
  onLocate?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(thread.isResolved && !showLocation);
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = thread.comments[0];
  const line = thread.line ?? thread.originalLine;
  const active = handlers.activeThread === thread.id;

  const resolve = async () => {
    setBusy(true);
    setError(null);
    try {
      await prApi.resolve(pr, thread.id, !thread.isResolved);
      handlers.reloadThreads();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`comment pr-thread ${thread.isResolved ? "resolved" : ""} ${active ? "active" : ""}`} data-thread-id={thread.id}>
      <div className="comment-head">
        {thread.isResolved && <span className="pr-badge ok">Resolved</span>}
        {thread.isOutdated && <span className="pr-badge">Outdated</span>}
        {showLocation && (
          <button className="link-btn inline pr-thread-where" title={thread.path} onClick={onLocate} disabled={!onLocate}>
            {thread.path.split("/").pop()}
            {line != null && `:${line}`}
          </button>
        )}
        {collapsed && first && (
          <span className="pr-thread-peek">
            {first.author}: {first.body.replace(/\s+/g, " ").slice(0, 80)}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button className="link-btn inline" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? `Show (${thread.comments.length})` : "Hide"}
        </button>
        <button className="link-btn inline" disabled={busy} onClick={() => void resolve()}>
          {thread.isResolved ? "Unresolve" : "Resolve"}
        </button>
      </div>
      {showLocation && !collapsed && thread.diffHunk && (
        <HunkSnippet hunk={thread.diffHunk} rangeLines={thread.startLine != null && line != null ? Math.max(1, line - thread.startLine + 1) : 1} />
      )}
      {error && <div className="pr-error">{error}</div>}
      {!collapsed && (
        <div className="pr-thread-body">
          {thread.comments.map((c) => (
            <div key={c.id} className="pr-comment">
              {c.authorAvatarUrl ? <img src={c.authorAvatarUrl} alt="" className="pr-avatar" /> : <span className="pr-avatar blank" />}
              <EditableComment
                pr={pr}
                id={c.id}
                kind="review"
                body={c.body}
                mine={c.author != null && c.author === handlers.viewer}
                meta={
                  <>
                    <span className="pr-comment-author">{c.author ?? "ghost"}</span>{" "}
                    <a href={c.url} target="_blank" rel="noreferrer" title={new Date(c.createdAt).toLocaleString()}>
                      {commentTime(c.createdAt)}
                    </a>
                  </>
                }
                onSaved={handlers.reloadThreads}
                onDeleted={handlers.reloadThreads}
              />
            </div>
          ))}
          {replying ? (
            <CommentEditor
              submitLabel="Reply"
              placeholder="Reply"
              onCancel={() => setReplying(false)}
              onSubmit={async (body) => {
                await prApi.reply(pr, thread.id, body);
                handlers.reloadThreads();
                setReplying(false);
              }}
            />
          ) : (
            <button className="pr-reply-btn" onClick={() => setReplying(true)}>
              Reply…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A comment body with its author line. When it is the viewer's own, the author line
 * offers Edit and Delete; editing swaps the body for the editor in place.
 */
export function EditableComment({
  pr,
  id,
  kind,
  body,
  mine,
  meta,
  format = (s) => s,
  bodyClass = "comment-body",
  onSaved,
  onDeleted,
}: {
  pr: PrRef;
  id: string;
  kind: CommentKind;
  body: string;
  mine: boolean;
  meta: ReactNode;
  format?: (body: string) => string;
  bodyClass?: string;
  onSaved: (body: string) => void;
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    if (!window.confirm("Delete this comment on GitHub?")) return;
    setBusy(true);
    setError(null);
    try {
      await prApi.deleteComment(pr, id, kind);
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="pr-comment-main">
      <div className="pr-comment-meta">
        {meta}
        {mine && !editing && (
          <span className="pr-comment-tools">
            <button className="link-btn inline" disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </button>
            <button className="link-btn inline" disabled={busy} onClick={() => void remove()}>
              Delete
            </button>
          </span>
        )}
      </div>
      {error && <div className="pr-error">{error}</div>}
      {editing ? (
        <CommentEditor
          initial={body}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={async (next) => {
            await prApi.editComment(pr, id, kind, next);
            onSaved(next);
            setEditing(false);
          }}
        />
      ) : (
        <div className={bodyClass}>
          <Markdown text={format(body)} />
        </div>
      )}
    </div>
  );
}

/** One line standing in for a thread while the Conversations panel shows the full thing. */
export function ThreadMarker({ thread, handlers }: { thread: ReviewThread; handlers: ReviewHandlers }) {
  const first = thread.comments[0];
  const active = handlers.activeThread === thread.id;
  return (
    <button
      data-thread-id={thread.id}
      className={`pr-marker ${active ? "active" : ""} ${thread.isResolved ? "resolved" : ""}`}
      onClick={() => handlers.setActiveThread(thread.id)}
    >
      {first?.authorAvatarUrl && <img src={first.authorAvatarUrl} alt="" className="pr-avatar small" />}
      <span className="pr-marker-author">{first?.author ?? "ghost"}</span>
      <span className="pr-marker-text">{first?.body.replace(/\s+/g, " ")}</span>
      {thread.comments.length > 1 && <span className="pr-marker-more">+{thread.comments.length - 1}</span>}
      {thread.isResolved && <span className="pr-marker-resolved">Resolved</span>}
      <span className="pr-marker-arrow">→</span>
    </button>
  );
}

export function LineComments({ pr, data, handlers }: { pr: PrRef; data: LineAnnotations; handlers: ReviewHandlers }) {
  return (
    <div className="line-review pr-line-review">
      {data.threads.map((t) =>
        handlers.panelOpen ? <ThreadMarker key={t.id} thread={t} handlers={handlers} /> : <ThreadItem key={t.id} pr={pr} thread={t} handlers={handlers} />,
      )}
      {data.drafts.map((d) => (
        <DraftItem key={d.id} pr={pr} draft={d} handlers={handlers} />
      ))}
    </div>
  );
}
