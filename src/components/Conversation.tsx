import { useCallback, useEffect, useRef, useState } from "react";
import {
  agentApi,
  agentBus,
  commentApi,
  fmtUsd,
  settingsApi,
  toolSummary,
  type AgentDetail,
  type ImageMediaType,
  type ModelInfo,
  type PermissionMode,
  type Settings,
  type TaskInfo,
  type TimelineItem,
} from "../api.ts";
import { onCompose } from "./compose.ts";
import { highlight } from "./highlight.tsx";
import { Markdown } from "./Markdown.tsx";
import { ScrollJump, useJumpToEnd, useScrollEdges } from "./scroll.tsx";

/** What the composer holds between a paste and a send. */
type Attachment = {
  id: string;
  mediaType: ImageMediaType;
  /** Base64 payload, no data-URL prefix — what the API wants. */
  data: string;
  /** The full data URL, for the thumbnail. */
  previewUrl: string;
  bytes: number;
};

const IMAGE_TYPES: ImageMediaType[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Rough is fine here — it's a reassurance that the paste landed, not an audit. */
function fmtBytes(n: number): string {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
/** Matches the daemon's cap, so the composer refuses before the round trip. */
const MAX_ATTACHMENTS = 8;

type TurnImage = NonNullable<Extract<TimelineItem, { kind: "user" }>["images"]>[number];

/**
 * What you attached, back in the transcript.
 *
 * Thumbnails rather than the full picture: a message can carry eight of them and
 * the transcript is a reading surface, not a gallery. Click opens the stored
 * copy full size. Items without a `url` — written before attachments were kept,
 * or whose write failed — still render as the old label chip, so history does
 * not turn into a wall of broken images.
 */
function Attachments({ images }: { images: TurnImage[] }) {
  const [open, setOpen] = useState<TurnImage | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <div className="turn-attachments">
        {images.map((img, i) =>
          img.url ? (
            <button
              className="turn-thumb"
              key={i}
              onClick={() => setOpen(img)}
              title={`${img.label} · ${fmtBytes(img.bytes)} — click to enlarge`}
            >
              <img src={img.url} alt={img.label} loading="lazy" />
            </button>
          ) : (
            <span className="turn-attachment" key={i}>
              {img.label} · {img.mediaType.replace("image/", "").toUpperCase()} ·{" "}
              {fmtBytes(img.bytes)}
            </span>
          ),
        )}
      </div>

      {open && (
        <div className="lightbox" onClick={() => setOpen(null)} role="presentation">
          {/* Stops a click on the picture itself from closing the thing you just opened. */}
          <img src={open.url} alt={open.label} onClick={(e) => e.stopPropagation()} />
          <div className="lightbox-bar">
            {open.label} · {open.mediaType.replace("image/", "").toUpperCase()} ·{" "}
            {fmtBytes(open.bytes)}
            <a href={open.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              open original
            </a>
          </div>
        </div>
      )}
    </>
  );
}

export const MODES: PermissionMode[] = [
  "auto",
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
];

/** The SDK ships identifiers; these are the human labels for the picker. */
export const MODE_LABEL: Record<string, string> = {
  default: "Ask me",
  acceptEdits: "Accept edits",
  plan: "Plan only",
  dontAsk: "Don't ask",
  auto: "Auto",
  bypassPermissions: "Bypass all",
};

/**
 * What each mode actually does. Worth spelling out: the difference between `auto`
 * and `bypassPermissions` is the difference between "judgement applied" and "no
 * checks at all", and the names alone do not say that.
 */
export const MODE_HELP: Record<string, string> = {
  auto: "Routine work proceeds; anything risky still asks. Not offered by every model — those fall back to Ask me.",
  default: "Every tool call that needs permission asks you first.",
  acceptEdits: "File edits apply without asking; other tools still ask.",
  plan: "Claude plans and explains, and does not touch anything until you accept.",
  dontAsk: "Never prompts; anything that would have prompted is skipped instead.",
  bypassPermissions:
    "No permission checks at all. Must be chosen when the session starts — it cannot be switched on later.",
};

/** Offered before a session exists, when no live model list can be fetched yet. */
export const STARTER_MODELS: { value: string; label: string }[] = [
  { value: "default", label: "Default (recommended)" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

/**
 * The live half of a session view: everything that only exists while the
 * dashboard owns the process — streaming replies, tool calls, permission
 * prompts, and the composer. Sessions started in a terminal never render this.
 */
export function LiveConversation({
  agentKey,
  settings,
  onSettings,
  onGone,
}: {
  agentKey: string;
  settings?: Settings | null;
  onSettings?: (s: Settings) => void;
  onGone?: () => void;
}) {
  const [data, setData] = useState<AgentDetail | null>(null);
  const [streaming, setStreaming] = useState("");
  const [draft, setDraft] = useState("");
  /**
   * Pasted images, held until send. The draft carries a matching `[Image #N]`
   * marker so the text you typed reads the way the model will see it, the same
   * as the terminal — the bytes never go in the textarea.
   */
  const [attached, setAttached] = useState<Attachment[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [picking, setPicking] = useState(true);
  /** Which subagent's transcript is showing; null is the main conversation. */
  const [tab, setTab] = useState<string | null>(null);
  const [showFinished, setShowFinished] = useState(false);
  /**
   * Review comments sitting in the draft, waiting on a send. Marked as seen only once
   * the message actually goes — a draft can still be edited or thrown away.
   */
  const pendingComments = useRef<string[]>([]);
  const scroller = useRef<HTMLDivElement | null>(null);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const pinned = useRef(true);

  /**
   * Held in a ref because callers pass an inline arrow, which is a new function on
   * every parent render — as a dependency it re-fetched the session (and reset the
   * scroll and the streaming buffer) several times a second during a turn.
   */
  const gone = useRef(onGone);
  gone.current = onGone;

  useEffect(() => {
    let cancelled = false;
    agentApi
      .get(agentKey)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setStreaming(d.streaming);
      })
      .catch(() => gone.current?.());
    return () => {
      cancelled = true;
    };
  }, [agentKey]);

  useEffect(() => {
    const unsubscribe = agentBus.subscribe((e) => {
      if (e.type === "agents") {
        const mine = e.agents.find((a) => a.key === agentKey);
        if (mine) setData((d) => (d ? { ...d, ...mine } : d));
        return;
      }
      if (e.key !== agentKey) return;
      if (e.type === "agent-delta") setStreaming((s) => s + e.text);
      else if (e.type === "agent-models") setData((d) => (d ? { ...d, models: e.models } : d));
      else if (e.type === "agent-commands")
        setData((d) => (d ? { ...d, commands: e.commands } : d));
      else if (e.type === "agent-tasks") setData((d) => (d ? { ...d, tasks: e.tasks } : d));
      else if (e.type === "agent-item") {
        setStreaming("");
        setData((d) => {
          if (!d) return d;
          const timeline = e.replace
            ? d.timeline.map((i) => (sameItem(i, e.item) ? e.item : i))
            : [...d.timeline, e.item];
          return { ...d, timeline };
        });
      }
    });
    return () => {
      unsubscribe();
    };
  }, [agentKey]);

  // Opening a long session lands on the newest turn, without an animation.
  useJumpToEnd(scroller, !!data, agentKey);

  // After that, follow the tail only while the reader is still at the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [data?.timeline.length, streaming]);

  const edges = useScrollEdges(scroller, data?.timeline.length);
  const hideTools = settings?.ui.hideToolCalls ?? false;

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  /**
   * Text offered by another panel — currently the git panel's review comments. It
   * lands in the draft rather than being sent, so it can be read and edited first,
   * and appends rather than replaces so a half-typed message isn't destroyed.
   */
  useEffect(
    () =>
      onCompose(agentKey, ({ text, commentIds }) => {
        setDraft((prev) => (prev.trim() ? `${prev.replace(/\s+$/, "")}\n\n${text}` : text));
        pendingComments.current = [...new Set([...pendingComments.current, ...commentIds])];
        setPicking(false);
        // Put the cursor at the end of what was just inserted, ready to edit.
        requestAnimationFrame(() => {
          const el = box.current;
          if (!el) return;
          el.focus();
          el.selectionStart = el.selectionEnd = el.value.length;
          el.scrollIntoView({ block: "nearest" });
        });
      }),
    [agentKey],
  );

  const send = async () => {
    const text = draft.trim();
    // An image on its own is a real message — "what is this?" with a screenshot.
    if (!text && attached.length === 0) return;
    const seen = pendingComments.current;
    const images = attached.map((a) => ({ mediaType: a.mediaType, data: a.data }));
    pendingComments.current = [];
    setDraft("");
    setAttached([]);
    setPicking(true);
    await agentApi.message(agentKey, text, images).catch((e: Error) => setNote(e.message));
    // Only now have these actually been put in front of Claude.
    if (seen.length) await commentApi.markSent(seen).catch(() => {});
  };

  /**
   * Take images off a paste or a drop. Anything that isn't an image is left
   * alone, so pasting text (or a screenshot *and* a caption) still behaves.
   */
  const absorbFiles = async (files: File[]): Promise<boolean> => {
    const images = files.filter((f) => IMAGE_TYPES.includes(f.type as ImageMediaType));
    if (images.length === 0) return false;

    const read = await Promise.all(
      images.map(
        (file) =>
          new Promise<Attachment | null>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              // FileReader gives "data:<type>;base64,<data>" — the API wants the tail.
              const url = String(reader.result ?? "");
              const data = url.slice(url.indexOf(",") + 1);
              resolve(
                data
                  ? {
                      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                      mediaType: file.type as ImageMediaType,
                      data,
                      previewUrl: url,
                      bytes: file.size,
                    }
                  : null,
              );
            };
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(file);
          }),
      ),
    );

    const ok = read.filter((a): a is Attachment => a !== null);
    if (ok.length === 0) {
      setNote("Could not read that image.");
      return true;
    }

    setAttached((prev) => {
      const next = [...prev, ...ok].slice(0, MAX_ATTACHMENTS);
      if (prev.length + ok.length > MAX_ATTACHMENTS) {
        setNote(`Up to ${MAX_ATTACHMENTS} images per message.`);
      }
      // Markers are numbered by final position, so they match what the model gets.
      const markers = next
        .slice(prev.length)
        .map((_, i) => `[Image #${prev.length + i + 1}]`)
        .join(" ");
      if (markers) setDraft((d) => (d ? `${d.replace(/\s+$/, "")} ${markers} ` : `${markers} `));
      return next;
    });
    return true;
  };

  const removeAttachment = (id: string) => {
    setAttached((prev) => {
      const idx = prev.findIndex((a) => a.id === id);
      if (idx < 0) return prev;
      const next = prev.filter((a) => a.id !== id);
      // Renumber the markers so they keep matching the images actually attached.
      setDraft((d) => {
        const stripped = d.replace(new RegExp(`\\[Image #${idx + 1}\\]\\s*`), "");
        return stripped.replace(/\[Image #(\d+)\]/g, (_m, n) =>
          Number(n) > idx + 1 ? `[Image #${Number(n) - 1}]` : `[Image #${n}]`,
        );
      });
      return next;
    });
  };

  // The picker only applies to a lone "/word" on the first line: past that the
  // command is chosen and the rest of the message is its arguments.
  const typed = /^\/([\w:-]*)$/.exec(draft);
  const matches =
    picking && typed && data?.commands
      ? data.commands
          .filter((c) => c.name.toLowerCase().includes(typed[1].toLowerCase()))
          .slice(0, 8)
      : [];

  const complete = (c: { name: string; argumentHint?: string }) => {
    // Commands that take arguments keep the cursor on the same line; the rest are
    // ready to send as they are.
    setDraft(`/${c.name} `);
    setPicking(false);
    box.current?.focus();
  };

  if (!data) return <div className="empty">Loading session…</div>;

  const tasks = data.tasks ?? [];
  const running = tasks.filter((t) => t.status === "running" || t.status === "pending");
  const finishedTasks = tasks.filter((t) => t.status !== "running" && t.status !== "pending");
  // Running first, and a finished agent stays visible while you are reading it.
  const shownTasks =
    showFinished || finishedTasks.length === 0
      ? [...running, ...finishedTasks]
      : [...running, ...finishedTasks.filter((t) => t.taskId === tab)];
  const openTask = tab ? tasks.find((t) => t.taskId === tab) : null;
  // Items are tagged with the Task tool_use id, which a task only learns once the
  // CLI reports it — until then its tab shows its report and status instead.
  const inTab = tab
    ? data.timeline.filter((i) => i.agentId && i.agentId === openTask?.toolUseId)
    : data.timeline.filter((i) => !i.agentId);
  // A pending permission is never hidden: it is the one item that blocks progress.
  const visible = hideTools
    ? inTab.filter(
        (i) =>
          i.kind !== "tool" &&
          i.kind !== "thinking" &&
          !(i.kind === "permission" && i.decision !== null),
      )
    : inTab;
  const hiddenCount = inTab.length - visible.length;

  const busy = data.status === "thinking" || data.status === "starting";
  const ended = data.status === "ended" || data.status === "error";
  const waiting = data.timeline.filter(
    (i): i is Extract<TimelineItem, { kind: "permission" }> =>
      i.kind === "permission" && i.decision === null,
  ).length;

  return (
    <>
      <div className="live-controls">
        <ModelPicker
          value={data.model}
          models={data.models}
          disabled={ended}
          onChange={(m) => {
            setNote(null);
            agentApi.model(agentKey, m).catch((err: Error) => setNote(err.message));
          }}
        />
        <span className="select-wrap small">
          <select
            className="mini-select select"
            value={data.permissionMode}
            // A rejected switch has to say so: the select would otherwise snap
            // back to the old value with no explanation.
            onChange={(e) => {
              setNote(null);
              agentApi
                .mode(agentKey, e.target.value as PermissionMode)
                .catch((err: Error) => setNote(err.message));
            }}
            disabled={ended}
            title={MODE_HELP[data.permissionMode] ?? "Permission mode"}
          >
            {MODES.map((m) => (
              <option key={m} value={m} title={MODE_HELP[m]}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </select>
        </span>
        <label className="check" title="Hide tool calls and thinking, keeping the conversation">
          <input
            type="checkbox"
            checked={hideTools}
            onChange={(e) =>
              settingsApi
                .save({ ui: { hideToolCalls: e.target.checked } })
                .then((r) => onSettings?.(r.settings))
                .catch(() => {})
            }
          />
          Hide tools
        </label>
        <span style={{ flex: 1 }} />
        {waiting > 0 && <span className="chat-pending">{waiting} waiting on you</span>}
        {busy ? (
          <button className="icon-btn" onClick={() => agentApi.interrupt(agentKey).catch(() => {})}>
            Stop
          </button>
        ) : (
          <button
            className="icon-btn"
            onClick={async () => {
              await agentApi.stop(agentKey).catch(() => {});
              if (ended) onGone?.();
            }}
            title={ended ? "Remove from the live list" : "End this session"}
          >
            {ended ? "Remove" : "End"}
          </button>
        )}
      </div>

      {note && <div className="control-note">{note}</div>}

      {tasks.length > 0 && (
        <div className="agent-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === null}
            className={`agent-tab main ${tab === null ? "active" : ""}`}
            onClick={() => setTab(null)}
          >
            <span className="agent-tab-name">Main</span>
            <span className="agent-tab-sub">{tasks.length} agents</span>
          </button>
          {shownTasks.map((t) => (
            <AgentTab
              key={t.taskId}
              task={t}
              active={tab === t.taskId}
              onSelect={() => setTab(t.taskId)}
            />
          ))}
          {/* Finished agents are kept — their reports are the useful part — but a
              long run would otherwise bury the ones still working. */}
          {finishedTasks.length > 0 && (
            <button
              className="link-btn inline agent-tabs-more"
              onClick={() => setShowFinished(!showFinished)}
            >
              {showFinished
                ? `hide ${finishedTasks.length} finished`
                : `+ ${finishedTasks.length} finished`}
            </button>
          )}
        </div>
      )}

      <div className="chat-scroll-wrap">
      <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
        {visible.map((item, n) => (
          <Item
            key={n}
            item={item}
            agentKey={agentKey}
            onOpenAgent={(id) => setTab(id)}
            // The Task card links to the tab whose messages it owns.
            taskIdFor={
              item.kind === "tool"
                ? (tasks.find((t) => t.toolUseId === item.id)?.taskId ?? null)
                : null
            }
          />
        ))}
        {openTask && (
          <div className="agent-report">
            <div className="agent-report-head">
              {openTask.subagentType ?? "subagent"} · {openTask.status}
              {openTask.toolUses > 0 && ` · ${openTask.toolUses} tools`}
              {openTask.tokens > 0 && ` · ${Math.round(openTask.tokens / 1000)}k tokens`}
              {openTask.durationMs > 0 && ` · ${(openTask.durationMs / 1000).toFixed(1)}s`}
            </div>
            {openTask.activity && openTask.status === "running" && (
              <div className="agent-report-activity">{openTask.activity}</div>
            )}
            {openTask.report ? (
              <Markdown text={openTask.report} />
            ) : (
              inTab.length === 0 && (
                <div className="hint">
                  {openTask.status === "running"
                    ? "This agent has not reported anything yet."
                    : "This agent produced no forwarded output."}
                </div>
              )
            )}
          </div>
        )}
        {hiddenCount > 0 && (
          <div className="chat-hidden-note">
            {hiddenCount} tool call{hiddenCount === 1 ? "" : "s"} hidden
          </div>
        )}
        {streaming && tab === null && (
          <div className="turn assistant">
            <div className="turn-head">
              <span className="turn-who">Claude</span>
            </div>
            <Markdown text={streaming} />
          </div>
        )}
        {busy && !streaming && tab === null && <div className="chat-working">working…</div>}
      </div>
      <ScrollJump target={scroller} {...edges} />
      </div>

      {ended && (
        <div className="ended-note">
          <strong>Session ended</strong>
          {data.endedReason ? ` — ${data.endedReason}.` : "."} Its transcript is kept, so you can
          resume the conversation from the Live tab.
          {data.stderr && (
            <details className="tool" style={{ marginTop: 8 }}>
              <summary>
                <span className="tool-name">process output</span>
              </summary>
              <pre>{data.stderr}</pre>
            </details>
          )}
        </div>
      )}

      <div className="composer-wrap">
        {/* Standing in for the TUI's /skills browser, which cannot exist here:
            these are the commands the session itself reports as available. */}
        {matches.length > 0 && (
          <div className="cmd-menu">
            {matches.map((c, n) => (
              <button
                key={c.name}
                className={`cmd-option ${n === highlight ? "active" : ""}`}
                onMouseEnter={() => setHighlight(n)}
                onClick={() => complete(c)}
              >
                <span className="cmd-option-name">/{c.name}</span>
                {c.argumentHint && <span className="cmd-option-hint">{c.argumentHint}</span>}
                <span className="cmd-option-desc">{c.description}</span>
              </button>
            ))}
          </div>
        )}

        {attached.length > 0 && (
          <div className="attach-strip">
            {attached.map((a, i) => (
              <div className="attach-chip" key={a.id}>
                <img src={a.previewUrl} alt="" />
                <span className="attach-label">Image #{i + 1}</span>
                <span className="attach-size">{fmtBytes(a.bytes)}</span>
                <button
                  className="attach-x"
                  aria-label={`Remove image ${i + 1}`}
                  onClick={() => removeAttachment(a.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="composer">
          <textarea
            ref={box}
            className="composer-box"
            rows={3}
            value={draft}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              // Only swallow the paste when it actually carried an image, so
              // pasting text (or a screenshot with a caption) is unaffected.
              if (files.length === 0) return;
              void absorbFiles(files).then((took) => took && setNote(null));
              if (files.some((f) => IMAGE_TYPES.includes(f.type as ImageMediaType))) {
                e.preventDefault();
              }
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("Files")) e.preventDefault();
            }}
            onDrop={(e) => {
              const files = Array.from(e.dataTransfer.files);
              if (files.length === 0) return;
              e.preventDefault();
              void absorbFiles(files);
            }}
            placeholder={
              ended ? "This session has ended." : "Message Claude…  (↵ to send, ⇧↵ for a new line)"
            }
            disabled={ended}
            onChange={(e) => {
              setDraft(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={(e) => {
              if (matches.length > 0) {
                if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
                  e.preventDefault();
                  setHighlight((h) => (h + 1) % matches.length);
                  return;
                }
                if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
                  e.preventDefault();
                  setHighlight((h) => (h - 1 + matches.length) % matches.length);
                  return;
                }
                if (e.key === "Escape") {
                  setPicking(false);
                  return;
                }
                // Enter accepts the highlighted command rather than sending a
                // half-typed one.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  complete(matches[highlight]);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {/* No send button: ↵ sends, and the placeholder says so. */}
        </div>
      </div>
      {data.error && <div className="chat-error">{data.error}</div>}
    </>
  );
}

function ModelPicker({
  value,
  models,
  disabled,
  onChange,
}: {
  value: string | null;
  models: ModelInfo[] | null;
  disabled: boolean;
  onChange: (model: string) => void;
}) {
  const list = models ?? [];
  // The running model is often an explicit id ('claude-opus-5[1m]') that matches
  // no alias row, so it needs its own entry or the select would look unset.
  const missing = value && !list.some((m) => m.value === value);
  return (
    <span className="select-wrap small">
      <select
      className="mini-select select"
      value={value ?? "default"}
      disabled={disabled}
      title="Model"
      onChange={(e) => onChange(e.target.value)}
    >
      {list.map((m) => (
        <option key={m.value} value={m.value}>
          {m.displayName}
        </option>
      ))}
      {missing && <option value={value}>{value}</option>}
      </select>
    </span>
  );
}

/** Identity for in-place updates: tool results and answered permissions. */
function sameItem(a: TimelineItem, b: TimelineItem): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "tool" && b.kind === "tool") return a.id === b.id;
  if (a.kind === "permission" && b.kind === "permission") return a.requestId === b.requestId;
  return false;
}

function Item({
  item,
  agentKey,
  onOpenAgent,
  taskIdFor,
}: {
  item: TimelineItem;
  agentKey: string;
  onOpenAgent?: (taskId: string) => void;
  taskIdFor?: string | null;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className={`turn user ${item.queued ? "queued" : ""}`}>
          <div className="turn-head">
            <span className="turn-who">You</span>
            <time>{new Date(item.ts).toLocaleTimeString()}</time>
            {item.queued && <span className="queued-chip">queued</span>}
          </div>
          <div className="turn-plain">{item.text}</div>
          {item.images && item.images.length > 0 && <Attachments images={item.images} />}
        </div>
      );

    case "assistant":
      return (
        <div className="turn assistant">
          <div className="turn-head">
            <span className="turn-who">Claude</span>
            <time>{new Date(item.ts).toLocaleTimeString()}</time>
          </div>
          <Markdown text={item.text} />
        </div>
      );

    case "thinking":
      return (
        <details className="tool thinking">
          <summary>
            <span className="tool-name">thinking</span>
          </summary>
          <pre>{item.text}</pre>
        </details>
      );

    case "tool":
      return (
        <details className={`tool ${item.ok === false ? "failed" : ""}`}>
          <summary>
            <span className="tool-name">{item.name}</span>
            <span className="tool-arg">{toolSummary("", item.input).replace(/^ · /, "")}</span>
            {/* A Task call has a whole conversation behind it; offer the way in. */}
            {taskIdFor && onOpenAgent && (
              <button
                className="link-btn inline"
                onClick={(e) => {
                  e.preventDefault();
                  onOpenAgent(taskIdFor);
                }}
              >
                open agent →
              </button>
            )}
            {item.ok === false && <span className="tool-bad">failed</span>}
          </summary>
          {/* The arguments are JSON; colouring them makes a long Bash command or
              a Write payload scannable. */}
          <pre>{highlight(JSON.stringify(item.input, null, 2), "json")}</pre>
          {item.result !== undefined && <pre className="tool-result">{item.result}</pre>}
        </details>
      );

    case "permission":
      return <Permission item={item} agentKey={agentKey} />;

    case "result":
      return (
        <div className="chat-result">
          {item.error ? `ended: ${item.error}` : "done"}
          {item.costUsd !== null && ` · ${fmtUsd(item.costUsd)}`}
          {item.durationMs !== null && ` · ${(item.durationMs / 1000).toFixed(1)}s`}
        </div>
      );

    case "error":
      return <div className="chat-error">{item.text}</div>;
  }
}

/** The shape AskUserQuestion puts in its input; only what the UI needs to render. */
type AskQuestion = {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};

function askQuestions(input: unknown): AskQuestion[] | null {
  if (!input || typeof input !== "object") return null;
  const qs = (input as { questions?: unknown }).questions;
  if (!Array.isArray(qs) || qs.length === 0) return null;
  const parsed = qs.filter(
    (q): q is AskQuestion =>
      !!q && typeof (q as AskQuestion).question === "string" && Array.isArray((q as AskQuestion).options),
  );
  return parsed.length > 0 ? parsed : null;
}

/**
 * AskUserQuestion's picker.
 *
 * This tool is answered through the permission step rather than after it: the host
 * collects the choices and hands them back as part of the tool's own input. Without
 * a UI here the prompt could only be allowed — and allowing it with no answers is
 * what produced "the user did not answer the questions" a few seconds later.
 *
 * "Other" is offered on every question because the tool's own description promises
 * it, and a free-text answer is often the real one.
 */
function AskQuestions({
  questions,
  busy,
  onSubmit,
  onSkip,
}: {
  questions: AskQuestion[];
  busy: boolean;
  onSubmit: (answers: Record<string, string>) => void;
  onSkip: () => void;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  const choose = (q: AskQuestion, label: string) =>
    setPicked((prev) => {
      const current = prev[q.question] ?? [];
      if (!q.multiSelect) return { ...prev, [q.question]: [label] };
      return {
        ...prev,
        [q.question]: current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label],
      };
    });

  /** Free text wins when present: typing it is a clearer signal than a stale chip. */
  const answerFor = (q: AskQuestion): string => {
    const typed = other[q.question]?.trim();
    if (typed) return typed;
    return (picked[q.question] ?? []).join(", ");
  };

  const ready = questions.every((q) => answerFor(q).length > 0);

  return (
    <div className="ask">
      {questions.map((q) => (
        <div className="ask-q" key={q.question}>
          <div className="ask-head">
            <span className="chip">{q.header}</span>
            {q.multiSelect && <span className="ask-multi">pick any</span>}
          </div>
          <div className="ask-question">{q.question}</div>
          <div className="ask-options">
            {q.options.map((o) => {
              const on = (picked[q.question] ?? []).includes(o.label);
              return (
                <button
                  key={o.label}
                  className={`ask-option ${on ? "on" : ""}`}
                  disabled={busy}
                  aria-pressed={on}
                  onClick={() => choose(q, o.label)}
                >
                  <span className="ask-option-label">{o.label}</span>
                  {o.description && <span className="ask-option-desc">{o.description}</span>}
                </button>
              );
            })}
          </div>
          <input
            className="search ask-other"
            placeholder="Other — type your own answer…"
            value={other[q.question] ?? ""}
            disabled={busy}
            onChange={(e) => setOther((prev) => ({ ...prev, [q.question]: e.target.value }))}
          />
        </div>
      ))}
      <div className="perm-actions">
        <button
          className="icon-btn primary"
          disabled={busy || !ready}
          onClick={() =>
            onSubmit(Object.fromEntries(questions.map((q) => [q.question, answerFor(q)])))
          }
        >
          {questions.length > 1 ? "Send answers" : "Send answer"}
        </button>
        <button className="icon-btn" disabled={busy} onClick={onSkip}>
          Skip
        </button>
      </div>
    </div>
  );
}

function Permission({
  item,
  agentKey,
}: {
  item: Extract<TimelineItem, { kind: "permission" }>;
  agentKey: string;
}) {
  const [busy, setBusy] = useState(false);
  const answer = async (
    behavior: "allow" | "allowAlways" | "deny",
    answers?: Record<string, string>,
  ) => {
    setBusy(true);
    await agentApi.permission(agentKey, item.requestId, behavior, answers).catch(() => {});
    setBusy(false);
  };

  if (item.decision) {
    return (
      <div className={`perm answered ${item.decision === "deny" ? "denied" : ""}`}>
        {item.decision === "deny"
          ? "Denied"
          : item.decision === "allowAlways"
            ? "Allowed always"
            : "Allowed"}
        {" · "}
        {item.toolName}
      </div>
    );
  }

  // A question is not a permission request in any useful sense, so it does not get
  // the allow/deny framing — it gets the picker and a Skip.
  const questions = item.toolName === "AskUserQuestion" ? askQuestions(item.input) : null;
  if (questions) {
    return (
      <div className="perm perm-ask">
        <div className="perm-title">Claude is asking</div>
        <AskQuestions
          questions={questions}
          busy={busy}
          onSubmit={(answers) => void answer("allow", answers)}
          onSkip={() => void answer("deny")}
        />
      </div>
    );
  }

  return (
    <div className="perm">
      <div className="perm-title">{item.title ?? `Claude wants to use ${item.toolName}`}</div>
      {item.description && <div className="perm-desc">{item.description}</div>}
      <pre className="perm-input">{toolSummary(item.toolName, item.input)}</pre>
      <div className="perm-actions">
        <button className="icon-btn primary" disabled={busy} onClick={() => answer("allow")}>
          Allow once
        </button>
        <button className="icon-btn" disabled={busy} onClick={() => answer("allowAlways")}>
          Allow always
        </button>
        <button className="icon-btn danger" disabled={busy} onClick={() => answer("deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}

/**
 * One subagent's tab. The progress summary is the useful part — it says what the
 * agent is doing right now, without opening it.
 */
function AgentTab({
  task,
  active,
  onSelect,
}: {
  task: TaskInfo;
  active: boolean;
  onSelect: () => void;
}) {
  const running = task.status === "running";
  return (
    <button
      role="tab"
      aria-selected={active}
      className={`agent-tab ${active ? "active" : ""} ${running ? "running" : task.status}`}
      onClick={onSelect}
      title={[
        task.subagentType,
        oneLine(task.activity),
        task.lastTool && `last tool: ${task.lastTool}`,
        task.status,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <span className="agent-tab-top">
        <i className="dot" />
        <span className="agent-tab-name">{task.name}</span>
      </span>
      <span className="agent-tab-sub">
        {oneLine(task.activity) ?? task.subagentType ?? (running ? "working…" : task.status)}
      </span>
    </button>
  );
}

/**
 * A tab subtitle has one line. Progress descriptions are short, but a report can
 * be several paragraphs of markdown, so strip and clip whatever arrives.
 */
function oneLine(text: string | null): string | null {
  if (!text) return null;
  const flat = text
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat ? (flat.length > 64 ? `${flat.slice(0, 64)}…` : flat) : null;
}
