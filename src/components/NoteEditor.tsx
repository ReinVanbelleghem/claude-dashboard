import { RefreshIcon, SaveIcon } from "./Icons.tsx";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import { oneDark } from "@codemirror/theme-one-dark";
import { editorViewOptionsCtx, remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { noteApi } from "../api.ts";
import { noteFolder } from "../../shared/notes.ts";
import { NOTES_CHANGED, type NotesChange } from "./noteEvents.ts";

const SAVE_AFTER_MS = 900;
const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/;
const LINK = /\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|[^\]\n]*)?\]\]/g;

/**
 * The editor writes Markdown its own way. These settings make it write the way
 * the notes already are, so opening and saving a note changes as little of the
 * file as it can: dashes for bullets and rules, asterisks for emphasis.
 */
const WRITE_AS = { bullet: "-", rule: "-", emphasis: "*", strong: "*", listItemIndent: "one", fences: true, incrementListMarker: true } as const;

/** `[[links]]` are not Markdown, so the writer escapes their brackets; a link to another note has to stay one. */
const keepLinks = (md: string) => md.replace(/\\\[\\?\[([^\]\n]+)\]\]/g, "[[$1]]");

/** Marks each `[[link]]` in the text so it can be styled and followed, without changing what is stored. */
const wikilinks = $prose(
  () =>
    new Plugin({
      key: new PluginKey("note-wikilinks"),
      props: {
        decorations(state) {
          const marks: Decoration[] = [];
          state.doc.descendants((node, pos) => {
            if (!node.isText || !node.text || node.marks.some((m) => m.type.name === "inlineCode")) return;
            for (const m of node.text.matchAll(LINK)) {
              marks.push(Decoration.inline(pos + m.index!, pos + m.index! + m[0].length, { class: "note-wikilink", "data-wikilink": m[1]!.trim() }));
            }
          });
          return DecorationSet.create(state.doc, marks);
        },
      },
    }),
);

export type NoteState = "saved" | "saving" | "dirty" | "error";

/**
 * One note in a block editor that reads and writes plain Markdown. The file is
 * only written after an edit, a moment later, and against the version that was
 * opened: when the file changed on disk in between, you are asked which side wins.
 *
 * What gets saved is always the text the editor last reported while it was
 * alive, never something asked of it while it is closing.
 */
