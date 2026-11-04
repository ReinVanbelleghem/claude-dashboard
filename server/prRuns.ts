import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  linksBeyondTemplate,
  type Finding,
  type Findings,
  type FindingTarget,
  type PostedFinding,
  type PrDetail,
  type PrRef,
  type PrRun,
  type ReviewAction,
  type RunStatus,
} from "../shared/pr.ts";
import { getAgent, listAgents, startAgent, type AgentStatus, type TimelineItem } from "./agents.ts";
import { rest } from "./github.ts";
import { ensureWorktree, pruneWorktrees, removeScratch, scratchFor } from "./prRepos.ts";
import { addDraft, commentableLines, listThreads, postIssueComment } from "./prReview.ts";
import { getPr, prTemplate } from "./prs.ts";
import { getSettings } from "./settings.ts";

/**
 * Review runs: an action button on a PR starts an ordinary dashboard session in a
 * checkout of the PR, with the action's prompt as its first message.
 *
 * Being a session is the point. It shows up on Live, opens in a tile or drawer,
 * streams, asks for permissions in the browser and takes follow-up questions in the
 * normal composer. What this module adds on top is the record: which PR, which
 * action, and — for actions with structured findings — the findings the session
 * reported, kept up to date as the conversation changes them.
 */
let db: Database;
let emit: (event: string, data: unknown) => void = () => {};

export function initRuns(database: Database, emitter: (event: string, data: unknown) => void) {
  db = database;
  emit = emitter;
  // A daemon restart takes every session with it; the records say so rather than
  // pretending a run is still working.
  db.query("UPDATE pr_runs SET status = 'ended', finished_at = COALESCE(finished_at, ?) WHERE status IN ('starting', 'running')").run(
    new Date().toISOString(),
  );
  db.query("UPDATE pr_runs SET agent_key = NULL").run();
}

// ── findings schema ───────────────────────────────────────────────────────────
const findingProperties = {
  id: { type: "string", description: "The id of an existing finding you are repeating or changing. Leave out for a new finding." },
  severity: { type: "string", enum: ["high", "medium", "low"] },
  title: { type: "string", description: "The problem in plain words, one line, no jargon." },
  background: {
    type: "string",
    description: "1-3 plain sentences a reviewer who does not know this area needs first: what this code does and any concept the finding relies on. Markdown.",
  },
  file: { type: "string", description: "Repo-relative path." },
  line: { type: "integer", description: "Line number in the head revision of the file." },
  body: { type: "string", description: "What goes wrong and why, as a concrete scenario. Short sentences. Markdown." },
  suggestion: { type: "string", description: "The fix in one or two plain sentences, or a short code snippet. Markdown." },
  change: { type: "string", description: "One short sentence on what changed or why this is new. Only on changed or new findings." },
};

/**
 * One schema for every turn of a review session. The first turn's `reply` is the
 * summary; a follow-up's `reply` is the answer. `findings` is always the full,
 * current list, so the panel can be rebuilt from the latest turn alone.
 */
export const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    reply: {
      type: "string",
      description:
        "On the first turn: 2-4 plain sentences on what the PR does and your overall verdict. On a follow-up: your answer to the message. Markdown, no headings, no bold.",
    },
    findings: {
      type: "array",
      description: "The FULL current list of findings, most severe first. On a follow-up, repeat unchanged findings as they are, with their id.",
      items: { type: "object", properties: findingProperties, required: ["severity", "title", "body"] },
    },
    dropped: {
      type: "array",
      description: "Existing findings that turned out to be invalid or not worth reporting. Empty on the first turn.",
      items: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } }, required: ["id", "reason"] },
    },
  },
  required: ["reply", "findings", "dropped"],
};

