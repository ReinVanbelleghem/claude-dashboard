import { lazy, Suspense, useEffect, useState, type PointerEvent, type ReactNode } from "react";
import { drawingApi, type Drawing } from "../api.ts";
import { drawingSlugOf } from "../../shared/drawings.ts";
import { parseProjectFileId } from "../../shared/projectFiles.ts";
import { DRAWINGS_CHANGED } from "./drawingEvents.ts";
import { EditableTitle } from "./EditableTitle.tsx";
import { DrawingIcon } from "./Icons.tsx";

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

/** Excalidraw is large, so it is fetched the first time a drawing is opened and not with the app. */
const DrawingCanvas = lazy(() => {
  window.EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";
  return import("./DrawingCanvas.tsx");
});

/** Looks a drawing up by the key sessions are opened with; null while loading, false once it is known to be gone. */
export function useDrawing(key: string): Drawing | null | false {
  const [found, setFound] = useState<Drawing | null | false>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener(DRAWINGS_CHANGED, bump);
    return () => window.removeEventListener(DRAWINGS_CHANGED, bump);
  }, []);
  useEffect(() => setFound(null), [key]);
  useEffect(() => {
    let stale = false;
    drawingApi
      .list()
      .then((r) => !stale && setFound(r.drawings.find((d) => d.slug === drawingSlugOf(key)) ?? false))
      .catch(() => !stale && setFound(false));
    return () => {
      stale = true;
    };
  }, [key, tick]);
  return found;
}

type SaveState = "saved" | "saving" | "error";
const SAVE_LABEL: Record<SaveState, string> = { saved: "Saved", saving: "Saving…", error: "Not saved" };

function Canvas({ slug, onState }: { slug: string; onState: (s: SaveState) => void }) {
  return (
    <Suspense fallback={<div className="empty">Loading the canvas…</div>}>
      <DrawingCanvas slug={slug} onState={onState} />
    </Suspense>
  );
}

/** A drawing where a session would be: the header a drawer or tile expects, then the canvas. */
export function DrawingPanel({
  id,
  onHeadPointerDown,
  headStart,
}: {
  id: string;
  onHeadPointerDown?: (e: PointerEvent) => void;
  headStart?: ReactNode;
}) {
  const found = useDrawing(id);
  const [state, setState] = useState<SaveState>("saved");
  return (
    <>
      <div className="drawer-head term-head kind-artifact" onPointerDown={onHeadPointerDown}>
        {headStart}
        <h3>
          <DrawingIcon /> {found ? found.title : "Drawing"}
        </h3>
        <div className="drawer-actions">{found && <span className={`drawing-state ${state}`}>{SAVE_LABEL[state]}</span>}</div>
      </div>
      {found === false && <div className="empty">This drawing is no longer on disk.</div>}
      {found && <Canvas slug={found.slug} onState={setState} />}
    </>
  );
}

/** A drawing on a page of its own, filling the window. */
export function DrawingPage({ id, onBack }: { id: string; onBack: () => void }) {
  const found = useDrawing(id);
  const [state, setState] = useState<SaveState>("saved");
  return (
    <div className="page session-chat drawing-page">
      <div className="page-head">
        <button className="icon-btn" onClick={onBack}>
          ← Back
        </button>
        <div>
          {found ? (
            <EditableTitle
              as="h1"
              value={found.title}
              placeholder="Drawing"
              onRename={async (title) => {
                await drawingApi.update(found.slug, { title });
              }}
            />
          ) : (
            <h1>Drawing</h1>
          )}
          <p className="page-sub">{found ? `${parseProjectFileId(found.slug).name}.excalidraw` : ""}</p>
        </div>
        <span style={{ flex: 1 }} />
        {found && <span className={`drawing-state ${state}`}>{SAVE_LABEL[state]}</span>}
      </div>
      {found === false && <div className="empty">This drawing is no longer on disk.</div>}
      {found && (
        <div className="panel drawing-page-panel">
          <Canvas slug={found.slug} onState={setState} />
        </div>
      )}
    </div>
  );
}
