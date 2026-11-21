import { useState } from "react";
import { MoreVerticalIcon } from "./Icons.tsx";
import { Popover } from "./Popover.tsx";

export type ItemAction = {
  label: string;
  /** Asked before a step that cannot be taken back. */
  confirm?: string;
  danger?: boolean;
  run: () => unknown;
};

/** The "more" button on a row of a project or workspace page: what can be done with that one task, note, drawing or page. */
export function ItemActions({ label, items }: { label: string; items: ItemAction[] }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        className={`icon-btn square item-actions${anchor ? " open" : ""}`}
        title={label}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          setAnchor(e.currentTarget);
        }}
      >
        <MoreVerticalIcon />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} className="drawing-menu">
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={item.danger ? "danger" : ""}
              onClick={() => {
                setAnchor(null);
                if (item.confirm && !window.confirm(item.confirm)) return;
                void Promise.resolve(item.run()).catch(() => {});
              }}
            >
              <span className="ws-menu-label">{item.label}</span>
            </button>
          ))}
        </Popover>
      )}
    </>
  );
}

/** What can be done with a task from a page that lists it. */
export const taskActions = (
  api: { link: (id: number, workspaceId: number | null) => unknown; remove: (id: number) => unknown },
  task: { id: number; content: string },
  takeOut: string,
): ItemAction[] => [
  { label: takeOut, run: () => api.link(task.id, null) },
  { label: "Delete task", danger: true, confirm: `Delete “${task.content}”?`, run: () => api.remove(task.id) },
];
