import { useFind } from "../useFind.ts";
import { useFrameFind } from "../useFrameFind.ts";
import { MATCH_LIMIT } from "../find.ts";

type Find = ReturnType<typeof useFind>;

/**
 * One bar, two backends.
 *
 * Searching this document and searching inside an open artifact are the same
 * interaction and must not become two different-looking controls — but they cannot
 * share an implementation, because an artifact is a separate cross-origin document
 * this window cannot read. The split is here and nowhere else: both hooks return
 * the same shape, and everything below renders it.
 */
export function FindBar({ onClose, frame }: { onClose: () => void; frame?: HTMLIFrameElement | null }) {
  // Hooks cannot be called conditionally, so the choice is made by which component
  // mounts rather than by a branch inside one.
  return frame === undefined ? (
    <PageFindBar onClose={onClose} />
  ) : (
    <FrameFindBar frame={frame} onClose={onClose} />
  );
}

function PageFindBar({ onClose }: { onClose: () => void }) {
  return <FindBarUI find={useFind(true)} onClose={onClose} />;
}

function FrameFindBar({ frame, onClose }: { frame: HTMLIFrameElement | null; onClose: () => void }) {
  return <FindBarUI find={useFrameFind(frame)} onClose={onClose} inFrame />;
}

function FindBarUI({
  find: { query, setQuery, count, index, step },
  onClose,
  inFrame,
}: {
  find: Find;
  onClose: () => void;
  inFrame?: boolean;
}) {
  const empty = query.trim().length > 0 && count === 0;

  return (
    <div
      className={`find-bar${inFrame ? " find-bar-artifact" : ""}`}
      data-find-skip
      role="search"
      aria-label={inFrame ? "Find in artifact" : "Find on page"}
    >
      <input
        className="find-input"
        autoFocus
        value={query}
        placeholder={inFrame ? "Find in artifact…" : "Find in page…"}
        aria-label="Find"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            // The drawer and the modals each close on their own window-level Escape.
            // React listens at the root container, below window, so stopping here is
            // what keeps one press from closing the find bar and the drawer both.
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <span className={`find-count ${empty ? "none" : ""}`} aria-live="polite">
        {query.trim().length === 0
          ? ""
          : count === 0
            ? "no matches"
            : `${index + 1}/${count}${count === MATCH_LIMIT ? "+" : ""}`}
      </span>
      <button className="icon-btn tiny" onClick={() => step(-1)} disabled={count === 0} aria-label="Previous match">
        ↑
      </button>
      <button className="icon-btn tiny" onClick={() => step(1)} disabled={count === 0} aria-label="Next match">
        ↓
      </button>
      <button className="icon-btn tiny" onClick={onClose} aria-label="Close find">
        ✕
      </button>
    </div>
  );
}
