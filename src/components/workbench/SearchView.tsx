import { useEffect, useMemo, useRef, useState } from "react";
import { gitApi, type GrepHit } from "../../api.ts";
import { ChevronIcon, FileTypeIcon } from "../Icons.tsx";

/** Search across the repository's files, the results grouped under the file they are in. */
export function SearchView({
  cwd,
  focusKey,
  onOpen,
}: {
  cwd: string;
  /** Bumped when the search shortcut is pressed, to put the cursor in the field. */
  focusKey: number;
  onOpen: (path: string, at: { line: number; column: number }) => void;
}) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [hits, setHits] = useState<GrepHit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shut, setShut] = useState<Set<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusKey]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setTruncated(false);
      setError(null);
      return;
    }
    let stale = false;
    setBusy(true);
    const timer = setTimeout(() => {
      gitApi
        .grep(cwd, q, { caseSensitive, regex })
        .then((r) => {
          if (stale) return;
          setHits(r.hits);
          setTruncated(r.truncated);
          setError(r.ok ? null : r.error);
        })
        .catch((e) => !stale && setError(e instanceof Error ? e.message : String(e)))
        .finally(() => !stale && setBusy(false));
    }, 220);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [cwd, query, caseSensitive, regex]);

  const groups = useMemo(() => {
    const out = new Map<string, GrepHit[]>();
    for (const h of hits) out.set(h.path, [...(out.get(h.path) ?? []), h]);
    return [...out.entries()];
  }, [hits]);

  return (
    <div className="wb-search">
      <div className="wb-side-head">
        <span>Search</span>
      </div>
      <div className="wb-search-box">
        <input ref={input} type="search" placeholder="Search in files" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
        <button className={`wb-search-opt${caseSensitive ? " on" : ""}`} title="Match case" aria-pressed={caseSensitive} onClick={() => setCaseSensitive((v) => !v)}>
          Aa
        </button>
        <button className={`wb-search-opt${regex ? " on" : ""}`} title="Use a regular expression" aria-pressed={regex} onClick={() => setRegex((v) => !v)}>
          .*
        </button>
      </div>
      {error && <p className="wb-side-note bad">{error}</p>}
      {!error && query.trim().length >= 2 && (
        <p className="wb-side-note">
          {busy && hits.length === 0
            ? "Searching…"
            : `${hits.length}${truncated ? "+" : ""} result${hits.length === 1 ? "" : "s"} in ${groups.length} file${groups.length === 1 ? "" : "s"}`}
        </p>
      )}
      <div className="wb-search-results">
        {groups.map(([path, list]) => {
          const name = path.split("/").pop() ?? path;
          const closed = shut.has(path);
          return (
            <div key={path} className="wb-search-file">
              <button
                className="wb-tree-row dir"
                title={path}
                onClick={() => {
                  const next = new Set(shut);
                  if (closed) next.delete(path);
                  else next.add(path);
                  setShut(next);
                }}
              >
                <span className={`ws-chev${closed ? "" : " open"}`}>
                  <ChevronIcon />
                </span>
                <FileTypeIcon name={name} />
                <span className="wb-tree-name">{name}</span>
                <small className="wb-search-dir">{path.slice(0, -name.length).replace(/\/$/, "")}</small>
                <em className="wb-tree-status">{list.length}</em>
              </button>
              {!closed &&
                list.map((h) => (
                  <button key={`${h.line}:${h.column}`} className="wb-search-hit" onClick={() => onOpen(path, { line: h.line, column: h.column })}>
                    <span className="wb-search-line">{h.line}</span>
                    <span className="wb-search-text">{h.text.trim()}</span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
