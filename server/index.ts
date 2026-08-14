import { watch } from "node:fs";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  answerPermission,
  cachedModels,
  forgetAgent,
  forgetRestorable,
  getAgent,
  IMAGE_FILE_RE,
  IMAGE_MEDIA_TYPES,
  IMAGES_DIR,
  type ImageMediaType,
  type InboundImage,
  listRestorable,
  pruneImages,
  restoreAgent,
  interruptAgent,
  listAgents,
  ownedSessionIds,
  rosterPayload,
  sendMessage,
  setAgentEmitter,
  setAgentMode,
  setAgentModel,
  startAgent,
  stopAgent,
  stopAllAgents,
} from "./agents.ts";
import {
  addComment,
  buildPrompt,
  clearResolved,
  deleteComment,
  listComments,
  markSent,
  updateComment,
} from "./comments.ts";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { listDirs, listFavourites, removeFavourite, saveFavourite } from "./dirs.ts";
import {
  branchFiles,
  branches as gitBranches,
  checkout as gitCheckout,
  diff as gitDiff,
  fetch as gitFetch,
  log as gitLog,
  pull as gitPull,
  repoStatus,
  show as gitShow,
} from "./git.ts";
import { indexOnce } from "./indexer.ts";
import {
  reconcile,
  sendTestNotification,
  setFocus,
  setNotifyEmitter,
  type NotifySubject,
} from "./notify.ts";
import { PORT, PROJECTS_DIR, SESSIONS_DIR, slugToPath } from "./paths.ts";
import { needsInput, readRegistry } from "./registry.ts";
import { getSettings, loadSettings, updateSettings } from "./settings.ts";
import { usageSummary } from "./usage.ts";

const cfg = loadConfig();
const settings = loadSettings();
const db = openDb();

// Budgets are read once at startup; printing them makes a stale config obvious
// instead of leaving you wondering why a gauge disagrees with the file on disk.
console.log(
  `[claude-dashboard] budgets: ${(cfg.budgets.fiveHourTokens / 1e6).toFixed(0)}M per 5h, ` +
    `${(cfg.budgets.weeklyTokens / 1e6).toFixed(0)}M per week, ` +
    `$${cfg.budgets.dailyCostUsd}/day (fresh tokens; edit config.json to tune)`,
);
{
  const n = settings.notifications;
  const on = Object.entries(n.events)
    .filter(([, v]) => v)
    .map(([k]) => k);
  const channels = Object.entries(n.channels)
    .filter(([, v]) => v)
    .map(([k]) => k);
  console.log(
    `[claude-dashboard] notifications: ${n.enabled ? on.join(", ") || "none enabled" : "off"}` +
      ` via ${channels.join(", ") || "no channel"} (${n.delaySeconds}s delay)`,
  );
}
console.log("[claude-dashboard] backfilling index…");
const t0 = Date.now();
const touched = await indexOnce(db);
console.log(`[claude-dashboard] indexed ${touched} transcript(s) in ${Date.now() - t0}ms`);

// ── SSE fan-out ────────────────────────────────────────────────────────────────
type Client = { send: (event: string, data: unknown) => void; close: () => void };
const clients = new Set<Client>();

function broadcast(event: string, data: unknown) {
  for (const c of clients) {
    try {
      c.send(event, data);
    } catch {
      clients.delete(c);
    }
  }
}

// No timeline can be pointing at a stored attachment yet, so this is the one
// safe moment to expire them.
pruneImages();

setNotifyEmitter(broadcast);
// Every roster change already flows through here, which makes it the natural
// place to re-evaluate what deserves a notification — agents.ts stays unaware.
setAgentEmitter((event, data) => {
  broadcast(event, data);
  if (event === "agents") notifyTick();
});

/**
 * Validate pasted images. Returns the parsed list, or a string describing what is
 * wrong with it — the daemon is local, but a screenshot is megabytes and the API
 * rejects the request wholesale past its own limit, so it is worth failing here
 * with a message the composer can show rather than mid-turn.
 */
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // The API's per-image ceiling.
const MAX_TOTAL_BYTES = 24 * 1024 * 1024; // Under the 32MB request cap, with headroom.

