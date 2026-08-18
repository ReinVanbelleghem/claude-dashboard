import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { DATA_DIR } from "./paths.ts";
import {
  query,
  type ModelInfo,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * Sessions the dashboard owns.
 *
 * A session started here is a child process of the API server, which is what
 * makes it interactive: we hold its stdin, so prompts, permission answers,
 * model switches and interrupts all have somewhere to go. Sessions started in a
 * terminal remain read-only — their input is a tty we cannot reach.
 *
 * Everything else about them is ordinary: `settingSources` is left at its
 * default so they load ~/.claude settings, CLAUDE.md, skills and MCP servers
 * exactly like the CLI, and the transcript lands in ~/.claude/projects where
 * the indexer already picks it up.
 */

/**
 * Which subagent an item belongs to: the `parent_tool_use_id` the CLI stamps on
 * forwarded subagent messages, matching the id of the Task tool_use that spawned
 * it. Absent on the main conversation.
 */
export type TimelineItem = (
  | {
      kind: "user";
      ts: number;
      text: string;
      queued?: boolean;
      /**
       * Attached images. The base64 still never enters the timeline — a few
       * screenshots would be megabytes on every SSE fan-out — but the bytes are
       * written to disk first and referenced by `url`, so the browser can fetch
       * (and cache) each one on demand instead of only seeing that it existed.
       */
      images?: { label: string; mediaType: string; bytes: number; url?: string }[];
    }
  | { kind: "assistant"; ts: number; text: string }
  | { kind: "thinking"; ts: number; text: string }
  | { kind: "tool"; ts: number; id: string; name: string; input: unknown; result?: string; ok?: boolean }
  | {
      kind: "permission";
      ts: number;
      requestId: string;
      toolName: string;
      title: string | null;
      description: string | null;
      input: unknown;
      /** Set once answered; while null the turn is parked waiting on the browser. */
      decision: "allow" | "allowAlways" | "deny" | null;
    }
  | { kind: "result"; ts: number; costUsd: number | null; durationMs: number | null; error: string | null }
  | { kind: "error"; ts: number; text: string }
) & { agentId?: string };

/**
 * A subagent spawned by the Task tool.
 *
 * Identity is `taskId`: every task event carries it, while `tool_use_id` is
 * optional — keying on the optional one produced a second, empty entry for the
 * same agent as soon as an event arrived without it. `toolUseId` is still kept,
 * because that is what forwarded subagent messages are tagged with, so it is the
 * link between a tab and its content.
 */
export type TaskInfo = {
  taskId: string;
  toolUseId: string | null;
  /** First description seen — a stable name for the tab. */
  name: string;
  /** Latest description — what it is doing right now. */
  activity: string | null;
  subagentType: string | null;
  status: "running" | "completed" | "failed" | "stopped" | "paused" | "pending";
  /** The final report, once it finishes. Long-form, rendered in the tab. */
  report: string | null;
  lastTool: string | null;
  tokens: number;
  toolUses: number;
  durationMs: number;
};

export type AgentStatus = "starting" | "idle" | "thinking" | "awaiting-permission" | "ended" | "error";

type Pending = {
  resolve: (r: PermissionResult) => void;
  suggestions: PermissionUpdate[];
};

type Agent = {
  key: string;
  sessionId: string | null;
  cwd: string;
  title: string | null;
  model: string | null;
  permissionMode: PermissionMode;
  status: AgentStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  /** Why the session stopped, so a surprise exit is diagnosable after the fact. */
  endedReason: string | null;
  timeline: TimelineItem[];
  /** Text of the assistant block currently streaming, before it is committed. */
  streaming: string;
  q: Query;
  push: (m: SDKUserMessage) => void;
  close: () => void;
  pending: Map<string, Pending>;
  tasks: Map<string, TaskInfo>;
  models: ModelInfo[] | null;
  /**
   * Slash commands this session accepts — skills, plugins, and the prompt-level
   * built-ins. TUI-only commands like /skills or /config are absent, because they
   * render interactive terminal UI rather than expanding into a prompt.
   */
  commands: { name: string; description: string; argumentHint?: string }[] | null;
  stderr: string[];
};

const agents = new Map<string, Agent>();

// ── surviving a restart ───────────────────────────────────────────────────────
/**
 * Sessions are child processes, so a daemon restart takes them with it. Their
 * transcripts outlive them, though, so we remember enough to offer a one-click
 * resume: same session id, full history, new process.
 *
 * Nothing is auto-resumed on boot — spawning processes and re-reading transcripts
 * without being asked would burn tokens you didn't authorise.
 */
export type Restorable = {
  sessionId: string;
  cwd: string;
  title: string | null;
  model: string | null;
  lastSeen: number;
};

const RESTORE_PATH = join(DATA_DIR, "sessions.json");
let restorable: Restorable[] = [];

function loadRestorable() {
  try {
    restorable = JSON.parse(readFileSync(RESTORE_PATH, "utf8")) as Restorable[];
  } catch {
    restorable = [];
  }
}

function saveRestorable() {
  // Merge over what is already on disk rather than replacing it. A restarted
  // daemon writes before it has any sessions of its own, and rebuilding purely
  // from memory at that moment would erase every entry the last run recorded.
  let onDisk: Restorable[] = [];
  try {
    const parsed = JSON.parse(readFileSync(RESTORE_PATH, "utf8"));
    if (Array.isArray(parsed)) onDisk = parsed as Restorable[];
  } catch {
    // No readable file yet; the in-memory list is all there is.
  }
  const rows = [
    ...[...agents.values()]
      .filter((a) => a.sessionId)
      .map((a) => ({
        sessionId: a.sessionId!,
        cwd: a.cwd,
        title: a.title,
        model: a.model,
        lastSeen: a.updatedAt,
      })),
    ...restorable,
    ...onDisk,
  ];
  const seen = new Set<string>();
  restorable = rows
    .filter((r) => (seen.has(r.sessionId) ? false : seen.add(r.sessionId)))
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, 50);
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(RESTORE_PATH, JSON.stringify(restorable, null, 2));
  } catch {
    // A dashboard that cannot write its own bookkeeping should still run.
  }
}

