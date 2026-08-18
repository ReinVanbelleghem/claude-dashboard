import { useFind } from "../useFind.ts";
import { MATCH_LIMIT } from "../find.ts";

export function FindBar({ onClose }: { onClose: () => void }) {
  const { query, setQuery, count, index, step } = useFind(true);
  const empty = query.trim().length > 0 && count === 0;

  return (
    <div className="find-bar" data-find-skip role="search" aria-label="Find on page">
      <input
        className="find-input"
        autoFocus
        value={query}
        placeholder="Find in page…"
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