function parseImages(raw: unknown): InboundImage[] | string {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return "images must be an array";
  if (raw.length > MAX_IMAGES) return `at most ${MAX_IMAGES} images per message`;

  const out: InboundImage[] = [];
  let total = 0;
  for (const entry of raw) {
    const e = entry as { mediaType?: unknown; data?: unknown };
    const mediaType = String(e.mediaType ?? "");
    const data = String(e.data ?? "");
    if (!IMAGE_MEDIA_TYPES.includes(mediaType as ImageMediaType)) {
      return `unsupported image type ${mediaType || "(none)"} — use PNG, JPEG, GIF or WebP`;
    }
    if (!data) return "image data is empty";
    const bytes = Math.round((data.length * 3) / 4);
    if (bytes > MAX_IMAGE_BYTES) return "image is larger than 5MB";
    total += bytes;
    if (total > MAX_TOTAL_BYTES) return "attached images total more than 24MB";
    out.push({ mediaType: mediaType as ImageMediaType, data });
  }
  return out;
}

function livePayload() {
  // Sessions we drive are reported separately, with their live state; dropping
  // them here keeps them out of the external list and out of these counts.
  const owned = ownedSessionIds();
  const sessions = readRegistry().filter((s) => !owned.has(s.sessionId));
  return {
    sessions,
    counts: {
      alive: sessions.filter((s) => s.alive).length,
      needsInput: sessions.filter(needsInput).length,
      stale: sessions.filter((s) => !s.alive).length,
    },
  };
}

let liveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleLiveBroadcast() {
  if (liveTimer) return;
  liveTimer = setTimeout(() => {
    liveTimer = null;
    broadcast("live", livePayload());
    notifyTick();
  }, 150);
}

// ── notifications ─────────────────────────────────────────────────────────────
/** Titles and branches come from the index; nothing here spawns a subprocess. */
const labelQuery = db.query<{ title: string | null; git_branch: string | null }, [string]>(
  "SELECT title, git_branch FROM sessions WHERE id = ?",
);

function contextOf(cwd: string, branch: string | null): string {
  const where = cwd ? cwd.split("/").filter(Boolean).slice(-2).join("/") : "unknown folder";
  return branch ? `${where} on ${branch}` : where;
}

/** The tool a session is currently blocked on, for a notification that says why. */
function pendingTool(key: string): string | null {
  const detail = getAgent(key);
  if (!detail) return null;
  for (let i = detail.timeline.length - 1; i >= 0; i--) {
    const item = detail.timeline[i];
    if (item.kind === "permission" && item.decision === null) return item.toolName;
  }
  return null;
}

/**
 * Everything that currently wants attention, in the shape notify.ts consumes. It
 * describes the present, not events: the notifier does the edge-triggering, so
 * calling this on every poll is correct and idempotent.
 */
function notifySubjects(): NotifySubject[] {
  const out: NotifySubject[] = [];

  for (const s of livePayload().sessions) {
    if (!needsInput(s)) continue;
    const row = labelQuery.get(s.sessionId);
    out.push({
      kind: "needsInput",
      key: `needsInput:${s.sessionId}`,
      sessionId: s.sessionId,
      label: s.name ?? row?.title ?? (basename(s.cwd || "") || s.sessionId.slice(0, 8)),
      context: contextOf(s.cwd, row?.git_branch ?? null),
      detail: s.waitingFor ? `Waiting on you: ${s.waitingFor}` : "Waiting for your input",
    });
  }

  for (const a of listAgents()) {
    const row = a.sessionId ? labelQuery.get(a.sessionId) : null;
    const label = a.title ?? row?.title ?? (basename(a.cwd || "") || a.key.slice(0, 8));
    const context = contextOf(a.cwd, row?.git_branch ?? null);
    const base = { sessionId: a.sessionId, label, context };

    if (a.status === "awaiting-permission") {
      const tool = pendingTool(a.key);
      out.push({
        ...base,
        kind: "awaitingPermission",
        key: `awaitingPermission:${a.key}`,
        detail: tool ? `Asking to use ${tool}` : "Waiting for a permission decision",
      });
    } else if (a.status === "error") {
      out.push({
        ...base,
        kind: "sessionError",
        key: `sessionError:${a.key}`,
        detail: a.error ?? a.endedReason ?? "The session stopped unexpectedly",
      });
    } else if (a.status === "idle" && a.turns > 0) {
      // Idle with turns behind it means a reply just landed. A session that is
      // idle before its first prompt has not finished anything.
      out.push({
        ...base,
        kind: "turnComplete",
        key: `turnComplete:${a.key}:${a.turns}`,
        detail: `Finished after ${a.turns} turn${a.turns === 1 ? "" : "s"}`,
      });
    }
  }

  return out;
}

