import { openDb } from "./db.ts";
import { indexOnce } from "./indexer.ts";

/**
 * Force a full re-read of every transcript.
 *
 * The indexer is incremental: it records how far into each JSONL it has parsed and
 * only reads the growth. Clearing that bookkeeping makes the next pass start from
 * zero, which is what you want after changing what the indexer extracts — a new
 * record type is invisible to already-consumed lines otherwise.
 *
 * Per-session rows are rebuilt, not duplicated: a full re-read deletes a session's
 * prompts, replies, tools and usage before re-inserting them.
 */
const db = openDb();
const { n } = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM files").get() ?? { n: 0 };
db.exec("DELETE FROM files");
console.log(`[reindex] cleared offsets for ${n} transcript(s); re-reading…`);

const t0 = Date.now();
const touched = await indexOnce(db);
const totals = db
  .query<{ sessions: number; prompts: number; replies: number }, []>(
    `SELECT (SELECT COUNT(*) FROM sessions) AS sessions,
            (SELECT COUNT(*) FROM prompts) AS prompts,
            (SELECT COUNT(*) FROM replies) AS replies`,
  )
  .get();
console.log(
  `[reindex] ${touched} transcript(s) in ${Date.now() - t0}ms — ` +
    `${totals?.sessions} sessions, ${totals?.prompts} prompts, ${totals?.replies} replies`,
);
