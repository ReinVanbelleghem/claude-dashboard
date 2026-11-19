import {
  Fragment,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { agentApi, terminalApi, workspaceApi, type Artifact, type Workspace, type WorkspacesPayload } from "../../api.ts";
import { artifactKey } from "../../../shared/artifacts.ts";
import { terminalIdOf } from "../../../shared/terminals.ts";
import { namedByBranch, workspaceTitle } from "../../../shared/workspaces.ts";
import {
  ArtifactIcon,
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

const INLINE_ARTIFACTS = 2;

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
  workspaceArtifacts,
  sessionArtifacts,
  onOpen,
  onNewWorkspace,
  onNewSession,
  onNewChat,
  onOpenWorkspace,
  onNewTerminal,
  activeWorkspaceId,
}: {
  sessions: SidebarSession[];
  payload: WorkspacesPayload | null;
  /** The session on screen, by session id or agent key. */
  activeId: string | null;
  /** Sessions whose tile is put away, marked on their row. */
  minimized: Set<string>;
  /** Workspace id to the text of each open task it holds. */
  workspaceTasks: Map<number, string[]>;
  /** The pages each workspace's sessions wrote, listed under it. */
  workspaceArtifacts: Map<number, Artifact[]>;
  /** The pages each session wrote, for sessions that sit outside a workspace. */
  sessionArtifacts: Map<string, Artifact[]>;
  onOpen: (id: string, opts?: OpenOpts) => void;
  /** The New workspace dialog, optionally on one project's folder. */
  onNewWorkspace: (folder?: string) => void;
  /** The new-session dialog on a folder, filed in a workspace when one is given. */
  onNewSession: (folder: string, workspaceId?: number) => void;
  /** Start a chat that belongs to no project. */
  onNewChat: () => void;
  /** Open a shell in a workspace's folder. */
  onNewTerminal: (folder: string, workspaceId: number | null) => void;
  /** Open a workspace's own page: its changes, git, worktrees and artifacts. */
  onOpenWorkspace: (workspace: Workspace) => void;
  /** The workspace whose page is on screen. */
  activeWorkspaceId: number | null;
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
    if (s.terminal) {
      return [
        ...items,
        "sep",
        { label: "Rename", icon: <PencilIcon />, run: () => setRenaming({ kind: "session", key: s.id }) },
        { label: "End terminal", icon: <TrashIcon />, danger: true, run: () => void terminalApi.close(terminalIdOf(s.id)).catch(() => {}) },
      ];
    }
    if (s.resumable) {
      return [
        { label: "Resume", icon: <PlayIcon />, run: () => void agentApi.restore(s.id).catch(() => {}) },
        "sep",
        ...items,
        "sep",
        { label: "Remove from the list", icon: <TrashIcon />, run: () => void agentApi.forget(s.id).catch(() => {}) },
      ];
    }
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
      { label: "Open workspace", icon: <FolderIcon open />, run: () => onOpenWorkspace(w) },
      { label: "New session here", icon: <PlusIcon />, run: () => onNewSession(w.folder, w.id) },
      { label: "New terminal here", icon: <TerminalIcon />, run: () => onNewTerminal(w.folder, w.id) },
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

  const row = (s: SidebarSession, home: Card | null, project: Project | null, flat: Card | null = null) => {
    const editing = renaming?.kind === "session" && renaming.key === s.id;
    const rowItems = (): MenuItem[] =>
      flat?.ws ? [...sessionItems(s, home, project), "sep", { heading: "Workspace" }, ...cardItems(flat)] : sessionItems(s, home, project);
    const rowTitle = flat ? flat.title : s.title;
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
        title={[flat?.title, s.title, s.model, s.external ? "started in a terminal" : null, s.cwd].filter(Boolean).join("\n")}
        onClick={(e) => {
          if (editing) return;
          onOpen(s.id, { full: e.metaKey || e.ctrlKey, option: e.altKey });
        }}
        onAuxClick={(e) => e.button === 1 && onOpen(s.id, { full: true })}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && e.key === "Enter") onOpen(s.id, { option: e.altKey });
        }}
        onContextMenu={(e) => openMenu(e, rowItems())}
      >
        <span className={`ws-mark ws-mark-${s.status}`} title={STATUS_LABEL[s.status]} role="img" aria-label={STATUS_LABEL[s.status]}>
          {s.terminal ? <TerminalIcon /> : <ClaudeMark />}
        </span>
        {s.resumable && (
          <button
            className="ws-hover-btn ws-resume"
            title="Resume this conversation"
            aria-label={`Resume ${s.title}`}
            onClick={(e) => {
              e.stopPropagation();
              void agentApi.restore(s.id).catch(() => {});
            }}
          >
            <PlayIcon />
          </button>
        )}
        <span className="ws-row-text">
          {editing ? (
            <span className="ws-row-title">
              <TitleEditInput
                initial={s.title}
                onCancel={() => setRenaming(null)}
                onCommit={(v) => {
                  setRenaming(null);
                  if (!v || v === s.title) return;
                  if (s.terminal) void terminalApi.rename(terminalIdOf(s.id), v).catch(() => {});
                  else if (s.agentKey) void agentApi.rename(s.agentKey, v).catch(() => {});
                }}
              />
            </span>
          ) : (
            <span className="ws-row-title">{rowTitle}</span>
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
          aria-label={`Actions for ${rowTitle}`}
          onClick={(e) => openMenu(e, rowItems())}
        >
          <MoreVerticalIcon />
        </button>
      </div>
    );
  };

  const artifactItems = (a: Artifact): MenuItem[] => [
    { label: "Open in drawer", icon: <DrawerOpenIcon />, run: () => onOpen(artifactKey(a.slug), { drawer: true }) },
    { label: "Open in tile", icon: <TileWindowIcon />, run: () => onOpen(artifactKey(a.slug), { tile: true }) },
    { label: "Open full page", icon: <FullPageIcon />, run: () => onOpen(artifactKey(a.slug), { full: true }) },
  ];

  const artifactsOf = (ws: Workspace | null, rows: SidebarSession[]): Artifact[] => {
    const bySlug = new Map<string, Artifact>();
    for (const a of ws ? (workspaceArtifacts.get(ws.id) ?? []) : []) bySlug.set(a.slug, a);
    for (const s of rows) for (const id of s.ids) for (const a of sessionArtifacts.get(id) ?? []) bySlug.set(a.slug, a);
    return [...bySlug.values()].sort((a, b) => (b.modifiedTs ?? 0) - (a.modifiedTs ?? 0));
  };

  const artifactGroup = (groupKey: string, list: Artifact[], bare: boolean) => {
    if (list.length === 0 || only) return null;
    const key = `art:${groupKey}`;
    const inline = list.length <= INLINE_ARTIFACTS;
    const open = inline || prefs.folds[key] === false;
    return (
      <div key={key} className={`ws-arts${bare ? " bare" : ""}${inline ? " inline" : ""}`}>
        {!inline && (
          <button className="ws-arts-head" aria-expanded={open} onClick={() => sidebarPrefs.fold(key, open)}>
            <span className={`ws-arts-chev${open ? " open" : ""}`}>
              <ChevronIcon />
            </span>
            <ArtifactIcon />
            <span className="ws-arts-name">Artifacts</span>
            <span className="ws-arts-count">{list.length}</span>
          </button>
        )}
        {open &&
          list.map((a) => {
            const id = artifactKey(a.slug);
            return (
              <div
                key={a.slug}
                className={`ws-row ws-art${activeId === id ? " on" : ""}`}
                role="button"
                tabIndex={0}
                draggable
                title={`${a.title}\n${a.entry}`}
                onDragStart={(e) => {
                  e.dataTransfer.setData(SESSION_DRAG_MIME, id);
                  e.dataTransfer.effectAllowed = "copyMove";
                }}
                onClick={(e) => onOpen(id, { full: e.metaKey || e.ctrlKey, option: e.altKey })}
                onAuxClick={(e) => e.button === 1 && onOpen(id, { full: true })}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && e.key === "Enter") onOpen(id, { option: e.altKey });
                }}
                onContextMenu={(e) => openMenu(e, artifactItems(a))}
              >
                {inline && (
                  <span className="ws-mark">
                    <ArtifactIcon />
                  </span>
                )}
                <span className="ws-row-text">
                  <span className="ws-row-title">{a.title}</span>
                </span>
                <span className="ws-row-age">{a.modifiedTs ? ageShort(a.modifiedTs) : ""}</span>
                <button className="ws-hover-btn" title="Artifact actions" aria-label={`Actions for ${a.title}`} onClick={(e) => openMenu(e, artifactItems(a))}>
                  <MoreVerticalIcon />
                </button>
              </div>
            );
          })}
      </div>
    );
  };

  const isEmptyCard = (c: Card) =>
    c.rows.length === 0 && artifactsOf(c.ws, []).length === 0 && !(renaming?.kind === "ws" && renaming.key === c.key);
  const isEmptyProject = (p: Project) => p.cards.every(isEmptyCard);

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
        <Fragment key={c.key}>
          {sessionRows(c, p, rows, "ws-rows bare")}
          {artifactGroup(c.key, artifactsOf(c.ws, c.rows), true)}
        </Fragment>
      ) : null;
    }
    const arts = artifactsOf(c.ws, c.rows);
    if (!editing && c.ws && c.rows.length === 1 && rows.length === 1 && arts.length === 0) {
      return (
        <div
          key={c.key}
          className={`ws-card flat${c.ws.id === activeWorkspaceId ? " open-page" : ""}${sort?.dragging ? " dragging" : ""}`}
          style={sort?.style}
        >
          <div className="ws-rows bare">{row(rows[0]!, c, p, c)}</div>
        </div>
      );
    }
    return (
      <div
        key={c.key}
        className={`ws-card${current ? " current" : ""}${c.ws && c.ws.id === activeWorkspaceId ? " open-page" : ""}${editing ? " editing" : ""}${sort?.dragging ? " dragging" : ""}`}
        style={sort?.style}
      >
        <div
          className="ws-card-head"
          role="button"
          tabIndex={0}
          title={c.ws ? [c.title, c.ws.branch, c.ws.folder].filter(Boolean).join("\n") : c.title}
          aria-expanded={!shut}
          onClick={() => (c.ws && !editing ? onOpenWorkspace(c.ws) : toggle())}
          onPointerDown={sort && !editing ? grab(sort.handle).onPointerDown : undefined}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter") (c.ws && !editing ? onOpenWorkspace(c.ws) : toggle());
            else sort?.handle.onKeyDown?.(e);
          }}
          onContextMenu={(e) => c.ws && openMenu(e, cardItems(c))}
        >
          <span
            className={`ws-chev${shut ? "" : " open"}${c.rows.length === 0 ? " none" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
          >
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
                  className="ws-hover-btn"
                  title={`Start something in ${c.title}`}
                  aria-label={`Start a session or terminal in ${c.title}`}
                  onClick={(e) =>
                    openMenu(e, [
                      { label: "New session", icon: <PlusIcon />, run: () => onNewSession(c.ws!.folder, c.ws!.id) },
                      { label: "New terminal", icon: <TerminalIcon />, run: () => onNewTerminal(c.ws!.folder, c.ws!.id) },
                    ])
                  }
                >
                  <PlusIcon />
                </button>
              </span>
            </>
          )}
        </div>
        {rows.length > 0 && !shut && sessionRows(c, p, rows, "ws-rows")}
        {!shut && artifactGroup(c.key, arts, false)}
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
      {
        label: "New terminal",
        icon: <TerminalIcon />,
        run: () => (bare?.ws ? onNewTerminal(bare.ws.folder, bare.ws.id) : onNewTerminal(p.root, null)),
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
    const named = p.cards.filter((c) => !c.bare && !isEmptyCard(c));
    const empties = p.cards.filter((c) => !c.bare && isEmptyCard(c));
    const emptyKey = `empty:${p.key}`;
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
              className="ws-hover-btn"
              title={`Start something in ${p.name}`}
              aria-label={`Start a session, terminal or workspace in ${p.name}`}
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
                const ids = [...moved(named, from, to), ...empties].flatMap((c) => (c.ws ? [c.ws.id] : []));
                void workspaceApi.reorder({ ids }).catch(() => {});
              }}
            >
              {(c, s) => cardView(c, p, s)}
            </SortableGroup>
            {empties.length > 0 && !only && (
              <>
                <button
                  className="ws-rest-btn"
                  aria-expanded={prefs.folds[emptyKey] === false}
                  onClick={() => sidebarPrefs.fold(emptyKey, prefs.folds[emptyKey] === false)}
                >
                  {empties.length} empty
                </button>
                {prefs.folds[emptyKey] === false && empties.map((c) => cardView(c, p))}
              </>
            )}
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

  const filledProjects = tree.projects.filter((p) => !isEmptyProject(p));
  const emptyProjects = tree.projects.filter(isEmptyProject);
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
          items={filledProjects}
          itemSelector=":scope > .ws-project"
          disabled={only || filledProjects.length < 2}
          onMove={(from, to) => {
            const projects = [...moved(filledProjects, from, to), ...emptyProjects].map((p) => p.key);
            void workspaceApi.reorder({ projects }).catch(() => {});
          }}
        >
          {(p, s) => projectView(p, s)}
        </SortableGroup>
        {(!only || chats.length > 0) && (
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
                <span className="ws-project-name">Standalone chats</span>
              </button>
              <span className="ws-project-trail">
                {chats.length > 0 && folded("chats") && <span className="ws-project-count">{chats.length}</span>}
                <button
                  className="ws-hover-btn"
                  title="Start a chat or terminal"
                  aria-label="Start a standalone chat or terminal"
                  onClick={(e) =>
                    openMenu(e, [
                      { label: "New chat", icon: <PlusIcon />, run: () => onNewChat() },
                      { label: "New terminal", icon: <TerminalIcon />, run: () => onNewTerminal("~", null) },
                    ])
                  }
                >
                  <PlusIcon />
                </button>
              </span>
            </div>
            {(!folded("chats") || only) && chats.length > 0 && <div className="ws-rows flat">{chats.map((s) => row(s, null, null))}</div>}
            {!folded("chats") && artifactGroup("chats", artifactsOf(null, tree.chats), true)}
          </section>
        )}
        {emptyProjects.length > 0 && !only && (
          <>
            <button
              className="ws-rest-btn ws-empty-projects"
              aria-expanded={prefs.folds["empty-projects"] === false}
              onClick={() => sidebarPrefs.fold("empty-projects", prefs.folds["empty-projects"] === false)}
            >
              {emptyProjects.length} empty {emptyProjects.length === 1 ? "project" : "projects"}
            </button>
            {prefs.folds["empty-projects"] === false && emptyProjects.map((p) => projectView(p))}
          </>
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
