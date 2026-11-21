import { RefreshIcon, SaveIcon } from "./Icons.tsx";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Excalidraw, exportToSvg, restore, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { drawingApi } from "../api.ts";
import { DRAWINGS_CHANGED, type DrawingsChange } from "./drawingEvents.ts";

type Api = Parameters<NonNullable<React.ComponentProps<typeof Excalidraw>["excalidrawAPI"]>>[0];
type Initial = NonNullable<Exclude<React.ComponentProps<typeof Excalidraw>["initialData"], Promise<unknown> | (() => unknown)>>;
type Elements = ReturnType<Api["getSceneElements"]>;
type Files = ReturnType<Api["getFiles"]>;
type AppState = ReturnType<Api["getAppState"]>;
/** The drawing as the canvas last reported it. */
type Scene = { elements: Elements; appState: AppState; files: Files };

const SAVE_AFTER_MS = 900;

/** What changes when the drawing does, and stays put while you only pan, zoom or select. */
const stampOf = (elements: Elements, files: Files, background: string) => {
  const live = elements.filter((e) => !e.isDeleted);
  return `${live.length}:${live.reduce((n, e) => n + e.version, 0)}:${Object.keys(files).length}:${background}`;
};

function useAppTheme(): "light" | "dark" {
  const read = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
  const [theme, setTheme] = useState<"light" | "dark">(read);
  useEffect(() => {
    const watch = new MutationObserver(() => setTheme(read()));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => watch.disconnect();
  }, []);
  return theme;
}

/**
 * One drawing, on Excalidraw's own canvas. It saves itself a moment after each
 * change and writes a preview beside the file. When the file changes on disk,
 * because an agent redrew it, the canvas follows unless you have changes of your
 * own waiting, in which case you are asked which side wins.
 */
export default function DrawingCanvas({ slug, onState }: { slug: string; onState?: (state: "saved" | "saving" | "error") => void }) {
  const theme = useAppTheme();
  const [initial, setInitial] = useState<Initial | null>(null);
  const [missing, setMissing] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mounts, setMounts] = useState(0);
  /**
   * What gets saved. Kept from the canvas's own change reports and never asked
   * of the canvas afterwards: by the time this component is closing the canvas
   * has already emptied itself, and asking it then saved an empty drawing over
   * the real one.
   */
  const latest = useRef<Scene | null>(null);
  const closing = useRef(false);
  const hash = useRef<string | null>(null);
  const savedStamp = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);
  const again = useRef(false);

  const load = useCallback(
    (scene: string, nextHash: string) => {
      const data = restore(JSON.parse(scene), null, null);
      hash.current = nextHash;
      savedStamp.current = stampOf(data.elements, data.files ?? {}, data.appState.viewBackgroundColor ?? "");
      latest.current = null;
      setInitial({ elements: data.elements, appState: { ...data.appState, collaborators: new Map() }, files: data.files, scrollToContent: true });
      setConflict(null);
      setMounts((n) => n + 1);
    },
    [],
  );

  useEffect(() => {
    let stale = false;
    setInitial(null);
    setMissing(false);
    drawingApi
      .read(slug)
      .then((r) => !stale && load(r.scene, r.hash))
      .catch(() => !stale && setMissing(true));
    return () => {
      stale = true;
    };
  }, [slug, load]);

  const dirty = () => {
    const now = latest.current;
    return !!now && stampOf(now.elements, now.files, now.appState.viewBackgroundColor) !== savedStamp.current;
  };

  const save = useCallback(
    async (force = false) => {
      const now = latest.current;
      if (!now || hash.current === null) return;
      if (saving.current) {
        again.current = true;
        return;
      }
      const { elements, files, appState } = now;
      const stamp = stampOf(elements, files, appState.viewBackgroundColor);
      if (stamp === savedStamp.current && !force) return;
      saving.current = true;
      onState?.("saving");
      try {
        const scene = serializeAsJSON(elements, appState, files, "local");
        const preview = await exportToSvg({ elements, appState: { ...appState, exportBackground: true, exportWithDarkMode: false }, files, exportPadding: 16 })
          .then((svg: SVGSVGElement) => svg.outerHTML)
          .catch(() => undefined);
        const r = await drawingApi.save(slug, { scene, baseHash: force ? undefined : hash.current, preview });
        if (r.ok) {
          hash.current = r.hash;
          savedStamp.current = stamp;
          setError(null);
          setConflict(null);
          onState?.("saved");
        } else if (r.conflict) {
          setConflict(r.conflict.scene);
          hash.current = r.conflict.hash;
          onState?.("error");
        } else {
          setError(r.error);
          onState?.("error");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        onState?.("error");
      } finally {
        saving.current = false;
        if (again.current) {
          again.current = false;
          void save();
        }
      }
    },
    [slug, onState],
  );

  const onChange = useCallback(
    (elements: Elements, appState: AppState, files: Files) => {
      if (closing.current) return;
      latest.current = { elements, appState, files };
      if (conflict !== null) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), SAVE_AFTER_MS);
    },
    [save, conflict],
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
    const onDisk = (e: Event) => {
      const change = (e as CustomEvent<DrawingsChange>).detail;
      if (change?.slug !== slug || !change.hash || change.hash === hash.current || saving.current) return;
      void drawingApi
        .read(slug)
        .then((r) => {
          if (r.hash === hash.current) return;
          if (dirty()) {
            hash.current = r.hash;
            setConflict(r.scene);
          } else load(r.scene, r.hash);
        })
        .catch(() => {});
    };
    window.addEventListener(DRAWINGS_CHANGED, onDisk);
    return () => window.removeEventListener(DRAWINGS_CHANGED, onDisk);
  }, [slug, load]);

  if (missing) return <div className="empty">This drawing is no longer on disk.</div>;
  if (!initial) return <div className="empty">Opening the drawing…</div>;

  return (
    <div className="drawing-canvas">
      {conflict !== null && (
        <div className="drawing-conflict" role="alert">
          <span>This drawing changed on disk while you were editing it.</span>
          <button className="icon-btn" onClick={() => load(conflict, hash.current!)}>
            <RefreshIcon /> Take the one on disk
          </button>
          <button className="icon-btn" onClick={() => void save(true)}>
            <SaveIcon /> Keep mine
          </button>
        </div>
      )}
      {error && <div className="chat-error">{error}</div>}
      <div className="drawing-stage">
        <Excalidraw
          key={mounts}
          initialData={initial}
          onChange={onChange}
          theme={theme}
          UIOptions={{ canvasActions: { toggleTheme: false, loadScene: false, saveToActiveFile: false } }}
        />
      </div>
    </div>
  );
}
