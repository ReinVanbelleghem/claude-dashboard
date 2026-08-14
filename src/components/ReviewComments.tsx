import { useState } from "react";
import { fmtAgo, type ReviewComment } from "../api.ts";
import { CheckIcon, TrashIcon } from "./Icons.tsx";
import { Markdown } from "./Markdown.tsx";

/**
 * Review comment threads, as rendered inside a diff.
 *
 * The operations are deliberately few: write, edit, resolve, delete. Resolving
 * hides a comment without destroying it and takes it out of the prompt, which is
 * the distinction that matters — "done with this" is not the same as "never said
 * it".
 */
export type CommentHandlers = {
  add: (input: {
    path: string;
    line: number | null;
    side: "old" | "new";
    anchorText: string | null;
    body: string;
  }) => Promise<void>;
  update: (id: string, patch: { body?: string; status?: "open" | "resolved" }) => Promise<void>;
  remove: (id: string) => Promise<void>;
};

export function CommentThread({
  comment,
  handlers,
  adrift,
}: {
  comment: ReviewComment;
  handlers: CommentHandlers;
  /** The line this was written against no longer reads the same. */
  adrift?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const resolved = comment.status === "resolved";

  return (
    <div className={`comment ${resolved ? "resolved" : ""}`}>
      <div className="comment-head">
        <span className="comment-where">
          {comment.line ? `line ${comment.line}` : "file"}
          {resolved && " · resolved"}
          {comment.sentAt && !resolved && " · sent to Claude"}
        </span>
        <time>{fmtAgo(comment.updatedAt)}</time>
        <span style={{ flex: 1 }} />
        <button
          className="icon-btn ghost square"
          title={resolved ? "Reopen" : "Resolve — hides it and drops it from the prompt"}
          onClick={() => handlers.update(comment.id, { status: resolved ? "open" : "resolved" })}
        >
          {resolved ? "↺" : <CheckIcon />}
        </button>
        <button
          className="icon-btn ghost square"
          title="Edit"
          onClick={() => {
            setDraft(comment.body);
            setEditing(!editing);
          }}
        >
          ✎
        </button>
        <button
          className="icon-btn ghost square"
          title="Delete this comment"
          onClick={() => handlers.remove(comment.id)}
        >
          <TrashIcon />
        </button>
      </div>

      {adrift && !resolved && (
        <div className="comment-adrift">
          The line has changed since this was written — check it still applies.
        </div>
      )}

      {editing ? (
        <div className="comment-edit">
          <textarea
            className="composer-box"
            rows={3}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                void handlers.update(comment.id, { body: draft }).then(() => setEditing(false));
              }
            }}
          />
          <div className="comment-actions">
            <button className="icon-btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              className="icon-btn primary"
              disabled={!draft.trim()}
              onClick={() => void handlers.update(comment.id, { body: draft }).then(() => setEditing(false))}
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="comment-body">
          <Markdown text={comment.body} />
        </div>
      )}
    </div>
  );
}

export function NewComment({
  placeholder,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(body);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="comment new">
      <textarea
        className="composer-box"
        rows={3}
        autoFocus
        value={body}
        placeholder={`${placeholder} — ⌘↵ to save`}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="comment-actions">
        <button className="icon-btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="icon-btn primary" disabled={busy || !body.trim()} onClick={submit}>
          {busy ? "Saving…" : "Comment"}
        </button>
      </div>
    </div>
  );
}
