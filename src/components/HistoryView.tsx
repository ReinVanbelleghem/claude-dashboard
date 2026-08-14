import { useEffect, useState } from "react";
import { api, fmtAgo, fmtTokens, shortPath, type SessionRow } from "../api.ts";

export function HistoryView({ onOpen }: { onOpen: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Debounce so typing doesn't fire an FTS query per keystroke.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      api
        .sessions(q)
        .then((r) => {
          if (!cancelled) setRows(r.sessions);
        })
        .catch(() => {
          if (!cancelled) setRows([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  return (
    <div className="panel">
      <h2>Session history</h2>
      <p className="hint">
        Full-text search over every prompt you have typed, across {rows.length ? "" : "all "}
        projects. Click a row for the transcript summary.
      </p>
      <input
        className="search"
        placeholder="Search your prompts — e.g. redis queue, trimble syncer, pallet network…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {loading && rows.length === 0 ? (
        <div className="empty">Searching…</div>
      ) : rows.length === 0 ? (
        <div className="empty">No sessions matched “{q}”.</div>
      ) : (
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
      )}
    </div>
  );
}
