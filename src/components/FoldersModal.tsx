import { useEffect, useState } from "react";
import { dirApi, type Favourite } from "../api.ts";
import { FolderPicker } from "./FolderPicker.tsx";
import { FolderIcon, PlusIcon, TrashIcon } from "./Icons.tsx";

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

  const startAdding = () => setAdding(true);

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
        ) : null}

        {adding && (
          <FolderPicker
            stacked
            title="Add a working directory"
            hint="Pick a folder to start sessions in. You can rename it in the list afterwards."
            primary="Add folder"
            onClose={() => setAdding(false)}
            onPick={(path) => {
              if (already(path)) return setAdding(false);
              const name = path.replace(/\/$/, "").split("/").pop() ?? path;
              setBusy(true);
              dirApi
                .save(name, path)
                .then((r) => apply(r.favourites))
                .catch(() => {})
                .finally(() => {
                  setBusy(false);
                  setAdding(false);
                });
            }}
          />
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
