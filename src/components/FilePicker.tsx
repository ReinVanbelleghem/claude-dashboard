import { useEffect, useRef, useState } from "react";
import { fileApi, type Browse } from "../api.ts";
import { FileTypeIcon, FolderIcon } from "./Icons.tsx";

/**
 * Pick any file in the repository to edit.
 *
 * The diff only knows about files something has already changed, so this is the way
 * to reach the other ones. It is scoped to the repo rather than to the whole machine:
 * the daemon will not read or write outside it, and "which file in this project" is
 * the question being asked anyway.
 *
 * Typing searches the whole repo instead of filtering the folder on screen — in a
 * checkout of any size, knowing part of a filename beats knowing where it lives.
 */
export function FilePicker({
  cwd,
  onPick,
  onClose,
}: {
  cwd: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<Browse | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  /** Drops responses to superseded keystrokes, which can land out of order. */
  const seq = useRef(0);

  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const load = (opts: { path?: string; q?: string }) => {
    const mine = ++seq.current;
    setLoading(true);
    fileApi
      .browse(cwd, opts)
      .then((r) => {
        if (seq.current !== mine) return;
        setListing(r);
        setLoading(false);
      })
      .catch(() => seq.current === mine && setLoading(false));
  };

  // One effect for both modes: a query searches, an empty one lists the folder.
  useEffect(() => {
    const t = setTimeout(() => load(query.trim() ? { q: query } : { path: listing?.path ?? "" }), 120);
    return () => clearTimeout(t);
    // Deliberately not on `listing.path`: navigating calls load() itself, and
    // depending on it here would re-fetch every folder twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, cwd]);

  const searching = !!query.trim();
  const here = listing?.path ? `${repoName(listing.root)}/${listing.path}` : repoName(listing?.root);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal wide" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h3>Open a file</h3>
            <p className="hint">
              Anything in this repository — including files nothing has changed yet.
            </p>
          </div>
          <button className="icon-btn" onClick={onClose}>
            Close
          </button>
        </div>

        {/* Wrapped, because `.modal.wide > *` puts the body inset on its own direct
            children — on a bare input that indents the text and leaves the box
            running edge to edge. */}
        <div className="file-picker-search">
          <input
            ref={input}
            className="search"
            placeholder="Search the repo by name, or browse below…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="browser">
          {!searching && (
            <div className="browser-bar">
              <button
                className="icon-btn"
                disabled={!listing?.path}
                onClick={() => load({ path: "" })}
                title="Back to the repository root"
              >
                Root
              </button>
              <button
                className="icon-btn"
                disabled={listing?.parent === null || listing?.parent === undefined}
                onClick={() => load({ path: listing?.parent ?? "" })}
              >
                ↑ Up
              </button>
              <span className="browser-path">{here}</span>
            </div>
          )}

          <div className="file-picker-list">
            {listing?.error && <div className="hint" style={{ padding: 10 }}>{listing.error}</div>}
            {!listing?.error && loading && !listing && <div className="empty">Reading…</div>}
            {listing && !listing.error && listing.entries.length === 0 && (
              <div className="hint" style={{ padding: 10 }}>
                {searching ? "Nothing matches that." : "This folder is empty."}
              </div>
            )}
            {listing?.entries.map((e) => (
              <button
                className="file-picker-row"
                key={e.path}
                onClick={() => (e.dir ? (setQuery(""), load({ path: e.path })) : onPick(e.path))}
                title={e.path}
              >
                <span className="file-picker-ic">{e.dir ? <FolderIcon /> : <FileTypeIcon name={e.name} />}</span>
                {/* When searching, the folder is the useful half of the answer —
                    three files called index.ts are told apart by nothing else. */}
                <span className="file-picker-name">
                  {searching && e.path.includes("/") && (
                    <span className="file-picker-dir">
                      {e.path.slice(0, e.path.lastIndexOf("/") + 1)}
                    </span>
                  )}
                  {e.name}
                </span>
              </button>
            ))}
          </div>

          {listing?.truncated && (
            <p className="hint" style={{ margin: "8px 0 0" }}>
              Showing the first {listing.entries.length} matches — type more to narrow it.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

const repoName = (root: string | null | undefined) => root?.split("/").pop() ?? "repository";
