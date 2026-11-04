import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Explanation, ExplainResult, ExplainStatus, ExplainTarget, PrRef } from "../shared/pr.ts";
import { getAgent, sendMessage, startAgent, type AgentStatus, type TimelineItem } from "./agents.ts";
import { ensureWorktree } from "./prRepos.ts";
import { getPr } from "./prs.ts";
import { getSettings } from "./settings.ts";

/**
 * Explain: select some code in the diff and get an explanation you can drill into.
 *
 * Each root explanation is one dashboard session in a checkout of the relevant
 * commit, started with the selected code and a schema that shapes every answer as a
 * summary plus a few parts. Drilling into a part, or asking a question, is another
 * turn in the same session — the model already has the context — and lands as a
 * child node under the one it came from. Turns are answered in order, so a result
 * is matched to the oldest node of that session still waiting.
 */
let db: Database;
let emit: (event: string, data: unknown) => void = () => {};

export function initExplain(database: Database, emitter: (event: string, data: unknown) => void) {
  db = database;
  emit = emitter;
  db.query("UPDATE pr_explanations SET status = 'failed', error = 'The daemon restarted' WHERE status IN ('queued', 'running')").run();
  db.query("UPDATE pr_explanations SET agent_key = NULL").run();
}

export const EXPLAIN_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "One or two sentences: what this code does and why, or the direct answer to the question asked. Not repeated in the parts. No bold, no headings.",
    },
    parts: {
      type: "array",
      description: "3-5 separable pieces of the logic, in execution order, each worth drilling into. Empty when answering a plain question.",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Plain-language name of this piece, at most 6 words." },
          explanation: {
            type: "string",
            description:
              "2-4 short sentences. Starts with any building block the reader needs, then what this piece does. Name concrete functions, fields and values in backticks. No overlap with other parts. No bold, no headings.",
          },
          path: { type: "string", description: "Repo-relative path of the code this part is about, when it is a specific location." },
          startLine: { type: "integer", description: "First line of that code in this revision." },
          endLine: { type: "integer", description: "Last line of that code in this revision." },
        },
        required: ["title", "explanation"],
      },
    },
  },
  required: ["summary", "parts"],
};

const STYLE = [
  "The reader is an engineer on this codebase who is tired of long AI text. Write so it reads fast:",
  "- Say each fact once. The summary must not be repeated in the parts, and parts must not overlap. No closing recap.",
  "- Everyday English for everything that is not technical. Technical terms, function names and code concepts are fine.",
  "- When the code relies on a concept the reader may not know, explain it bottom-up in one or two sentences, then stop; deeper detail belongs in a drill-down.",
  "- Short sentences. Explain what happens and why, not each line in turn.",
  "- No filler, no hedging, no bold, no headings. Ignore any house style that asks for bold headlines.",
  "Your answer must be JSON matching the schema.",
].join("\n");

type Row = {
  id: string;
  root_id: string;
  parent_id: string | null;
  drill_part_index: number | null;
  drill_text: string | null;
  owner: string;
  repo: string;
  number: number;
  side: "base" | "head";
  sha: string;
  path: string;
  start_line: number;
  end_line: number;
  code: string;
  question: string | null;
  status: ExplainStatus;
  result: string | null;
  error: string | null;
  agent_key: string | null;
  session_id: string | null;
  created_at: string;
  finished_at: string | null;
};

const toExplanation = (r: Row): Explanation => ({
  id: r.id,
  rootId: r.root_id,
  parentId: r.parent_id,
  drillPartIndex: r.drill_part_index,
  drillText: r.drill_text,
  owner: r.owner,
  repo: r.repo,
  number: r.number,
  side: r.side,
  sha: r.sha,
  path: r.path,
  startLine: r.start_line,
  endLine: r.end_line,
  code: r.code,
  question: r.question,
  status: r.status,
  result: r.result ? (JSON.parse(r.result) as ExplainResult) : null,
  error: r.error,
  agentKey: r.agent_key,
  sessionId: r.session_id,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});

const rowById = (id: string) => db.query<Row, [string]>("SELECT * FROM pr_explanations WHERE id = ?").get(id);