loadRestorable();

/**
 * The model list is only knowable by asking a running session, but the
 * new-session dialog needs it before one exists. So the last list any session
 * reported is cached here and served to the dialog — that way it tracks whatever
 * your CLI actually offers (Fable included) instead of a list hardcoded by hand.
 */
const MODELS_PATH = join(DATA_DIR, "models.json");

export function cachedModels(): ModelInfo[] {
  try {
    const rows = JSON.parse(readFileSync(MODELS_PATH, "utf8")) as ModelInfo[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function cacheModels(models: ModelInfo[]) {
  if (models.length === 0) return;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(MODELS_PATH, JSON.stringify(models, null, 2));
  } catch {
    // Losing the cache only costs us the fallback list next time.
  }
}

/** Past dashboard sessions that are not currently running, newest first. */
export function listRestorable(): Restorable[] {
  const live = new Set([...agents.values()].map((a) => a.sessionId).filter(Boolean));
  return restorable.filter((r) => !live.has(r.sessionId));
}

/** Set by the server so state changes reach the browser over the existing SSE. */
let emit: (event: string, data: unknown) => void = () => {};
export function setAgentEmitter(fn: (event: string, data: unknown) => void) {
  emit = fn;
}

/** Running sessions and resumable ones travel together — the UI lists both. */
export function rosterPayload() {
  return { agents: listAgents(), restorable: listRestorable() };
}

function emitRoster() {
  emit("agents", rosterPayload());
}

// ── public shape ──────────────────────────────────────────────────────────────
export function agentSummary(a: Agent) {
  return {
    key: a.key,
    sessionId: a.sessionId,
    cwd: a.cwd,
    title: a.title,
    model: a.model,
    permissionMode: a.permissionMode,
    status: a.status,
    error: a.error,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    endedAt: a.endedAt,
    endedReason: a.endedReason,
    turns: a.timeline.filter((i) => i.kind === "user").length,
    pending: a.timeline.filter((i) => i.kind === "permission" && i.decision === null).length,
  };
}

/**
 * Session ids the dashboard drives. The CLI a session spawns registers itself in
 * ~/.claude/sessions like any other, so without this the same session shows up
 * twice: once as ours, once as an external one.
 */
export function ownedSessionIds(): Set<string> {
  const ids = new Set<string>();
  for (const a of agents.values()) if (a.sessionId) ids.add(a.sessionId);
  return ids;
}

/**
 * Live sessions whose working directory is inside `root`.
 *
 * Used to refuse deleting a worktree that something is still working in. Real paths
 * on both sides: a cwd recorded through a symlinked parent would otherwise compare
 * unequal to the path git reports, and the check would pass when it should not.
 * A session that has already ended holds no files, so only running ones count.
 */
export function agentsUnder(root: string): string[] {
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const a of agents.values()) {
    if (a.status === "ended" || a.status === "error") continue;
    let cwd: string;
    try {
      cwd = realpathSync(a.cwd);
    } catch {
      continue;
    }
    if (cwd === real || cwd.startsWith(real + sep)) out.push(a.key);
  }
  return out;
}

export function listAgents() {
  return [...agents.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(agentSummary);
}

export function getAgent(key: string) {
  const a = agents.get(key);
  if (!a) return null;
  return {
    ...agentSummary(a),
    timeline: a.timeline,
    streaming: a.streaming,
    tasks: [...a.tasks.values()],
    models: a.models,
    commands: a.commands,
    // Last words of the child process — the only clue when it dies unasked.
    stderr: a.stderr.join("").trim().split("\n").slice(-20).join("\n"),
  };
}

function touch(a: Agent, status?: AgentStatus) {
  a.updatedAt = Date.now();
  // Ended is terminal. A turn already in flight when the session was stopped
  // still emits its result, which would otherwise flip the status back to idle.
  const settled = a.endedAt !== null;
  if (status && (!settled || status === "ended" || status === "error")) a.status = status;
  if (a.sessionId) saveRestorable();
  emitRoster();
}

/**
 * Record why a session stopped. An unexplained exit is the hardest thing to
 * diagnose after the fact, so the reason and the child's last words are kept.
 */
function markEnded(a: Agent, status: "ended" | "error", reason: string) {
  if (a.endedAt) return;
  a.endedAt = Date.now();
  a.endedReason = reason;
  const alive = Math.round((a.endedAt - a.createdAt) / 1000);
  const tail = a.stderr.join("").trim().split("\n").slice(-3).join(" | ");
  console.log(
    `[claude-dashboard] session ${a.sessionId ?? a.key} ${status} after ${alive}s: ${reason}` +
      (tail ? ` — stderr: ${tail.slice(0, 400)}` : ""),
  );
  touch(a, status);
}

function append(a: Agent, item: TimelineItem) {
  a.timeline.push(item);
  a.updatedAt = Date.now();
  emit("agent-item", { key: a.key, item });
}

// ── input plumbing ────────────────────────────────────────────────────────────
/**
 * An async iterable that stays open between turns. `query()` consumes it for the
 * life of the session, so the process is spawned once and every later prompt is
 * just another item pushed onto this queue.
 */
function inputQueue() {
  const items: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(m: SDKUserMessage) {
      items.push(m);
      wake?.();
      wake = null;
    },
    close() {
      closed = true;
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
      while (true) {
        const next = items.shift();
        if (next) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    },
  };
}

/** What the browser may attach to a message. Base64 because it came off a paste. */
export type InboundImage = { mediaType: ImageMediaType; data: string };

/** The four the API accepts; anything else is rejected at the route. */
export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
export const IMAGE_MEDIA_TYPES: ImageMediaType[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

// ── attachment store ──────────────────────────────────────────────────────────
/**
 * Where pasted images live once the model has been handed them.
 *
 * On disk rather than in the timeline: the timeline is broadcast whole to every
 * SSE client on every change, so inlining base64 would re-send megabytes per
 * keystroke-ish event. A file the browser fetches once and caches forever costs
 * nothing after the first look, and survives a daemon restart the same way the
 * restorable roster does.
 */
export const IMAGES_DIR = join(DATA_DIR, "images");

const EXT: Record<ImageMediaType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Files are named `<uuid>.<ext>`; the route rejects anything that is not. */
export const IMAGE_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;

/**
 * Write one attachment out and describe it for the timeline. A failed write is
 * not worth losing the message over — the turn still goes to the model, the
 * chip just renders without a thumbnail, exactly as it did before.
 */
function persistImage(img: InboundImage, i: number) {
  const buf = Buffer.from(img.data, "base64");
  const meta = { label: `Image #${i + 1}`, mediaType: img.mediaType, bytes: buf.byteLength };
  try {
    mkdirSync(IMAGES_DIR, { recursive: true });
    const name = `${randomUUID()}.${EXT[img.mediaType]}`;
    writeFileSync(join(IMAGES_DIR, name), buf);
    return { ...meta, url: `/api/images/${name}` };
  } catch (e) {
    console.log(`[claude-dashboard] could not store attachment: ${(e as Error).message}`);
    return meta;
  }
}

/**
 * Drop attachments older than the retention window, once, at boot.
 *
 * Nothing else ever deletes them: a timeline can be forgotten, a session can
 * end, and the daemon would otherwise keep every screenshot ever pasted. Boot is
 * the only moment where no timeline can be pointing at a file we are about to
 * remove that is also still on screen.
 */
const IMAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function pruneImages(now = Date.now()) {
  let removed = 0;
  try {
    for (const name of readdirSync(IMAGES_DIR)) {
      if (!IMAGE_FILE_RE.test(name)) continue;
      const f = join(IMAGES_DIR, name);
      if (now - statSync(f).mtimeMs < IMAGE_RETENTION_MS) continue;
      rmSync(f, { force: true });
      removed++;
    }
  } catch {
    return; // No directory yet, or unreadable — nothing to prune either way.
  }
  if (removed) console.log(`[claude-dashboard] pruned ${removed} stored attachment(s)`);
}

function userMessage(
  text: string,
  images: InboundImage[] = [],
  priority?: "now" | "next" | "later",
): SDKUserMessage {
  // Images lead: the model reads the blocks in order, and the text almost always
  // refers back to the picture ("why does this look wrong?").
  const content = [
    ...images.map((img) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: img.mediaType, data: img.data },
    })),
    { type: "text" as const, text },
  ];
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    priority,
  } as SDKUserMessage;
}

