import type { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { PROJECTS_DIR } from "./paths.ts";

/** Accumulator for one session while we parse its (possibly partial) JSONL. */
type Agg = {
  id: string;
  project_slug: string;
  cwd: string | null;
  git_branch: string | null;
  title: string | null;
  /** 1 when the title was set deliberately rather than auto-generated. */
  title_custom: number;
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
  version: string | null;
  file_path: string;
};

function emptyAgg(id: string, slug: string, filePath: string): Agg {
  return {
    id,
    project_slug: slug,
    cwd: null,
    git_branch: null,
    title: null,
    title_custom: 0,
    first_ts: null,
    last_ts: null,
    msg_count: 0,
    prompt_count: 0,
    tool_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read: 0,
    cache_write: 0,
    model: null,
    version: null,
    file_path: filePath,
  };
}

function ts(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
}

/**
 * Pull the human-typed text out of a `user` record. Records carrying
 * `toolUseResult` are tool results wearing a user costume, and `isMeta` ones are
 * harness-injected — neither is a prompt. Image blocks are inlined base64 and
 * are dropped on the floor: a single screenshot is megabytes.
 */
function promptText(rec: any): string | null {
  if (rec.toolUseResult !== undefined || rec.isMeta) return null;
  const content = rec.message?.content;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text);
  const text = parts.join("\n").trim();
  return text || null;
}

/** A single reply is capped so one runaway turn can't bloat the database. */
const MAX_REPLY_CHARS = 20_000;

/**
 * Pull Claude's prose out of an `assistant` record. Only `text` blocks count:
 * `thinking` is not the reply, and `tool_use` is already counted separately.
 * Turns that were pure tool calls yield nothing and are skipped.
 */
function replyText(rec: any): string | null {
  const content = rec.message?.content;
  if (typeof content === "string") return content.trim().slice(0, MAX_REPLY_CHARS) || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n")
    .trim();
  return text ? text.slice(0, MAX_REPLY_CHARS) : null;
}

/** Top-level session transcripts only — subdirectories hold tool-result overflow. */
type Transcript = {
  path: string;
  slug: string;
  sessionId: string;
  /**
   * True for a subagent transcript. Its assistant turns are real spend and must be
   * counted, but its prompts are Claude-authored task briefs rather than anything
   * the user typed, so they stay out of the conversation and prompt search.
   */
  usageOnly: boolean;
};

/**
 * Every transcript under a project slug. Subagent transcripts live a further two
 * levels down, as `<slug>/<parent-session-id>/subagents/agent-*.jsonl`, and are
 * attributed to the parent session that spawned them.
 */