export function listExplanations(pr: PrRef): Explanation[] {
  return db
    .query<Row, [string, string, number]>(
      "SELECT * FROM pr_explanations WHERE owner = ? AND repo = ? AND number = ? ORDER BY created_at, rowid",
    )
    .all(pr.owner, pr.repo, pr.number)
    .map(toExplanation);
}

function update(id: string, fields: Record<string, string | number | null>): Explanation {
  const keys = Object.keys(fields);
  db.query(`UPDATE pr_explanations SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(fields), id);
  const e = toExplanation(rowById(id)!);
  emit("pr-explain", e);
  return e;
}

function insert(input: Omit<Row, "status" | "result" | "error" | "created_at" | "finished_at">): Explanation {
  db.query(
    `INSERT INTO pr_explanations (id, root_id, parent_id, drill_part_index, drill_text, owner, repo, number, side, sha, path, start_line, end_line, code, question, status, agent_key, session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
  ).run(
    input.id,
    input.root_id,
    input.parent_id,
    input.drill_part_index,
    input.drill_text,
    input.owner,
    input.repo,
    input.number,
    input.side,
    input.sha,
    input.path,
    input.start_line,
    input.end_line,
    input.code,
    input.question,
    input.agent_key,
    input.session_id,
    new Date().toISOString(),
  );
  const e = toExplanation(rowById(input.id)!);
  emit("pr-explain", e);
  return e;
}

function rootPrompt(row: Row, baseSha: string): string {
  const lines = row.start_line === row.end_line ? `line ${row.start_line}` : `lines ${row.start_line}-${row.end_line}`;
  return [
    "Explain exactly how this code works in the context of this repository.",
    `File: ${row.path}`,
    `Revision: ${row.side === "base" ? "base (before the pull request)" : "head (the pull request branch)"}, ${lines}`,
    "",
    "Selected code:",
    "```",
    row.code,
    "```",
    "",
    `You may read surrounding code, follow definitions with Read, Grep and Glob, and see what the pull request changed with \`git diff ${baseSha} -- <path>\` (${baseSha} is the pull request base). Only report what the reader needs to understand this code.`,
    row.side === "head" ? "If this file is changed by the pull request, also explain what the pull request changed about this code." : "",
    row.question ? `\nThe reader specifically asks: ${row.question}` : "",
    "",
    STYLE,
  ].join("\n");
}

const EXPLAIN_TOOLS = ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)"];

export async function startExplanation(pr: PrRef, target: ExplainTarget, question: string | null): Promise<Explanation> {
  const detail = await getPr(pr.owner, pr.repo, pr.number);
  const sha = target.side === "head" ? detail.headSha : detail.baseSha;
  const id = randomUUID();
  const e = insert({
    id,
    root_id: id,
    parent_id: null,
    drill_part_index: null,
    drill_text: null,
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    side: target.side,
    sha,
    path: target.path,
    start_line: target.startLine,
    end_line: target.endLine,
    code: target.code,
    question,
    agent_key: null,
    session_id: null,
  });
  void (async () => {
    try {
      const cwd = await ensureWorktree(pr.owner, pr.repo, sha);
      const row = rowById(id);
      if (!row) return;
      const model = getSettings().reviews.explainModel || getSettings().ui.defaultModel || undefined;
      const key = startAgent({
        cwd,
        model,
        permissionMode: getSettings().reviews.explainPermissionMode ?? "default",
        prompt: rootPrompt(row, detail.baseSha),
        title: `Explain · ${pr.repo}#${pr.number} ${target.path.split("/").pop()}:${target.startLine}`,
        allowedTools: EXPLAIN_TOOLS,
        outputSchema: EXPLAIN_SCHEMA,
      });
      update(id, { agent_key: key, status: "running" });
    } catch (err) {
      update(id, { status: "failed", error: err instanceof Error ? err.message : String(err), finished_at: new Date().toISOString() });
    }
  })();
  return e;
}

/**
 * Go deeper on a part, or ask about the explanation. Both are a new turn in the root's
 * session, recorded as a child of the node they came from.
 */
