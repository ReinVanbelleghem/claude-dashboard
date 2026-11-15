import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { agentApi, workspaceApi, type Workspace, type WorkspacesPayload } from "../../api.ts";
import { namedByBranch, workspaceTitle } from "../../../shared/workspaces.ts";
import {
  ChevronIcon,
  ClaudeMark,
  CommentIcon,
  DrawerOpenIcon,
  FolderIcon,
  FullPageIcon,
  GitIcon,
  ArchiveIcon,
  MoreVerticalIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  StopIcon,
  TasksIcon,
  TerminalIcon,
  TileWindowIcon,
  TrashIcon,
  WorktreeIcon,
} from "../Icons.tsx";
import { TitleEditInput } from "../EditableTitle.tsx";
import { Popover } from "../Popover.tsx";
import { SESSION_DRAG_MIME } from "../../tiles.ts";
import { useSortable, type Sortable } from "../../useSortable.ts";
import { DeleteProjectDialog, DeleteWorkspaceDialog } from "./DeleteWorkspaceDialog.tsx";
import { sidebarPrefs, useSidebarPrefs } from "./prefs.ts";
import { ageShort, buildTree, STATUS_LABEL, type Card, type Project, type SidebarSession, type StatusKind } from "./sessions.ts";

export type OpenOpts = { full?: boolean; tile?: boolean; drawer?: boolean; option?: boolean };

type MenuItem = { label: string; icon?: ReactNode; run: () => void; danger?: boolean; disabled?: boolean } | "sep" | { heading: string };
type Menu = { anchor: HTMLElement; items: MenuItem[] };

const offMain = (branch: string | null | undefined): branch is string => !!branch && !/^(main|master)$/.test(branch);

type SortProps = {
  /** Spread onto the heading that is grabbed to drag the item. Empty while sorting is off. */
  handle: Partial<ReturnType<Sortable["handleProps"]>>;
  style: CSSProperties | undefined;
  dragging: boolean;
};

const moved = <T,>(list: T[], from: number, to: number): T[] => {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
};

/** A heading is the drag handle, but its own buttons and a rename field are not. */
const grab = (handle: SortProps["handle"]) => ({
  ...handle,
  onPointerDown: (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest("input, .ws-hover-btn")) return;
    handle.onPointerDown?.(e);
  },
});

