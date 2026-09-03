import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  agentApi,
  agentBus,
  api,
  commentApi,
  fileApi,
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
import { ClipIcon } from "./Icons.tsx";
import { onCompose } from "./compose.ts";
import { loadAttachments, loadDraft, saveAttachments, saveDraft } from "./drafts.ts";
import {
  atTokenAt,
  COLLAPSE_LINES,
  expandPastes,
  insertAtCaret,
  pasteMarker,
  tokenizeComposer,
} from "./composerTokens.ts";
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

/**
 * The "/word" being typed at the caret, wherever that is in the message.
 *
 * The picker used to be anchored to the entire draft (`^/word$`), so a command could
 * only ever be the whole message — naming a skill partway through a sentence ("take
 * a look with /abel-order") silently did nothing. The leading word boundary is what
 * keeps it from firing inside `src/components`, a URL, or a closed fraction.
 *
 * Returns the token's start index as well, because completing it has to replace just
 * that slice and leave the words either side of it alone.
 */
export function slashTokenAt(
  draft: string,
  caret: number,
): { word: string; start: number } | null {
  const at = /(?:^|\s)\/([\w:-]*)$/.exec(draft.slice(0, caret));
  return at ? { word: at[1], start: caret - at[1].length - 1 } : null;
}

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
  // Restored, not reset: closing a session must not throw away what you typed in it.
  const [draft, setDraft] = useState(() => loadDraft(agentKey));
  /**
   * Where the caret is, so a "/" mid-message can be recognised as one. Seeded to the
   * end of a restored draft: left at 0 it claimed the caret was at the start of text
   * the cursor was actually sitting after, which suppressed the picker and let Enter
   * send instead.
   */
  const [caret, setCaret] = useState(() => loadDraft(agentKey).length);
  /**
   * How far back through your own prompts ArrowUp has walked. -1 is "not walking",
   * which is what typing anything returns it to — otherwise the next ArrowUp would
   * carry on from a position that no longer relates to what is in the box.
   */
  const [histAt, setHistAt] = useState(-1);
  const histDraft = useRef("");
  /** Repo files matching the `@fragment` at the caret. */
  const [fileHits, setFileHits] = useState<{ name: string; path: string; dir: boolean }[]>([]);
  /**
   * Pasted images, held until send. The draft carries a matching `[Image #N]`
   * marker so the text you typed reads the way the model will see it, the same
   * as the terminal — the bytes never go in the textarea.
   */
  const [attached, setAttached] = useState<Attachment[]>(() => loadAttachments<Attachment>(agentKey));
  const [highlight, setHighlight] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  /**
   * Which token's menu you dismissed, as "kind:index" — not a boolean.
   *
   * A flag had to be turned back *on* by something, and the only thing that knows a
   * new token appeared is the render itself; flipping it from an effect happens a
   * commit later, so everything derived from it lagged by a frame and the fetch
   * raced against it. Comparing the current token against the dismissed one is
   * decided during the same render, so there is nothing to race.
   */
  const [dismissed, setDismissed] = useState<string | null>(null);
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
  const mirror = useRef<HTMLDivElement | null>(null);
  const filePick = useRef<HTMLInputElement | null>(null);
  /**
   * The real text behind each `[Pasted text #N]` marker, by number. A ref rather than
   * state: it is never rendered, and re-rendering the composer on a paste of 400
   * lines is exactly what collapsing them is meant to avoid.
   */
  const pastes = useRef(new Map<number, string>());
  const pasteSeq = useRef(0);
  /**
   * Paths this composer put in the box, from an `@` completion or a pasted file.
   * State rather than a ref: the mirror re-renders off it.
   */
  const [refPaths, setRefPaths] = useState<string[]>([]);
  /** The token under the pointer, and where to hang its tooltip. */
  const [hover, setHover] = useState<{ label: string; left: number; top: number } | null>(null);
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
        setDismissed(null);
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

  /**
   * Grow with the content instead of sitting at three rows with a scrollbar. Capped
   * at 40% of the viewport so a pasted essay cannot push the conversation off screen,
   * and the height is reset before measuring or scrollHeight only ever grows.
   */
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [draft]);

  useEffect(() => saveDraft(agentKey, draft), [agentKey, draft]);
  useEffect(() => saveAttachments(agentKey, attached), [agentKey, attached]);
  /**
   * The same pane can be pointed at another session without unmounting, so the
   * draft has to follow the key rather than only the mount.
   */
  const shownKey = useRef(agentKey);
  useEffect(() => {
    if (shownKey.current === agentKey) return;
    shownKey.current = agentKey;
    const restored = loadDraft(agentKey);
    setDraft(restored);
    setCaret(restored.length);
    setAttached(loadAttachments<Attachment>(agentKey));
  }, [agentKey]);

  const send = async () => {
    // What the model gets is the full text, not the collapsed view of it.
    const text = expandPastes(draft, pastes.current).trim();
    // An image on its own is a real message — "what is this?" with a screenshot.
    if (!text && attached.length === 0) return;
    const seen = pendingComments.current;
    const images = attached.map((a) => ({ mediaType: a.mediaType, data: a.data }));
    pendingComments.current = [];
    pastes.current = new Map();
    setRefPaths([]);
    setDraft("");
    setAttached([]);
    setDismissed(null);
    await agentApi.message(agentKey, text, images).catch((e: Error) => setNote(e.message));
    // Only now have these actually been put in front of Claude.
    if (seen.length) await commentApi.markSent(seen).catch(() => {});
  };

  /**
   * Insert a path for every non-image file pasted or dropped in.
   *
   * This is the browser's version of what the CLI does when you paste a file into
   * it, and it has to work differently: a `File` from a clipboard carries a name and
   * bytes but never a path, so there is nothing to insert until the bytes have been
   * stored somewhere the session can reach. The daemon keeps them and answers with
   * the path — which is also what makes this work with the dashboard open on a
   * different machine from the sessions.
   */
  const stashFiles = async (files: File[]): Promise<boolean> => {
    const stored = await Promise.all(
      files.map((f) =>
        api
          .stashFile(f)
          .then((r) => r.path)
          .catch((e: Error) => {
            setNote(`${f.name}: ${e.message}`);
            return null;
          }),
      ),
    );
    const paths = stored.filter((p): p is string => p !== null);
    if (paths.length === 0) return files.length > 0;
    setRefPaths((prev) => [...prev, ...paths]);
    // Inserted at the caret, like any other paste: the path usually belongs in the
    // middle of a sentence ("have a look at <path> and tell me…").
    setDraft((d) => {
      const { text, caret: pos } = insertAtCaret(d, caret, paths.join(" "));
      requestAnimationFrame(() => {
        const el = box.current;
        if (!el) return;
        el.focus();
        el.selectionStart = el.selectionEnd = pos;
        setCaret(pos);
      });
      return text;
    });
    setNote(
      paths.length === 1
        ? `Stored ${files[0].name} — the session can read it at that path.`
        : `Stored ${paths.length} files — the session can read them at those paths.`,
    );
    return true;
  };

  /**
   * Take images off a paste or a drop, and turn anything else into a path. Text
   * pasted as text is left alone, so pasting a screenshot *and* a caption still
   * behaves.
   */
  const absorbFiles = async (files: File[]): Promise<boolean> => {
    const images = files.filter((f) => IMAGE_TYPES.includes(f.type as ImageMediaType));
    const others = files.filter((f) => !IMAGE_TYPES.includes(f.type as ImageMediaType));
    if (others.length > 0) {
      const took = await stashFiles(others);
      if (images.length === 0) return took;
    }

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

  const slashTok = slashTokenAt(draft, caret);
  const atTok = atTokenAt(draft, caret);
  /** Identity of the token at the caret: its kind and where it starts. */
  const tokenId = slashTok ? `/:${slashTok.start}` : atTok ? `@:${atTok.start}` : null;
  const open = tokenId !== null && tokenId !== dismissed;
  const typed = open ? slashTok : null;
  const atToken = open ? atTok : null;
  const files = atToken ? fileHits : [];
  const matches =
    typed && data?.commands
      ? data.commands
          .filter((c) => c.name.toLowerCase().includes(typed.word.toLowerCase()))
          .slice(0, 8)
      : [];

  /**
   * Only commands the session itself reports are highlighted, so the mark answers
   * "is this a real skill" instead of lighting up every slash.
   */
  const knownCommands = useMemo(
    () => new Set((data?.commands ?? []).map((c) => c.name)),
    [data?.commands],
  );

  /**
   * Your own prompts in this session, newest first. Read off the timeline rather than
   * kept separately, so it survives a reload and matches what the transcript shows —
   * including the ones sent from the terminal side of the same session.
   */
  const history = useMemo(
    () =>
      (data?.timeline ?? [])
        .filter((i): i is Extract<TimelineItem, { kind: "user" }> => i.kind === "user")
        .map((i) => i.text)
        .filter((t) => t.trim())
        .reverse(),
    [data?.timeline],
  );

  /** ArrowUp walks back, ArrowDown forward, and stepping past the end restores the
   *  draft you were writing before you started walking. */
  const recall = (delta: number) => {
    if (history.length === 0) return false;
    const next = histAt + delta;
    if (next < -1 || next >= history.length) return false;
    if (histAt === -1) histDraft.current = draft;
    const text = next === -1 ? histDraft.current : history[next];
    setHistAt(next);
    setDraft(text);
    setDismissed(null);
    requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = text.length;
      setCaret(text.length);
    });
    return true;
  };

  /**
   * Files for the `@` picker, from the repository the session is working in.
   *
   * Debounced and guarded by a token check on the way back: a slower response for
   * "@ap" must not replace the results for "@api", which is what makes the list
   * jump around while you type.
   */
  /**
   * Keyed to the token being looked up and to whether its menu is open.
   *
   * `open` is computed in the same render as the token that opens the menu, so this
   * fires the moment there is something to look up — and again if the menu is
   * dismissed and reopened, which is cheap: one debounced, idempotent request.
   */
  const atWord = atTok?.word ?? null;
  const cwd = data?.cwd ?? null;
  useEffect(() => {
    if (!open || atWord === null || !cwd) {
      setFileHits([]);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      /**
       * Two ways to find a file, picked by whether the fragment has a slash in it.
       *
       * A bare word searches the whole repository, which is how you find something
       * you only know the name of. Once there is a slash the fragment is read as a
       * directory plus a filter, so `@src/comp` lists what is inside `src` — that is
       * what makes descending through folders possible at all, rather than only ever
       * matching leaf names.
       */
      const cut = atWord.lastIndexOf("/");
      const dir = cut >= 0 ? atWord.slice(0, cut) : null;
      const tail = (cut >= 0 ? atWord.slice(cut + 1) : atWord).toLowerCase();
      const req = dir === null && tail ? { q: tail } : { path: dir ?? "" };
      fileApi
        .browse(cwd, req)
        .then((r) => {
          if (stale) return;
          const hits = r.entries
            // A listing needs filtering by the typed tail; a search already is.
            .filter((e) => (req.q ? true : e.name.toLowerCase().includes(tail)))
            // Folders first: they are the thing you are passing through, and
            // burying them under files makes descending feel impossible.
            .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
          setFileHits(hits.slice(0, 8));
        })
        .catch(() => !stale && setFileHits([]));
    }, 120);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [atWord, cwd, open]);

  /**
   * Put the chosen entry in place of the `@fragment` that opened the picker.
   *
   * A folder is not an answer, so choosing one keeps the `@` and the trailing slash
   * and leaves the picker open — the next fetch lists what is inside it. Only a file
   * closes the menu, and only a file drops the `@`, since what the model wants is a
   * plain path.
   */
  const completeFile = (entry: { path: string; dir: boolean }) => {
    if (!atToken) return;
    const rest = draft.slice(caret);
    // The `@` stays on a finished reference too, not just while descending: it is
    // what marks the path as something you pointed at rather than typed, and
    // dropping it made a completed reference indistinguishable from prose.
    const insert = entry.dir ? `@${entry.path}/` : `@${entry.path}`;
    const sep = entry.dir || /^\s/.test(rest) ? "" : " ";
    const next = `${draft.slice(0, atToken.start)}${insert}${sep}${rest}`;
    const pos = atToken.start + insert.length + sep.length;
    if (!entry.dir) {
      setRefPaths((prev) => [...prev, entry.path]);
      setDismissed(tokenId);
    }
    setHighlight(0);
    setDraft(next);
    requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = pos;
      setCaret(pos);
    });
  };

  /**
   * What a hovered token should say about itself.
   *
   * Read off the same sources the highlight uses, so the tooltip can never disagree
   * with the colour: a marked command is one the session listed, and its description
   * is that session's own.
   */
  const describe = (kind: string, text: string): string => {
    if (kind === "cmd") {
      const cmd = (data?.commands ?? []).find((c) => c.name === text.slice(1));
      return cmd
        ? `${cmd.description}${cmd.argumentHint ? ` — takes ${cmd.argumentHint}` : ""}`
        : "skill";
    }
    if (kind === "path") {
      if (text.startsWith("@")) return "file reference — pick one from the list";
      return `file — ${text}`;
    }
    if (kind === "img") return "pasted image, attached to this message";
    if (kind === "paste") {
      const n = Number(/#(\d+)/.exec(text)?.[1]);
      const full = pastes.current.get(n);
      const lines = full ? full.split("\n").length : 0;
      return full
        ? `${lines} pasted lines — sent in full, collapsed here`
        : "collapsed paste";
    }
    return text;
  };

  /**
   * Hover detection by geometry rather than by pointer events.
   *
   * The mirror has to stay `pointer-events: none` or clicking a highlighted path
   * would no longer put the caret in it. But a mark's rectangles are readable
   * regardless of hit testing, so the pointer is tested against those instead —
   * which also handles a token that wraps across two lines, since it has one
   * rectangle per line.
   */
  const trackHover = (e: { clientX: number; clientY: number }) => {
    const root = mirror.current;
    if (!root) return;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("mark[data-kind]"))) {
      for (const r of Array.from(el.getClientRects())) {
        if (e.clientX < r.left || e.clientX > r.right) continue;
        if (e.clientY < r.top || e.clientY > r.bottom) continue;
        const box = root.getBoundingClientRect();
        setHover({
          label: describe(el.dataset.kind ?? "", el.textContent ?? ""),
          left: r.left - box.left + r.width / 2,
          top: r.top - box.top,
        });
        return;
      }
    }
    setHover(null);
  };

  /**
   * A picker reopens when a token *appears* at the caret, or moves to a different
   * position — not on every keystroke inside one.
   *
   * That distinction is the whole behaviour: dismissing the menu for `@src` has to
   * survive typing the rest of `@src/api`, but completing a reference and then
   * deleting it has to offer the menu again, even though the new `@` lands at the
   * same index the old one did. Watching the token rather than the keys also means a
   * pasted "@" behaves like a typed one.
   */
  /**
   * Leaving a token behind clears the dismissal, so the next one starts fresh even
   * when it lands at the same index the dismissed one did — which is exactly what
   * happens when you delete a completed reference and type "@" again.
   */
  useEffect(() => {
    if (tokenId === null) setDismissed(null);
  }, [tokenId]);

  const syncCaret = (e: { target: EventTarget | null }) =>
    setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0);

  /** How many rows the open picker has, whichever picker that is. */
  const menuLen = matches.length || files.length;
  const accept = (n: number) => {
    if (matches.length) complete(matches[n]);
    else if (files.length) completeFile(files[n]);
  };

  const complete = (c: { name: string; argumentHint?: string }) => {
    if (!typed) return;
    // Only the token is replaced, so the words either side of it survive. The
    // trailing space both separates arguments and closes the picker — but not when
    // the text after the caret already starts with one, or completing mid-sentence
    // leaves a double space behind.
    const rest = draft.slice(caret);
    const sep = /^\s/.test(rest) ? "" : " ";
    const next = `${draft.slice(0, typed.start)}/${c.name}${sep}${rest}`;
    const pos = typed.start + c.name.length + 1 + sep.length;
    setDraft(next);
    setDismissed(tokenId);
    requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = pos;
      setCaret(pos);
    });
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
        {/* Files from the session's own repository. The same box as the command
            picker on purpose: one menu shape, whichever token opened it. */}
        {files.length > 0 && matches.length === 0 && (
          <div className="cmd-menu">
            {files.map((f, n) => (
              <button
                key={f.path}
                className={`cmd-option ${n === Math.min(highlight, files.length - 1) ? "active" : ""}`}
                onMouseEnter={() => setHighlight(n)}
                onClick={() => completeFile(f)}
              >
                <span className="cmd-option-name">
                  {f.name}
                  {f.dir ? "/" : ""}
                </span>
                {f.dir && <span className="cmd-option-hint">folder</span>}
                <span className="cmd-option-desc">{f.path}</span>
              </button>
            ))}
          </div>
        )}

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
          <div
            className="composer-field"
            onMouseMove={trackHover}
            onMouseLeave={() => setHover(null)}
          >
            {hover && (
              <div className="composer-tip" style={{ left: hover.left, top: hover.top }}>
                {hover.label}
              </div>
            )}
            {/* Behind the textarea, mirroring it character for character: the text
                here is transparent and only the token backgrounds show, so the real
                text — and its selection and caret — stay the textarea's own. */}
            <div className="composer-mirror" ref={mirror} aria-hidden="true">
              {tokenizeComposer(draft, knownCommands, refPaths).map((seg, i) =>
                seg.kind === "plain" ? (
                  <span key={i}>{seg.text}</span>
                ) : (
                  <mark key={i} className={`tok tok-${seg.kind}`} data-kind={seg.kind}>
                    {seg.text}
                  </mark>
                ),
              )}
              {/* A trailing newline renders no line box, so the mirror would come up
                  one line short of the textarea and scroll out of step. */}
              {draft.endsWith("\n") ? " " : ""}
            </div>
          <textarea
            ref={box}
            className="composer-box"
            rows={1}
            value={draft}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              // Only swallow the paste when it actually carried a file, so pasting
              // text (or a screenshot with a caption) is unaffected. Any file counts,
              // not just images: a spreadsheet becomes a path.
              if (files.length > 0) {
                e.preventDefault();
                void absorbFiles(files);
                return;
              }
              /**
               * A wall of pasted text becomes a chip. The message stays readable and
               * the model still receives every line — see expandPastes.
               */
              const text = e.clipboardData.getData("text/plain");
              const lines = text ? text.split("\n").length : 0;
              if (lines <= COLLAPSE_LINES) return;
              e.preventDefault();
              const n = ++pasteSeq.current;
              pastes.current.set(n, text);
              setDraft((d) => {
                const { text: next, caret: pos } = insertAtCaret(
                  d,
                  caret,
                  pasteMarker(n, lines),
                );
                requestAnimationFrame(() => {
                  const el = box.current;
                  if (!el) return;
                  el.focus();
                  el.selectionStart = el.selectionEnd = pos;
                  setCaret(pos);
                });
                return next;
              });
              setNote(`Collapsed ${lines} pasted lines — they are sent in full.`);
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
              ended
                ? "This session has ended."
                : busy
                  ? "Message Claude…  (↵ queues it for after this turn, esc stops)"
                  : "Message Claude…  (↵ to send, ⇧↵ for a new line, ↑ for the last one)"
            }
            disabled={ended}
            onChange={(e) => {
              const next = e.target.value;
              const pos = e.target.selectionStart ?? next.length;
              setDraft(next);
              setCaret(pos);
              setHighlight(0);
              setHistAt(-1);
            }}
            /**
             * Arrowing or clicking away from a "/word" has to close the picker, and
             * moving back onto one has to reopen it — so the caret is read from every
             * event that can move it, not just from typing. `select` alone is not
             * enough: browsers only guarantee it for an actual selection, not for a
             * collapsed caret walking with the arrow keys.
             */
            onSelect={syncCaret}
            onKeyUp={syncCaret}
            onClick={syncCaret}
            onFocus={syncCaret}
            onKeyDown={(e) => {
              /**
               * Escape has three jobs here, in this order: close the picker, stop a
               * running turn, then — only if neither applied — fall through to the
               * drawer's own listener and close the session. Interrupting is the one
               * you want mid-turn, and it used to be a button you had to aim at.
               */
              if (e.key === "Escape") {
                if (menuLen > 0) {
                  e.stopPropagation();
                  setDismissed(tokenId);
                  return;
                }
                if (busy) {
                  e.stopPropagation();
                  e.preventDefault();
                  setNote("Stopping…");
                  void agentApi
                    .interrupt(agentKey)
                    .then(() => setNote("Stopped."))
                    .catch((err: Error) => setNote(err.message));
                  return;
                }
                return;
              }
              /**
               * ArrowUp recalls the previous prompt, but only from an empty box or
               * while already walking the history — otherwise it would hijack moving
               * the caret up a line in a message you are still writing.
               */
              if (
                e.key === "ArrowUp" &&
                menuLen === 0 &&
                (histAt >= 0 || !draft.trim()) &&
                recall(1)
              ) {
                e.preventDefault();
                return;
              }
              if (e.key === "ArrowDown" && menuLen === 0 && histAt >= 0 && recall(-1)) {
                e.preventDefault();
                return;
              }
              if (menuLen > 0) {
                if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
                  e.preventDefault();
                  setHighlight((h) => (h + 1) % menuLen);
                  return;
                }
                if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
                  e.preventDefault();
                  setHighlight((h) => (h - 1 + menuLen) % menuLen);
                  return;
                }
                // Enter accepts the highlighted row rather than sending a
                // half-typed command or a bare "@".
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  accept(Math.min(highlight, menuLen - 1));
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            // The mirror is a separate scroll box, so it has to be dragged along
            // with the textarea or the pills lag behind the words on a long message.
            onScroll={(e) => {
              const el = mirror.current;
              if (el) el.scrollTop = (e.target as HTMLTextAreaElement).scrollTop;
            }}
          />
          <div className="composer-side">
            {/* Paste and drop were the only way in, and neither is visible. */}
            <button
              className="icon-btn composer-attach"
              title="Attach files — or paste and drop them straight into the box"
              aria-label="Attach files"
              disabled={ended}
              onClick={() => filePick.current?.click()}
            >
              <ClipIcon />
            </button>
            <input
              ref={filePick}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                // Reset first: picking the same file twice in a row fires no change
                // event otherwise, which reads as the button being broken.
                e.target.value = "";
                if (files.length) void absorbFiles(files);
              }}
            />
            {/* One word either way. Mid-turn it queues rather than interrupts, which
                the tooltip says — but a button whose label changes under you is worse
                than a button that just sends. */}
            <button
              className="icon-btn primary composer-send"
              disabled={ended || (!draft.trim() && attached.length === 0)}
              title={busy ? "Queue for when this turn finishes (↵)" : "Send (↵)"}
              onClick={() => void send()}
            >
              Send
            </button>
          </div>
          </div>
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
