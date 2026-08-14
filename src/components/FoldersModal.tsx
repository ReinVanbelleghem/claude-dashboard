import { useEffect, useState } from "react";
import { dirApi, shortPath, type DirListing, type Favourite } from "../api.ts";
import { CheckIcon, FolderIcon, GitIcon, PlusIcon, TrashIcon } from "./Icons.tsx";

/**
 * Manage the working directories you start sessions in.
 *
 * Browsing lives here rather than in the new-session dialog: picking a folder is
 * a one-off setup task, and starting a session should just be choosing from the
 * shortlist you already curated.
 *
 * The daemon does the directory walking because a browser cannot give us a real
 * path — its folder picker returns an opaque handle, and only in some browsers.
 */
export function FoldersModal({
  onClose,
  onChanged,
  stacked,
}: {
  onClose: () => void;
  onChanged?: (favourites: Favourite[]) => void;
  /** True when opened on top of another modal, so it layers above it. */
  stacked?: boolean;
}) {
  const [favourites, setFavourites] = useState<Favourite[]>([]);
  const [adding, setAdding] = useState(false);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    dirApi.favourites().then((r) => setFavourites(r.favourites)).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (adding ? setAdding(false) : onClose());
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, adding]);

  const apply = (rows: Favourite[]) => {
    setFavourites(rows);
    onChanged?.(rows);
  };

  const go = (path: string) => {
    dirApi
      .list(path)
      .then((l) => {
        setListing(l);
        setLabel(l.path.replace(/\/$/, "").split("/").pop() ?? "");
      })
      .catch(() => {});
  };

  const startAdding = () => {
    setAdding(true);
    go("~");
  };

  const add = async () => {
    if (!listing) return;
    setBusy(true);
    try {
      apply((await dirApi.save(label, listing.path)).favourites);
      setAdding(false);
    } finally {
      setBusy(false);
    }
  };

  const already = (p: string) => favourites.some((f) => f.path === p);

  return (
    <>
      <div className={`scrim ${stacked ? "stacked" : ""}`} onClick={onClose} />
      <div className={`modal wide ${stacked ? "stacked" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h3>Working directories</h3>
            <p className="hint">Your shortlist for new sessions — name them how you think of them.</p>
          </div>
          {!adding && (
            <button className="icon-btn primary" onClick={startAdding}>
              <PlusIcon /> Add folder
            </button>
          )}
        </div>

        {!adding ? (
          favourites.length === 0 ? (
            <div className="empty">
              Nothing saved yet.{" "}
              <button className="link-btn inline" onClick={startAdding}>
                Add your first folder
              </button>
              .
            </div>
          ) : (
            <div className="fav-manage">
              {favourites.map((f) => (
                <div className="fav-row-item" key={f.path}>
                  <span className="fav-ic">
                    <FolderIcon />
                  </span>
                  {/* Name over path: a fixed label column leaves a dead gap between
                      the two, and long paths have nowhere to go. */}
                  <span className="fav-text">
                    <input
                      className="fav-label-input"
                      value={f.label}
                      aria-label="Folder name"
                      // Path is the identity, so saving under the same path renames.
                      onChange={(e) =>
                        setFavourites((rows) =>
                          rows.map((r) => (r.path === f.path ? { ...r, label: e.target.value } : r)),
                        )
                      }
                      onBlur={(e) =>
                        dirApi
                          .save(e.target.value, f.path)
                          .then((r) => apply(r.favourites))
                          .catch(() => {})
                      }
                    />
                    <span className="fav-path" title={f.path}>
                      {f.path.replace(/^\/Users\/[^/]+/, "~")}
                    </span>
                  </span>
                  <button
                    className="icon-btn ghost square"
                    title="Remove from the shortlist"
                    onClick={() =>
                      dirApi.remove(f.path).then((r) => apply(r.favourites)).catch(() => {})
                    }
                  >
                    <TrashIcon />
                  </button>
                </div>
              ))}
            </div>
          )
        ) : (
          <div className="browser">
            <div className="browser-bar">
              <button className="icon-btn" onClick={() => go("~")} title="Home">
                Home
              </button>
              <button
                className="icon-btn"
                disabled={!listing?.parent}
                onClick={() => listing?.parent && go(listing.parent)}
              >
                ↑ Up
              </button>
              <span className="browser-path">
                {listing ? listing.path.replace(/^\/Users\/[^/]+/, "~") : "…"}
              </span>
              {listing?.isRepo && (
                <span className="chip">
                  <GitIcon /> repo
                </span>
              )}
            </div>

            <div className="browser-grid">
              {listing?.entries.length === 0 && (
                <div className="hint" style={{ padding: 10 }}>
                  No subfolders here — this is a leaf. Name it below and add it.
                </div>
              )}
              {listing?.entries.map((e) => (
                <button
                  key={e.path}
                  className={`folder-card ${already(e.path) ? "saved" : ""}`}
                  onClick={() => go(e.path)}
                  title={e.path}
                >
                  <span className="folder-ic">
                    <FolderIcon />
                  </span>
                  <span className="folder-name">{e.name}</span>
                  {e.isRepo && (
                    <span className="folder-tag">
                      <GitIcon />
                    </span>
                  )}
                  {already(e.path) && (
                    <span className="folder-saved">
                      <CheckIcon />
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div className="browser-foot">
              <div className="field" style={{ margin: 0, flex: 1 }}>
                <span>Name for this folder</span>
                <input
                  className="search"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Backend"
                  onKeyDown={(e) => e.key === "Enter" && void add()}
                />
              </div>
              <div className="modal-actions" style={{ margin: 0 }}>
                <button className="icon-btn" onClick={() => setAdding(false)}>
                  Cancel
                </button>
                <button
                  className="icon-btn primary"
                  disabled={busy || !listing || already(listing.path)}
                  onClick={add}
                >
                  {already(listing?.path ?? "")
                    ? "Already saved"
                    : `Add ${listing ? shortPath(listing.path, 1) : ""}`}
                </button>
              </div>
            </div>
          </div>
        )}

        {!adding && (
          <div className="modal-actions">
            <button className="icon-btn primary" onClick={onClose}>
              Done
            </button>
          </div>
        )}
      </div>
    </>
  );
}
