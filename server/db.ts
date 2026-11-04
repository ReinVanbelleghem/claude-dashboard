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

  /**
   * The reply index was added after replies themselves, so an existing database
   * already holds every row it needs — the text is in `replies`. That makes this a
   * copy rather than a re-index: no transcript is re-read, and the offsets stay put.
   */
  const hadRepliesFts = db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'replies_fts'",
    )
    .get();
  const needsRepliesFts = (hadRepliesFts?.n ?? 0) === 0;

  // Usage events used to be keyed on `uuid` alone. A single API request can emit
  // several transcript records (streaming continuations), all with distinct uuids
  // but one shared requestId, so every such call was counted once per record —
  // roughly doubling every token and cost figure. Keying on requestId fixes it,
  // but only for rows written after the column exists, so an existing database
  // has to be re-read from scratch.
  const usageCols = db
    .query<{ name: string }, []>("PRAGMA table_info(usage_events)")
    .all();
  const needsUsageBackfill = usageCols.length > 0 && !usageCols.some((c) => c.name === "request_id");

  /**
   * Artifacts were added after the fact, and the indexer is incremental: an
   * existing database has a byte offset recorded for every transcript, so without
   * clearing them the writes that produced every artifact you already have sit
   * behind the read head and stay unattributed forever. Same shape of problem as
   * replies above, same one-time answer — clear the offsets and read once more.
   */
  const hadArtifacts = db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'",
    )
    .get();
  const hadFiles = db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'files'",
    )
    .get();
  const needsArtifactBackfill = (hadArtifacts?.n ?? 0) === 0 && (hadFiles?.n ?? 0) > 0;

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

    -- Assistant prose, searchable. Standalone rather than external-content for the
    -- same reason prompts_fts is: we own every write, so no triggers are needed to
    -- keep it in step with the table it mirrors.
    CREATE VIRTUAL TABLE IF NOT EXISTS replies_fts USING fts5(
      text, uuid UNINDEXED, session_id UNINDEXED, ts UNINDEXED
    );

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
      cache_write   INTEGER NOT NULL DEFAULT 0,
      -- The API request this record belongs to. Several records can share one,
      -- so it — not uuid — is the unit we bill. Null on records that predate the
      -- field, which then fall back to per-uuid keying.
      request_id    TEXT,
      -- Cache writes split by TTL, since the two bill at different multiples of
      -- the input rate. Both zero when the transcript only gave us a lump sum.
      cache_write_5m INTEGER NOT NULL DEFAULT 0,
      cache_write_1h INTEGER NOT NULL DEFAULT 0,
      -- Which transcript the row came from. A session's events can span its own
      -- transcript plus one file per subagent it spawned, so re-reading any single
      -- file must only clear that file's rows.
      src_path      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts DESC);

    -- Generated HTML artifacts, split by who owns the truth.
    --
    -- The artifacts table is what is on disk and is written only by the reconciler;
    -- the filesystem decides what exists. artifact_writes is who made it and is
    -- written only by the indexer; the transcript decides provenance. Keeping them
    -- apart means re-reading one transcript can never delete a folder's row, and
    -- deleting a folder can never lose the record of which session produced it.
    CREATE TABLE IF NOT EXISTS artifacts (
      slug        TEXT PRIMARY KEY,
      title       TEXT,
      -- Entry page, relative to the artifact root: <slug>/index.html, or <slug>.html
      -- for a loose page that never got a folder.
      entry       TEXT NOT NULL,
      created_ts  INTEGER,
      modified_ts INTEGER,
      size        INTEGER NOT NULL DEFAULT 0,
      file_count  INTEGER NOT NULL DEFAULT 1,
      -- Kept, not deleted, when the folder goes away: a session's history should
      -- still say it made something, even once the something is gone.
      missing     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_modified ON artifacts(modified_ts DESC);

    CREATE TABLE IF NOT EXISTS artifact_writes (
      slug       TEXT NOT NULL,
      session_id TEXT NOT NULL,
      ts         INTEGER,
      PRIMARY KEY (slug, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_writes_session ON artifact_writes(session_id);
  `);

  /**
   * The GitHub review pages. These rows are authored by the user or by a review
   * session, not derived from transcripts, so no re-index ever touches them.
   */
  db.exec(`
    -- Review comments collected locally and submitted to GitHub together, as one review.
    CREATE TABLE IF NOT EXISTS pr_drafts (
      id         TEXT PRIMARY KEY,
      owner      TEXT NOT NULL,
      repo       TEXT NOT NULL,
      number     INTEGER NOT NULL,
      path       TEXT NOT NULL,
      side       TEXT NOT NULL,
      line       INTEGER NOT NULL,
      start_line INTEGER,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pr_drafts_pr ON pr_drafts(owner, repo, number);

    -- One Claude session started against a PR from an action button.
    CREATE TABLE IF NOT EXISTS pr_runs (
      id               TEXT PRIMARY KEY,
      action_id        TEXT,
      action_name      TEXT NOT NULL,
      owner            TEXT NOT NULL,
      repo             TEXT NOT NULL,
      number           INTEGER NOT NULL,
      title            TEXT NOT NULL,
      status           TEXT NOT NULL,
      agent_key        TEXT,
      session_id       TEXT,
      cwd              TEXT,
      prompt           TEXT NOT NULL,
      replies          TEXT NOT NULL DEFAULT '[]',
      cost_usd         REAL,
      findings         TEXT,
      checked_findings TEXT NOT NULL DEFAULT '[]',
      posted_findings  TEXT NOT NULL DEFAULT '{}',
      created_at       TEXT NOT NULL,
      finished_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pr_runs_pr ON pr_runs(owner, repo, number);

    -- A selection of code explained by a session; drill-downs are children.
    CREATE TABLE IF NOT EXISTS pr_explanations (
      id               TEXT PRIMARY KEY,
      root_id          TEXT NOT NULL,
      parent_id        TEXT,
      drill_part_index INTEGER,
      drill_text       TEXT,
      owner            TEXT NOT NULL,
      repo             TEXT NOT NULL,
      number           INTEGER NOT NULL,
      side             TEXT NOT NULL,
      sha              TEXT NOT NULL,
      path             TEXT NOT NULL,
      start_line       INTEGER NOT NULL,
      end_line         INTEGER NOT NULL,
      code             TEXT NOT NULL,
      question         TEXT,
      status           TEXT NOT NULL,
      result           TEXT,
      error            TEXT,
      agent_key        TEXT,
      session_id       TEXT,
      created_at       TEXT NOT NULL,
      finished_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pr_explanations_pr ON pr_explanations(owner, repo, number);

    -- The last snapshot of a watched PR, so the next poll can say what changed.
    CREATE TABLE IF NOT EXISTS pr_watch_state (
      owner           TEXT NOT NULL,
      repo            TEXT NOT NULL,
      number          INTEGER NOT NULL,
      head_sha        TEXT,
      review_decision TEXT,
      ci_state        TEXT,
      mergeable       TEXT,
      state           TEXT,
      last_comment_id TEXT,
      last_review_id  TEXT,
      last_polled_at  TEXT,
      last_seen_at    TEXT,
      closed_at       TEXT,
      snapshot        TEXT NOT NULL,
      PRIMARY KEY (owner, repo, number)
    );
  `);

  if (needsArtifactBackfill) {
    const n = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM files").get()?.n ?? 0;
    if (n > 0) {
      db.exec("DELETE FROM files");
      console.log(
        `[claude-dashboard] re-reading ${n} transcript(s) once to link artifacts to their sessions`,
      );
    }
  }

  if (needsRepliesFts) {
    const n = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM replies").get()?.n ?? 0;
    if (n > 0) {
      db.exec(
        `INSERT INTO replies_fts (text, uuid, session_id, ts)
         SELECT text, uuid, session_id, COALESCE(ts, 0) FROM replies WHERE text IS NOT NULL`,
      );
      console.log(`[claude-dashboard] indexed ${n} assistant replies for search`);
    }
  }

  /**
   * A link the user made by hand, rather than one read out of a transcript.
   *
   * Needed because attribution cannot always be inferred: an artifact written
   * somewhere else and moved in by a shell script leaves no trace a path scan can
   * follow. A manual link is also the only kind a re-read must not delete — the
   * transcript it would be rebuilt from never contained it.
   */
  ensureColumn(db, "artifact_writes", "manual", "INTEGER NOT NULL DEFAULT 0");

  /**
   * Tags on artifacts. `source` says who put it there: 'meta' rows are re-read
   * from the page's <meta name="tags"> on every reconcile and replaced wholesale;
   * 'user' rows were added in the dashboard and survive a re-read.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_tags (
      slug   TEXT NOT NULL,
      tag    TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'user',
      PRIMARY KEY (slug, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_tags_tag ON artifact_tags(tag);
  `);
  ensureColumn(db, "artifacts", "pinned", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "artifacts", "hidden", "INTEGER NOT NULL DEFAULT 0");

  /** One row per session a template started, by hand or on its schedule. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS template_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id TEXT NOT NULL,
      agent_key   TEXT NOT NULL,
      session_id  TEXT,
      started_at  INTEGER NOT NULL,
      trigger     TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE INDEX IF NOT EXISTS idx_template_runs_template ON template_runs(template_id, started_at DESC);
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

  // These three must be added before the unique index below, which references
  // request_id and would fail on a database created before the column existed.
  ensureColumn(db, "usage_events", "request_id", "TEXT");
  ensureColumn(db, "usage_events", "cache_write_5m", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "usage_events", "cache_write_1h", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "usage_events", "src_path", "TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_request ON usage_events(request_id)");

  if (needsBackfill || needsUsageBackfill) {
    // A missing offset makes the next pass a full re-read, which clears and
    // rebuilds each session's rows — so this is a re-index, not a duplication.
    const files = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM files").get();
    if ((files?.n ?? 0) > 0) {
      const why = needsBackfill ? "assistant replies" : "de-duplicated usage";
      console.log(`[claude-dashboard] re-indexing ${files?.n} transcript(s) for ${why}…`);
      db.exec("DELETE FROM files");
    }
    if (needsUsageBackfill) {
      // Pre-migration rows carry no request_id and no src_path, so neither the
      // de-duplicating upsert nor the per-file delete can see them: left in place
      // they would survive the re-read and be counted a second time. The re-read
      // rebuilds every one of them.
      db.exec("DELETE FROM usage_events");
    }
  }
}