const FINDINGS_INSTRUCTIONS = [
  "",
  "",
  "Write for a reviewer who may not know this part of the codebase:",
  "- Plain words and short sentences. Explain or avoid jargon and internal names; when you must use one, say what it is.",
  "- Give each finding background first, then a concrete scenario of what goes wrong, then the fix.",
  "- No bold, no headings inside fields, no hedging, no filler. Ignore any house style asking for bold headlines.",
  "",
  "Your answer must be JSON matching the schema: reply, the full list of findings, and dropped (empty on this first turn).",
  "In later turns, answer the message in reply and return the full updated list of findings: keep the id of findings that stay or change, leave the id out for new ones, add a short change note only on findings you changed or added, and list findings you withdraw under dropped with a reason.",
].join("\n");

type FindingsOutput = {
  reply: string;
  findings: (Omit<Finding, "id"> & { id?: string })[];
  dropped?: { id: string; reason: string }[];
};

const isFindingsOutput = (v: unknown): v is FindingsOutput =>
  typeof v === "object" && v !== null && typeof (v as FindingsOutput).reply === "string" && Array.isArray((v as FindingsOutput).findings);

const CONTENT_KEYS = ["title", "body", "background", "suggestion", "file", "line"] as const;

function firstFindings(out: FindingsOutput): Findings {
  return {
    summary: out.reply,
    findings: out.findings.map((f, i) => ({ ...f, id: `f${i + 1}` })),
    dropped: [],
  };
}

/** What a finding is about, for recognising one that came back without its id. */
const identity = (f: { file?: string; line?: number; title: string }) =>
  `${f.file ?? ""}:${f.line ?? ""}:${f.title.trim().toLowerCase()}`;

/** Merge a follow-up turn's findings over the current list, keeping track of what moved. */
export function mergeFindings(current: Findings, out: FindingsOutput): Findings {
  const existing = new Map(current.findings.map((f) => [f.id, f]));
  const byIdentity = new Map(current.findings.map((f) => [identity(f), f]));
  const returned = new Set<string>();
  let counter = Math.max(0, ...[...current.findings, ...(current.dropped ?? [])].map((f) => Number(f.id.slice(1)) || 0)) + 1;
  const merged: Finding[] = [];
  for (const incoming of out.findings) {
    // A turn that forgets the ids would otherwise append the whole list again, so
    // an id-less finding about the same line still matches the one already there.
    const matched = byIdentity.get(identity(incoming));
    const before = (incoming.id ? existing.get(incoming.id) : undefined) ?? (matched && !returned.has(matched.id) ? matched : undefined);
    if (before) {
      returned.add(before.id);
      const severityChanged = before.severity !== incoming.severity;
      const changed = severityChanged || CONTENT_KEYS.some((k) => (incoming[k] ?? undefined) !== before[k]);
      merged.push({
        ...incoming,
        id: before.id,
        previousSeverity: severityChanged ? before.severity : before.previousSeverity,
        change: changed ? incoming.change || before.change : before.change,
        isNew: before.isNew,
      });
    } else {
      merged.push({ ...incoming, id: `f${counter++}`, isNew: true });
    }
  }
  const reasons = new Map((out.dropped ?? []).map((d) => [d.id, d.reason]));
  const dropped = [...(current.dropped ?? [])];
  const kept = new Set(merged.map(identity));
  for (const before of current.findings) {
    if (returned.has(before.id)) continue;
    const reason = reasons.get(before.id);
    if (reason !== undefined) {
      dropped.push({ ...before, reason });
      continue;
    }
    // Copies a run collected before the ids were echoed back heal on the next turn.
    if (kept.has(identity(before))) continue;
    kept.add(identity(before));
    merged.push(before);
  }
  return { summary: current.summary, findings: merged, dropped };
}

// ── prompt ────────────────────────────────────────────────────────────────────
export function templateVars(pr: PrDetail): Record<string, string> {
  return {
    pr_url: pr.url,
    pr_number: String(pr.number),
    owner: pr.owner,
    repo: pr.repo,
    title: pr.title,
    head_ref: pr.headRefName,
    base_ref: pr.baseRefName,
    head_sha: pr.headSha,
    base_sha: pr.baseSha,
    author: pr.author,
    body: pr.body,
  };
}

export const TEMPLATE_VARS = ["pr_url", "pr_number", "owner", "repo", "title", "head_ref", "base_ref", "head_sha", "base_sha", "author", "body"];

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => vars[key] ?? match);
}