export function drill(parentId: string, input: { partIndex?: number; text?: string; question?: string }): Explanation | { error: string; httpStatus: number } {
  const parent = rowById(parentId);
  if (!parent) return { error: "not found", httpStatus: 404 };
  if (parent.status !== "done" || !parent.result) return { error: "explanation is not finished", httpStatus: 409 };
  const root = rowById(parent.root_id);
  const agentKey = root?.agent_key;
  if (!agentKey || !getAgent(agentKey)) return { error: "the explain session has ended; start a new explanation", httpStatus: 409 };
  const parts = (JSON.parse(parent.result) as ExplainResult).parts;
  const part = input.partIndex != null ? parts[input.partIndex] : undefined;
  if (input.partIndex != null && !part) return { error: "no such part", httpStatus: 400 };
  const text = input.text?.trim() || null;
  const question = input.question?.trim() || null;
  if (!part && !text && !question) return { error: "partIndex, text or question is required", httpStatus: 400 };
  const focus = part ? `${part.title}\n\n${part.explanation}` : text;
  const prompt = [
    focus ? `Go one level deeper on this, and only this:\n\n${focus}\n\nAdd what is new at this level. Do not repeat what you already explained.` : "",
    question ? (focus ? `\nThe reader specifically asks: ${question}` : `Answer this about the explanation so far: ${question}`) : "",
    "",
    STYLE,
  ]
    .filter((l) => l !== "")
    .join("\n");
  const e = insert({
    id: randomUUID(),
    root_id: parent.root_id,
    parent_id: parent.id,
    drill_part_index: part ? (input.partIndex ?? null) : null,
    drill_text: part ? null : text,
    owner: parent.owner,
    repo: parent.repo,
    number: parent.number,
    side: parent.side,
    sha: parent.sha,
    path: part?.path ?? parent.path,
    start_line: part?.startLine ?? parent.start_line,
    end_line: part?.endLine ?? part?.startLine ?? parent.end_line,
    code: "",
    question,
    agent_key: agentKey,
    session_id: parent.session_id,
  });
  sendMessage(agentKey, prompt);
  return update(e.id, { status: "running" });
}

export function deleteExplanation(id: string): string[] {
  const ids = db
    .query<{ id: string }, [string]>(
      `WITH RECURSIVE tree(id) AS (SELECT id FROM pr_explanations WHERE id = ?
         UNION ALL SELECT e.id FROM pr_explanations e JOIN tree t ON e.parent_id = t.id)
       SELECT id FROM tree`,
    )
    .all(id)
    .map((r) => r.id);
  for (const target of ids) db.query("DELETE FROM pr_explanations WHERE id = ?").run(target);
  emit("pr-explain", { ids, deleted: true });
  return ids;
}

const isResult = (v: unknown): v is ExplainResult =>
  typeof v === "object" && v !== null && typeof (v as ExplainResult).summary === "string" && Array.isArray((v as ExplainResult).parts);

/** A turn ended in an explain session: hand its result to the oldest node still waiting. */
export function onAgentItem(key: string, item: TimelineItem) {
  if (item.kind !== "result") return;
  const waiting = db
    .query<Row, [string]>("SELECT * FROM pr_explanations WHERE agent_key = ? AND status = 'running' ORDER BY created_at, rowid LIMIT 1")
    .get(key);
  if (!waiting) return;
  const sessionId = getAgent(key)?.sessionId ?? waiting.session_id;
  if (item.error) {
    update(waiting.id, { status: "failed", error: item.error, session_id: sessionId, finished_at: new Date().toISOString() });
  } else if (isResult(item.structured)) {
    update(waiting.id, {
      status: "done",
      result: JSON.stringify(item.structured),
      error: null,
      session_id: sessionId,
      finished_at: new Date().toISOString(),
    });
  } else {
    update(waiting.id, { status: "failed", error: "No structured explanation came back", session_id: sessionId, finished_at: new Date().toISOString() });
  }
}

/** The roster changed: a dead session fails whatever it still owed. */
export function onRoster(agents: { key: string; status: AgentStatus }[]) {
  for (const a of agents) {
    if (a.status !== "ended" && a.status !== "error") continue;
    const rows = db.query<Row, [string]>("SELECT * FROM pr_explanations WHERE agent_key = ? AND status IN ('queued', 'running')").all(a.key);
    for (const r of rows) update(r.id, { status: "failed", error: "The session ended before answering", finished_at: new Date().toISOString() });
  }
}