// ── lifecycle ─────────────────────────────────────────────────────────────────
export type StartOptions = {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  /** Session id to continue; its history is loaded and appended to. */
  resume?: string;
  /** First prompt, sent as soon as the session is up. */
  prompt?: string;
  /** Replaces the auto-generated title. Ignored by the CLI when resuming. */
  title?: string;
};

export function startAgent(opts: StartOptions): string {
  const key = randomUUID();
  const queue = inputQueue();

  const agent: Agent = {
    key,
    sessionId: opts.resume ?? null,
    cwd: opts.cwd,
    title: opts.title?.trim() || null,
    model: opts.model ?? null,
    permissionMode: opts.permissionMode ?? "default",
    status: "starting",
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    endedAt: null,
    endedReason: null,
    timeline: [],
    streaming: "",
    pending: new Map(),
    tasks: new Map(),
    models: null,
    commands: null,
    stderr: [],
    push: queue.push,
    close: queue.close,
    // Replaced immediately below; declared here to keep the type non-optional.
    q: null as unknown as Query,
  };

  agent.q = query({
    prompt: queue,
    options: {
      cwd: opts.cwd,
      model: opts.model,
      permissionMode: opts.permissionMode ?? "default",
      // The CLI refuses bypassPermissions unless it was allowed at spawn time, so
      // this is opted into only when the session is deliberately started that way.
      allowDangerouslySkipPermissions: opts.permissionMode === "bypassPermissions",
      resume: opts.resume,
      title: opts.title?.trim() || undefined,
      includePartialMessages: true,
      // Without these a Task call is an opaque tool row: the first forwards the
      // subagent's own messages (tagged with parent_tool_use_id), the second adds
      // a rolling one-line summary of what each one is doing.
      forwardSubagentText: true,
      agentProgressSummaries: true,
      // The whole point of this feature: a permission request becomes a
      // question in the browser instead of a blocked turn.
      canUseTool: (toolName, input, o) => askBrowser(agent, toolName, input, o),
      stderr: (d) => {
        agent.stderr.push(d);
        if (agent.stderr.length > 200) agent.stderr.shift();
      },
    },
  });

  agents.set(key, agent);
  void consume(agent);
  void agent.q
    .supportedModels()
    .then((m) => {
      agent.models = m;
      cacheModels(m);
      emit("agent-models", { key, models: m });
    })
    .catch(() => {});
  void agent.q
    .supportedCommands()
    .then((c) => {
      agent.commands = c.map((x) => ({
        name: x.name,
        description: x.description ?? "",
        argumentHint: (x as { argumentHint?: string }).argumentHint,
      }));
      emit("agent-commands", { key, commands: agent.commands });
    })
    .catch(() => {});

  if (opts.prompt) sendMessage(key, opts.prompt);
  emitRoster();
  return key;
}

