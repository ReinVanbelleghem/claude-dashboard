import { useCallback, useEffect, useRef, useState } from "react";
import { fileApi, type BrowseEntry } from "../../api.ts";
import { ChevronIcon, FileTypeIcon, FolderIcon, RefreshIcon } from "../Icons.tsx";

const STORE = "workbench-tree:";

const readOpen = (cwd: string): string[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE + cwd) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/**
 * The repository as a tree, read a folder at a time as folders are opened.
 * `stamp` changes when the working tree does, which is the cue to read the open
 * folders again, so a file a session just wrote shows up without a reload.
 */
export function FileTree({
  cwd,
  active,
  changed,
  stamp,
  onOpen,
}: {
  cwd: string;
  /** The file in the editor, highlighted here. */
  active: string | null;
  /** Git's one-letter status for each changed path. */
  changed: Map<string, string>;
  stamp: string;
  onOpen: (path: string, opts: { keep: boolean }) => void;
}) {
  const [listings, setListings] = useState<Map<string, BrowseEntry[]>>(new Map());
  const [open, setOpen] = useState<Set<string>>(() => new Set(readOpen(cwd)));
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const openRef = useRef(open);
  openRef.current = open;

  const load = useCallback(
    (path: string) =>
      fileApi
        .browse(cwd, { path })
        .then((r) => {
          if (!r.ok) return path === "" ? setError(r.error ?? "This folder could not be read.") : undefined;
          setError(null);
          setListings((prev) => new Map(prev).set(path, r.entries));
        })
        .catch(() => {}),
    [cwd],
  );

  useEffect(() => {
    void load("");
    for (const dir of openRef.current) void load(dir);
  }, [load, stamp, reloads]);

  const toggle = (dir: string) => {
    const next = new Set(open);
    if (next.has(dir)) next.delete(dir);
    else {
      next.add(dir);
      void load(dir);
    }
    setOpen(next);
    try {
      localStorage.setItem(STORE + cwd, JSON.stringify([...next].slice(0, 200)));
    } catch {
      return;
    }
  };

  const dirtyDirs = new Set<string>();
  for (const path of changed.keys()) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) dirtyDirs.add(parts.slice(0, i).join("/"));
  }

  const rows = (dir: string, depth: number): JSX.Element[] =>
    (listings.get(dir) ?? []).flatMap((e) => {
      const pad = { paddingLeft: 8 + depth * 14 };
      if (e.dir) {
        const isOpen = open.has(e.path);
        return [
          <button key={e.path} className={`wb-tree-row dir${dirtyDirs.has(e.path) ? " touched" : ""}`} style={pad} onClick={() => toggle(e.path)} aria-expanded={isOpen}>
            <span className={`ws-chev${isOpen ? " open" : ""}`}>
              <ChevronIcon />
            </span>
            <FolderIcon open={isOpen} />
            <span className="wb-tree-name">{e.name}</span>
          </button>,
          ...(isOpen ? rows(e.path, depth + 1) : []),
        ];
      }
      const status = changed.get(e.path);
      return [
        <button
          key={e.path}
          className={`wb-tree-row file${active === e.path ? " active" : ""}${status ? ` st-${status === "?" ? "U" : status}` : ""}`}
          style={pad}
          title={e.path}
          onClick={() => onOpen(e.path, { keep: false })}
          onDoubleClick={() => onOpen(e.path, { keep: true })}
        >
          <span className="ws-chev none" />
          <FileTypeIcon name={e.name} />
          <span className="wb-tree-name">{e.name}</span>
          {status && <em className="wb-tree-status">{status === "?" ? "U" : status}</em>}
        </button>,
      ];
    });

  return (
    <div className="wb-tree">
      <div className="wb-side-head">
        <span>Explorer</span>
        <button className="icon-btn ghost square" title="Read the folders again" aria-label="Refresh the explorer" onClick={() => setReloads((n) => n + 1)}>
          <RefreshIcon />
        </button>
      </div>
      {error && <p className="wb-side-note">{error}</p>}
      <div className="wb-tree-rows">{rows("", 0)}</div>
    </div>
  );
}
