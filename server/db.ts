import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { DATA_DIR, DB_PATH } from "./paths.ts";

export function openDb(): Database {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  migrate(db);
  return db;
}

/** Add a column to an existing table, since CREATE TABLE IF NOT EXISTS won't. */
function ensureColumn(db: Database, table: string, column: string, decl: string) {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

function migrate(db: Database) {
  // Replies were added after the first release. An existing database has byte
  // offsets recorded for every transcript, so without clearing them the indexer
  // would only ever see new lines and old sessions would stay reply-less.
  const hadReplies = db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'replies'",
    )
    .get();
  const needsBackfill = (hadReplies?.n ?? 0) === 0;

  db.exec(`
    -- Incremental-read bookkeeping: how far into each JSONL we've already parsed.
    CREATE TABLE IF NOT EXISTS files (
      path      TEXT PRIMARY KEY,
      offset    INTEGER NOT NULL DEFAULT 0,
      size      INTEGER NOT NULL DEFAULT 0,
      mtime_ms  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id             TEXT PRIMARY KEY,
      project_slug   TEXT,
      cwd            TEXT,
      git_branch     TEXT,
      title          TEXT,
      first_ts       INTEGER,
      last_ts        INTEGER,
      msg_count      INTEGER NOT NULL DEFAULT 0,
      prompt_count   INTEGER NOT NULL DEFAULT 0,
      tool_count     INTEGER NOT NULL DEFAULT 0,
      input_tokens   INTEGER NOT NULL DEFAULT 0,
      output_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_read     INTEGER NOT NULL DEFAULT 0,
      cache_write    INTEGER NOT NULL DEFAULT 0,
      model          TEXT,
      version        TEXT,
      file_path      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_last ON sessions(last_ts DESC);

    CREATE TABLE IF NOT EXISTS prompts (
      uuid       TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      ts         INTEGER,
      text       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts(session_id, ts);

    -- Standalone (not external-content) FTS so we own all writes and never
    -- need triggers to keep it in sync.
    CREATE VIRTUAL TABLE IF NOT EXISTS prompts_fts USING fts5(
      text, uuid UNINDEXED, session_id UNINDEXED, ts UNINDEXED
    );

    -- Assistant prose, one row per text block group in an assistant turn.
    -- Thinking blocks and tool_use blocks are not stored; sidechain (subagent)
    -- turns are, flagged, so the transcript view can hide or show them.
    CREATE TABLE IF NOT EXISTS replies (
      uuid         TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      ts           INTEGER,
      text         TEXT,
      model        TEXT,
      is_sidechain INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_replies_session ON replies(session_id, ts);

    CREATE TABLE IF NOT EXISTS tools (
      session_id TEXT NOT NULL,
      name       TEXT NOT NULL,
      count      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, name)
    );

    CREATE TABLE IF NOT EXISTS pr_links (
      session_id TEXT NOT NULL,
      pr_url     TEXT NOT NULL,
      pr_number  INTEGER,
      repo       TEXT,
      ts         INTEGER,
      PRIMARY KEY (session_id, pr_url)
    );

    -- One row per assistant turn, for time-bucketed usage rollups.
    CREATE TABLE IF NOT EXISTS usage_events (
      uuid          TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      ts            INTEGER NOT NULL,
      model         TEXT,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read    INTEGER NOT NULL DEFAULT 0,
      cache_write   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts DESC);
  `);

  // Added with dashboard-set titles: marks a title the user chose, so a later
  // auto-generated one cannot quietly replace it.
  ensureColumn(db, "sessions", "title_custom", "INTEGER NOT NULL DEFAULT 0");

  /**
   * Which repository a session's cwd belongs to, and which checkout of it.
   *
   * Transcripts are keyed by cwd, so every worktree of one repo files as a separate
   * project — the thing that made five checkouts of one codebase look like five
   * unrelated projects in History. `repo_key` is the shared `.git`, so all of them
   * group under one repository again.
   *
   * Both are derived from `cwd` alone, never from the transcript, which is why filling
   * them in needs no re-index: see repoKeys.ts. NULL means "not resolved yet", and a
   * cwd that is not in a repository stays NULL for good.
   */
  ensureColumn(db, "sessions", "repo_key", "TEXT");
  ensureColumn(db, "sessions", "worktree_root", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(repo_key)");

  if (needsBackfill) {
    // A missing offset makes the next pass a full re-read, which clears and
    // rebuilds each session's rows — so this is a re-index, not a duplication.
    const files = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM files").get();
    if ((files?.n ?? 0) > 0) {
      console.log(`[claude-dashboard] re-indexing ${files?.n} transcript(s) for assistant replies…`);
      db.exec("DELETE FROM files");
    }
  }
}