export default function NoteEditor({
  path,
  source,
  onState,
  onOpenLink,
}: {
  path: string;
  /** Edit the Markdown itself rather than the rendered blocks. */
  source: boolean;
  onState?: (state: NoteState) => void;
  onOpenLink?: (target: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<{ body: string; front: string } | null>(null);
  const [missing, setMissing] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mounts, setMounts] = useState(0);
  const [draft, setDraft] = useState("");
  const hash = useRef<string | null>(null);
  const front = useRef("");
  const baseline = useRef<string | null>(null);
  const latest = useRef<string | null>(null);
  const closing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);
  const again = useRef(false);
  const stateRef = useRef(onState);
  stateRef.current = onState;
  const linkRef = useRef(onOpenLink);
  linkRef.current = onOpenLink;

  const open = useCallback((content: string, nextHash: string) => {
    const fm = FRONTMATTER.exec(content)?.[0] ?? "";
    front.current = fm;
    hash.current = nextHash;
    baseline.current = null;
    latest.current = null;
    const body = content.slice(fm.length);
    setDraft(body);
    setLoaded({ body, front: fm });
    setConflict(null);
    setError(null);
    setMounts((n) => n + 1);
    stateRef.current?.("saved");
  }, []);

  useEffect(() => {
    let stale = false;
    setLoaded(null);
    setMissing(false);
    noteApi
      .read(path)
      .then((r) => !stale && open(r.content, r.hash))
      .catch(() => !stale && setMissing(true));
    return () => {
      stale = true;
    };
  }, [path, open]);

  const dirty = () => latest.current !== null && latest.current !== baseline.current;

  const save = useCallback(
    async (force = false) => {
      if (hash.current === null || latest.current === null) return;
      if (!force && latest.current === baseline.current) return;
      if (saving.current) {
        again.current = true;
        return;
      }
      const body = latest.current;
      saving.current = true;
      stateRef.current?.("saving");
      try {
        const text = `${front.current}${body.endsWith("\n") ? body : `${body}\n`}`;
        const r = await noteApi.save(path, text, force ? undefined : hash.current);
        if (r.ok) {
          hash.current = r.hash;
          baseline.current = body;
          setError(null);
          setConflict(null);
          stateRef.current?.(latest.current === body ? "saved" : "dirty");
        } else if (r.conflict) {
          hash.current = r.conflict.hash;
          setConflict(r.conflict.content);
          stateRef.current?.("error");
        } else {
          setError(r.error);
          stateRef.current?.("error");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        stateRef.current?.("error");
      } finally {
        saving.current = false;
        if (again.current) {
          again.current = false;
          void save();
        }
      }
    },
    [path],
  );

  const changed = useCallback(
    (body: string) => {
      if (closing.current) return;
      if (baseline.current === null) baseline.current = body;
      latest.current = body;
      if (body === baseline.current) return;
      stateRef.current?.("dirty");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), SAVE_AFTER_MS);
    },
    [save],
  );

  useLayoutEffect(() => {
    closing.current = false;
    return () => {
      closing.current = true;
    };
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      void save();
    },
    [save],
  );

  useEffect(() => {
    if (!loaded || source || !host.current) return;
    const root = host.current;
    const folder = noteFolder(path);
    let alive = true;
    const crepe = new Crepe({
      root,
      defaultValue: latest.current ?? loaded.body,
      features: { [Crepe.Feature.AI]: false, [Crepe.Feature.TopBar]: false },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: { text: "Write, or press / for blocks" },
        ...(document.documentElement.dataset.theme === "light" ? {} : { [Crepe.Feature.CodeMirror]: { theme: oneDark } }),
        [Crepe.Feature.ImageBlock]: {
          proxyDomURL: (url: string) =>
            /^(https?:|data:|blob:|\/)/.test(url) ? url : noteApi.assetUrl(`${folder ? `${folder}/` : ""}${decodeURIComponent(url)}`.replace(/^\.\//, "")),
        },
      },
    });
    crepe.editor.config((ctx) => {
      ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, ...WRITE_AS }));
      ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, attributes: { ...(prev.attributes as object), spellcheck: "false" } }));
    });
    crepe.editor.use(wikilinks);
    crepe.on((listen) => listen.markdownUpdated((_ctx, md) => alive && changed(keepLinks(md))));
    void crepe.create().then(() => {
      if (!alive) return;
      if (baseline.current === null) baseline.current = keepLinks(crepe.getMarkdown());
    });
    const follow = (e: MouseEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-wikilink]")?.dataset.wikilink;
      if (!target) return;
      e.preventDefault();
      linkRef.current?.(target);
    };
    root.addEventListener("click", follow);
    return () => {
      alive = false;
      root.removeEventListener("click", follow);
      void crepe.destroy();
    };
  }, [loaded, source, mounts, path, changed]);

  useEffect(() => {
    if (source && loaded) setDraft(latest.current ?? loaded.body);
  }, [source, loaded]);

  useEffect(() => {
    const onDisk = (e: Event) => {
      const change = (e as CustomEvent<NotesChange>).detail;
      if (change?.path !== path || !change.hash || change.hash === hash.current || saving.current) return;
      void noteApi
        .read(path)
        .then((r) => {
          if (r.hash === hash.current) return;
          if (dirty()) {
            hash.current = r.hash;
            setConflict(r.content);
          } else open(r.content, r.hash);
        })
        .catch(() => {});
    };
    window.addEventListener(NOTES_CHANGED, onDisk);
    return () => window.removeEventListener(NOTES_CHANGED, onDisk);
  }, [path, open]);

  if (missing) return <div className="empty">This note is no longer on disk.</div>;
  if (!loaded) return <div className="empty">Opening the note…</div>;

  return (
    <div className="note-editor">
      {conflict !== null && (
        <div className="drawing-conflict" role="alert">
          <span>This note changed on disk while you were editing it.</span>
          <button className="icon-btn" onClick={() => open(conflict, hash.current!)}>
            <RefreshIcon /> Take the one on disk
          </button>
          <button className="icon-btn" onClick={() => void save(true)}>
            <SaveIcon /> Keep mine
          </button>
        </div>
      )}
      {error && <div className="chat-error">{error}</div>}
      {loaded.front && !source && (
        <details className="note-front">
          <summary>Properties</summary>
          <pre>{loaded.front.replace(/^---\n|\n---\n?$/g, "")}</pre>
        </details>
      )}
      {source ? (
        <textarea
          className="note-source"
          value={draft}
          spellCheck={false}
          onChange={(e) => {
            setDraft(e.target.value);
            changed(e.target.value);
          }}
        />
      ) : (
        <div key={mounts} className="note-stage" ref={host} />
      )}
    </div>
  );
}