/** Notion and Slack links from the description, as references to read rather than text to inline. */
async function linkedSources(pr: PrDetail): Promise<string> {
  const links = linksBeyondTemplate(pr.body, await prTemplate(pr.owner, pr.repo));
  const notion = links.filter((l) => l.kind === "notion").map((l) => `- ${l.url}`);
  const slack = links.filter((l) => l.kind === "slack").map((l) => `- ${l.url}`);
  if (!notion.length && !slack.length) return "";
  return [
    "",
    "",
    "## Linked sources",
    "The pull request description links these. Read them before you review: they say what the change must do. Check the change against them and call out anything missing or different.",
    notion.length ? `\nNotion (read with notion-fetch, and notion-get-comments for the discussion):\n${notion.join("\n")}` : "",
    slack.length ? `\nSlack (read with slack_read_thread or slack_read_channel):\n${slack.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const DISCUSSION_MAX_CHARS = 12_000;
const quote = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

/** What reviewers and the author already said, so the session does not raise it again as news. */
async function existingDiscussion(pr: PrRef): Promise<string> {
  const base = `/repos/${pr.owner}/${pr.repo}`;
  const [threads, comments, reviews] = await Promise.all([
    listThreads(pr),
    rest.paginate<{ body: string | null; user: { login: string } | null }>(`${base}/issues/${pr.number}/comments`),
    rest.paginate<{ body: string | null; state: string; user: { login: string } | null }>(`${base}/pulls/${pr.number}/reviews`),
  ]);
  const blocks: string[] = [];
  for (const r of reviews) {
    if (r.state === "PENDING" || !r.body?.trim()) continue;
    blocks.push(`Review by @${r.user?.login} (${r.state.toLowerCase().replace("_", " ")}):\n${quote(r.body)}`);
  }
  for (const c of comments) if (c.body?.trim()) blocks.push(`Conversation comment by @${c.user?.login}:\n${quote(c.body)}`);
  for (const t of threads) {
    const line = t.line ?? t.originalLine;
    const state = [t.isResolved ? "resolved" : "unresolved", t.isOutdated ? "outdated" : ""].filter(Boolean).join(", ");
    const replies = t.comments.map((c) => `@${c.author ?? "ghost"}:\n${quote(c.body)}`).join("\n");
    blocks.push(`Inline thread on \`${t.path}${line != null ? `:${line}` : ""}\` (${state}):\n${replies}`);
  }
  if (!blocks.length) return "";
  let body = blocks.join("\n\n");
  if (body.length > DISCUSSION_MAX_CHARS) body = `${body.slice(0, DISCUSSION_MAX_CHARS)}\n\n[truncated; read the rest with \`gh pr view ${pr.number} --comments\`]`;
  return [
    "",
    "",
    "## Existing PR discussion",
    "Reviewers and the author already discussed this PR. Take it into account:",
    "- Do not raise a point again as new when it is already raised and still unresolved; if you agree with it, say \"already raised by @x\" in that finding.",
    "- Respect resolved threads and the author's answers; only re-open one when the code still has the problem, and say why.",
    "",
    body,
  ].join("\n");
}

const CONTEXT_HINT =
  "\n\nProduct and team context lives in Slack and Notion. When it would help you judge the change, search and read them with the Slack and Notion tools, read-only. Cite every Slack message and Notion page you rely on as a markdown link to its URL.";

// ── records ───────────────────────────────────────────────────────────────────
type RunRow = {
  id: string;
  action_id: string | null;
  action_name: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  status: RunStatus;
  agent_key: string | null;
  session_id: string | null;
  cwd: string | null;
  prompt: string;
  replies: string;
  cost_usd: number | null;
  findings: string | null;
  checked_findings: string;
  posted_findings: string;
  created_at: string;
  finished_at: string | null;
};

