import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { dirApi, type DirListing } from "../api.ts";
import { ArrowUpIcon, FolderIcon, GitIcon, HomeIcon } from "./Icons.tsx";

/**
 * Pick a folder on this machine.
 *
 * The daemon walks the directories because a browser cannot give us a real path.
 * One dialog for every "which folder" question in the app, so the artifacts root,
 * a repository checkout and a worktrees directory are all chosen the same way.
 */
export function FolderPicker({
  title,
  hint,
  initial,
  primary = "Use this folder",
  wantRepo = false,
  stacked = false,
  onPick,
  onClose,
}: {
  title: string;
  hint?: string;
  /** Where to open; empty or missing falls back to home. */
  initial?: string;
  primary?: string;
  /** A checkout is wanted: the footer says whether the current folder is one. */
  wantRepo?: boolean;
  stacked?: boolean;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const go = (path: string) => {
    const mine = ++seq.current;
    dirApi
      .list(path)
      .then((l) => {
        if (seq.current !== mine) return;
        setListing(l);
        setTyped(l.path);
        setError(null);
      })
      .catch((e) => seq.current === mine && setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    go(initial?.trim() || "~");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const status = listing
    ? listing.isRepo
      ? `checkout root${listing.branch ? ` on ${listing.branch}` : ""}`
      : wantRepo
        ? "not a checkout — no .git here"
        : `${listing.entries.length} subfolder${listing.entries.length === 1 ? "" : "s"}`
    : "…";

  return createPortal(
    <>
      <div className={`scrim ${stacked ? "stacked" : ""}`} onClick={onClose} />
      <div className={`modal wide folder-picker ${stacked ? "stacked" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <div>
            <h3>{title}</h3>
            {hint && <p className="hint">{hint}</p>}
          </div>
          <button className="icon-btn square ghost" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="fp-bar">
          <button className="icon-btn square" onClick={() => go("~")} title="Home" aria-label="Home">
            <HomeIcon />
          </button>
          <button
            className="icon-btn square"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && go(listing.parent)}
            title="Up one level"
            aria-label="Up one level"
          >
            <ArrowUpIcon />
          </button>
          <input
            className="search mono fp-path"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") go(typed);
            }}
            onBlur={() => typed.trim() && typed !== listing?.path && go(typed)}
            placeholder="/path/to/folder"
          />
        </div>

        <div className="fp-list" role="listbox">
          {error && <div className="hint fp-note">{error}</div>}
          {listing && listing.entries.length === 0 && !error && (
            <div className="hint fp-note">No subfolders here.</div>
          )}
          {listing?.entries.map((e) => (
            <button key={e.path} className="fp-row" onClick={() => go(e.path)} onDoubleClick={() => onPick(e.path)} title={e.path}>
              <span className="fp-ic">
                <FolderIcon />
              </span>
              <span className="fp-name mono">{e.name}</span>
              {e.isRepo && (
                <span className="fp-tag" title="Git repository">
                  <GitIcon />
                </span>
              )}
            </button>
          ))}
        </div>

        <div className={`fp-status ${wantRepo && listing && !listing.isRepo ? "warn" : ""}`}>
          {listing?.isRepo && <GitIcon />}
          <span>{status}</span>
        </div>

        <div className="modal-actions fp-foot">
          <button className="icon-btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="icon-btn primary" disabled={!listing} onClick={() => listing && onPick(listing.path)}>
            {primary}
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}

/**
 * A settings field for a folder: the path, a Browse button that opens the picker,
 * and a clear button when the field is optional. Typing still works for the people
 * who know the path by heart; it saves on blur like the other settings fields.
 */
export function FolderField({
  label,
  value,
  placeholder,
  onChange,
  pickerTitle,
  pickerHint,
  wantRepo,
  optional = true,
  mono = true,
}: {
  label?: string;
  value: string;
  placeholder?: string;
  onChange: (path: string) => void;
  pickerTitle: string;
  pickerHint?: string;
  wantRepo?: boolean;
  optional?: boolean;
  mono?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (v: string) => {
    const next = v.trim();
    setDraft(next);
    if (next !== value) onChange(next);
  };
  return (
    <div className="field folder-field">
      {label && <span>{label}</span>}
      <div className="folder-field-row">
        <input
          className={`search ${mono ? "mono" : ""}`}
          spellCheck={false}
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        />
        {optional && draft && (
          <button className="icon-btn square ghost" title="Clear — use the default" aria-label="Clear" onClick={() => commit("")}>
            ×
          </button>
        )}
        <button className="icon-btn" onClick={() => setPicking(true)} title="Browse for a folder">
          <FolderIcon />
          <span>Browse</span>
        </button>
      </div>
      {picking && (
        <FolderPicker
          title={pickerTitle}
          hint={pickerHint}
          initial={draft || placeholder}
          wantRepo={wantRepo}
          onPick={(p) => {
            setPicking(false);
            commit(p);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