function askBrowser(
  agent: Agent,
  toolName: string,
  input: Record<string, unknown>,
  o: {
    requestId: string;
    title?: string;
    description?: string;
    suggestions?: PermissionUpdate[];
    signal: AbortSignal;
  },
): Promise<PermissionResult> {
  return new Promise<PermissionResult>((resolve) => {
    agent.pending.set(o.requestId, { resolve, suggestions: o.suggestions ?? [] });
    append(agent, {
      kind: "permission",
      ts: Date.now(),
      requestId: o.requestId,
      toolName,
      title: o.title ?? null,
      description: o.description ?? null,
      input,
      decision: null,
    });
    touch(agent, "awaiting-permission");

    // If the turn is interrupted while parked, stop waiting on a human.
    o.signal.addEventListener("abort", () => {
      if (agent.pending.delete(o.requestId)) {
        resolve({ behavior: "deny", message: "Interrupted before you answered." });
      }
    });
  });
}

/**
 * Fold a task_started / task_progress / task_completed event into the roster.
 *
 * These are keyed by `tool_use_id` — the id of the Task tool_use in the parent's
 * timeline — which is also what forwarded subagent messages carry, so one key
 * ties the card, the tab and the messages together. `task_id` is the fallback for
 * a task that reports no tool_use id.
 */
