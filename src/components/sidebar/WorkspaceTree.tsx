import { markColorValue, markKey } from "../../../shared/projectMarks.ts";
import { parseProjectFileId } from "../../../shared/projectFiles.ts";
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
import { agentApi, artifactApi, drawingApi, noteApi, servicesApi, terminalApi, workspaceApi, type Artifact, type Workspace, type WorkspacesPayload } from "../../api.ts";
import { serviceSessionOf } from "../../../shared/services.ts";
import { artifactKey } from "../../../shared/artifacts.ts";
import { drawingKey, type Drawing } from "../../../shared/drawings.ts";
import { useDrawings } from "../DrawingsView.tsx";
import { useNotes } from "../NotePane.tsx";
import { noteRoot, noteKey, type Note } from "../../../shared/notes.ts";
import { terminalIdOf } from "../../../shared/terminals.ts";
import { namedByBranch, workspaceTitle } from "../../../shared/workspaces.ts";
import {
  ArtifactIcon,
  ChevronIcon,
  ClaudeMark,
  CommentIcon,
  DocIcon,
  DrawerOpenIcon,
  DrawingIcon,
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
  ServiceIcon, TerminalIcon,
  TileWindowIcon,
  TrashIcon,
  WorktreeIcon,
  XIcon,
} from "../Icons.tsx";
import { TitleEditInput } from "../EditableTitle.tsx";
import { Popover } from "../Popover.tsx";
import { hasOwnMark, OwnProjectMark, ProjectIcon, ProjectMark, ProjectMarkPicker } from "../ProjectMark.tsx";
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

/**
 * Put a project's rows in the order they were dragged into. One that has no
 * place yet, a new workspace or the first note, goes right after whatever it
 * follows by default, so it never jumps to the far end.
 */
