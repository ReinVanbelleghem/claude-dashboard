import { useEffect, useRef, useState } from "react";
import { SESSION_DRAG_MIME, type Desktop } from "../tiles.ts";
import { useSortable } from "../useSortable.ts";
import { PlusIcon, XIcon } from "./Icons.tsx";

const HOVER_SWITCH_MS = 450;

/**
 * The strip of desktops above the tile area. Each tab is a drop target: a
 * session dragged from the sidebar and held over one switches to it, and
 * dropped on one opens there. Tiles dragged onto a tab are copied to it. The
 * tabs themselves drag sideways to reorder; Shift with an arrow key does the same.
 */
export function DesktopBar({
  desktops,
  active,
  onSelect,
  onAdd,
  onRename,
  onClose,
  onMove,
}: {
  desktops: Desktop[];
  active: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onClose: (id: string) => void;
  onMove: (from: number, to: number) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const sort = useSortable({ count: desktops.length, listRef: bar, itemSelector: ".desk-tab", axis: "x", onMove });
  const hover = useRef<{ id: string; timer: number } | null>(null);

  const stopHover = () => {
    if (hover.current) window.clearTimeout(hover.current.timer);
    hover.current = null;
  };
  useEffect(() => stopHover, []);

  const holdOver = (id: string) => {
    if (hover.current?.id === id) return;
    stopHover();
    if (id === active) return;
    hover.current = { id, timer: window.setTimeout(() => onSelect(id), HOVER_SWITCH_MS) };
  };

  return (
    <div ref={bar} className="desk-bar" role="tablist" aria-label="Desktops">
      {desktops.map((d, i) => {
        const shown = d.tiles.length;
        const handle = sort.handleProps(i);
        return (
          <div
            key={d.id}
            role="tab"
            tabIndex={0}
            aria-selected={d.id === active}
            data-desktop={d.id}
            className={`desk-tab${d.id === active ? " on" : ""}${sort.active === i ? " dragging" : ""}`}
            style={sort.itemStyle(i)}
            title={editing === d.id ? undefined : `${d.name} · drag to reorder, double-click to rename`}
            onPointerDown={(e) => {
              if (editing !== null || (e.target as HTMLElement).closest("button, input")) return;
              handle.onPointerDown(e);
            }}
            onClick={() => onSelect(d.id)}
            onDoubleClick={() => setEditing(d.id)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.shiftKey) handle.onKeyDown(e);
              if (e.key === "Enter" || e.key === " ") onSelect(d.id);
              if (e.key === "F2") setEditing(d.id);
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(SESSION_DRAG_MIME)) return;
              holdOver(d.id);
            }}
            onDragLeave={stopHover}
            onDrop={stopHover}
          >
            {editing === d.id ? (
              <input
                className="desk-tab-input"
                defaultValue={d.name}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  onRename(d.id, e.currentTarget.value);
                  setEditing(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <span className="desk-tab-name">{d.name}</span>
            )}
            {shown > 0 && editing !== d.id && <span className="desk-tab-count">{shown}</span>}
            {desktops.length > 1 && editing !== d.id && (
              <button
                className="desk-tab-close"
                title={`Close ${d.name}`}
                aria-label={`Close ${d.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(d.id);
                }}
              >
                <XIcon />
              </button>
            )}
          </div>
        );
      })}
      <button className="desk-add" title="New desktop" aria-label="New desktop" onClick={onAdd}>
        <PlusIcon />
      </button>
    </div>
  );
}