function applyTaskEvent(agent: Agent, msg: Record<string, any>) {
  const taskId: string | undefined = msg.task_id;
  if (!taskId) return;
  const prev = agent.tasks.get(taskId);

  // task_notification is the completion signal — there is no task_completed
  // subtype. task_updated can also report paused or killed mid-flight.
  const reported: string | undefined =
    msg.subtype === "task_notification" ? (msg.status ?? "completed") : msg.status;
  const status: TaskInfo["status"] =
    reported === "killed"
      ? "stopped"
      : reported && reported !== "pending"
        ? (reported as TaskInfo["status"])
        : (prev?.status ?? "running");

  agent.tasks.set(taskId, {
    taskId,
    toolUseId: msg.tool_use_id ?? prev?.toolUseId ?? null,
    name: prev?.name ?? msg.description ?? "Subagent",
    // Progress rewrites the description as the agent moves; the first one stays
    // the name so the tab does not rename itself under the reader.
    activity: msg.description ?? prev?.activity ?? null,
    subagentType: msg.subagent_type ?? prev?.subagentType ?? null,
    status,
    report: (msg.subtype === "task_notification" ? msg.summary : null) ?? prev?.report ?? null,
    lastTool: msg.last_tool_name ?? prev?.lastTool ?? null,
    tokens: msg.usage?.total_tokens ?? prev?.tokens ?? 0,
    toolUses: msg.usage?.tool_uses ?? prev?.toolUses ?? 0,
    durationMs: msg.usage?.duration_ms ?? prev?.durationMs ?? 0,
  });

  emit("agent-tasks", { key: agent.key, tasks: [...agent.tasks.values()] });
  touch(agent);
}