function inSavedOrder<T extends { key: string }>(items: T[], saved: string[] | undefined): T[] {
  if (!saved?.length) return items;
  const rank = new Map(saved.map((key, i) => [key, i]));
  const out = items.filter((s) => rank.has(s.key)).sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  items.forEach((s, i) => {
    if (rank.has(s.key)) return;
    const before = items
      .slice(0, i)
      .reverse()
      .find((x) => out.includes(x));
    out.splice(before ? out.indexOf(before) + 1 : 0, 0, s);
  });
  return out;
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
  workspaceArtifacts,
  projectArtifacts,
  sessionArtifacts,
  onOpen,
  onNewWorkspace,
  onNewSession,
  onNewProjectSession,
  onNewProjectTerminal,
  onNewChat,
  onOpenWorkspace,
  onNewTerminal,
  activeWorkspaceId,
  onOpenProject,
  activeProjectId,
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
  /** The pages put on a project as a whole, by hand. */
  projectArtifacts: Map<number, Artifact[]>;
  /** The pages each session wrote, for sessions that sit outside a workspace. */
  sessionArtifacts: Map<string, Artifact[]>;
  onOpen: (id: string, opts?: OpenOpts) => void;
  /** The New workspace dialog, optionally on a repository's folder and filed in one project. */
  onNewWorkspace: (folder?: string, projectId?: number) => void;
  /** Open a project's own page: everything it holds, across its checkouts. */
  onOpenProject: (projectId: number) => void;
  /** The project whose page is on screen. */
  activeProjectId: number | null;
  /** The new-session dialog on a folder, filed in a workspace when one is given. */
  onNewSession: (folder: string, workspaceId?: number) => void;
  /** The new-session dialog on a project's own folder, which is made if it is not there yet. */
  onNewProjectSession: (projectId: number) => void;
  /** Open a shell in a project's own folder. */
  onNewProjectTerminal: (projectId: number) => void;
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
  const { drawings } = useDrawings();
  const { notes } = useNotes();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<{ kind: "ws" | "session" | "project" | "drawing"; key: string } | null>(null);
  const [deleting, setDeleting] = useState<Workspace | null>(null);
  const [deletingProject, setDeletingProject] = useState<Project | null>(null);
  const [marking, setMarking] = useState<{ repoKey?: string; goalId?: number; name: string; anchor: HTMLElement } | null>(null);
  const markedProject = marking?.goalId !== undefined ? payload?.projects.find((x) => x.id === marking.goalId) : undefined;
  const markedGoal = markedProject && { id: markedProject.id, icon: markedProject.icon, color: markedProject.color };
  const menuAnchor = useRef<HTMLElement | null>(null);
  /** The session row being dragged: onto another row of its workspace to reorder, or out onto the page to open a tile. */
  const rowDrag = useRef<{ id: string; card: string | null } | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);

  const tree = useMemo(
    () => buildTree(sessions, payload, undefined, new Set([...[...drawings, ...notes].flatMap((d) => (d.projectId === null ? [] : [d.projectId])), ...projectArtifacts.keys()])),
    [sessions, payload, drawings, notes, projectArtifacts],
  );
  const needsTotal = sessions.filter((s) => s.status === "needs").length;
  const only = prefs.onlyNeeds && needsTotal > 0;
  const folded = (key: string) => prefs.folds[key] === true;
  const isActive = (s: SidebarSession) => !!activeId && s.ids.includes(activeId);

  const openMenu = (e: ReactMouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    menuAnchor.current = e.currentTarget as HTMLElement;
    setMenu({ anchor: e.currentTarget as HTMLElement, items });
  };

  /** "Move to…" on a session: any project as a whole, or one checkout in it. Where it is put, it stays. */
  const moveSessionItem = (s: SidebarSession, home: Card | null): MenuItem => ({
    label: "Move to…",
    icon: <FolderIcon open />,
    run: () =>
      menuAnchor.current &&
      setMenu({
        anchor: menuAnchor.current,
        items: [
          { heading: "Move to" },
          ...(payload?.projects ?? [])
            .filter((p) => !p.generalKey?.startsWith("review:") && !p.archivedAt)
            .flatMap((p): MenuItem[] => {
              const inside = (payload?.workspaces ?? []).filter((w) => w.projectId === p.id && w.status !== "archived");
              if (p.generalKey && inside.length === 0) return [];
              return [
                p.generalKey
                  ? { heading: `${p.name} (main checkout)` }
                  : {
                      label: p.name,
                      icon: <ProjectIcon project={p} size={15} />,
                      disabled: home?.key === `own:${p.id}`,
                      run: () => void workspaceApi.attachProject(p.id, s.ids).catch(() => {}),
                    },
                ...inside.map(
                  (w): MenuItem => ({
                    label: `↳ ${w.repoName}${w.branch ? ` · ${w.branch}` : ""}`,
                    icon: <ProjectMark projectKey={w.repoKey} name={w.repoName} size={13} />,
                    disabled: home?.ws?.id === w.id,
                    run: () => void workspaceApi.attach(w.id, s.ids).catch(() => {}),
                  }),
                ),
              ];
            }),
        ],
      }),
  });

  const sessionItems = (s: SidebarSession, home: Card | null, project: Project | null): MenuItem[] => {
    const items: MenuItem[] = [
      { label: "Open in drawer", icon: <DrawerOpenIcon />, run: () => onOpen(s.id, { drawer: true }) },
      { label: "Open in tile", icon: <TileWindowIcon />, run: () => onOpen(s.id, { tile: true }) },
      { label: "Open full page", icon: <FullPageIcon />, run: () => onOpen(s.id, { full: true }) },
    ];
    if (s.service) {
      return [
        ...items,
        "sep",
        { label: "Stop service", icon: <StopIcon />, danger: true, run: () => void servicesApi.stop(serviceSessionOf(s.id)).catch(() => {}) },
      ];
    }
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
        moveSessionItem(s, home),
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
    items.push("sep", moveSessionItem(s, home));
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
      {
        label: "Move to project…",
        icon: <FolderIcon />,
        run: () =>
          menuAnchor.current &&
          setMenu({
            anchor: menuAnchor.current,
            items: [
              { heading: "Move to project" },
              ...(payload?.projects ?? [])
                .filter((p) => !p.generalKey || p.generalKey === w.repoKey)
                .map((p) => ({
                  icon: <ProjectIcon project={p} size={15} />,
                  label: p.generalKey ? `${p.name} (general)` : p.name,
                  disabled: p.id === w.projectId,
                  run: () => void workspaceApi.moveToProject(w.id, p.id).catch(() => {}),
                })),
            ],
          }),
      },
      {
        label: "Change repository icon…",
        icon: <ProjectMark projectKey={w.repoKey} name={w.repoName} size={15} />,
        run: () => menuAnchor.current && setMarking({ repoKey: w.repoKey, name: w.repoName, anchor: menuAnchor.current }),
      },
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
    const sortable = !only && !!home && (!!home.ws || home.key.startsWith("own:")) && home.rows.length > 1;
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
        <span className={`ws-mark ws-mark-${s.status}${s.service ? ` ws-mark-service svc-${s.health ?? "ok"}` : ""}`} title={s.service ? (s.why ?? "Running service") : STATUS_LABEL[s.status]} role="img" aria-label={s.service ? (s.why ?? "Running service") : STATUS_LABEL[s.status]}>
          {s.service ? <ServiceIcon /> : s.terminal ? <TerminalIcon /> : <ClaudeMark />}
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
          {s.why && <span className={`ws-row-why${s.service ? " svc-crashed" : ""}`}>{s.why}</span>}
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

  /**
   * The "Link to…" entry every linkable thing gets: pick a project, one checkout
   * in it, or nothing. `follow` is offered where the thing can go back to
   * following the session that made it.
   */
  const linkItem = (
    current: { projectId: number | null; workspaceId: number | null },
    pick: (to: { projectId: number | null; workspaceId: number | null }) => void,
    follow?: () => void,
    /** Set for a thing that is moved rather than linked: whether its file already sits in the project's own folder. */
    moves?: { inFolder: boolean },
  ): MenuItem => ({
    label: moves
      ? current.projectId !== null || current.workspaceId !== null
        ? "Move to another project…"
        : "Move to a project…"
      : current.projectId !== null || current.workspaceId !== null
        ? "Link to something else…"
        : "Link to a project…",
    icon: <FolderIcon open />,
    run: () =>
      menuAnchor.current &&
      setMenu({
        anchor: menuAnchor.current,
        items: [
          { heading: moves ? "Move to" : "Link to" },
          {
            label: moves ? "No project" : "Nothing (unlink)",
            icon: <XIcon />,
            disabled: current.projectId === null && current.workspaceId === null && !moves?.inFolder,
            run: () => pick({ projectId: null, workspaceId: null }),
          },
          ...(follow ? [{ label: "The session that wrote it", icon: <ClaudeMark />, run: follow } as MenuItem] : []),
          "sep" as const,
          ...(payload?.projects ?? [])
            .filter((p) => !p.generalKey?.startsWith("review:") && !p.archivedAt)
            .flatMap((p): MenuItem[] => [
              {
                label: p.generalKey ? `${p.name} (main checkout)` : p.name,
                icon: <ProjectIcon project={p} size={15} />,
                disabled: current.projectId === p.id && current.workspaceId === null && (!moves || moves.inFolder || !!p.generalKey),
                run: () => pick({ projectId: p.id, workspaceId: null }),
              },
              ...(p.generalKey
                ? []
                : (payload?.workspaces ?? [])
                    .filter((w) => w.projectId === p.id && w.status !== "archived")
                    .map(
                      (w): MenuItem => ({
                        label: `↳ ${w.repoName}${w.branch ? ` · ${w.branch}` : ""}`,
                        icon: <ProjectMark projectKey={w.repoKey} name={w.repoName} size={13} />,
                        disabled: current.workspaceId === w.id,
                        run: () => pick({ projectId: null, workspaceId: w.id }),
                      }),
                    )),
            ]),
        ],
      }),
  });

  const artifactItems = (a: Artifact): MenuItem[] => [
    { label: "Open in drawer", icon: <DrawerOpenIcon />, run: () => onOpen(artifactKey(a.slug), { drawer: true }) },
    { label: "Open in tile", icon: <TileWindowIcon />, run: () => onOpen(artifactKey(a.slug), { tile: true }) },
    { label: "Open full page", icon: <FullPageIcon />, run: () => onOpen(artifactKey(a.slug), { full: true }) },
    "sep",
    linkItem(
      { projectId: a.link?.projectId ?? null, workspaceId: a.link?.workspaceId ?? null },
      (to) => void artifactApi.link(a.slug, to).catch(() => {}),
      a.link ? () => void artifactApi.link(a.slug, "follow").catch(() => {}) : undefined,
      { inFolder: parseProjectFileId(a.slug).projectId !== null },
    ),
  ];

  const artifactsOf = (ws: Workspace | null, rows: SidebarSession[]): Artifact[] => {
    const bySlug = new Map<string, Artifact>();
    for (const a of ws ? (workspaceArtifacts.get(ws.id) ?? []) : []) bySlug.set(a.slug, a);
    for (const s of rows) for (const id of s.ids) for (const a of sessionArtifacts.get(id) ?? []) if (!a.link) bySlug.set(a.slug, a);
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

  const drawingItems = (d: Drawing): MenuItem[] => [
    { label: "Open in drawer", icon: <DrawerOpenIcon />, run: () => onOpen(drawingKey(d.slug), { drawer: true }) },
    { label: "Open in tile", icon: <TileWindowIcon />, run: () => onOpen(drawingKey(d.slug), { tile: true }) },
    { label: "Open full page", icon: <FullPageIcon />, run: () => onOpen(drawingKey(d.slug), { full: true }) },
    "sep",
    { label: "Rename…", icon: <PencilIcon />, run: () => setRenaming({ kind: "drawing", key: d.slug }) },
    linkItem({ projectId: d.projectId, workspaceId: d.workspaceId }, (to) =>
      void drawingApi.update(d.slug, to.workspaceId !== null ? { workspaceId: to.workspaceId } : { projectId: to.projectId }).catch(() => {}),
      undefined,
      { inFolder: parseProjectFileId(d.slug).projectId !== null },
    ),
    "sep",
    {
      label: "Delete…",
      icon: <TrashIcon />,
      danger: true,
      run: () =>
        menuAnchor.current &&
        setMenu({
          anchor: menuAnchor.current,
          items: [
            { heading: `Delete “${d.title}”?` },
            { label: "Delete the file for good", icon: <TrashIcon />, danger: true, run: () => void drawingApi.remove(d.slug).catch(() => {}) },
          ],
        }),
    },
  ];
  /**
   * A checkout's own drawings. With no workspace: the ones that belong to the
   * project as a whole, and those of a checkout that has no card to sit under.
   */
  const drawingsOf = (ws: Workspace | null, project: Project | null = null): Drawing[] => {
    if (ws) return drawings.filter((d) => d.workspaceId === ws.id);
    if (!project || project.id === null) return [];
    const carded = new Set(project.cards.flatMap((c) => (c.ws ? [c.ws.id] : [])));
    return drawings.filter((d) => d.projectId === project.id && (d.workspaceId === null || !carded.has(d.workspaceId)));
  };

  const notesOf = (ws: Workspace | null, project: Project | null = null): Note[] => {
    if (ws) return notes.filter((n) => n.workspaceId === ws.id);
    if (!project || project.id === null) return [];
    const carded = new Set(project.cards.flatMap((c) => (c.ws ? [c.ws.id] : [])));
    return notes.filter((n) => n.projectId === project.id && (n.workspaceId === null || !carded.has(n.workspaceId)));
  };
  const noteItems = (n: Note): MenuItem[] => [
    { label: "Open in drawer", icon: <DrawerOpenIcon />, run: () => onOpen(noteKey(n.path), { drawer: true }) },
    { label: "Open in tile", icon: <TileWindowIcon />, run: () => onOpen(noteKey(n.path), { tile: true }) },
    { label: "Open full page", icon: <FullPageIcon />, run: () => onOpen(noteKey(n.path), { full: true }) },
    "sep",
    linkItem({ projectId: n.via ? null : n.projectId, workspaceId: n.via ? null : n.workspaceId }, (to) =>
      void noteApi.update(n.path, to.workspaceId !== null ? { workspaceId: to.workspaceId } : { projectId: to.projectId }).catch(() => {}),
      undefined,
      { inFolder: noteRoot(n.path).projectId !== null },
    ),
  ];
  const noteRows = (groupKey: string, list: Note[], bare: boolean) => {
    if (list.length === 0 || only) return null;
    const key = `note:${groupKey}`;
    const inline = list.length <= INLINE_ARTIFACTS;
    const open = inline || prefs.folds[key] === false;
    return (
      <div key={key} className={`ws-arts${bare ? " bare" : ""}${inline ? " inline" : ""}`}>
        {!inline && (
          <button className="ws-arts-head" aria-expanded={open} onClick={() => sidebarPrefs.fold(key, open)}>
            <span className={`ws-arts-chev${open ? " open" : ""}`}>
              <ChevronIcon />
            </span>
            <DocIcon />
            <span className="ws-arts-name">Notes</span>
            <span className="ws-arts-count">{list.length}</span>
          </button>
        )}
        {open && list.map((n) => {
          const id = noteKey(n.path);
          return (
            <div
              key={n.path}
              className={`ws-row ws-art${activeId === id ? " on" : ""}`}
              role="button"
              tabIndex={0}
              draggable
              title={`${n.title}\n${n.path}`}
              onDragStart={(e) => {
                e.dataTransfer.setData(SESSION_DRAG_MIME, id);
                e.dataTransfer.effectAllowed = "copyMove";
              }}
              onClick={(e) => onOpen(id, { full: e.metaKey || e.ctrlKey, option: e.altKey })}
              onAuxClick={(e) => e.button === 1 && onOpen(id, { full: true })}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && e.key === "Enter") onOpen(id, { option: e.altKey });
              }}
              onContextMenu={(e) => openMenu(e, noteItems(n))}
            >
              {inline && (
                <span className="ws-mark">
                  <DocIcon />
                </span>
              )}
              <span className="ws-row-text">
                <span className="ws-row-title">{n.title}</span>
              </span>
              <span className="ws-row-age">{ageShort(n.modifiedAt)}</span>
              <button className="ws-hover-btn" title="Note actions" aria-label={`Actions for ${n.title}`} onClick={(e) => openMenu(e, noteItems(n))}>
                <MoreVerticalIcon />
              </button>
            </div>
          );
        })}
      </div>
    );
  };

  const drawingRows = (groupKey: string, list: Drawing[], bare: boolean) => {
    if (list.length === 0 || only) return null;
    const key = `draw:${groupKey}`;
    const inline = list.length <= INLINE_ARTIFACTS;
    const open = inline || prefs.folds[key] === false;
    return (
      <div key={key} className={`ws-arts${bare ? " bare" : ""}${inline ? " inline" : ""}`}>
        {!inline && (
          <button className="ws-arts-head" aria-expanded={open} onClick={() => sidebarPrefs.fold(key, open)}>
            <span className={`ws-arts-chev${open ? " open" : ""}`}>
              <ChevronIcon />
            </span>
            <DrawingIcon />
            <span className="ws-arts-name">Drawings</span>
            <span className="ws-arts-count">{list.length}</span>
          </button>
        )}
        {open && list.map((d) => {
          const id = drawingKey(d.slug);
          return (
            <div
              key={d.slug}
              className={`ws-row ws-art${activeId === id ? " on" : ""}`}
              role="button"
              tabIndex={0}
              draggable
              title={`${d.title}\n${parseProjectFileId(d.slug).name}.excalidraw`}
              onDragStart={(e) => {
                e.dataTransfer.setData(SESSION_DRAG_MIME, id);
                e.dataTransfer.effectAllowed = "copyMove";
              }}
              onClick={(e) => onOpen(id, { full: e.metaKey || e.ctrlKey, option: e.altKey })}
              onAuxClick={(e) => e.button === 1 && onOpen(id, { full: true })}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && e.key === "Enter") onOpen(id, { option: e.altKey });
              }}
              onContextMenu={(e) => openMenu(e, drawingItems(d))}
            >
              {inline && (
                <span className="ws-mark">
                  <DrawingIcon />
                </span>
              )}
              <span className="ws-row-text">
                {renaming?.kind === "drawing" && renaming.key === d.slug ? (
                  <span className="ws-row-title" onClick={(e) => e.stopPropagation()}>
                    <TitleEditInput
                      initial={d.title}
                      placeholder="Name this drawing"
                      onCancel={() => setRenaming(null)}
                      onCommit={(v) => {
                        setRenaming(null);
                        if (v && v !== d.title) void drawingApi.update(d.slug, { title: v }).catch(() => {});
                      }}
                    />
                  </span>
                ) : (
                  <span className="ws-row-title">{d.title}</span>
                )}
              </span>
              <span className="ws-row-age">{ageShort(d.modifiedAt)}</span>
              <button className="ws-hover-btn" title="Drawing actions" aria-label={`Actions for ${d.title}`} onClick={(e) => openMenu(e, drawingItems(d))}>
                <MoreVerticalIcon />
              </button>
            </div>
          );
        })}
      </div>
    );
  };

  const isEmptyCard = (c: Card) =>
    c.rows.length === 0 &&
    artifactsOf(c.ws, []).length === 0 &&
    drawingsOf(c.ws).length === 0 &&
    notesOf(c.ws).length === 0 &&
    !(renaming?.kind === "ws" && renaming.key === c.key);
  const isEmptyProject = (p: Project) =>
    !(renaming?.kind === "project" && renaming.key === p.key) &&
    p.cards.every(isEmptyCard) && drawingsOf(null, p).length === 0 && notesOf(null, p).length === 0 && !(p.id !== null && projectArtifacts.get(p.id)?.length);

  /** The colour of the line that runs down a project's rows: its own mark's, else its first repository's. */
  const lineOf = (p: Project): CSSProperties | undefined => {
    const repo = p.repos[0];
    const color =
      p.id !== null && hasOwnMark(p)
        ? markColorValue(`project:${p.id}`, p.color)
        : repo
          ? markColorValue(markKey(repo.key), payload?.repos.find((r) => r.key === repo.key)?.color)
          : null;
    return color ? ({ "--mark": color } as CSSProperties) : undefined;
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
        <Fragment key={c.key}>
          {sessionRows(c, p, rows, "ws-rows bare")}
          {artifactGroup(c.key, artifactsOf(c.ws, c.rows), true)}
          {noteRows(c.key, notesOf(c.ws), true)}
          {drawingRows(c.key, drawingsOf(c.ws), true)}
        </Fragment>
      ) : drawingsOf(c.ws).length + notesOf(c.ws).length > 0 ? (
        <Fragment key={c.key}>{noteRows(c.key, notesOf(c.ws), true)}
          {drawingRows(c.key, drawingsOf(c.ws), true)}</Fragment>
      ) : null;
    }
    const arts = artifactsOf(c.ws, c.rows);
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
          {c.ws && c.byRepo && <ProjectMark projectKey={c.ws.repoKey} name={c.ws.repoName} size={14} className="ws-card-mark" />}
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
              <span className={`ws-card-title${c.ws && !c.byRepo && namedByBranch(c.ws) ? " branch" : ""}`}>
                {c.ws && !c.byRepo && namedByBranch(c.ws) && <GitIcon />}
                {c.title}
              </span>
            )}
          </span>
          {c.ws && (c.byRepo || !namedByBranch(c.ws)) && offMain(c.ws.branch) && (
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
        {!shut && noteRows(c.key, notesOf(c.ws), false)}
          {!shut && drawingRows(c.key, drawingsOf(c.ws), false)}
      </div>
    );
  };

  const projectView = (p: Project, sort?: SortProps) => {
    const key = `p:${p.key}`;
    const shut = folded(key) && !only;
    const needs = p.cards.reduce((n, c) => n + c.needs, 0);
    if (only && needs === 0) return null;
    const restKey = `rest:${p.key}`;
    const bare = p.cards.find((c) => c.bare && c.ws);
    const root = bare?.ws?.folder ?? p.repos[0]?.root ?? null;
    const projectId = p.id;
    const editingName = renaming?.kind === "project" && renaming.key === p.key;
    const projectItems: MenuItem[] = [];
    if (projectId !== null) projectItems.push({ label: "Open project", icon: <FolderIcon open />, run: () => onOpenProject(projectId) }, "sep");
    const inProjectFolder = projectId !== null && !p.general;
    if (inProjectFolder) {
      projectItems.push(
        { label: "New session in the project folder", icon: <PlusIcon />, run: () => onNewProjectSession(projectId) },
        { label: "New terminal in the project folder", icon: <TerminalIcon />, run: () => onNewProjectTerminal(projectId) },
      );
    } else if (root) {
      projectItems.push(
        { label: "New session", icon: <PlusIcon />, run: () => (bare?.ws ? onNewSession(bare.ws.folder, bare.ws.id) : onNewSession(root)) },
        { label: "New terminal", icon: <TerminalIcon />, run: () => (bare?.ws ? onNewTerminal(bare.ws.folder, bare.ws.id) : onNewTerminal(root, null)) },
      );
    }
    projectItems.push({
      label: "Add a workspace…",
      icon: <WorktreeIcon />,
      run: () => onNewWorkspace(root ?? undefined, p.general ? undefined : (projectId ?? undefined)),
    });
    if (projectId !== null && !p.general) {
      projectItems.push({ label: "Rename project…", icon: <PencilIcon />, run: () => setRenaming({ kind: "project", key: p.key }) });
    }
    if (projectId !== null) {
      projectItems.push("sep", {
        label: "Change icon…",
        icon: hasOwnMark(p) ? <OwnProjectMark project={{ id: projectId, name: p.name, icon: p.icon, color: p.color }} size={15} /> : <FolderIcon />,
        run: () => menuAnchor.current && setMarking({ goalId: projectId, name: p.name, anchor: menuAnchor.current }),
      });
    }
    if (bare?.ws) {
      projectItems.push("sep", { label: "Name the sessions here…", icon: <PencilIcon />, run: () => setRenaming({ kind: "ws", key: bare.key }) });
    }
    if (p.repos.length === 1) {
      const repo = p.repos[0]!;
      projectItems.push("sep", {
        label: "Change repository icon…",
        icon: <ProjectMark projectKey={repo.key} name={repo.name} size={15} />,
        run: () => menuAnchor.current && setMarking({ repoKey: repo.key, name: repo.name, anchor: menuAnchor.current }),
      });
    }
    if (projectId !== null) {
      projectItems.push("sep", {
        label: "Archive project",
        icon: <ArchiveIcon />,
        run: () => void workspaceApi.archiveProject(projectId).catch(() => {}),
      });
      projectItems.push({
        label: "Delete project…",
        icon: <TrashIcon />,
        danger: true,
        run: () => setDeletingProject(p),
      });
    }
    const rest = [...p.paused, ...p.archived];
    const named = p.cards.filter((c) => !c.bare);
    const parts = shut
      ? []
      : inSavedOrder(
          [
            ...p.cards.filter((c) => c.bare).map((c) => ({ key: c.key, card: null as Card | null, node: cardView(c, p) })),
            ...named.map((c) => ({ key: c.key, card: c as Card | null, node: null as ReactNode })),
            { key: "arts", card: null, node: artifactGroup(`p:${p.key}`, p.id === null ? [] : (projectArtifacts.get(p.id) ?? []), true) },
            { key: "notes", card: null, node: noteRows(p.key, notesOf(null, p), true) },
            { key: "draws", card: null, node: drawingRows(p.key, drawingsOf(null, p), true) },
          ].filter((s) => s.card || s.node),
          prefs.order?.[p.key],
        );
    return (
      <section key={p.key} className={`ws-project${sort?.dragging ? " dragging" : ""}`} style={sort?.style}>
        <div
          className="ws-project-head"
          onContextMenu={(e) => openMenu(e, projectItems)}
          onPointerDown={sort ? grab(sort.handle).onPointerDown : undefined}
          onKeyDown={(e) => (e.target as HTMLElement).classList.contains("ws-project-btn") && sort?.handle.onKeyDown?.(e)}
        >
          <button
            className={`ws-project-btn${projectId !== null && activeProjectId === projectId ? " active" : ""}`}
            aria-expanded={!shut}
            title={p.repos.length ? p.repos.map((r) => r.root).join("\n") : p.name}
            onClick={() => (projectId !== null && !editingName ? onOpenProject(projectId) : sidebarPrefs.fold(key, !shut))}
          >
            <span
              className={`ws-chev${shut ? "" : " open"}`}
              onClick={(e) => {
                e.stopPropagation();
                sidebarPrefs.fold(key, !shut);
              }}
            >
              <ChevronIcon />
            </span>
            {projectId !== null && hasOwnMark(p) ? (
              <OwnProjectMark project={{ id: projectId, name: p.name, icon: p.icon, color: p.color }} />
            ) : p.repos.length === 0 ? (
              <FolderIcon />
            ) : (
              <span className="ws-project-marks">
                {p.repos.slice(0, 3).map((r) => (
                  <ProjectMark key={r.key} projectKey={r.key} name={r.name} />
                ))}
              </span>
            )}
            {editingName && projectId !== null ? (
              <span className="ws-project-name" onClick={(e) => e.stopPropagation()}>
                <TitleEditInput
                  initial={p.name}
                  placeholder="Name this project"
                  onCancel={() => setRenaming(null)}
                  onCommit={(v) => {
                    setRenaming(null);
                    if (v && v !== p.name) void workspaceApi.renameProject(projectId, v).catch(() => {});
                  }}
                />
              </span>
            ) : (
              <span className="ws-project-name">{p.name}</span>
            )}
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
          <div className="ws-project-body" style={lineOf(p)}>
            <SortableGroup
              items={parts}
              itemSelector=":scope > .ws-card, :scope > .ws-sec"
              disabled={only || parts.length < 2}
              onMove={(from, to) => {
                const next = moved(parts, from, to);
                sidebarPrefs.setOrder(p.key, next.map((s) => s.key));
                const ids = next.flatMap((s) => (s.card?.ws ? [s.card.ws.id] : []));
                if (ids.length > 1) void workspaceApi.reorder({ ids }).catch(() => {});
              }}
            >
              {(s, sort) =>
                s.card ? (
                  cardView(s.card, p, sort)
                ) : (
                  <div
                    key={s.key}
                    className={`ws-sec${sort.dragging ? " dragging" : ""}`}
                    style={sort.style}
                    onPointerDown={(e) => {
                      if ((e.target as HTMLElement).closest(".ws-arts-head")) sort.handle.onPointerDown?.(e);
                    }}
                  >
                    {s.node}
                  </div>
                )
              }
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
          </div>
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
      aria-label="Projects"
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes(SESSION_DRAG_MIME)) return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="ws-head">
        <span className="ws-head-label">Projects</span>
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
          title="New project or workspace"
          aria-label="New project or workspace"
          onClick={(e) =>
            openMenu(e, [
              {
                label: "New project",
                icon: <FolderIcon />,
                run: () =>
                  void workspaceApi
                    .createProject("New project", { unnamed: true })
                    .then((r) => setRenaming({ kind: "project", key: `p${r.project.id}` }))
                    .catch(() => {}),
              },
              { label: "New workspace…", icon: <WorktreeIcon />, run: () => onNewWorkspace() },
            ])
          }
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
            const projects = [...moved(filledProjects, from, to), ...emptyProjects].flatMap((p) => (p.id === null ? [] : [p.id]));
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
      {marking && (marking.repoKey !== undefined || markedGoal) && (
        <ProjectMarkPicker
          anchor={marking.anchor}
          projectKey={marking.repoKey}
          goal={markedGoal}
          name={marking.name}
          onClose={() => setMarking(null)}
        />
      )}
      {deletingProject && deletingProject.id !== null && (
        <DeleteProjectDialog
          project={{ id: deletingProject.id, name: deletingProject.name }}
          workspaces={(payload?.workspaces ?? []).filter((w) => w.projectId === deletingProject.id).length}
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