function notifyTick() {
  try {
    reconcile(notifySubjects());
  } catch (err) {
    console.error("[claude-dashboard] notification pass failed:", err);
  }
}

// The registry rewrites a file on every status change, so watching the directory
// is the fast path. The interval is a safety net: pid liveness can change with no
// file write at all (a crashed session leaves its json behind).
if (existsSync(SESSIONS_DIR)) {
  try {
    watch(SESSIONS_DIR, scheduleLiveBroadcast);
  } catch (err) {
    console.warn("[claude-dashboard] sessions watch failed, polling only:", err);
  }
}
setInterval(scheduleLiveBroadcast, 3_000);

// Transcripts are append-heavy; poll rather than watch recursively so we get one
// coalesced pass instead of an event per line written.
setInterval(async () => {
  try {
    if ((await indexOnce(db)) > 0) {
      broadcast("index", { at: Date.now() });
      broadcast("usage", usageSummary(db, cfg, Date.now()));
    }
  } catch (err) {
    console.error("[claude-dashboard] index pass failed:", err);
  }
}, 4_000);

// ── queries ───────────────────────────────────────────────────────────────────
type SessionRow = {
  id: string;
  project_slug: string;
  cwd: string | null;
  git_branch: string | null;
  title: string | null;
  first_ts: number | null;
  last_ts: number | null;
  msg_count: number;
  prompt_count: number;
  tool_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  model: string | null;
};

const SESSION_COLS = `id, project_slug, cwd, git_branch, title, first_ts, last_ts,
  msg_count, prompt_count, tool_count, input_tokens, output_tokens, cache_read,
  cache_write, model`;