/** Drain the SDK's message stream into the timeline the browser renders. */
async function consume(agent: Agent) {
  try {
    for await (const msg of agent.q) {
      const anyMsg = msg as any;
      if (anyMsg.session_id && agent.sessionId !== anyMsg.session_id) {
        agent.sessionId = anyMsg.session_id;
        touch(agent);
      }

      switch (msg.type) {
        case "system":
          if (anyMsg.subtype?.startsWith("task_")) {
            applyTaskEvent(agent, anyMsg);
            break;
          }
          if (anyMsg.subtype === "init") {
            if (anyMsg.model) agent.model = anyMsg.model;
            if (anyMsg.permissionMode) agent.permissionMode = anyMsg.permissionMode;
            touch(agent, agent.status === "starting" ? "idle" : agent.status);
          }
          break;

        case "stream_event": {
          // Token deltas: the only path that makes a reply appear as it is written.
          const ev = anyMsg.event;
          if (
            ev?.type === "content_block_delta" &&
            ev.delta?.type === "text_delta" &&
            !anyMsg.parent_tool_use_id
          ) {
            agent.streaming += ev.delta.text;
            emit("agent-delta", { key: agent.key, text: ev.delta.text });
          }
          break;
        }

        case "assistant": {
          const from = anyMsg.parent_tool_use_id ?? undefined;
          // Only the main conversation streams into the composer's live buffer;
          // a subagent's tokens belong to its own tab.
          if (!from) agent.streaming = "";
          for (const b of anyMsg.message?.content ?? []) {
            if (b.type === "text" && b.text.trim()) {
              append(agent, { kind: "assistant", ts: Date.now(), text: b.text, agentId: from });
            } else if (b.type === "thinking" && b.thinking?.trim()) {
              append(agent, { kind: "thinking", ts: Date.now(), text: b.thinking, agentId: from });
            } else if (b.type === "tool_use") {
              append(agent, {
                kind: "tool",
                ts: Date.now(),
                id: b.id,
                name: b.name,
                input: b.input,
                agentId: from,
              });
            }
          }
          touch(agent, agent.status === "awaiting-permission" ? agent.status : "thinking");
          break;
        }

        case "user": {
          // Tool results arrive as user messages; attach them to their call so
          // the UI can show one collapsible block per tool instead of two. The
          // lookup is by tool_use_id, which is unique across subagents too.
          for (const b of anyMsg.message?.content ?? []) {
            if (b?.type !== "tool_result") continue;
            const item = [...agent.timeline]
              .reverse()
              .find((i): i is Extract<TimelineItem, { kind: "tool" }> =>
                i.kind === "tool" && i.id === b.tool_use_id,
              );
            if (!item) continue;
            const text =
              typeof b.content === "string"
                ? b.content
                : Array.isArray(b.content)
                  ? b.content
                      .filter((c: any) => c?.type === "text")
                      .map((c: any) => c.text)
                      .join("\n")
                  : "";
            item.result = text.slice(0, 4000);
            item.ok = !b.is_error;
            emit("agent-item", { key: agent.key, item, replace: true });
          }
          break;
        }

        case "result": {
          for (const i of agent.timeline) if (i.kind === "user" && i.queued) delete i.queued;
          append(agent, {
            kind: "result",
            ts: Date.now(),
            costUsd: anyMsg.total_cost_usd ?? null,
            durationMs: anyMsg.duration_ms ?? null,
            error: anyMsg.is_error ? (anyMsg.subtype ?? "error") : null,
          });
          agent.streaming = "";
          touch(agent, "idle");
          break;
        }
      }
    }
    // The generator only finishes when the child process is gone, which for a
    // session nobody ended means it exited or was killed underneath us.
    markEnded(agent, "ended", agent.endedReason ?? "the session process exited");
  } catch (err) {
    agent.error = err instanceof Error ? err.message : String(err);
    append(agent, { kind: "error", ts: Date.now(), text: agent.error });
    markEnded(agent, "error", agent.error);
  }
}

// ── control ───────────────────────────────────────────────────────────────────
/**
 * Send a prompt, whether or not a turn is already running.
 *
 * A message typed mid-turn is marked `next`, so the CLI queues it as an async user
 * message and picks it up when the current turn finishes instead of being blocked
 * on it. The timeline records it immediately, flagged as queued, so you can see
 * that it landed and is waiting rather than wondering if it was dropped.
 */
export function sendMessage(key: string, text: string, images: InboundImage[] = []): boolean {
  const a = agents.get(key);
  if (!a || a.status === "ended" || a.status === "error") return false;
  const busy = a.status === "thinking" || a.status === "awaiting-permission";
  append(a, {
    kind: "user",
    ts: Date.now(),
    text,
    ...(busy ? { queued: true } : {}),
    ...(images.length ? { images: images.map(persistImage) } : {}),
  });
  a.push(userMessage(text, images, busy ? "next" : undefined));
  if (!busy) touch(a, "thinking");
  else touch(a);
  return true;
}

/**
 * Resolve a parked permission prompt.
 *
 * `answers` exists for AskUserQuestion, whose contract puts the host's UI inside the
 * permission step: the tool reads the picked options back out of its own input, under
 * `answers` keyed by question text. Allowing it without them runs the tool with
 * nothing to report, which is why an unanswered question came back as "the user did
 * not answer" seconds after being allowed.
 */
