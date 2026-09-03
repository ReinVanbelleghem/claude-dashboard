import { useEffect, useRef, useState } from "react";

/**
 * A session title you can correct in place.
 *
 * Renaming used to be impossible after the fact: the title was set once in the
 * new-session dialog and only ever read, so a typo followed the session through
 * every card, banner and search result for as long as the transcript existed.
 *
 * The element renders as text until it is asked for, because a title that always
 * looks like a form invites edits nobody wanted — a click is not enough on a card
 * that is itself a link to the session, so the card passes `openOn="doubleClick"`
 * while the headers, where nothing else is competing for the gesture, take a click.
 *
 * Saving is optimistic and the pending value survives the round trip: the daemon
 * echoes the change back over SSE, and dropping to the old prop in the meantime
 * would flash the typo back for a frame.
 */
export function EditableTitle({
  value,
  onRename,
  openOn = "click",
  as: Tag = "span",
  className,
  placeholder = "Untitled session",
}: {
  value: string | null;
  onRename: (title: string) => Promise<unknown>;
  openOn?: "click" | "doubleClick";
  as?: "h1" | "h3" | "span";
  className?: string;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  // A rename that lands from elsewhere (another tab, the SSE echo) is authoritative
  // and clears the local copy we were holding over the round trip.
  useEffect(() => {
    if (value !== null && value === saved) setSaved(null);
  }, [value, saved]);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const shown = saved ?? value;

  function open() {
    setDraft(shown ?? "");
    setError(null);
    setEditing(true);
  }

  async function commit() {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === shown) return;
    setSaved(next);
    try {
      await onRename(next);
    } catch (err) {
      setSaved(null);
      setError(err instanceof Error ? err.message : "rename failed");
    }
  }

  // The input stays inside the element it replaces, so an h1 edits at h1 size and a
  // card name in its mono face — swapping the tag out would resize the row mid-edit.
  if (editing) {
    return (
      <Tag className={className}>
        <input
          ref={input}
          className="title-edit"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") void commit();
            if (e.key === "Escape") {
              setEditing(false);
              setDraft(shown ?? "");
            }
          }}
        />
      </Tag>
    );
  }

  const handler = openOn === "click" ? "onClick" : "onDoubleClick";
  return (
    <Tag
      className={`title-editable ${className ?? ""}`}
      title={error ?? "Rename this session"}
      {...{
        [handler]: (e: React.MouseEvent) => {
          e.stopPropagation();
          open();
        },
      }}
    >
      {shown || placeholder}
      {error && <span className="title-error"> · {error}</span>}
    </Tag>
  );
}