/** One reorderable list, on the app's own sortable: the lifted item follows the pointer and the rest slide aside. */
function SortableGroup<T>({
  items,
  itemSelector,
  className,
  disabled = false,
  onMove,
  children,
}: {
  items: T[];
  itemSelector: string;
  className?: string;
  disabled?: boolean;
  onMove: (from: number, to: number) => void;
  children: (item: T, sort: SortProps) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useSortable({ count: items.length, listRef: ref, itemSelector, onMove });
  return (
    <div ref={ref} className={className}>
      {items.map((item, i) =>
        children(item, {
          handle: disabled ? {} : drag.handleProps(i),
          style: drag.itemStyle(i),
          dragging: drag.active === i,
        }),
      )}
    </div>
  );
}

export function StatusDot({ kind }: { kind: StatusKind }) {
  return (
    <span className={`ws-st ws-st-${kind}`} title={STATUS_LABEL[kind]} role="img" aria-label={STATUS_LABEL[kind]}>
      {kind === "needs" ? (
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
          <path d="M7 3.5v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
          <circle cx="7" cy="10.4" r="1" fill="currentColor" />
        </svg>
      ) : kind === "failed" ? (
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
          <path d="M4.8 4.8l4.4 4.4M9.2 4.8l-4.4 4.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
        </svg>
      ) : null}
    </span>
  );
}

/**
 * The sidebar's list of running work: project, then workspace, then the
 * sessions each holds. Nothing here sorts by state, so a row stays where it was
 * while its status changes around it.
 */
export function WorkspaceTree({
  sessions,
  payload,
  activeId,
  minimized,
  workspaceTasks,
  onOpen,
  onNewWorkspace,
  onNewSession,
}: {
  sessions: SidebarSession[];
  payload: WorkspacesPayload | null;
  /** The session on screen, by session id or agent key. */
  activeId: string | null;
  /** Sessions whose tile is put away, marked on their row. */
  minimized: Set<string>;
  /** Workspace id to the text of each open task it holds. */
  workspaceTasks: Map<number, string[]>;
  onOpen: (id: string, opts?: OpenOpts) => void;
  /** The New workspace dialog, optionally on one project's folder. */
  onNewWorkspace: (folder?: string) => void;
  /** The new-session dialog on a folder, filed in a workspace when one is given. */
  onNewSession: (folder: string, workspaceId?: number) => void;
}) {
  const prefs = useSidebarPrefs();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<{ kind: "ws" | "session"; key: string } | null>(null);
  const [deleting, setDeleting] = useState<Workspace | null>(null);
  const [deletingProject, setDeletingProject] = useState<Project | null>(null);
  /** The session row being dragged: onto another row of its workspace to reorder, or out onto the page to open a tile. */
  const rowDrag = useRef<{ id: string; card: string | null } | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);

  const tree = useMemo(() => buildTree(sessions, payload), [sessions, payload]);
  const needsTotal = sessions.filter((s) => s.status === "needs").length;
  const only = prefs.onlyNeeds && needsTotal > 0;
  const folded = (key: string) => prefs.folds[key] === true;
  const isActive = (s: SidebarSession) => !!activeId && s.ids.includes(activeId);

  const openMenu = (e: ReactMouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ anchor: e.currentTarget as HTMLElement, items });
  };

  const sessionItems = (s: SidebarSession, home: Card | null, project: Project | null): MenuItem[] => {
    const items: MenuItem[] = [
      { label: "Open in drawer", icon: <DrawerOpenIcon />, run: () => onOpen(s.id, { drawer: true }) },
      { label: "Open in tile", icon: <TileWindowIcon />, run: () => onOpen(s.id, { tile: true }) },
      { label: "Open full page", icon: <FullPageIcon />, run: () => onOpen(s.id, { full: true }) },
    ];
    const key = s.agentKey;
    if (key) {
      items.push("sep", { label: "Rename", icon: <PencilIcon />, run: () => setRenaming({ kind: "session", key: s.id }) });
      if (s.status === "working") {
        items.push({ label: "Stop this turn", icon: <StopIcon />, run: () => void agentApi.interrupt(key).catch(() => {}) });
      }
    }
    const others = (project?.cards ?? []).filter((c) => c.ws && c.key !== home?.key);
    if (others.length > 0) {
      items.push("sep", { heading: "Move to" });
      for (const c of others.slice(0, 8)) {
        items.push({
          label: c.title,
          icon: <WorktreeIcon />,
          run: () => void workspaceApi.attach(c.ws!.id, s.ids).catch(() => {}),
        });
      }
    }
    if (key) {
      items.push("sep", {
        label: s.status === "ended" || s.status === "failed" ? "Clear from the sidebar" : "End session",
        icon: <TrashIcon />,
        danger: true,
        run: () => void agentApi.stop(key).catch(() => {}),
      });
    }
    return items;
  };

  const cardItems = (c: Card): MenuItem[] => {
    const w = c.ws;
    if (!w) return [];
    return [
      { label: "New session here", icon: <PlusIcon />, run: () => onNewSession(w.folder, w.id) },
      { label: "Rename goal…", icon: <PencilIcon />, run: () => setRenaming({ kind: "ws", key: c.key }) },
      "sep",
      {
        label: c.rows.length > 0 ? "Archive and end its sessions" : "Archive",
        icon: <ArchiveIcon />,
        run: () => void workspaceApi.archive(w.id).catch(() => {}),
      },
      ...(workspaceTasks.get(w.id)?.length
        ? [
            {
              label: `Archive and complete its ${workspaceTasks.get(w.id)!.length === 1 ? "task" : `${workspaceTasks.get(w.id)!.length} tasks`}`,
              icon: <TasksIcon />,
              run: () => void workspaceApi.archive(w.id, { completeTasks: true }).catch(() => {}),
            },
          ]
        : []),
      { label: "Delete…", icon: <TrashIcon />, danger: true, run: () => setDeleting(w) },
    ];
  };

  const restItems = (w: Workspace): MenuItem[] => [
    { label: "Reopen", icon: <PlayIcon />, run: () => void workspaceApi.resume(w.id).catch(() => {}) },
    { label: "Delete…", icon: <TrashIcon />, danger: true, run: () => setDeleting(w) },
  ];

  const row = (s: SidebarSession, home: Card | null, project: Project | null) => {
    const editing = renaming?.kind === "session" && renaming.key === s.id;
    const put = s.ids.some((id) => minimized.has(id));
    const sortable = !only && !!home?.ws && home.rows.length > 1;
    const drop = dropAt?.id === s.id ? (dropAt.after ? " drop-after" : " drop-before") : "";
    return (
      <div
        key={s.id}
        className={`ws-row${isActive(s) ? " on" : ""}${s.status === "ended" ? " ended" : ""}${drop}`}
        draggable={!editing}
        onDragStart={(e) => {
          e.dataTransfer.setData(SESSION_DRAG_MIME, s.id);
          e.dataTransfer.effectAllowed = "copyMove";
          rowDrag.current = { id: s.id, card: home?.key ?? null };
        }}
        onDragEnd={() => {
          rowDrag.current = null;
          setDropAt(null);
        }}
        onDragOver={(e) => {
          const from = rowDrag.current;
          if (!sortable || !from || from.card !== home?.key || from.id === s.id) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const after = home.rows.findIndex((r) => r.id === s.id) > home.rows.findIndex((r) => r.id === from.id);
          setDropAt((prev) => (prev?.id === s.id && prev.after === after ? prev : { id: s.id, after }));
        }}
        onDrop={(e) => {
          const from = rowDrag.current;
          if (!home || !from || !dropAt || dropAt.id !== s.id) return;
          e.preventDefault();
          const rest = home.rows.filter((r) => r.id !== from.id);
          const dragged = home.rows.find((r) => r.id === from.id);
          if (!dragged) return;
          rest.splice(rest.findIndex((r) => r.id === s.id) + (dropAt.after ? 1 : 0), 0, dragged);
          setDropAt(null);
          void workspaceApi.reorder({ sessions: rest.map((r) => r.ids) }).catch(() => {});
        }}
        role="button"
        tabIndex={0}
        title={[s.title, s.model, s.external ? "started in a terminal" : null, s.cwd].filter(Boolean).join("\n")}
        onClick={(e) => {
          if (editing) return;
          onOpen(s.id, { full: e.metaKey || e.ctrlKey, option: e.altKey });
        }}
        onAuxClick={(e) => e.button === 1 && onOpen(s.id, { full: true })}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && e.key === "Enter") onOpen(s.id, { option: e.altKey });
        }}
        onContextMenu={(e) => openMenu(e, sessionItems(s, home, project))}
      >
        <StatusDot kind={s.status} />
        <ClaudeMark />
        <span className="ws-row-text">
          {editing ? (
            <span className="ws-row-title">
              <TitleEditInput
                initial={s.title}
                onCancel={() => setRenaming(null)}
                onCommit={(v) => {
                  setRenaming(null);
                  if (v && v !== s.title && s.agentKey) void agentApi.rename(s.agentKey, v).catch(() => {});
                }}
              />
            </span>
          ) : (
            <span className="ws-row-title">{s.title}</span>
          )}
          {s.why && <span className="ws-row-why">{s.why}</span>}
        </span>
        {put && (
          <span className="ws-row-ext" title="Its tile is put away. Open it as a tile, or drag it onto the Desktop, to bring it back.">
            <TileWindowIcon />
          </span>
        )}
        {s.external && (
          <span className="ws-row-ext" title="Started in a terminal">
            <TerminalIcon />
          </span>
        )}
        <span className="ws-row-age">{ageShort(s.at)}</span>
        <button
          className="ws-hover-btn"
          title="Session actions"
          aria-label={`Actions for ${s.title}`}
          onClick={(e) => openMenu(e, sessionItems(s, home, project))}
        >
          <MoreVerticalIcon />
        </button>
      </div>
    );
  };

  const sessionRows = (c: Card, p: Project, rows: SidebarSession[], className: string) => (
    <div key={c.key} className={className}>
      {rows.map((s) => row(s, c, p))}
    </div>
  );

  const cardView = (c: Card, p: Project, sort?: SortProps) => {
    const rows = only ? c.rows.filter((r) => r.status === "needs") : c.rows;
    if (only && rows.length === 0) return null;
    const current = c.rows.some(isActive);
    const editing = renaming?.kind === "ws" && renaming.key === c.key;
    const foldKey = `c:${c.key}`;
    const shut = folded(foldKey) && !only && c.rows.length > 0;
    const toggle = () => !editing && c.rows.length > 0 && sidebarPrefs.fold(foldKey, !shut);
    if (c.bare && !editing) {
      return rows.length > 0 ? (
        sessionRows(c, p, rows, "ws-rows bare")
      ) : null;
    }
    return (
      <div
        key={c.key}
        className={`ws-card${current ? " current" : ""}${editing ? " editing" : ""}${sort?.dragging ? " dragging" : ""}`}
        style={sort?.style}
      >
        <div
          className="ws-card-head"
          role="button"
          tabIndex={0}
          title={c.ws ? [c.title, c.ws.branch, c.ws.folder].filter(Boolean).join("\n") : c.title}
          aria-expanded={!shut}
          onClick={toggle}
          onPointerDown={sort && !editing ? grab(sort.handle).onPointerDown : undefined}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter") toggle();
            else sort?.handle.onKeyDown?.(e);
          }}
          onContextMenu={(e) => c.ws && openMenu(e, cardItems(c))}
        >
          <span className={`ws-chev${shut ? "" : " open"}${c.rows.length === 0 ? " none" : ""}`}>
            <ChevronIcon />
          </span>
          <span className="ws-card-text">
            {editing && c.ws ? (
              <span className="ws-card-title">
                <TitleEditInput
                  initial={c.ws.goal}
                  placeholder="Name this workspace"
                  onCancel={() => setRenaming(null)}
                  onCommit={(v) => {
                    setRenaming(null);
                    if (v !== c.ws!.goal) void workspaceApi.rename(c.ws!.id, v).catch(() => {});
                  }}
                />
              </span>
            ) : (
              <span className={`ws-card-title${c.ws && namedByBranch(c.ws) ? " branch" : ""}`}>
                {c.ws && namedByBranch(c.ws) && <GitIcon />}
                {c.title}
              </span>
            )}
          </span>
          {c.ws && !namedByBranch(c.ws) && offMain(c.ws.branch) && (
            <span className="ws-card-sub" title={`Branch ${c.ws!.branch}`}>
              <GitIcon />
              {c.ws!.branch}
            </span>
          )}
          {c.ws && workspaceTasks.get(c.ws.id)?.length ? (
            <span className="ws-card-task" title={`Open tasks:\n${workspaceTasks.get(c.ws.id)!.join("\n")}`}>
              <TasksIcon />
              {workspaceTasks.get(c.ws.id)!.length > 1 && workspaceTasks.get(c.ws.id)!.length}
            </span>
          ) : null}
          {c.rows.length === 0 && <span className="ws-card-empty">empty</span>}
          {c.ws && (
            <>
              <button
                className="ws-hover-btn"
                title="Workspace actions"
                aria-label={`Actions for ${c.title}`}
                onClick={(e) => openMenu(e, cardItems(c))}
              >
                <MoreVerticalIcon />
              </button>
              <span className="ws-project-trail">
                {shut && (
                  <span className="ws-project-count">
                    {c.status !== "idle" && c.status !== "ended" && <StatusDot kind={c.status} />}
                    {c.rows.length}
                  </span>
                )}
                <button
                  className={`ws-hover-btn${shut ? "" : " show"}`}
                  title={`New session in ${c.title}`}
                  aria-label={`New session in ${c.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onNewSession(c.ws!.folder, c.ws!.id);
                  }}
                >
                  <PlusIcon />
                </button>
              </span>
            </>
          )}
        </div>
        {rows.length > 0 && !shut && sessionRows(c, p, rows, "ws-rows")}
      </div>
    );
  };

  const projectView = (p: Project, sort?: SortProps) => {
    const key = `p:${p.key}`;
    const shut = folded(key) && !only;
    const needs = p.cards.reduce((n, c) => n + c.needs, 0);
    if (only && needs === 0) return null;
    const restKey = `rest:${p.key}`;
    const bare = p.cards.find((c) => c.bare);
    const projectItems: MenuItem[] = [
      {
        label: "New session",
        icon: <PlusIcon />,
        run: () => (bare?.ws ? onNewSession(bare.ws.folder, bare.ws.id) : onNewSession(p.root)),
      },
      { label: "New workspace…", icon: <WorktreeIcon />, run: () => onNewWorkspace(p.root) },
    ];
    if (bare?.ws) {
      projectItems.push("sep", { label: "Name the sessions here…", icon: <PencilIcon />, run: () => setRenaming({ kind: "ws", key: bare.key }) });
    }
    projectItems.push("sep", {
      label: "Delete project…",
      icon: <TrashIcon />,
      danger: true,
      run: () => setDeletingProject(p),
    });
    const rest = [...p.paused, ...p.archived];
    const named = p.cards.filter((c) => !c.bare);
    return (
      <section key={p.key} className={`ws-project${sort?.dragging ? " dragging" : ""}`} style={sort?.style}>
        <div
          className="ws-project-head"
          onContextMenu={(e) => openMenu(e, projectItems)}
          onPointerDown={sort ? grab(sort.handle).onPointerDown : undefined}
          onKeyDown={(e) => (e.target as HTMLElement).classList.contains("ws-project-btn") && sort?.handle.onKeyDown?.(e)}
        >
          <button
            className="ws-project-btn"
            aria-expanded={!shut}
            title={p.root}
            onClick={() => sidebarPrefs.fold(key, !shut)}
          >
            <span className={`ws-chev${shut ? "" : " open"}`}>
              <ChevronIcon />
            </span>
            <FolderIcon open={!shut} />
            <span className="ws-project-name">{p.name}</span>
            {!shut && offMain(bare?.ws?.branch) && <span className="ws-project-branch">{bare!.ws!.branch}</span>}
          </button>
          <span className="ws-project-trail">
            {shut && (
              <span className="ws-project-count">
                {needs > 0 && <StatusDot kind="needs" />}
                {p.cards.reduce((n, c) => n + c.rows.length, 0)}
              </span>
            )}
            <button
              className={`ws-hover-btn${shut || p.cards.some((c) => !c.bare) ? "" : " show"}`}
              title={`Start something in ${p.name}`}
              aria-label={`Start a session or workspace in ${p.name}`}
              onClick={(e) => openMenu(e, projectItems)}
            >
              <PlusIcon />
            </button>
          </span>
        </div>
        {!shut && (
          <>
            {p.cards.filter((c) => c.bare).map((c) => cardView(c, p))}
            <SortableGroup
              items={named}
              itemSelector=":scope > .ws-card"
              disabled={only || named.length < 2}
              onMove={(from, to) => {
                const ids = moved(named, from, to).flatMap((c) => (c.ws ? [c.ws.id] : []));
                void workspaceApi.reorder({ ids }).catch(() => {});
              }}
            >
              {(c, s) => cardView(c, p, s)}
            </SortableGroup>
            {rest.length > 0 && !only && (
              <>
                <button
                  className="ws-rest-btn"
                  aria-expanded={prefs.folds[restKey] === false}
                  onClick={() => sidebarPrefs.fold(restKey, prefs.folds[restKey] === false)}
                >
                  {rest.length} archived
                </button>
                {prefs.folds[restKey] === false &&
                  rest.map((w) => (
                    <div key={w.id} className="ws-rest-row" onContextMenu={(e) => openMenu(e, restItems(w))}>
                      <span className="ws-rest-title" title={w.folder}>
                        {workspaceTitle(w)}
                      </span>
                      <button
                        className="ws-hover-btn show"
                        title="Reopen or delete"
                        aria-label={`Actions for ${workspaceTitle(w)}`}
                        onClick={(e) => openMenu(e, restItems(w))}
                      >
                        <MoreVerticalIcon />
                      </button>
                    </div>
                  ))}
              </>
            )}
          </>
        )}
      </section>
    );
  };

  const chats = only ? tree.chats.filter((s) => s.status === "needs") : tree.chats;
  const empty = tree.projects.length === 0 && tree.chats.length === 0;

  return (
    <div
      className="ws-tree"
      aria-label="Workspaces"
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes(SESSION_DRAG_MIME)) return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="ws-head">
        <span className="ws-head-label">Workspaces</span>
        {needsTotal > 0 && (
          <button
            className={`ws-filter${only ? " on" : ""}`}
            aria-pressed={only}
            title={only ? "Show everything" : "Only what waits on you"}
            onClick={() => sidebarPrefs.setOnlyNeeds(!prefs.onlyNeeds)}
          >
            <StatusDot kind="needs" />
            {needsTotal}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button
          className="ws-hover-btn show"
          title="New workspace"
          aria-label="New workspace"
          onClick={() => onNewWorkspace()}
        >
          <PlusIcon />
        </button>
      </div>
      <div className="ws-scroll">
        {empty && (
          <div className="ws-empty">
            Nothing running.
            <button className="ws-link" onClick={() => onNewWorkspace()}>
              Start a workspace
            </button>
          </div>
        )}
        <SortableGroup
          items={tree.projects}
          itemSelector=":scope > .ws-project"
          disabled={only || tree.projects.length < 2}
          onMove={(from, to) => {
            const projects = moved(tree.projects, from, to).map((p) => p.key);
            void workspaceApi.reorder({ projects }).catch(() => {});
          }}
        >
          {(p, s) => projectView(p, s)}
        </SortableGroup>
        {chats.length > 0 && (
          <section className="ws-project">
            <div className="ws-project-head">
              <button
                className="ws-project-btn"
                aria-expanded={!folded("chats")}
                onClick={() => sidebarPrefs.fold("chats", !folded("chats"))}
              >
                <span className={`ws-chev${folded("chats") ? "" : " open"}`}>
                  <ChevronIcon />
                </span>
                <CommentIcon />
                <span className="ws-project-name">Chats</span>
              </button>
              <span className="ws-project-trail">
                <span className="ws-project-count">{chats.length}</span>
              </span>
            </div>
            {(!folded("chats") || only) && <div className="ws-rows flat">{chats.map((s) => row(s, null, null))}</div>}
          </section>
        )}
      </div>
      {deletingProject && (
        <DeleteProjectDialog
          project={deletingProject}
          workspaces={(payload?.workspaces ?? []).filter((w) => w.projectKey === deletingProject.key).length}
          sessions={deletingProject.cards.reduce((n, c) => n + c.rows.length, 0)}
          onClose={() => setDeletingProject(null)}
        />
      )}
      {deleting && (
        <DeleteWorkspaceDialog
          workspace={deleting}
          sessions={sessions.filter((s) => s.ids.some((id) => payload?.sessions[id] === deleting.id)).length}
          shared={
            (payload?.workspaces ?? []).filter(
              (o) => o.id !== deleting.id && o.status !== "archived" && o.folder === deleting.folder,
            ).length
          }
          onClose={() => setDeleting(null)}
        />
      )}
      {menu && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)}>
          {menu.items.map((it, i) =>
            it === "sep" ? (
              <hr key={i} />
            ) : "heading" in it ? (
              <div key={i} className="svc-menu-heading">
                {it.heading}
              </div>
            ) : (
              <button
                key={i}
                role="menuitem"
                className={it.danger ? "danger" : ""}
                disabled={it.disabled}
                onClick={() => {
                  setMenu(null);
                  it.run();
                }}
              >
                {it.icon}
                <span className="ws-menu-label">{it.label}</span>
              </button>
            ),
          )}
        </Popover>
      )}
    </div>
  );
}