function listTranscripts(): Transcript[] {
  const out: Transcript[] = [];
  let slugs: string[];
  try {
    slugs = readdirSync(PROJECTS_DIR);
  } catch {
    return out;
  }
  for (const slug of slugs) {
    const dir = join(PROJECTS_DIR, slug);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const name of safeReaddir(dir)) {
      const p = join(dir, name);
      if (name.endsWith(".jsonl")) {
        out.push({ path: p, slug, sessionId: basename(name, ".jsonl"), usageOnly: false });
        continue;
      }
      const subDir = join(p, "subagents");
      try {
        if (!statSync(subDir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const agentFile of safeReaddir(subDir)) {
        if (!agentFile.endsWith(".jsonl")) continue;
        out.push({ path: join(subDir, agentFile), slug, sessionId: name, usageOnly: true });
      }
    }
  }
  return out;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Index every transcript whose size or mtime changed since last pass.
 * Growth is read from the stored byte offset; a file that shrank (rotated or
 * rewritten) is re-read from zero. Returns the number of files touched.
 */
export async function indexOnce(db: Database): Promise<number> {
  const getFile = db.query<{ offset: number; size: number; mtime_ms: number }, [string]>(
    "SELECT offset, size, mtime_ms FROM files WHERE path = ?",
  );
  const upsertFile = db.query(
    `INSERT INTO files (path, offset, size, mtime_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, size = excluded.size, mtime_ms = excluded.mtime_ms`,
  );

  let changed = 0;

  for (const { path, slug, sessionId, usageOnly } of listTranscripts()) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    const prev = getFile.get(path);
    const mtime = Math.floor(st.mtimeMs);
    if (prev && prev.size === st.size && prev.mtime_ms === mtime) continue;

    // A shrunken file means the transcript was replaced — start over so we
    // never splice the tail of an old file onto the head of a new one.
    const fullReread = !prev || st.size < prev.size;
    const start = fullReread ? 0 : prev.offset;

    const file = Bun.file(path);
    const text = await file.slice(start).text();

    // A partial trailing line means the session is mid-write; stop at the last
    // newline and leave the remainder for the next pass.
    const lastNl = text.lastIndexOf("\n");
    const consumable = lastNl === -1 ? "" : text.slice(0, lastNl + 1);
    const consumedBytes = start + Buffer.byteLength(consumable, "utf8");

    if (consumable.length > 0) {
      applyLines(db, consumable, sessionId, slug, path, fullReread, usageOnly);
      changed++;
    }
    upsertFile.run(path, consumedBytes, st.size, mtime);
  }
  return changed;
}

function applyLines(
  db: Database,
  chunk: string,
  sessionId: string,
  slug: string,
  path: string,
  fullReread: boolean,
  usageOnly: boolean,
) {
  const existing = fullReread
    ? null
    : db
        .query<Agg, [string]>("SELECT * FROM sessions WHERE id = ?")
        .get(sessionId);

  const agg: Agg = existing
    ? { ...existing, project_slug: slug, file_path: path }
    : emptyAgg(sessionId, slug, path);

  if (fullReread) {
    // Usage events are cleared per FILE, not per session: a session's spend is
    // spread over its own transcript and one file per subagent, so keying the
    // delete on session_id would wipe siblings this pass is not re-reading.
    db.query("DELETE FROM usage_events WHERE src_path = ?").run(path);
    if (!usageOnly) {
      for (const t of ["prompts", "replies", "tools", "pr_links"]) {
        db.query(`DELETE FROM ${t} WHERE session_id = ?`).run(sessionId);
      }
      db.query("DELETE FROM prompts_fts WHERE session_id = ?").run(sessionId);
    }
  }

  const toolCounts = new Map<string, number>();
  // Only used to synthesise a key for the rare record with no uuid.
  let replySeq = 0;
  const insertPrompt = db.query(
    "INSERT OR REPLACE INTO prompts (uuid, session_id, ts, text) VALUES (?, ?, ?, ?)",
  );
  const insertFts = db.query(
    "INSERT INTO prompts_fts (text, uuid, session_id, ts) VALUES (?, ?, ?, ?)",
  );
  // One API request can appear as several records — streaming continuations share
  // a requestId while each carries its own uuid. Keying on requestId collapses
  // them, and MAX keeps the most complete copy rather than whichever landed last,
  // since a later partial can report fewer output tokens than an earlier one.
  // Records with no requestId fall through to per-uuid keying.
  const insertUsage = db.query(
    `INSERT INTO usage_events
       (uuid, session_id, ts, request_id, model, input_tokens, output_tokens,
        cache_read, cache_write, cache_write_5m, cache_write_1h, src_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(request_id) DO UPDATE SET
       input_tokens   = MAX(usage_events.input_tokens,   excluded.input_tokens),
       output_tokens  = MAX(usage_events.output_tokens,  excluded.output_tokens),
       cache_read     = MAX(usage_events.cache_read,     excluded.cache_read),
       cache_write    = MAX(usage_events.cache_write,    excluded.cache_write),
       cache_write_5m = MAX(usage_events.cache_write_5m, excluded.cache_write_5m),
       cache_write_1h = MAX(usage_events.cache_write_1h, excluded.cache_write_1h)
     ON CONFLICT(uuid) DO NOTHING`,
  );
  const insertReply = db.query(
    `INSERT OR REPLACE INTO replies (uuid, session_id, ts, text, model, is_sidechain)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertPr = db.query(
    `INSERT OR REPLACE INTO pr_links (session_id, pr_url, pr_number, repo, ts) VALUES (?, ?, ?, ?, ?)`,
  );

  const run = db.transaction(() => {
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }

      if (usageOnly && rec.type !== "assistant") continue;

      const t = ts(rec.timestamp);
      if (t !== null) {
        if (agg.first_ts === null || t < agg.first_ts) agg.first_ts = t;
        if (agg.last_ts === null || t > agg.last_ts) agg.last_ts = t;
      }
      if (rec.cwd) agg.cwd = rec.cwd;
      if (rec.gitBranch) agg.git_branch = rec.gitBranch;
      if (rec.version) agg.version = rec.version;

      switch (rec.type) {
        // A title the user typed when starting the session. It outranks the
        // generated one, which arrives later in the same file.
        case "custom-title":
          if (rec.customTitle) {
            agg.title = rec.customTitle;
            agg.title_custom = 1;
          }
          break;

        case "ai-title":
          if (rec.aiTitle && !agg.title_custom) agg.title = rec.aiTitle;
          break;

        case "pr-link":
          insertPr.run(
            sessionId,
            rec.prUrl ?? "",
            rec.prNumber ?? null,
            rec.prRepository ?? null,
            ts(rec.timestamp),
          );
          break;

        case "user": {
          agg.msg_count++;
          const text = promptText(rec);
          if (text) {
            agg.prompt_count++;
            insertPrompt.run(rec.uuid ?? `${sessionId}:${agg.prompt_count}`, sessionId, t, text);
            insertFts.run(text, rec.uuid ?? "", sessionId, t ?? 0);
          }
          break;
        }

        case "assistant": {
          if (!usageOnly) agg.msg_count++;
          const msg = rec.message ?? {};
          if (msg.model && !usageOnly) agg.model = msg.model;
          const u = msg.usage ?? {};
          const inTok = u.input_tokens ?? 0;
          const outTok = u.output_tokens ?? 0;
          const cRead = u.cache_read_input_tokens ?? 0;
          const cWrite = u.cache_creation_input_tokens ?? 0;
          const cc = u.cache_creation ?? {};
          const cw5m = cc.ephemeral_5m_input_tokens ?? 0;
          const cw1h = cc.ephemeral_1h_input_tokens ?? 0;

          if (t !== null && (inTok || outTok || cRead || cWrite)) {
            insertUsage.run(
              rec.uuid ?? `${sessionId}:${t}`,
              sessionId,
              t,
              rec.requestId ?? msg.id ?? null,
              msg.model ?? null,
              inTok,
              outTok,
              cRead,
              cWrite,
              cw5m,
              cw1h,
              path,
            );
          }
          const reply = usageOnly ? null : replyText(rec);
          if (reply) {
            replySeq++;
            insertReply.run(
              rec.uuid ?? `${sessionId}:reply:${replySeq}`,
              sessionId,
              t,
              reply,
              msg.model ?? null,
              rec.isSidechain ? 1 : 0,
            );
          }
          for (const b of usageOnly || !Array.isArray(msg.content) ? [] : msg.content) {
            if (b?.type === "tool_use" && b.name) {
              agg.tool_count++;
              toolCounts.set(b.name, (toolCounts.get(b.name) ?? 0) + 1);
            }
          }
          break;
        }
      }
    }

    // Read the session's token totals back out of usage_events rather than
    // accumulating them while parsing: the table is de-duplicated per API request
    // and survives incremental reads, so a request split across two parsed chunks
    // still counts once.
    const totals = db
      .query<
        { input: number; output: number; read: number; write: number },
        [string]
      >(
        `SELECT COALESCE(SUM(input_tokens), 0)  AS input,
                COALESCE(SUM(output_tokens), 0) AS output,
                COALESCE(SUM(cache_read), 0)    AS read,
                COALESCE(SUM(cache_write), 0)   AS write
           FROM usage_events WHERE session_id = ?`,
      )
      .get(sessionId);
    agg.input_tokens = totals?.input ?? 0;
    agg.output_tokens = totals?.output ?? 0;
    agg.cache_read = totals?.read ?? 0;
    agg.cache_write = totals?.write ?? 0;

    // A subagent transcript has no session row of its own — it only moves the
    // parent's token totals. Everything else on that row belongs to the parent's
    // own transcript and must survive untouched.
    if (usageOnly) {
      db.query(
        `UPDATE sessions SET input_tokens = ?, output_tokens = ?, cache_read = ?, cache_write = ?
           WHERE id = ?`,
      ).run(agg.input_tokens, agg.output_tokens, agg.cache_read, agg.cache_write, sessionId);
      return;
    }

    db.query(
      `INSERT INTO sessions (id, project_slug, cwd, git_branch, title, title_custom, first_ts, last_ts,
         msg_count, prompt_count, tool_count, input_tokens, output_tokens, cache_read,
         cache_write, model, version, file_path)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         project_slug=excluded.project_slug, cwd=excluded.cwd, git_branch=excluded.git_branch,
         title=COALESCE(excluded.title, sessions.title),
         title_custom=MAX(sessions.title_custom, excluded.title_custom),
         first_ts=excluded.first_ts, last_ts=excluded.last_ts, msg_count=excluded.msg_count,
         prompt_count=excluded.prompt_count, tool_count=excluded.tool_count,
         input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
         cache_read=excluded.cache_read, cache_write=excluded.cache_write,
         model=COALESCE(excluded.model, sessions.model), version=excluded.version,
         file_path=excluded.file_path`,
    ).run(
      agg.id, agg.project_slug, agg.cwd, agg.git_branch, agg.title, agg.title_custom,
      agg.first_ts, agg.last_ts,
      agg.msg_count, agg.prompt_count, agg.tool_count, agg.input_tokens, agg.output_tokens,
      agg.cache_read, agg.cache_write, agg.model, agg.version, agg.file_path,
    );

    const upTool = db.query(
      `INSERT INTO tools (session_id, name, count) VALUES (?, ?, ?)
       ON CONFLICT(session_id, name) DO UPDATE SET count = tools.count + excluded.count`,
    );
    for (const [name, count] of toolCounts) upTool.run(sessionId, name, count);
  });

  run();
}