const toRun = (r: RunRow): PrRun => ({
  id: r.id,
  actionId: r.action_id,
  actionName: r.action_name,
  pr: { owner: r.owner, repo: r.repo, number: r.number },
  title: r.title,
  status: r.status,
  agentKey: r.agent_key,
  sessionId: r.session_id,
  cwd: r.cwd,
  prompt: r.prompt,
  replies: JSON.parse(r.replies) as string[],
  costUsd: r.cost_usd,
  findings: r.findings ? (JSON.parse(r.findings) as Findings) : null,
  checkedFindings: JSON.parse(r.checked_findings) as string[],
  postedFindings: JSON.parse(r.posted_findings) as Record<string, PostedFinding>,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});

const rowById = (id: string) => db.query<RunRow, [string]>("SELECT * FROM pr_runs WHERE id = ?").get(id);

export function getRun(id: string): PrRun | null {
  const row = rowById(id);
  return row ? toRun(row) : null;
}

export function listRuns(pr?: PrRef): PrRun[] {
  const rows = pr
    ? db
        .query<RunRow, [string, string, number]>(
          "SELECT * FROM pr_runs WHERE owner = ? AND repo = ? AND number = ? ORDER BY created_at DESC",
        )
        .all(pr.owner, pr.repo, pr.number)
    : db.query<RunRow, []>("SELECT * FROM pr_runs ORDER BY created_at DESC LIMIT 300").all();
  return rows.map(toRun);
}

/** Run counts per PR, for the badges on the list. */
export function runSummary(): Record<string, { total: number; active: number; last: RunStatus }> {
  const rows = db
    .query<{ owner: string; repo: string; number: number; status: RunStatus }, []>(
      "SELECT owner, repo, number, status FROM pr_runs ORDER BY created_at ASC",
    )
    .all();
  const out: Record<string, { total: number; active: number; last: RunStatus }> = {};
  for (const r of rows) {
    const key = `${r.owner}/${r.repo}#${r.number}`;
    const entry = (out[key] ??= { total: 0, active: 0, last: r.status });
    entry.total++;
    if (r.status === "starting" || r.status === "running") entry.active++;
    entry.last = r.status;
  }
  return out;
}

function update(id: string, fields: Record<string, string | number | null>): PrRun {
  const keys = Object.keys(fields);
  db.query(`UPDATE pr_runs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(fields), id);
  const run = getRun(id)!;
  emit("pr-run", run);
  return run;
}

export function deleteRun(id: string): boolean {
  const run = getRun(id);
  if (!run) return false;
  db.query("DELETE FROM pr_runs WHERE id = ?").run(id);
  removeScratch(id);
  emit("pr-run", { id, deleted: true });
  return true;
}

export const actionById = (id: string): ReviewAction | null => getSettings().reviews.actions.find((a) => a.id === id) ?? null;

// ── starting ──────────────────────────────────────────────────────────────────
export async function startRun(action: ReviewAction, ref: PrRef): Promise<PrRun> {
  const pr = await getPr(ref.owner, ref.repo, ref.number);
  const vars = templateVars(pr);
  const [sources, discussion] = await Promise.all([linkedSources(pr).catch(() => ""), existingDiscussion(pr).catch(() => "")]);
  const prompt =
    renderTemplate(action.promptTemplate, vars) + sources + discussion + CONTEXT_HINT + (action.structuredFindings ? FINDINGS_INSTRUCTIONS : "");
  const id = randomUUID();
  db.query(
    `INSERT INTO pr_runs (id, action_id, action_name, owner, repo, number, title, status, prompt, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?)`,
  ).run(id, action.id, action.name, pr.owner, pr.repo, pr.number, pr.title, prompt, new Date().toISOString());
  emit("pr-run", getRun(id));

  void (async () => {
    try {
      const cwd = action.checkout === "head" ? await ensureWorktree(pr.owner, pr.repo, pr.headSha) : scratchFor(id);
      const defaultModel = getSettings().ui.defaultModel;
      const key = startAgent({
        cwd,
        model: action.model || defaultModel || undefined,
        permissionMode: action.permissionMode,
        prompt,
        title: `${action.name} · ${pr.repo}#${pr.number} ${pr.title}`,
        allowedTools: action.allowedTools,
        outputSchema: action.structuredFindings ? FINDINGS_SCHEMA : undefined,
      });
      update(id, { agent_key: key, cwd, status: "running" });
      void pruneWorktrees(busyCheckouts()).catch(() => {});
    } catch (e) {
      update(id, {
        status: "failed",
        replies: JSON.stringify([`Could not start: ${e instanceof Error ? e.message : String(e)}`]),
        finished_at: new Date().toISOString(),
      });
    }
  })();
  return getRun(id)!;
}

