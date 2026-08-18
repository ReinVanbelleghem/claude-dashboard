import { watch } from "node:fs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
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
  clearAll,
  clearResolved,
  countOffBranch,
  deleteComment,
  listComments,
  markSent,
  updateComment,
} from "./comments.ts";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { listDirs, listFavourites, removeFavourite, saveFavourite } from "./dirs.ts";
import { browse as browseFiles, readFile, writeFile } from "./files.ts";
import {
  branchFiles,
  branches as gitBranches,
  checkout as gitCheckout,
  commit as gitCommit,
  diff as gitDiff,
  discard as gitDiscard,
  fetch as gitFetch,
  log as gitLog,
  pull as gitPull,
  push as gitPush,
  repoStatus,
  show as gitShow,
  stage as gitStage,
  unstage as gitUnstage,
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

const HOME = homedir();

/** `/Users/rein/src/app` → `~/src/app`, so a banner never leaks the home prefix. */
function tildify(path: string): string {
  if (path === HOME) return "~";
  return path.startsWith(`${HOME}/`) ? `~${path.slice(HOME.length)}` : path;
}

/** Trim to a length that survives the macOS banner without an ellipsis mid-word. */
function clamp(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A branch worth naming. Detached heads and placeholders only add noise. */
function realBranch(branch: string | null): string | null {
  if (!branch) return null;
  const b = branch.trim();
  if (!b || b === "HEAD" || b === "(detached)" || b === "unknown") return null;
  return b;
}

function contextOf(cwd: string, branch: string | null): string {
  const short = cwd ? tildify(cwd) : "";
  // Two trailing segments are enough to recognise a project; "~" stays whole.
  const where = short === "~" ? "~" : short.split("/").filter(Boolean).slice(-2).join("/");
  const b = realBranch(branch);
  return b ? `${where || "unknown folder"} · ${b}` : where || "unknown folder";
}

/**
 * What to call the session in a banner. A title beats a folder, a folder beats an
 * id — and the home directory is not a project, so it never wins.
 */
function labelOf(title: string | null | undefined, cwd: string, key: string): string {
  const named = title?.trim();
  if (named) return clamp(named, 44);
  const base = cwd && cwd !== HOME ? basename(cwd) : "";
  return base || `session ${key.slice(0, 8)}`;
}

/** Plain-English verbs for the tools that block a turn most often. */
const TOOL_VERB: Record<string, string> = {
  Bash: "run a command",
  BashOutput: "read command output",
  Read: "read a file",
  Edit: "edit a file",
  Write: "write a file",
  NotebookEdit: "edit a notebook",
  Glob: "search for files",
  Grep: "search the code",
  WebFetch: "fetch a page",
  WebSearch: "search the web",
  Task: "start a subagent",
  Agent: "start a subagent",
  Workflow: "run a workflow",
  SendMessage: "message another agent",
  AskUserQuestion: "ask you a question",
  ExitPlanMode: "start on its plan",
  KillShell: "stop a running command",
};

/** The argument worth quoting for a given tool — the command, the file, the URL. */
function toolObject(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  switch (toolName) {
    case "Bash":
      return pick(i.command);
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const p = pick(i.file_path ?? i.notebook_path);
      return p ? basename(p) : null;
    }
    case "WebFetch":
      return pick(i.url);
    case "WebSearch":
      return pick(i.query);
    case "Task":
    case "Agent":
      return pick(i.description);
    default:
      return null;
  }
}

/** "Wants to run a command: bun test" — the request, in words you can act on. */
function permissionDetail(toolName: string, input: unknown, description: string | null): string {
  if (toolName.startsWith("mcp__")) {
    const [, server, tool] = toolName.split("__");
    const pretty = (tool ?? toolName).replace(/[-_]/g, " ");
    return clamp(`Wants to use ${pretty}${server ? ` (${server.replace(/_/g, " ")})` : ""}`, 90);
  }
  const verb = TOOL_VERB[toolName];
  if (!verb) return clamp(`Wants to use ${toolName}${description ? `: ${description}` : ""}`, 90);
  const object = toolObject(toolName, input);
  return clamp(object ? `Wants to ${verb}: ${object}` : `Wants to ${verb}`, 90);
}

/** The permission a session is parked on, for a notification that says why. */
function pendingRequest(key: string): string | null {
  const detail = getAgent(key);
  if (!detail) return null;
  for (let i = detail.timeline.length - 1; i >= 0; i--) {
    const item = detail.timeline[i];
    if (item.kind === "permission" && item.decision === null) {
      return permissionDetail(item.toolName, item.input, item.description);
    }
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
      label: labelOf(s.name ?? row?.title, s.cwd, s.sessionId),
      context: contextOf(s.cwd, row?.git_branch ?? null),
      detail: s.waitingFor ? clamp(`Waiting on you: ${s.waitingFor}`, 90) : "Waiting for your reply",
    });
  }

  for (const a of listAgents()) {
    const row = a.sessionId ? labelQuery.get(a.sessionId) : null;
    const label = labelOf(a.title ?? row?.title, a.cwd, a.key);
    const context = contextOf(a.cwd, row?.git_branch ?? null);
    const base = { sessionId: a.sessionId, label, context };

    if (a.status === "awaiting-permission") {
      out.push({
        ...base,
        kind: "awaitingPermission",
        key: `awaitingPermission:${a.key}`,
        detail: pendingRequest(a.key) ?? "Waiting for a permission decision",
      });
    } else if (a.status === "error") {
      out.push({
        ...base,
        kind: "sessionError",
        key: `sessionError:${a.key}`,
        detail: clamp(a.error ?? a.endedReason ?? "The session stopped unexpectedly", 90),
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

/**
 * One page of sessions, newest first, with the size of the whole result set.
 *
 * The total is what makes paging navigable rather than a guess: without it the
 * client cannot tell a last page from a page that happens to be short, so it can
 * neither disable "next" nor say how much is behind it. It counts the same
 * predicate the page does, so the two can never disagree.
 */
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
    if (ids.length === 0) return { sessions: [], total: 0 };
    const holes = ids.map(() => "?").join(",");
    const sessions = db
      .query<SessionRow, string[]>(
        `SELECT ${SESSION_COLS} FROM sessions WHERE id IN (${holes})
         ORDER BY last_ts DESC LIMIT ${limit} OFFSET ${offset}`,
      )
      .all(...ids);
    /**
     * Counted from the matched rows rather than from `ids.length`: FTS can name a
     * session the index has since dropped, and a total larger than the pages can
     * ever reach leaves a last page that is permanently empty.
     */
    const total =
      db
        .query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM sessions WHERE id IN (${holes})`)
        .get(...ids)?.n ?? sessions.length;
    return { sessions, total };
  }
  const sessions = db
    .query<SessionRow, [number, number]>(
      `SELECT ${SESSION_COLS} FROM sessions ORDER BY last_ts DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset);
  const total = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM sessions`).get()?.n ?? 0;
  return { sessions, total };
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
              ok: answerPermission(
                id,
                String(body.requestId ?? ""),
                body.behavior as never,
                body.answers as Record<string, string> | undefined,
              ),
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
        /**
         * `branch` present scopes the read to that branch; absent returns the whole
         * repo. Present-but-empty is a detached HEAD, which is why this asks whether
         * the parameter was sent rather than reading its value — the two are the
         * same string and mean different things.
         */
        const branch = url.searchParams.has("branch")
          ? url.searchParams.get("branch") || null
          : undefined;
        const comments = listComments(repo, branch);
        return json({
          comments,
          offBranch: repo && branch !== undefined ? countOffBranch(repo, branch) : 0,
        });
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
      const branch = url.searchParams.has("branch")
        ? url.searchParams.get("branch") || null
        : undefined;
      return json(buildPrompt(repo, { branch }));
    }

    if (p === "/api/comments/sent" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { ids?: string[] };
      markSent(b.ids ?? []);
      return json({ ok: true });
    }

    if (p === "/api/comments/clear-all" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { repo?: string; branch?: string | null };
      const branch = "branch" in b ? (b.branch ?? null) : undefined;
      return json({ removed: b.repo ? clearAll(b.repo, branch) : 0 });
    }

    if (p === "/api/comments/clear-resolved" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { repo?: string; branch?: string | null };
      // Same three-way distinction as the read: a missing key clears the repo, a
      // present one clears only that branch.
      const branch = "branch" in b ? (b.branch ?? null) : undefined;
      return json({ removed: b.repo ? clearResolved(b.repo, branch) : 0 });
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
          paths?: unknown;
          all?: boolean;
          message?: string;
          noVerify?: boolean;
        };
        const root = b.cwd?.trim();
        if (!root) return json({ error: "cwd is required" }, 400);

        /** Paths only ever arrive as a list of strings; git.ts validates each one. */
        const paths = Array.isArray(b.paths) ? b.paths.filter((x): x is string => typeof x === "string") : [];

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

        if (action === "stage" || action === "unstage") {
          if (!b.all && !paths.length) return json({ error: "paths or all is required" }, 400);
          const fn = action === "stage" ? gitStage : gitUnstage;
          const r = await fn(root, { paths, all: !!b.all });
          // The index changed, so any tab showing this repo's file list is stale.
          if (r.ok) broadcast("git", { root: r.status?.root ?? null, branch: r.status?.branch ?? null });
          return json(r, r.ok ? 200 : 409);
        }

        // No `all` here, unlike stage: discarding is the one write that destroys
        // work, so it always names its files.
        if (action === "discard") {
          if (!paths.length) return json({ error: "paths are required" }, 400);
          const r = await gitDiscard(root, paths);
          if (r.ok) broadcast("git", { root: r.status?.root ?? null, branch: r.status?.branch ?? null });
          return json(r, r.ok ? 200 : 409);
        }

        if (action === "commit") {
          const message = typeof b.message === "string" ? b.message : "";
          const r = await gitCommit(root, message, { noVerify: !!b.noVerify });
          // HEAD moved: branch history, the ahead count and the diff all changed.
          if (r.ok) broadcast("git", { root: r.status?.root ?? null, branch: r.status?.branch ?? null });
          return json(r, r.ok ? 200 : 409);
        }

        if (action === "push") {
          const r = await gitPush(root);
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

    // Browse or search the repo, to open a file no diff mentions.
    if (p === "/api/files/browse") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return json({ error: "cwd is required" }, 400);
      return json(
        await browseFiles(cwd, {
          path: url.searchParams.get("path") ?? undefined,
          q: url.searchParams.get("q") ?? undefined,
        }),
      );
    }

    // ── one file, for the editor in the diff panel ───────────────────────────
    if (p === "/api/file") {
      if (req.method === "POST") {
        const b = (await req.json().catch(() => ({}))) as {
          cwd?: string;
          path?: string;
          content?: string;
          baseHash?: string;
        };
        if (!b.cwd?.trim() || !b.path?.trim()) return json({ error: "cwd and path are required" }, 400);
        if (typeof b.content !== "string") return json({ error: "content is required" }, 400);
        const r = await writeFile(b.cwd, b.path, b.content, b.baseHash ?? "");
        // The file list, the diff and every branch badge are now describing the
        // working tree as it was a moment ago.
        if (r.ok) broadcast("git", { root: null, branch: null });
        return json(r, r.ok ? 200 : 409);
      }
      const cwd = url.searchParams.get("cwd");
      const path = url.searchParams.get("path");
      if (!cwd || !path) return json({ error: "cwd and path are required" }, 400);
      const r = await readFile(cwd, path);
      return json(r, r.ok ? 200 : 400);
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
      // Clamped rather than trusted: these come off a URL, and a NaN or a negative
      // offset is a SQL error rather than an empty page.
      const limit = Math.min(500, Math.max(1, Math.floor(Number(url.searchParams.get("limit")) || 100)));
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
      const q = url.searchParams.get("q");
      const { sessions, total } = listSessions(limit, offset, q);
      return json({ sessions, total, limit, offset });
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