function listSessions(limit: number, offset: number, q: string | null) {
  if (q && q.trim()) {
    // FTS5 needs a sanitized query — bare punctuation is a syntax error, so we
    // quote each term and let the caller's words act as an implicit AND.
    const terms = q
      .trim()
      .split(/\s+/)
      .map((w) => `"${w.replace(/"/g, '""')}"`)
      .join(" ");
    const ids = db
      .query<{ session_id: string }, [string]>(
        `SELECT DISTINCT session_id FROM prompts_fts WHERE prompts_fts MATCH ?`,
      )
      .all(terms)
      .map((r) => r.session_id);
    if (ids.length === 0) return [];
    const holes = ids.map(() => "?").join(",");
    return db
      .query<SessionRow, string[]>(
        `SELECT ${SESSION_COLS} FROM sessions WHERE id IN (${holes})
         ORDER BY last_ts DESC LIMIT ${limit} OFFSET ${offset}`,
      )
      .all(...ids);
  }
  return db
    .query<SessionRow, [number, number]>(
      `SELECT ${SESSION_COLS} FROM sessions ORDER BY last_ts DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset);
}

function sessionDetail(id: string) {
  const session = db
    .query<SessionRow, [string]>(`SELECT ${SESSION_COLS} FROM sessions WHERE id = ?`)
    .get(id);
  if (!session) return null;
  return {
    session,
    prompts: db
      .query<{ uuid: string; ts: number | null; text: string }, [string]>(
        "SELECT uuid, ts, text FROM prompts WHERE session_id = ? ORDER BY ts",
      )
      .all(id),
    // The conversation as it happened. Subagent (sidechain) turns are excluded:
    // they are a different conversation that merely shares the transcript file.
    turns: db
      .query<
        { uuid: string; ts: number | null; text: string; role: string; model: string | null },
        [string, string]
      >(
        `SELECT uuid, ts, text, 'user' AS role, NULL AS model FROM prompts WHERE session_id = ?
         UNION ALL
         SELECT uuid, ts, text, 'assistant' AS role, model FROM replies
           WHERE session_id = ? AND is_sidechain = 0
         ORDER BY ts`,
      )
      .all(id, id),
    tools: db
      .query<{ name: string; count: number }, [string]>(
        "SELECT name, count FROM tools WHERE session_id = ? ORDER BY count DESC",
      )
      .all(id),
    prLinks: db
      .query<{ pr_url: string; pr_number: number | null; repo: string | null }, [string]>(
        "SELECT pr_url, pr_number, repo FROM pr_links WHERE session_id = ?",
      )
      .all(id),
  };
}

function overview() {
  const totals = db
    .query<{ sessions: number; msgs: number; prompts: number; tools: number }, []>(
      `SELECT COUNT(*) AS sessions, SUM(msg_count) AS msgs,
              SUM(prompt_count) AS prompts, SUM(tool_count) AS tools FROM sessions`,
    )
    .get();
  // Prefer the cwd recorded in the transcript: the directory slug replaces every
  // "/" with "-", so a path segment containing a dash is unrecoverable from it.
  const projects = db
    .query<
      { project_slug: string; cwd: string | null; sessions: number; last_ts: number | null },
      []
    >(
      `SELECT project_slug, MAX(cwd) AS cwd, COUNT(*) AS sessions, MAX(last_ts) AS last_ts
         FROM sessions GROUP BY project_slug ORDER BY last_ts DESC`,
    )
    .all()
    .map((p) => ({ ...p, path: p.cwd ?? slugToPath(p.project_slug) }));
  const topTools = db
    .query<{ name: string; count: number }, []>(
      "SELECT name, SUM(count) AS count FROM tools GROUP BY name ORDER BY count DESC LIMIT 15",
    )
    .all();
  return { totals, projects, topTools };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const DIST = join(import.meta.dir, "..", "dist");
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });

const server = Bun.serve({
  port: PORT,
  // Localhost only. These endpoints start Claude sessions with real file access
  // on this machine, so the server must not be reachable from the network.
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    // ── owned sessions (write path) ──────────────────────────────────────────
    if (p === "/api/agents" && req.method === "GET")
      return json(rosterPayload());

    if (p === "/api/agents/restore" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { sessionId?: string };
      const key = body.sessionId ? restoreAgent(body.sessionId) : null;
      return key ? json({ key }) : json({ error: "unknown session" }, 404);
    }

    if (p === "/api/agents/forget" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { sessionId?: string };
      return json({ ok: !!body.sessionId && forgetRestorable(body.sessionId) });
    }

    if (p === "/api/agents" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as
        | {
            cwd?: string;
            model?: string;
            permissionMode?: string;
            resume?: string;
            prompt?: string;
            title?: string;
          }
        | null;
      const cwd = body?.cwd?.trim();
      if (!cwd) return json({ error: "cwd is required" }, 400);
      if (!existsSync(cwd)) return json({ error: `no such directory: ${cwd}` }, 400);
      const key = startAgent({
        cwd,
        model: body?.model || undefined,
        permissionMode: (body?.permissionMode as never) || undefined,
        resume: body?.resume || undefined,
        prompt: body?.prompt || undefined,
        title: body?.title || undefined,
      });
      return json({ key, agent: getAgent(key) });
    }

    if (p.startsWith("/api/agents/")) {
      const [key, action] = p.slice("/api/agents/".length).split("/");
      if (!key) return json({ error: "not found" }, 404);

      if (!action && req.method === "GET") {
        const a = getAgent(decodeURIComponent(key));
        return a ? json(a) : json({ error: "not found" }, 404);
      }
      if (!action && req.method === "DELETE") {
        // First DELETE ends the session; a second one drops it from the roster,
        // so the list can be tidied without a separate endpoint.
        const id = decodeURIComponent(key);
        if (forgetAgent(id)) return json({ ok: true, forgotten: true });
        return json({ ok: await stopAgent(id) });
      }
      if (req.method === "POST") {
        const id = decodeURIComponent(key);
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        switch (action) {
          case "message": {
            const text = String(body.text ?? "").trim();
            const images = parseImages(body.images);
            if (typeof images === "string") return json({ error: images }, 400);
            // An image on its own is a legitimate message ("what is this?"), so the
            // requirement is content of some kind, not text specifically.
            if (!text && images.length === 0) return json({ error: "text is required" }, 400);
            return json({ ok: sendMessage(id, text, images) });
          }
          case "permission":
            return json({
              ok: answerPermission(id, String(body.requestId ?? ""), body.behavior as never),
            });
          case "interrupt":
            return json({ ok: await interruptAgent(id) });
          case "model": {
            const r = await setAgentModel(id, (body.model as string) || undefined);
            return json(r, r.ok ? 200 : 400);
          }
          case "mode": {
            const r = await setAgentMode(id, body.permissionMode as never);
            return json(r, r.ok ? 200 : 400);
          }
        }
      }
      return json({ error: "not found" }, 404);
    }

    // Stored message attachments. The name is matched against the uuid pattern
    // the writer uses rather than sanitised, so no `..` or absolute path can be
    // smuggled through — and content-type comes from that same match, never from
    // the request. Immutable because the name is a uuid: the bytes never change.
    if (p.startsWith("/api/images/")) {
      const name = p.slice("/api/images/".length);
      if (!IMAGE_FILE_RE.test(name)) return new Response("Not found", { status: 404 });
      const file = Bun.file(join(IMAGES_DIR, name));
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      return new Response(file, {
        headers: { "cache-control": "public, max-age=31536000, immutable" },
      });
    }

    if (p === "/api/health") return json({ ok: true, projectsDir: PROJECTS_DIR });

    // ── settings ─────────────────────────────────────────────────────────────
    if (p === "/api/settings") {
      if (req.method === "GET") return json({ settings: getSettings() });
      if (req.method === "POST") {
        const patch = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const next = updateSettings(patch);
        // Other open tabs should not keep showing the old toggles.
        broadcast("settings", next);
        return json({ settings: next });
      }
    }

    if (p === "/api/settings/test" && req.method === "POST") {
      return json(await sendTestNotification());
    }

    /**
     * The browser tells us what it is looking at, so a session you already have
     * on screen doesn't notify you about itself.
     */
    if (p === "/api/focus" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { sessionId?: string; visible?: boolean };
      setFocus(b.sessionId ?? null, b.visible !== false);
      return json({ ok: true });
    }

    // ── review comments ──────────────────────────────────────────────────────
    if (p === "/api/comments") {
      if (req.method === "GET") {
        const repo = url.searchParams.get("repo") ?? undefined;
        return json({ comments: listComments(repo) });
      }
      if (req.method === "POST") {
        const b = (await req.json().catch(() => ({}))) as Parameters<typeof addComment>[0];
        const c = addComment(b);
        return c ? json({ comment: c }) : json({ error: "repo and body are required" }, 400);
      }
    }

    /**
     * Compose the open comments into a prompt. Returned rather than sent, so the
     * caller can show it before it goes anywhere, and marked as sent only when it
     * actually is.
     */
    if (p === "/api/comments/prompt") {
      const repo = url.searchParams.get("repo");
      if (!repo) return json({ error: "repo is required" }, 400);
      return json(buildPrompt(repo, { branch: url.searchParams.get("branch") }));
    }

    if (p === "/api/comments/sent" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { ids?: string[] };
      markSent(b.ids ?? []);
      return json({ ok: true });
    }

    if (p === "/api/comments/clear-resolved" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { repo?: string };
      return json({ removed: b.repo ? clearResolved(b.repo) : 0 });
    }

    if (p.startsWith("/api/comments/")) {
      const id = decodeURIComponent(p.slice("/api/comments/".length));
      if (req.method === "DELETE") return json({ ok: deleteComment(id) });
      if (req.method === "POST") {
        const b = (await req.json().catch(() => ({}))) as Parameters<typeof updateComment>[1];
        const c = updateComment(id, b);
        return c ? json({ comment: c }) : json({ error: "not found" }, 404);
      }
    }

    // ── git ──────────────────────────────────────────────────────────────────
    if (p.startsWith("/api/git/")) {
      const action = p.slice("/api/git/".length);

      /**
       * Writes take cwd from the body rather than the query string: they are POSTs,
       * and a mutating URL is one accidental link-share away from being followed.
       */
      if (req.method === "POST") {
        const b = (await req.json().catch(() => ({}))) as {
          cwd?: string;
          branch?: string;
          create?: boolean;
          from?: string;
        };
        const root = b.cwd?.trim();
        if (!root) return json({ error: "cwd is required" }, 400);

        if (action === "checkout") {
          const branch = b.branch?.trim();
          if (!branch) return json({ error: "branch is required" }, 400);
          const r = await gitCheckout(root, { branch, create: !!b.create, from: b.from });
          // Every open tab is showing a branch name that may have just changed.
          if (r.ok) broadcast("git", { root: r.status?.root ?? null, branch: r.status?.branch ?? null });
          return json(r, r.ok ? 200 : 409);
        }

        if (action === "fetch") {
          const r = await gitFetch(root);
          return json(r, r.ok ? 200 : 400);
        }

        if (action === "pull") {
          const r = await gitPull(root);
          // HEAD moved, so every tab's branch line and diff is now behind.
          if (r.ok) broadcast("git", { root: r.status?.root ?? null, branch: r.status?.branch ?? null });
          return json(r, r.ok ? 200 : 409);
        }

        return json({ error: "not found" }, 404);
      }

      const cwd = url.searchParams.get("cwd");
      if (!cwd) return json({ error: "cwd is required" }, 400);
      const ignoreWhitespace = url.searchParams.get("ws") === "ignore";

      if (action === "branches") {
        return json(
          await gitBranches(cwd, {
            q: url.searchParams.get("q") ?? undefined,
            limit: Number(url.searchParams.get("limit")) || undefined,
          }),
        );
      }

      if (action === "status") {
        return json(await repoStatus(cwd, url.searchParams.get("force") === "1"));
      }

      if (action === "diff") {
        const scope = url.searchParams.get("scope") === "branch" ? "branch" : "worktree";
        return json(
          await gitDiff({
            cwd,
            scope,
            path: url.searchParams.get("path") ?? undefined,
            ignoreWhitespace,
            context: Number(url.searchParams.get("context") ?? 3),
          }),
        );
      }

      if (action === "log") {
        return json(await gitLog(cwd, Number(url.searchParams.get("limit") ?? 50)));
      }

      if (action === "branch-files") return json({ files: await branchFiles(cwd) });

      if (action === "commit") {
        const sha = url.searchParams.get("sha") ?? "";
        const r = await gitShow(cwd, sha, { ignoreWhitespace });
        return json(r, r.ok ? 200 : 400);
      }

      return json({ error: "not found" }, 404);
    }

    // Models a session last reported. Empty until the first session has run, in
    // which case the UI falls back to its built-in shortlist.
    if (p === "/api/models") return json({ models: cachedModels() });

    // ── directory picking for the new-session dialog ─────────────────────────
    if (p === "/api/dirs") return json(listDirs(url.searchParams.get("path") ?? undefined));

    if (p === "/api/favourites") {
      if (req.method === "GET") return json({ favourites: listFavourites() });
      if (req.method === "POST") {
        const b = (await req.json().catch(() => ({}))) as { label?: string; path?: string; remove?: boolean };
        if (!b.path) return json({ error: "path is required" }, 400);
        return json({
          favourites: b.remove ? removeFavourite(b.path) : saveFavourite(b.label ?? "", b.path),
        });
      }
    }
    if (p === "/api/live") return json(livePayload());
    if (p === "/api/usage") return json(usageSummary(db, cfg, Date.now()));
    if (p === "/api/overview") return json(overview());
    if (p === "/api/config") return json({ budgets: cfg.budgets, pricing: cfg.pricing });

    if (p === "/api/sessions") {
      const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 100));
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const q = url.searchParams.get("q");
      return json({ sessions: listSessions(limit, offset, q) });
    }

    if (p.startsWith("/api/sessions/")) {
      const detail = sessionDetail(decodeURIComponent(p.slice("/api/sessions/".length)));
      return detail ? json(detail) : json({ error: "not found" }, 404);
    }

    if (p === "/api/events") {
      let interval: ReturnType<typeof setInterval> | null = null;
      let client: Client | null = null;
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          client = {
            send: (event, data) =>
              controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
            close: () => controller.close(),
          };
          clients.add(client);
          client.send("live", livePayload());
          client.send("usage", usageSummary(db, cfg, Date.now()));
          client.send("agents", rosterPayload());
          client.send("settings", getSettings());
          // Comment-only heartbeat keeps proxies and browsers from timing out.
          interval = setInterval(() => {
            try {
              controller.enqueue(enc.encode(": ping\n\n"));
            } catch {
              if (client) clients.delete(client);
            }
          }, 20_000);
        },
        cancel() {
          if (interval) clearInterval(interval);
          if (client) clients.delete(client);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "access-control-allow-origin": "*",
        },
      });
    }

    // Static build (production). In dev, Vite serves the UI and proxies /api here.
    if (existsSync(DIST)) {
      const file = Bun.file(join(DIST, p === "/" ? "index.html" : p));
      if (await file.exists()) return new Response(file);
      const index = Bun.file(join(DIST, "index.html"));
      if (await index.exists()) return new Response(index);
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`[claude-dashboard] api on http://localhost:${server.port}`);

// Owned sessions are child processes; ending them beats orphaning them.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void stopAllAgents().finally(() => process.exit(0));
  });
}
