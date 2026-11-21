import { lazy, Suspense, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { FileTypeIcon, FolderIcon, SearchIcon, TerminalIcon, XIcon } from "../Icons.tsx";
import { FileTree } from "./FileTree.tsx";
import { QuickOpen } from "./QuickOpen.tsx";
import { SearchView } from "./SearchView.tsx";
import { TerminalDock } from "./TerminalDock.tsx";

/** The editor is large, so it is fetched the first time a file is opened and not with the app. */
const MonacoEditor = lazy(() => import("./MonacoEditor.tsx"));

export type WorkbenchView = { key: string; label: string; count?: number; render: () => ReactNode };

const FILE = "file:";
export const fileTab = (path: string) => `${FILE}${path}`;
export const isFileTab = (tab: string) => tab.startsWith(FILE);
const pathOf = (tab: string) => tab.slice(FILE.length);

type Side = "explorer" | "search";
type Layout = { files: string[]; side: Side | null; sideWidth: number; dock: boolean; dockHeight: number };

const STORE = "workbench:";
const DEFAULT_LAYOUT: Layout = { files: [], side: "explorer", sideWidth: 260, dock: false, dockHeight: 260 };

function readLayout(id: number): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE + id) ?? "{}") as Partial<Layout>;
    return {
      files: Array.isArray(raw.files) ? raw.files.filter((x): x is string => typeof x === "string").slice(0, 30) : [],
      side: raw.side === "explorer" || raw.side === "search" ? raw.side : raw.side === null ? null : DEFAULT_LAYOUT.side,
      sideWidth: Number.isFinite(raw.sideWidth) ? Math.min(560, Math.max(180, raw.sideWidth!)) : DEFAULT_LAYOUT.sideWidth,
      dock: raw.dock === true,
      dockHeight: Number.isFinite(raw.dockHeight) ? Math.min(700, Math.max(120, raw.dockHeight!)) : DEFAULT_LAYOUT.dockHeight,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/** Drag a divider: `onDrag` gets how far the pointer has moved since the press. */
function dragHandle(onDrag: (dx: number, dy: number) => void, onEnd?: () => void) {
  return (e: ReactPointerEvent) => {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    const move = (ev: PointerEvent) => onDrag(ev.clientX - start.x, ev.clientY - start.y);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      onEnd?.();
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
}

/**
 * A workspace laid out like an editor: a rail that switches the side bar between
 * the file explorer and search, a strip of tabs over the main area, and the
 * workspace's terminals in a panel underneath.
 *
 * The first tabs are the workspace's own views and never close. Files open after
 * them: a single click shows a file in one reusable preview tab, a double click
 * or an edit keeps it.
 */
export function Workbench({
  workspaceId,
  cwd,
  views,
  active,
  onActive,
  changed,
  stamp,
  terminals,
  onNewTerminal,
}: {
  workspaceId: number;
  cwd: string;
  views: WorkbenchView[];
  /** A view's key, or `fileTab(path)`. */
  active: string;
  onActive: (tab: string) => void;
  changed: Map<string, string>;
  /** Changes when the working tree does, so the explorer reads its folders again. */
  stamp: string;
  terminals: { id: string; title: string }[];
  onNewTerminal: () => void;
}) {
  const [layout, setLayout] = useState<Layout>(() => readLayout(workspaceId));
  const [preview, setPreview] = useState<string | null>(null);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [reveal, setReveal] = useState<{ path: string; line: number; column?: number; nonce: number } | null>(null);
  const [quick, setQuick] = useState(false);
  const [saveKey, setSaveKey] = useState(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [searchFocus, setSearchFocus] = useState(0);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const update = useCallback(
    (patch: Partial<Layout>) =>
      setLayout((prev) => {
        const next = { ...prev, ...patch };
        try {
          localStorage.setItem(STORE + workspaceId, JSON.stringify(next));
        } catch {
          return next;
        }
        return next;
      }),
    [workspaceId],
  );

  useEffect(() => {
    if (isFileTab(active) && !layout.files.includes(pathOf(active))) onActive(views[0]!.key);
  }, [active, layout.files, views, onActive]);

  const openFile = useCallback(
    (path: string, opts: { keep?: boolean; line?: number; column?: number } = {}) => {
      const current = layoutRef.current.files;
      const keep = opts.keep === true || opts.line !== undefined;
      if (!current.includes(path)) {
        const replace = preview && !keep && !dirty.has(preview) ? preview : null;
        const next = replace ? current.map((p) => (p === replace ? path : p)) : [...current, path];
        update({ files: next });
        setPreview(keep ? (replace ? null : preview) : path);
      } else if (keep && preview === path) setPreview(null);
      if (opts.line !== undefined) setReveal({ path, line: opts.line, column: opts.column, nonce: Date.now() });
      onActive(fileTab(path));
    },
    [preview, dirty, update, onActive],
  );

  const closeFile = (path: string) => {
    if (dirty.has(path) && !window.confirm(`${path} has changes that are not saved. Close it anyway?`)) return;
    const files = layout.files;
    const at = files.indexOf(path);
    const next = files.filter((p) => p !== path);
    update({ files: next });
    setDirty((prev) => {
      const out = new Set(prev);
      out.delete(path);
      return out;
    });
    if (preview === path) setPreview(null);
    if (active === fileTab(path)) onActive(next[at] ? fileTab(next[at]!) : next[at - 1] ? fileTab(next[at - 1]!) : views[0]!.key);
  };

  const onEditorState = useCallback((path: string, state: { dirty: boolean }) => {
    setDirty((prev) => {
      if (prev.has(path) === state.dirty) return prev;
      const out = new Set(prev);
      if (state.dirty) out.add(path);
      else out.delete(path);
      return out;
    });
    if (state.dirty) setPreview((p) => (p === path ? null : p));
  }, []);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.size > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const showSide = useCallback(
    (side: Side) => {
      const same = layoutRef.current.side === side;
      update({ side: same && side !== "search" ? null : side });
      if (side === "search") setSearchFocus((n) => n + 1);
    },
    [update],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && !e.shiftKey && !e.altKey && key === "s" && isFileTab(activeRef.current)) {
        // Wherever the focus is, Cmd-S saves the file on screen and never opens the browser's own save dialog.
        e.preventDefault();
        e.stopPropagation();
        setSaveKey((n) => n + 1);
      } else if (mod && !e.shiftKey && !e.altKey && key === "p") {
        e.preventDefault();
        setQuick(true);
      } else if (mod && e.shiftKey && key === "f") {
        e.preventDefault();
        update({ side: "search" });
        setSearchFocus((n) => n + 1);
      } else if (mod && e.shiftKey && key === "e") {
        e.preventDefault();
        update({ side: "explorer" });
      } else if ((mod && !e.shiftKey && key === "j") || (e.ctrlKey && e.key === "`")) {
        e.preventDefault();
        update({ dock: !layoutRef.current.dock });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [update]);

  const sideStart = useRef(layout.sideWidth);
  const dockStart = useRef(layout.dockHeight);
  const activePath = isFileTab(active) ? pathOf(active) : null;
  const view = views.find((v) => v.key === active) ?? (activePath ? null : views[0]!);

  return (
    <div className="wb">
      <nav className="wb-rail" aria-label="Side bar">
        <button className={layout.side === "explorer" ? "on" : ""} title="Explorer (⇧⌘E)" aria-label="Explorer" aria-pressed={layout.side === "explorer"} onClick={() => showSide("explorer")}>
          <FolderIcon />
        </button>
        <button className={layout.side === "search" ? "on" : ""} title="Search in files (⇧⌘F)" aria-label="Search" aria-pressed={layout.side === "search"} onClick={() => showSide("search")}>
          <SearchIcon />
        </button>
        <span style={{ flex: 1 }} />
        <button className={layout.dock ? "on" : ""} title="Terminal panel (⌘J)" aria-label="Terminal panel" aria-pressed={layout.dock} onClick={() => update({ dock: !layout.dock })}>
          <TerminalIcon />
          {terminals.length > 0 && <em>{terminals.length}</em>}
        </button>
      </nav>

      {layout.side && (
        <>
          <aside className="wb-side" style={{ width: layout.sideWidth }}>
            <div style={{ display: layout.side === "explorer" ? "contents" : "none" }}>
              <FileTree cwd={cwd} active={activePath} changed={changed} stamp={stamp} onOpen={(path, opts) => openFile(path, opts)} />
            </div>
            <div style={{ display: layout.side === "search" ? "contents" : "none" }}>
              <SearchView cwd={cwd} focusKey={searchFocus} onOpen={(path, at) => openFile(path, at)} />
            </div>
          </aside>
          <div
            className="wb-split col"
            role="separator"
            aria-orientation="vertical"
            onPointerDown={(e) => {
              sideStart.current = layout.sideWidth;
              dragHandle((dx) => update({ sideWidth: Math.min(560, Math.max(180, sideStart.current + dx)) }))(e);
            }}
          />
        </>
      )}

      <div className="wb-main">
        <div className="wb-tabs" role="tablist">
          {views.map((v) => (
            <button key={v.key} role="tab" aria-selected={active === v.key} className={`wb-tab pinned${active === v.key ? " on" : ""}`} onClick={() => onActive(v.key)}>
              {v.label}
              {!!v.count && <em>{v.count}</em>}
            </button>
          ))}
          {layout.files.length > 0 && <span className="wb-tabs-gap" />}
          {layout.files.map((path) => {
            const name = path.split("/").pop() ?? path;
            const on = active === fileTab(path);
            return (
              <span
                key={path}
                role="tab"
                aria-selected={on}
                className={`wb-tab file${on ? " on" : ""}${preview === path ? " preview" : ""}${dirty.has(path) ? " dirty" : ""}`}
                title={path}
                onAuxClick={(e) => e.button === 1 && closeFile(path)}
              >
                <button className="wb-tab-open" onClick={() => onActive(fileTab(path))} onDoubleClick={() => preview === path && setPreview(null)}>
                  <FileTypeIcon name={name} />
                  {name}
                </button>
                <button className="wb-tab-close" title={dirty.has(path) ? "Not saved. Close" : "Close"} aria-label={`Close ${name}`} onClick={() => closeFile(path)}>
                  {dirty.has(path) ? <i className="wb-dot" /> : <XIcon />}
                </button>
              </span>
            );
          })}
          <span style={{ flex: 1 }} />
          <button className="wb-tab-tool" title="Go to file (⌘P)" onClick={() => setQuick(true)}>
            <SearchIcon /> Go to file
          </button>
        </div>

        <div className="wb-stage">
          {view && <div className="wb-view">{view.render()}</div>}
          <Suspense fallback={activePath ? <div className="empty">Loading the editor…</div> : null}>
            {layout.files.map((path) => (
              <MonacoEditor
                key={path}
                cwd={cwd}
                path={path}
                visible={activePath === path}
                saveKey={saveKey}
                reveal={reveal?.path === path ? reveal : null}
                onState={(state) => onEditorState(path, state)}
              />
            ))}
          </Suspense>
        </div>

        {layout.dock && (
          <>
            <div
              className="wb-split row"
              role="separator"
              aria-orientation="horizontal"
              onPointerDown={(e) => {
                dockStart.current = layout.dockHeight;
                dragHandle((_dx, dy) => update({ dockHeight: Math.min(700, Math.max(120, dockStart.current - dy)) }))(e);
              }}
            />
            <div className="wb-dock-slot" style={{ height: layout.dockHeight }}>
              <TerminalDock terminals={terminals} onNew={onNewTerminal} onHide={() => update({ dock: false })} />
            </div>
          </>
        )}
      </div>

      {quick && <QuickOpen cwd={cwd} recent={[...layout.files].reverse()} onOpen={(path) => openFile(path, { keep: true })} onClose={() => setQuick(false)} />}
    </div>
  );
}
