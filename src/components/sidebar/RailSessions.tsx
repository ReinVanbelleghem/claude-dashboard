import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { WorkspacesPayload } from "../../api.ts";
import { SESSION_DRAG_MIME } from "../../tiles.ts";
import { ageShort, buildTree, STATUS_LABEL, type SidebarSession } from "./sessions.ts";
import { StatusDot, type OpenOpts } from "./WorkspaceTree.tsx";

type Entry = { session: SidebarSession; project: string | null; workspace: string | null };
type Tip = { entry: Entry; top: number; left: number };

/**
 * The sessions in the collapsed sidebar: one status dot each, in the same order
 * as the open tree, with a gap between projects. There is no room for a name,
 * so hovering a dot says which session it is, where it lives and what it is
 * doing.
 */
export function RailSessions({
  sessions,
  payload,
  activeId,
  onOpen,
}: {
  sessions: SidebarSession[];
  payload: WorkspacesPayload | null;
  activeId: string | null;
  onOpen: (id: string, opts?: OpenOpts) => void;
}) {
  const [tip, setTip] = useState<Tip | null>(null);

  const groups = useMemo(() => {
    const tree = buildTree(sessions, payload);
    const out: Entry[][] = tree.projects
      .map((p) =>
        p.cards.flatMap((c) =>
          c.rows.map((session) => ({ session, project: p.name, workspace: c.bare ? null : c.title })),
        ),
      )
      .filter((g) => g.length > 0);
    if (tree.chats.length > 0) out.push(tree.chats.map((session) => ({ session, project: "Chats", workspace: null })));
    return out;
  }, [sessions, payload]);

  if (groups.length === 0) return null;

  return (
    <div className="ws-rail" aria-label="Sessions">
      {groups.map((group, i) => (
        <div key={i} className="ws-rail-group">
          {group.map((entry) => {
            const s = entry.session;
            const on = !!activeId && s.ids.includes(activeId);
            return (
              <button
                key={s.id}
                className={`ws-rail-item${on ? " on" : ""}`}
                aria-label={`${s.title}, ${STATUS_LABEL[s.status]}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(SESSION_DRAG_MIME, s.id);
                  e.dataTransfer.effectAllowed = "copyMove";
                  setTip(null);
                }}
                onClick={(e) => onOpen(s.id, { full: e.metaKey || e.ctrlKey, option: e.altKey })}
                onPointerEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setTip({ entry, top: r.top + r.height / 2, left: r.right + 10 });
                }}
                onPointerLeave={() => setTip(null)}
                onFocus={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setTip({ entry, top: r.top + r.height / 2, left: r.right + 10 });
                }}
                onBlur={() => setTip(null)}
              >
                <StatusDot kind={s.status} />
              </button>
            );
          })}
        </div>
      ))}
      {tip &&
        createPortal(
          <div className="ws-rail-tip" role="tooltip" style={{ top: tip.top, left: tip.left }}>
            <strong>{tip.entry.session.title}</strong>
            <span>{[tip.entry.project, tip.entry.workspace].filter(Boolean).join(" › ")}</span>
            <span>
              {tip.entry.session.why ?? STATUS_LABEL[tip.entry.session.status]}
              {tip.entry.session.at > 0 && ` · ${ageShort(tip.entry.session.at)}`}
            </span>
          </div>,
          document.body,
        )}
    </div>
  );
}