/** Every checkout a live session is working in — never pruned from under one. */
function busyCheckouts(): Set<string> {
  return new Set(listAgents().filter((a) => a.status !== "ended" && a.status !== "error").map((a) => a.cwd));
}

/** What a run's session is called, the same on a resume as on the first start. */
const runTitle = (row: RunRow) => `${row.action_name} · ${row.repo}#${row.number} ${row.title}`;

/** Resume an ended run's session, so the conversation can continue where it stopped. */
export function resumeRun(id: string): PrRun | { error: string } {
  const row = rowById(id);
  if (!row) return { error: "unknown run" };
  if (row.agent_key && getAgent(row.agent_key)) return toRun(row);
  if (!row.session_id || !row.cwd) return { error: "this run never got a session to resume" };
  const action = row.action_id ? actionById(row.action_id) : null;
  const key = startAgent({
    cwd: row.cwd,
    resume: row.session_id,
    permissionMode: action?.permissionMode,
    model: action?.model || undefined,
    title: runTitle(row),
    allowedTools: action?.allowedTools,
    outputSchema: row.findings ? FINDINGS_SCHEMA : undefined,
  });
  return update(id, { agent_key: key, status: "running", finished_at: null });
}

// ── following the session ─────────────────────────────────────────────────────
const runByAgent = (key: string) => db.query<RunRow, [string]>("SELECT * FROM pr_runs WHERE agent_key = ?").get(key);

/** A turn ended: pick up its structured findings or plain reply. */
export function onAgentItem(key: string, item: TimelineItem) {
  const row = runByAgent(key);
  if (!row) return;
  const agent = getAgent(key);
  if (agent?.sessionId && agent.sessionId !== row.session_id) update(row.id, { session_id: agent.sessionId });

  if (item.kind === "assistant" && !item.agentId && !row.findings && item.text.trim()) {
    const replies = JSON.parse(row.replies) as string[];
    update(row.id, { replies: JSON.stringify([...replies, item.text]) });
    return;
  }
  if (item.kind !== "result") return;
  const fields: Record<string, string | number | null> = {};
  if (item.costUsd !== null) fields.cost_usd = item.costUsd;
  if (isFindingsOutput(item.structured)) {
    const current = row.findings ? (JSON.parse(row.findings) as Findings) : null;
    fields.findings = JSON.stringify(current ? mergeFindings(current, item.structured) : firstFindings(item.structured));
    const replies = JSON.parse(row.replies) as string[];
    fields.replies = JSON.stringify([...replies, item.structured.reply]);
  }
  if (item.error) fields.status = "failed";
  if (Object.keys(fields).length) update(row.id, fields);
}

/**
 * The findings panel owns the ids, and a review session never sees them unless we
 * say so: every turn is forced to return the full list, and a finding that comes
 * back without its id is stored as a new one. So each follow-up carries the list.
 */
export function runMessagePreamble(agentKey: string, text: string): string {
  const row = runByAgent(agentKey);
  if (!row?.findings) return text;
  const current = JSON.parse(row.findings) as Findings;
  if (!current.findings.length) return text;
  const list = current.findings
    .map((f) => `- ${f.id} | ${f.severity} | ${f.title}${f.file ? ` | ${f.file}${f.line ? `:${f.line}` : ""}` : ""}`)
    .join("\n");
  return [
    "The review panel is holding these findings:",
    list,
    "",
    "Answer the message below in reply. Return this same list in findings, each one with the id it has above — a finding returned without its id is stored as a new one and shows up twice. Leave the id out only for a finding that is genuinely new.",
    "A question is usually just a question: change, add or drop a finding only when the message gives you a reason to.",
    "",
    "The message:",
    text,
  ].join("\n");
}

