import { useEffect, useState } from "react";
import { api, fmtAgo, fmtTokens, shortPath, type SessionRow } from "../api.ts";

/**
 * Page sizes, smallest first. 20 is the default because history is read by
 * scanning: a page you can take in without scrolling is the point of paging it at
 * all, and the larger sizes are there for when you know roughly where you are
 * going and want fewer hops to get there.
 */
const PER_PAGE_OPTIONS = [10, 20, 50, 100];
const DEFAULT_PER_PAGE = 20;
const PER_PAGE_KEY = "history-per-page";

function readPerPage(): number {
  const saved = Number(localStorage.getItem(PER_PAGE_KEY));
  return PER_PAGE_OPTIONS.includes(saved) ? saved : DEFAULT_PER_PAGE;
}

export function HistoryView({ onOpen }: { onOpen: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  // Remembered, because a page size is a preference about how you read, not about
  // the search you happen to be running.
  const [perPage, setPerPage] = useState(readPerPage);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    localStorage.setItem(PER_PAGE_KEY, String(perPage));
  }, [perPage]);

  // Debounce so typing doesn't fire an FTS query per keystroke.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      api
        .sessions(q, perPage, page * perPage)
        .then((r) => {
          if (cancelled) return;
          setRows(r.sessions);
          setTotal(r.total);
        })
        .catch(() => {
          if (cancelled) return;
          setRows([]);
          setTotal(0);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, page, perPage]);

  const pageCount = Math.max(1, Math.ceil(total / perPage));

  /**
   * The index grows while you are looking at it, and a session that moves off the
   * end can leave you on a page that no longer exists. Rather than show an empty
   * table with no way to tell why, walk back to the last page that has rows.
   *
   * Only ever backwards: a page that filled up is still valid, so growth must not
   * move you.
   */
  useEffect(() => {
    if (!loading && page >= pageCount) setPage(pageCount - 1);
  }, [loading, page, pageCount]);

  /** A new result set is a different list — staying on page 7 of it means nothing. */
  const search = (next: string) => {
    setQ(next);
    setPage(0);
  };

  const first = total === 0 ? 0 : page * perPage + 1;
  const last = page * perPage + rows.length;

  return (
    <div className="panel">
      <h2>Session history</h2>
      <p className="hint">
        Full-text search over every prompt you have typed, across all projects. Click a row for the
        transcript summary.
      </p>
      <input
        className="search"
        placeholder="Search your prompts — e.g. redis queue, trimble syncer, pallet network…"
        value={q}
        onChange={(e) => search(e.target.value)}
      />
      {loading && rows.length === 0 ? (
        <div className="empty">Searching…</div>
      ) : rows.length === 0 ? (
        <div className="empty">{q ? `No sessions matched “${q}”.` : "Nothing indexed yet."}</div>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Project</th>
                  <th>Branch</th>
                  <th className="num">Prompts</th>
                  <th className="num">Tools</th>
                  <th className="num">Output</th>
                  <th className="num">Last active</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className="click" onClick={() => onOpen(s.id)}>
                    <td style={{ maxWidth: 340 }}>{s.title ?? <em style={{ color: "var(--text-muted)" }}>untitled</em>}</td>
                    <td title={s.cwd ?? ""} style={{ color: "var(--text-secondary)" }}>
                      {shortPath(s.cwd, 2)}
                    </td>
                    <td>{s.git_branch ? <span className="chip">{s.git_branch}</span> : "—"}</td>
                    <td className="num">{s.prompt_count}</td>
                    <td className="num">{s.tool_count}</td>
                    <td className="num">{fmtTokens(s.output_tokens)}</td>
                    <td className="num" style={{ color: "var(--text-muted)" }}>{fmtAgo(s.last_ts)}</td>
                    {/* A real link, so cmd-click opens the session in its own tab. */}
                    <td className="num">
                      <a
                        className="row-open"
                        href={`#/session/${encodeURIComponent(s.id)}`}
                        title="Open full page"
                        onClick={(e) => e.stopPropagation()}
                      >
                        ↗
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Positions you in the whole result set, not just this page: "1–20" alone
              cannot tell you whether there are thirty sessions behind it or three
              thousand, which is the thing you want to know before paging at all. */}
          <div className="pager">
            <span className="pager-range">
              {first}–{last} of {total.toLocaleString()}
              {q ? " matching" : ""}
            </span>
            <span style={{ flex: 1 }} />
            <label className="pager-size">
              Per page
              <select
                value={perPage}
                onChange={(e) => {
                  setPerPage(Number(e.target.value));
                  setPage(0);
                }}
              >
                {PER_PAGE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <div className="pager-nav">
              <button
                className="icon-btn"
                disabled={page === 0 || loading}
                onClick={() => setPage(0)}
                title="First page"
              >
                «
              </button>
              <button
                className="icon-btn"
                disabled={page === 0 || loading}
                onClick={() => setPage((n) => Math.max(0, n - 1))}
              >
                ‹ Newer
              </button>
              <span className="pager-page">
                {page + 1} / {pageCount}
              </span>
              <button
                className="icon-btn"
                disabled={page >= pageCount - 1 || loading}
                onClick={() => setPage((n) => Math.min(pageCount - 1, n + 1))}
              >
                Older ›
              </button>
              <button
                className="icon-btn"
                disabled={page >= pageCount - 1 || loading}
                onClick={() => setPage(pageCount - 1)}
                title="Last page"
              >
                »
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
