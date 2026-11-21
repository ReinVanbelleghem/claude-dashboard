import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fileApi, type BrowseEntry } from "../../api.ts";
import { FileTypeIcon } from "../Icons.tsx";

/** How well a path answers what was typed: the name first, then how early and how tightly it matches. */
function score(path: string, query: string): number {
  const name = path.split("/").pop() ?? path;
  const lower = name.toLowerCase();
  if (lower === query) return 0;
  if (lower.startsWith(query)) return 1 + name.length / 1000;
  const inName = lower.indexOf(query);
  if (inName !== -1) return 2 + inName / 100 + name.length / 1000;
  return 3 + path.toLowerCase().indexOf(query) / 1000 + path.length / 10_000;
}

/** Go to a file by typing part of its name: the palette VS Code opens with Cmd-P. */
export function QuickOpen({ cwd, recent, onOpen, onClose }: { cwd: string; recent: string[]; onOpen: (path: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<BrowseEntry[]>([]);
  const [cursor, setCursor] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (!q) return setFound([]);
    let stale = false;
    const timer = setTimeout(() => {
      fileApi
        .browse(cwd, { q })
        .then((r) => !stale && setFound([...r.entries].sort((a, b) => score(a.path, q) - score(b.path, q)).slice(0, 60)))
        .catch(() => {});
    }, 90);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [cwd, query]);

  const shown: BrowseEntry[] = query.trim()
    ? found
    : recent.map((path) => ({ name: path.split("/").pop() ?? path, path, dir: false }));
  useEffect(() => setCursor(0), [query, found.length]);
  useEffect(() => {
    list.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const pick = (path: string | undefined) => {
    if (!path) return;
    onOpen(path);
    onClose();
  };

  return createPortal(
    <div className="wb-quick-scrim" onMouseDown={onClose}>
      <div className="wb-quick" role="dialog" aria-label="Go to file" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="Go to file…"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((n) => Math.min(shown.length - 1, n + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((n) => Math.max(0, n - 1));
            } else if (e.key === "Enter") pick(shown[cursor]?.path);
          }}
        />
        <div className="wb-quick-list" ref={list}>
          {shown.length === 0 && <p className="wb-side-note">{query.trim() ? "No file by that name." : "Type part of a file's name."}</p>}
          {shown.map((e, i) => (
            <button key={e.path} className={`wb-quick-row${i === cursor ? " on" : ""}`} onMouseEnter={() => setCursor(i)} onClick={() => pick(e.path)}>
              <FileTypeIcon name={e.name} />
              <span className="wb-quick-name">{e.name}</span>
              <small>{e.path.slice(0, -e.name.length).replace(/\/$/, "")}</small>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