const STATUS_FOR_AGENT: Partial<Record<AgentStatus, RunStatus>> = {
  starting: "running",
  thinking: "running",
  "awaiting-permission": "running",
  idle: "succeeded",
  ended: "ended",
  error: "failed",
};

/** The roster changed: mirror each run's session status onto its record. */
export function onRoster(agents: { key: string; status: AgentStatus; sessionId: string | null; turns: number }[]) {
  for (const a of agents) {
    const row = runByAgent(a.key);
    if (!row) continue;
    const next = a.status === "idle" && a.turns === 0 ? "running" : STATUS_FOR_AGENT[a.status];
    if (!next) continue;
    const fields: Record<string, string | number | null> = {};
    if (next !== row.status && row.status !== "failed") {
      fields.status = next;
      fields.finished_at = next === "running" ? null : new Date().toISOString();
    }
    if (a.sessionId && a.sessionId !== row.session_id) fields.session_id = a.sessionId;
    if (Object.keys(fields).length) update(row.id, fields);
  }
}

// ── findings ──────────────────────────────────────────────────────────────────
export function setChecked(id: string, findingId: string, checked: boolean): PrRun | null {
  const run = getRun(id);
  if (!run?.findings?.findings.some((f) => f.id === findingId)) return null;
  const set = new Set(run.checkedFindings);
  if (checked) set.add(findingId);
  else set.delete(findingId);
  return update(id, { checked_findings: JSON.stringify([...set]) });
}

const targetsCache = new Map<string, { at: number; lines: Map<string, Set<number>> }>();

/** Where each finding can go: a pending inline comment when its line is in the diff, else the PR conversation. */
export async function findingTargets(pr: PrRef, findings: Finding[]): Promise<Record<string, FindingTarget>> {
  const key = `${pr.owner}/${pr.repo}#${pr.number}`;
  let hit = targetsCache.get(key);
  if (!hit || Date.now() - hit.at > 60_000) {
    hit = { at: Date.now(), lines: await commentableLines(pr) };
    targetsCache.set(key, hit);
  }
  const lines = hit.lines;
  return Object.fromEntries(
    findings.map((f): [string, FindingTarget] => {
      if (!f.file || !f.line) return [f.id, { mode: "comment", reason: "No file and line" }];
      if (!lines.has(f.file)) return [f.id, { mode: "comment", reason: "File is not part of this PR" }];
      if (!lines.get(f.file)!.has(f.line)) return [f.id, { mode: "comment", reason: "Line is outside the diff" }];
      return [f.id, { mode: "draft" }];
    }),
  );
}

const SEVERITY_LABEL = { high: "🔴 High", medium: "🟠 Medium", low: "⚪ Low" } as const;

function findingBody(run: PrRun, f: Finding, withLocation: boolean): string {
  return [
    `**${SEVERITY_LABEL[f.severity]}: ${f.title}**`,
    withLocation && f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\`` : "",
    f.body,
    f.suggestion ? `**Suggestion:** ${f.suggestion}` : "",
    `<sub>🤖 Found by Claude (${run.actionName}) · posted from the Claude dashboard</sub>`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function postFinding(id: string, findingId: string): Promise<PrRun | { error: string; status: number }> {
  const run = getRun(id);
  const finding = run?.findings?.findings.find((f) => f.id === findingId);
  if (!run || !finding) return { error: "finding not found", status: 404 };
  if (run.postedFindings[findingId]) return { error: "finding already posted", status: 409 };
  const target = (await findingTargets(run.pr, [finding]))[findingId];
  let posted: PostedFinding;
  if (target.mode === "draft") {
    addDraft(run.pr, { path: finding.file!, side: "RIGHT", line: finding.line!, startLine: null, body: findingBody(run, finding, false) });
    posted = { kind: "draft" };
  } else {
    posted = { kind: "comment", url: await postIssueComment(run.pr, findingBody(run, finding, true)) };
  }
  return update(id, { posted_findings: JSON.stringify({ ...run.postedFindings, [findingId]: posted }) });
}
