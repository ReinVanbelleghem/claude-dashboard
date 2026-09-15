import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mcpApi, type McpLogin, type McpPayload, type McpServer, type McpStatus } from "../api.ts";

/**
 * The machine's MCP servers, and the button that connects the ones that are not.
 *
 * Standing in for the TUI's `/mcp`. Deliberately machine-wide rather than
 * per-session: what you come here to do is notice that a connector is unauthenticated
 * and fix it, which is true of every session at once and of none in particular.
 *
 * Laid out by what each group is *for* rather than uniformly. Forty servers rendered
 * as forty identical rows is a wall you have to read linearly, and on a wide screen it
 * is forty labels with their button a thousand pixels away. So: the ones needing you
 * are cards in a grid, sized to be scanned and clicked; the broken ones are wider,
 * because their error text is the whole point; and the ones that already work are
 * chips, because "it works" needs a name and nothing else.
 */

const STATUS_LABEL: Record<McpStatus, string> = {
  connected: "connected",
  "needs-auth": "needs auth",
  failed: "failed",
  pending: "pending approval",
  disabled: "disabled",
};

/** Headings, and the order the groups appear in: what you can fix, then what is broken. */
const GROUPS: { status: McpStatus; title: string; blurb: string }[] = [
  {
    status: "needs-auth",
    title: "Needs authentication",
    blurb: "Configured but not signed in. Sessions cannot use these yet.",
  },
  { status: "failed", title: "Failed", blurb: "Configured and signed in, but the server did not answer." },
  { status: "pending", title: "Pending approval", blurb: "From a project .mcp.json that has not been approved." },
  { status: "disabled", title: "Disabled", blurb: "Switched off, so no session loads them." },
  { status: "connected", title: "Connected", blurb: "Working, and available to every session." },
];

const ORIGIN_LABEL: Record<McpServer["origin"], string> = {
  claudeai: "claude.ai",
  plugin: "plugin",
  local: "local",
};

function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** claude.ai connectors carry their provider in the name; the prefix is noise in a list of them. */
function displayName(s: McpServer): string {
  if (s.origin === "claudeai") return s.name.replace(/^claude\.ai /, "");
  if (s.origin === "plugin") return s.name.replace(/^plugin:/, "");
  return s.name;
}

/**
 * The short form of where a server lives.
 *
 * A card is scanned, not read: the host tells you which service this is, and the
 * scheme and path are noise repeated forty times. A stdio server has no host, so its
 * command's last meaningful segment stands in. The full value stays on the title.
 */
function shortTarget(s: McpServer): string {
  try {
    const u = new URL(s.target);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    const parts = s.target.split(/\s+/);
    const last = parts[parts.length - 1] ?? s.target;
    return last.split("/").filter(Boolean).slice(-2).join("/") || last;
  }
}

