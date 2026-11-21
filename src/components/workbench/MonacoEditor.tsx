import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { fileApi } from "../../api.ts";
import { RefreshIcon, SaveIcon } from "../Icons.tsx";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

// One file is open at a time with no project around it, so anything that needs
// the other files (imports, types) would only ever report false errors.
for (const defaults of [monaco.languages.typescript.typescriptDefaults, monaco.languages.typescript.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  defaults.setCompilerOptions({ ...defaults.getCompilerOptions(), jsx: monaco.languages.typescript.JsxEmit.Preserve, allowNonTsExtensions: true });
}

/** A stylesheet colour as the #rrggbb Monaco wants, whatever notation the theme wrote it in. */
function hexOf(variable: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  if (!value) return fallback;
  const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
  if (!ctx) return fallback;
  ctx.fillStyle = fallback;
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((n) => n!.toString(16).padStart(2, "0")).join("")}`;
}

function applyTheme() {
  const dark = document.documentElement.dataset.theme !== "light";
  const background = hexOf("--surface-1", dark ? "#1b1b1a" : "#ffffff");
  monaco.editor.defineTheme("dashboard", {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": background,
      "editorGutter.background": background,
      "minimap.background": background,
      "editor.lineHighlightBackground": hexOf("--surface-2", dark ? "#242423" : "#f4f4f3"),
      "editorLineNumber.foreground": hexOf("--text-muted", "#888888"),
      "editorCursor.foreground": hexOf("--accent", "#3b82f6"),
      "editorWidget.background": hexOf("--surface-2", dark ? "#242423" : "#f4f4f3"),
      "editorWidget.border": hexOf("--border-strong", "#555555"),
    },
  });
  monaco.editor.setTheme("dashboard");
}

let themeWatch: MutationObserver | null = null;
function watchTheme() {
  applyTheme();
  if (themeWatch) return;
  themeWatch = new MutationObserver(applyTheme);
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
}

export type EditorState = { dirty: boolean; saving: boolean };

/**
 * One file in the editor VS Code itself is built on. It reads the file through
 * the daemon, saves with Cmd-S against the hash it read, and when the file
 * changed on disk in between it says so rather than writing over it.
 */
export default function MonacoEditor({
  cwd,
  path,
  reveal,
  visible,
  saveKey = 0,
  onState,
}: {
  /** Bumped by the page when Cmd-S is pressed while this file is the one on screen. */
  saveKey?: number;
  cwd: string;
  path: string;
  /** A line to jump to, with a counter so the same line can be asked for twice. */
  reveal?: { line: number; column?: number; nonce: number } | null;
  visible: boolean;
  onState?: (state: EditorState) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const hash = useRef<string | null>(null);
  const savedVersion = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<EditorState>({ dirty: false, saving: false });
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const saveRef = useRef<() => void>(() => {});
  const stateRef = useRef(onState);
  stateRef.current = onState;
  const revealRef = useRef(reveal);
  revealRef.current = reveal;

  const jump = (target: typeof reveal) => {
    const ed = editor.current;
    if (!ed || !target) return;
    const position = { lineNumber: target.line, column: target.column ?? 1 };
    ed.setPosition(position);
    ed.revealPositionInCenter(position);
    ed.focus();
  };

  useEffect(() => {
    if (!host.current) return;
    watchTheme();
    let disposed = false;
    const uri = monaco.Uri.from({ scheme: "file", path: `${cwd}/${path}` });
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel("", undefined, uri);
    const ed = monaco.editor.create(host.current, {
      model,
      automaticLayout: true,
      fontSize: 13,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "ui-monospace, Menlo, monospace",
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      smoothScrolling: true,
      padding: { top: 8 },
      readOnly: true,
    });
    editor.current = ed;

    const report = (saving = false) => {
      const next = { dirty: model.getAlternativeVersionId() !== savedVersion.current, saving };
      setState((prev) => (prev.dirty === next.dirty && prev.saving === next.saving ? prev : next));
      stateRef.current?.(next);
    };

    const load = () =>
      fileApi
        .read(cwd, path)
        .then((r) => {
          if (disposed) return;
          if (!r.ok) return setError(r.error ?? "This file could not be read.");
          model.setValue(r.content);
          hash.current = r.hash;
          savedVersion.current = model.getAlternativeVersionId();
          ed.updateOptions({ readOnly: false });
          setError(null);
          setConflict(null);
          setLoaded(true);
          report();
          jump(revealRef.current);
        })
        .catch((e) => !disposed && setError(e instanceof Error ? e.message : String(e)));

    const save = async () => {
      if (hash.current === null || model.getAlternativeVersionId() === savedVersion.current) return;
      const version = model.getAlternativeVersionId();
      report(true);
      try {
        const r = await fileApi.save(cwd, path, model.getValue(), hash.current);
        if (disposed) return;
        if (r.ok && r.hash) {
          hash.current = r.hash;
          savedVersion.current = version;
          setConflict(null);
          setSavedAt(Date.now());
        } else setConflict([r.error, r.hint].filter(Boolean).join(" — ") || "The file could not be saved.");
      } catch (e) {
        if (!disposed) setConflict(e instanceof Error ? e.message : String(e));
      } finally {
        if (!disposed) report();
      }
    };

    const changes = model.onDidChangeContent(() => report());
    const moves = ed.onDidChangeCursorPosition((e) => setCursor({ line: e.position.lineNumber, column: e.position.column }));
    saveRef.current = () => void save();
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
    const reload = () => void load();
    host.current.addEventListener("workbench-reload", reload);
    const node = host.current;
    void load();

    return () => {
      disposed = true;
      node.removeEventListener("workbench-reload", reload);
      changes.dispose();
      moves.dispose();
      saveRef.current = () => {};
      ed.dispose();
      model.dispose();
      editor.current = null;
    };
  }, [cwd, path]);

  useEffect(() => {
    if (loaded) jump(reveal);
  }, [reveal?.nonce, loaded]);

  useEffect(() => {
    if (visible) editor.current?.layout();
  }, [visible]);

  useEffect(() => {
    if (saveKey > 0 && visible) saveRef.current();
  }, [saveKey]);

  return (
    <div className="wb-editor" style={{ display: visible ? undefined : "none" }}>
      {conflict && (
        <div className="wb-editor-note" role="alert">
          <span>{conflict}</span>
          <button className="icon-btn" onClick={() => host.current?.dispatchEvent(new Event("workbench-reload"))}>
            <RefreshIcon /> Reload from disk
          </button>
        </div>
      )}
      {error && <div className="empty">{error}</div>}
      <div className="wb-editor-host" ref={host} style={{ display: error ? "none" : undefined }} />
      {!error && (
        <div className="wb-editor-bar">
          <span className="wb-editor-path" title={`${cwd}/${path}`}>
            {path}
          </span>
          <span>
            Ln {cursor.line}, Col {cursor.column}
          </span>
          <span style={{ flex: 1 }} />
          <span className={`wb-editor-state${state.dirty ? " dirty" : ""}`}>
            {state.saving
              ? "Saving…"
              : state.dirty
                ? "Not saved"
                : savedAt
                  ? `Saved ${new Date(savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
                  : "No changes"}
          </span>
          <button className="icon-btn primary" disabled={!state.dirty || state.saving} onClick={() => saveRef.current()} title="Write this file to disk (⌘S)">
            <SaveIcon /> Save <kbd>⌘S</kbd>
          </button>
        </div>
      )}
    </div>
  );
}