export function answerPermission(
  key: string,
  requestId: string,
  behavior: "allow" | "allowAlways" | "deny",
  answers?: Record<string, string>,
): boolean {
  const a = agents.get(key);
  const p = a?.pending.get(requestId);
  if (!a || !p) return false;
  a.pending.delete(requestId);

  const item = a.timeline.find(
    (i): i is Extract<TimelineItem, { kind: "permission" }> =>
      i.kind === "permission" && i.requestId === requestId,
  );
  if (item) {
    item.decision = behavior;
    emit("agent-item", { key, item, replace: true });
  }

  p.resolve(
    behavior === "deny"
      ? { behavior: "deny", message: "Denied from the dashboard." }
      : {
          behavior: "allow",
          // "Allow always" is exactly the suggestion set the SDK handed us, which
          // is what stops it asking again for this tool this session.
          updatedPermissions: behavior === "allowAlways" ? p.suggestions : undefined,
          // Merged over the original input rather than replacing it: the tool still
          // needs its questions to echo them back alongside the answers.
          updatedInput:
            answers && item ? { ...(item.input as object), answers } : undefined,
        },
  );
  touch(a, a.pending.size > 0 ? "awaiting-permission" : "thinking");
  return true;
}

export async function interruptAgent(key: string): Promise<boolean> {
  const a = agents.get(key);
  if (!a) return false;
  // Park nothing: outstanding prompts would otherwise hold the turn open.
  for (const [id] of a.pending) answerPermission(key, id, "deny");
  await a.q.interrupt().catch(() => {});
  touch(a, "idle");
  return true;
}

export async function setAgentModel(
  key: string,
  model: string | undefined,
): Promise<{ ok: boolean; error?: string }> {
  const a = agents.get(key);
  if (!a) return { ok: false, error: "no such session" };
  try {
    await a.q.setModel(model);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  a.model = model ?? null;
  touch(a);
  return { ok: true };
}

/**
 * Not every mode is available to every session: `auto` depends on the model, and
 * `bypassPermissions` only works if the session was started with it (the CLI
 * requires that opt-in up front). The reason is returned rather than thrown so
 * the UI can say what happened instead of silently snapping back.
 */
export async function setAgentMode(
  key: string,
  mode: PermissionMode,
): Promise<{ ok: boolean; error?: string; mode?: PermissionMode }> {
  const a = agents.get(key);
  if (!a) return { ok: false, error: "no such session" };
  try {
    await a.q.setPermissionMode(mode);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error, mode: a.permissionMode };
  }
  a.permissionMode = mode;
  touch(a);
  return { ok: true, mode };
}

export async function stopAgent(key: string, reason = "ended from the dashboard"): Promise<boolean> {
  const a = agents.get(key);
  if (!a) return false;
  a.endedReason = reason;
  for (const [id] of a.pending) answerPermission(key, id, "deny");
  a.close();
  await a.q.interrupt().catch(() => {});
  markEnded(a, "ended", reason);
  return true;
}

/**
 * Bring a past session back under dashboard control, history intact.
 *
 * The recorded cwd is checked first. `POST /api/agents` validates the directory it is
 * handed, but this path takes one off disk that was written months ago — and a
 * worktree that has since been removed would otherwise reach the SDK as a spawn into
 * nowhere, failing somewhere far less legible than here.
 */
export function restoreAgent(sessionId: string): { key: string } | { error: string } {
  const row = restorable.find((r) => r.sessionId === sessionId);
  if (!row) return { error: "unknown session" };
  if (!existsSync(row.cwd))
    return { error: `${row.cwd} no longer exists — the worktree or folder it ran in is gone` };
  return {
    key: startAgent({
      cwd: row.cwd,
      model: row.model ?? undefined,
      title: row.title ?? undefined,
      resume: sessionId,
    }),
  };
}

/** Drop a past session from the resumable list without touching its transcript. */
export function forgetRestorable(sessionId: string): boolean {
  const before = restorable.length;
  restorable = restorable.filter((r) => r.sessionId !== sessionId);
  // Forgetting is the one path that must survive the merge in saveRestorable, so
  // it writes the filtered list directly.
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(RESTORE_PATH, JSON.stringify(restorable, null, 2));
  } catch {
    // Nothing to do; the entry stays until the next successful write.
  }
  emitRoster();
  return restorable.length !== before;
}

export function forgetAgent(key: string): boolean {
  const a = agents.get(key);
  if (!a) return false;
  if (a.status !== "ended" && a.status !== "error") return false;
  agents.delete(key);
  emitRoster();
  return true;
}

/** Child sessions die with the server, so end them deliberately on shutdown. */
export async function stopAllAgents() {
  await Promise.all(
    [...agents.keys()].map((k) => stopAgent(k, "the dashboard daemon shut down").catch(() => {})),
  );
}