export function McpPanel() {
  const [data, setData] = useState<McpPayload | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  /** null is "every group"; a status narrows to one. */
  const [only, setOnly] = useState<McpStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Kept in a ref so the poll interval does not need re-creating as runs finish. */
  const active = useRef(false);

  const load = useCallback(() => {
    return mcpApi
      .list()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const logins = data?.logins ?? [];
  const checking = data?.checking === true;
  /** Something on the daemon is mid-flight, so the answer will arrive by polling. */
  active.current = checking || logins.some((l) => !l.done);

  /**
   * Two things resolve out of band — a health check walking every server, and a browser
   * tab someone is signing into — and neither pushes. The poll exists for those windows
   * only, and stops with them.
   */
  useEffect(() => {
    if (!active.current) return;
    const t = setInterval(() => {
      void load();
    }, 2000);
    return () => clearInterval(t);
  }, [load, active.current]);

  const check = () => {
    setRefreshing(true);
    void mcpApi
      .refresh()
      .then((d) => setData(d))
      .catch((e: Error) => setError(e.message))
      .finally(() => setRefreshing(false));
  };

  const connect = (name: string) => {
    setBusy(name);
    void mcpApi
      .login(name)
      .then((r) => {
        if (!r.ok && r.error) setError(r.error);
        return load();
      })
      .finally(() => setBusy(null));
  };

  const dismiss = (name: string) => {
    void mcpApi.dismiss(name).then(() => load());
  };

  const servers = data?.servers ?? [];

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of servers) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [servers]);

  /** Search narrows within the groups; it does not flatten them. */
  const matched = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return servers;
    return servers.filter(
      (s) => s.name.toLowerCase().includes(q) || s.target.toLowerCase().includes(q),
    );
  }, [servers, filter]);

  const loginFor = (name: string): McpLogin | undefined => logins.find((l) => l.name === name);

  const groups = GROUPS.map((g) => ({
    ...g,
    items: matched
      .filter((s) => s.status === g.status && (only === null || only === g.status))
      .sort((a, b) => displayName(a).localeCompare(displayName(b))),
  })).filter((g) => g.items.length > 0);

  /** A card, for the two groups where the row has something to say or do. */
  const card = (s: McpServer) => {
    const login = loginFor(s.name);
    const waiting = login && !login.done;
    return (
      <li key={s.name} className={`mcp-card ${s.status} ${s.status === "failed" ? "wide" : ""}`}>
        <div className="mcp-card-head">
          <span className="mcp-name">{displayName(s)}</span>
          <span className="mcp-origin">{ORIGIN_LABEL[s.origin]}</span>
        </div>
        <div className="mcp-target" title={s.target}>
          {shortTarget(s)}
        </div>
        {s.detail && <div className="mcp-detail">{s.detail}</div>}
        {waiting && (
          <div className="mcp-detail waiting">
            Finish the sign-in in your browser — this updates itself.
          </div>
        )}
        {login?.done && !login.ok && (
          <div className="mcp-detail bad">
            {login.error}
            <button className="link-btn inline" onClick={() => dismiss(s.name)}>
              dismiss
            </button>
          </div>
        )}
        {login?.done && login.ok && (
          <div className="mcp-detail good">
            Signed in.
            <button className="link-btn inline" onClick={() => dismiss(s.name)}>
              dismiss
            </button>
          </div>
        )}
        {s.status === "needs-auth" && (
          <button
            className="mcp-connect"
            disabled={busy === s.name || waiting}
            onClick={() => connect(s.name)}
          >
            {waiting ? "Waiting for browser…" : busy === s.name ? "Opening…" : "Connect"}
          </button>
        )}
      </li>
    );
  };

  /** Working servers earn a name and a tooltip. Anything more is forty rows of "fine". */
  const chip = (s: McpServer) => (
    <li key={s.name} className="mcp-chip" title={`${s.name} · ${s.target}`}>
      <span className="dot" />
      {displayName(s)}
    </li>
  );

  const total = servers.length;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>MCP servers</h2>
        <div className="mcp-head-right">
          {data && data.checkedAt > 0 && (
            <span className="mcp-checked">
              {checking ? "checking every server…" : `checked ${ago(data.checkedAt)}`}
            </span>
          )}
          <button className="icon-btn" disabled={refreshing || checking} onClick={check}>
            {refreshing || checking ? "Checking…" : "Check now"}
          </button>
        </div>
      </div>
      <p className="hint">
        Every server this machine is configured with — your claude.ai connectors, plugin servers and
        whatever <code>~/.claude</code> adds. Sessions load exactly these. Connecting opens the
        sign-in in your browser on this machine.
      </p>

      {(error || data?.error) && <div className="mcp-error">{error ?? data?.error}</div>}

      {total > 0 && (
        <div className="mcp-toolbar">
          {/* The counts are the filter — a number you just read is the thing you want to
              narrow to, and a separate control would only say it twice. */}
          <div className="mcp-tabs" role="tablist" aria-label="Filter by status">
            <button
              role="tab"
              aria-selected={only === null}
              className={`mcp-tab ${only === null ? "on" : ""}`}
              onClick={() => setOnly(null)}
            >
              All <span className="mcp-tab-n">{total}</span>
            </button>
            {GROUPS.filter((g) => (counts[g.status] ?? 0) > 0).map((g) => (
              <button
                key={g.status}
                role="tab"
                aria-selected={only === g.status}
                className={`mcp-tab ${g.status} ${only === g.status ? "on" : ""}`}
                onClick={() => setOnly(only === g.status ? null : g.status)}
              >
                <span className="dot" />
                {STATUS_LABEL[g.status]} <span className="mcp-tab-n">{counts[g.status]}</span>
              </button>
            ))}
          </div>
          {total > 8 && (
            <input
              className="search mcp-filter"
              placeholder="Filter by name or host"
              spellCheck={false}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
        </div>
      )}

      {data === null && !error ? (
        <div className="empty">Loading…</div>
      ) : total === 0 ? (
        <div className="empty">
          {data?.checkedAt === 0
            ? "No list yet — run a check to ask the CLI what is configured."
            : "No MCP servers configured."}
        </div>
      ) : groups.length === 0 ? (
        <div className="empty">Nothing matches.</div>
      ) : (
        groups.map((g) => (
          <section key={g.status} className="mcp-group">
            <h3 className={`mcp-group-h ${g.status}`}>
              <span className="dot" />
              {g.title}
              <span className="mcp-group-n">{g.items.length}</span>
              <span className="mcp-group-blurb">{g.blurb}</span>
            </h3>
            {g.status === "connected" ? (
              <ul className="mcp-chips">{g.items.map(chip)}</ul>
            ) : (
              <ul className="mcp-grid">{g.items.map(card)}</ul>
            )}
          </section>
        ))
      )}
    </div>
  );
}
