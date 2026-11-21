import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { visiblePages, type Tab } from "../pages.ts";
import {
  agentApi,
  api,
  drawingApi,
  fmtAgo,
  noteApi,
  shortPath,
  taskApi,
  workspaceApi,
  type Artifact,
  type Overview,
  type SessionRow,
  type TasksPayload,
  type Template,
  type Workspace,
  type WorkspacesPayload,
} from "../api.ts";
import { ACCENTS, type Appearance } from "../appearance.ts";
import { artifactKey } from "../../shared/artifacts.ts";
import { drawingKey } from "../../shared/drawings.ts";
import { noteKey, noteRoot } from "../../shared/notes.ts";
import { describeRecurrence, localDay, parseQuickAdd } from "../../shared/taskDates.ts";
import { useDrawings } from "./DrawingsView.tsx";
import { ArtifactIcon, ClaudeMark, DocIcon, DrawingIcon, FolderIcon, PlusIcon, SearchIcon, TasksIcon, ServiceIcon, TerminalIcon, WorktreeIcon } from "./Icons.tsx";
import { ProjectIcon, ProjectMark } from "./ProjectMark.tsx";
import { useNotes } from "./NotePane.tsx";
import { buildTree, STATUS_LABEL, type SidebarSession, type StatusKind } from "./sidebar/sessions.ts";
import { dayLabel } from "./tasks/TaskQuickAdd.tsx";

/**
 * ⌘K. One box over everything: do something (add a task, start a session, make
 * a note), or jump to anything the dashboard holds, a session, a project, a
 * workspace, a task, a note, a drawing, a page.
 *
 * What is already in memory filters locally and answers on every keystroke; a
 * full-text search of past sessions comes from the daemon's index, which is a
 * fetch, so it is debounced and merged in when it lands. Typing never waits on
 * the network.
 *
 * An action that needs one line of text, a task or a name, asks for it in the
 * same box: the palette steps into that action, the field becomes its input,
 * and Enter does it.
 */

type Group = "Actions" | "Needs you" | "Running" | "Projects" | "Tasks" | "Notes" | "Drawings" | "Artifacts" | "Go to" | "Templates" | "Past sessions" | "Appearance" | "Start in a folder";

export type PaletteItem = {
  id: string;
  /** What is matched against, lowercased once at build time. */
  haystack: string;
  group: Group;
  /** Leading mark: a glyph, or the thing's own icon. A group is a heading you scroll past; the mark travels with the row. */
  icon: ReactNode;
  label: string;
  hint?: string;
  /** Trailing column: an age, a status, a count. */
  meta?: string;
  /** Status class for the dot on session rows, matching the card pills. */
  state?: "busy" | "attention" | "idle" | "dead";
  /** Ranked above equally-good matches, and what orders the list before anything is typed. */
  boost?: number;
  /** Kept out of the no-query list: long tails (every note, every accent, every folder). */
  deep?: boolean;
  /** True when ⌘↵ means something different from ↵ for this row. */
  canFull?: boolean;
  /** Steps into an action that takes one line of text, instead of running and closing. */
  ask?: Ask;
  run: (opts?: { full?: boolean }) => void;
};

/** An action waiting for its one line: what to call it, what to type, and what Enter does with it. */
type Ask = { kind: "task" | "note" | "drawing" | "project"; title: string; placeholder: string; submit: (text: string) => Promise<unknown> };

/** A project or workspace page that is on screen, so a new thing can be made in it. */
export type PaletteContext = { projectId: number | null; workspaceId: number | null; name: string } | null;

/**
 * Every term has to appear, and where it appears decides the score: a match at the
 * start of the label beats one at a word boundary, which beats one buried mid-word.
 */
function score(item: PaletteItem, parts: string[]): number {
  let total = (item.boost ?? 0) / 4;
  for (const p of parts) {
    const at = item.haystack.indexOf(p);
    if (at < 0) return -1;
    const before = at === 0 ? " " : item.haystack[at - 1];
    total += at === 0 ? 14 : /[\s/:·-]/.test(before!) ? 9 : 3;
    total += Math.max(0, 5 - Math.floor(at / 10));
  }
  return total;
}

const STATE_OF: Record<StatusKind, PaletteItem["state"]> = {
  needs: "attention",
  failed: "attention",
  working: "busy",
  done: "idle",
  idle: "idle",
  ended: "dead",
};

const LIMIT = 50;
const GROUP_ORDER: Group[] = ["Actions", "Needs you", "Running", "Projects", "Tasks", "Go to", "Notes", "Drawings", "Artifacts", "Templates", "Past sessions", "Appearance", "Start in a folder"];

export function Palette({
  sessions,
  payload,
  tasks,
  artifacts,
  context,
  projects,
  recent,
  appearance,
  hiddenPages,
  pageOrder,
  onClose,
  onOpenSession,
  onTab,
  onNewSession,
  onNewChat,
  onNewIn,
  onNewWorkspace,
  onNewProjectSession,
  onNewProjectTerminal,
  onOpenProject,
  onOpenWorkspace,
  onOpenTask,
  onManageFolders,
  templates = [],
  pageIcons = {},
  onRunTemplate,
  onFind,
  onAppearance,
}: {
  /** The dock's own icon for each page. */
  pageIcons?: Partial<Record<Tab, () => JSX.Element>>;
  /** Every session and terminal the sidebar lists, with where each is filed. */
  sessions: SidebarSession[];
  payload: WorkspacesPayload | null;
  tasks: TasksPayload | null;
  artifacts: Artifact[];
  context: PaletteContext;
  /** Folders past sessions ran in, to start a new one there. */
  projects: Overview["projects"];
  recent: SessionRow[];
  appearance: Appearance;
  /** Dock pages turned off in settings, so the palette cannot jump to one. */
  hiddenPages: string[] | undefined;
  pageOrder?: string[];
  templates?: Template[];
  onRunTemplate?: (id: string) => void;
  onClose: () => void;
  onOpenSession: (id: string, opts?: { full?: boolean }) => void;
  onTab: (tab: Tab) => void;
  onNewSession: () => void;
  onNewChat: () => void;
  onNewIn: (cwd: string) => void;
  onNewWorkspace: (projectId?: number) => void;
  onNewProjectSession: (projectId: number) => void;
  onNewProjectTerminal: (projectId: number) => void;
  onOpenProject: (projectId: number) => void;
  onOpenWorkspace: (w: Workspace) => void;
  onOpenTask: (taskId: number) => void;
  onManageFolders: () => void;
  onFind: () => void;
  onAppearance: (patch: Partial<Appearance>) => void;
}) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<SessionRow[]>([]);
  const [active, setActive] = useState(0);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { notes } = useNotes();
  const { drawings } = useDrawings();
  const today = localDay(new Date());

  // Search is the only thing here that touches the network, so it is the only
  // thing that is debounced: the same 180ms the history view uses.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2 || ask) {
      setFound([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .sessions(term, 8)
        .then((r) => setFound(r.sessions))
        .catch(() => {});
    }, 180);
    return () => clearTimeout(t);
  }, [q, ask]);

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    const add = (item: Omit<PaletteItem, "haystack"> & { words?: string }) =>
      out.push({
        ...item,
        haystack: `${item.label} ${item.hint ?? ""} ${item.meta ?? ""} ${item.words ?? ""}`.toLowerCase(),
      });
    const work = (payload?.projects ?? []).filter((p) => !p.archivedAt && !p.generalKey?.startsWith("review:"));
    const own = work.filter((p) => !p.generalKey);
    const nameOf = (id: number | null | undefined) => work.find((p) => p.id === id)?.name ?? null;
    const here = context ? ` in ${context.name}` : "";
    const into = context?.workspaceId != null ? { workspaceId: context.workspaceId } : context?.projectId != null ? { projectId: context.projectId } : {};

    // ── things to do ────────────────────────────────────────────────────────
    add({
      id: "do:task",
      group: "Actions",
      icon: <TasksIcon />,
      label: `Add a task${here}`,
      hint: "today, friday 9:00, p1, #list",
      words: "todo new task remind",
      boost: 34,
      run: () => {},
      ask: {
        kind: "task",
        title: `Add a task${here}`,
        placeholder: "Review the PR friday 9:00 p1",
        submit: (line) =>
          taskApi.add({
            text: line,
            ...(context?.workspaceId != null ? { workspaceId: context.workspaceId } : context?.projectId != null ? { workProjectId: context.projectId } : {}),
          }),
      },
    });
    add({ id: "do:session", group: "Actions", icon: <PlusIcon />, label: "New session", hint: "pick where it runs", words: "start claude", boost: 32, run: onNewSession });
    add({ id: "do:chat", group: "Actions", icon: <PlusIcon />, label: "New chat", hint: "no project, connectors and web only", words: "research standalone", boost: 20, run: onNewChat });
    add({
      id: "do:note",
      group: "Actions",
      icon: <DocIcon />,
      label: `New note${here}`,
      hint: "type its title",
      words: "write markdown",
      boost: 28,
      run: () => {},
      ask: {
        kind: "note",
        title: `New note${here}`,
        placeholder: "Title of the note",
        submit: (title) => noteApi.create({ title, ...into }).then((r) => onOpenSession(noteKey(r.note.path), { full: true })),
      },
    });
    add({
      id: "do:drawing",
      group: "Actions",
      icon: <DrawingIcon />,
      label: `New drawing${here}`,
      hint: "type its title",
      words: "whiteboard excalidraw sketch",
      boost: 26,
      run: () => {},
      ask: {
        kind: "drawing",
        title: `New drawing${here}`,
        placeholder: "Title of the drawing",
        submit: (title) => drawingApi.create({ title, ...into }).then((r) => onOpenSession(drawingKey(r.drawing.slug), { full: true })),
      },
    });
    add({
      id: "do:project",
      group: "Actions",
      icon: <FolderIcon />,
      label: "New project",
      hint: "type its name",
      words: "create piece of work",
      boost: 24,
      run: () => {},
      ask: {
        kind: "project",
        title: "New project",
        placeholder: "Name of the project",
        submit: (name) => workspaceApi.createProject(name).then((r) => onOpenProject(r.project.id)),
      },
    });
    add({
      id: "do:workspace",
      group: "Actions",
      icon: <WorktreeIcon />,
      label: context?.projectId != null ? `Add a workspace to ${context.name}` : "New workspace",
      hint: "a checkout to work in",
      words: "worktree branch",
      boost: 22,
      run: () => onNewWorkspace(context?.projectId ?? undefined),
    });
    for (const p of own) {
      add({ id: `do:ps:${p.id}`, group: "Actions", icon: <ProjectIcon project={p} size={16} />, label: `New session in ${p.name}`, hint: "in the project folder", deep: true, run: () => onNewProjectSession(p.id) });
      add({ id: `do:pt:${p.id}`, group: "Actions", icon: <TerminalIcon />, label: `New terminal in ${p.name}`, hint: "in the project folder", deep: true, run: () => onNewProjectTerminal(p.id) });
      add({ id: `do:pw:${p.id}`, group: "Actions", icon: <WorktreeIcon />, label: `Add a workspace to ${p.name}`, hint: "a checkout to work in", deep: true, run: () => onNewWorkspace(p.id) });
    }
    add({ id: "do:repos", group: "Actions", icon: <FolderIcon />, label: "Manage repositories", hint: "the folders you start from", words: "folders working directories", deep: true, run: onManageFolders });
    add({ id: "do:find", group: "Actions", icon: <SearchIcon />, label: "Find in page", hint: "search this view", meta: "⌘F", boost: 6, run: onFind });

    // ── sessions and terminals, as the sidebar files them ───────────────────
    const tree = buildTree(sessions, payload);
    const whereOf = new Map<string, string>();
    for (const p of tree.projects) for (const c of p.cards) for (const s of c.rows) whereOf.set(s.id, c.ws && c.ws.repoName !== p.name ? `${p.name} › ${c.ws.repoName}` : p.name);
    for (const s of sessions) {
      const waiting = s.status === "needs" || s.status === "failed";
      add({
        id: `s:${s.id}`,
        group: s.resumable || s.status === "ended" ? "Past sessions" : waiting ? "Needs you" : "Running",
        icon: s.service ? <ServiceIcon /> : s.terminal ? <TerminalIcon /> : <span className={`ws-mark ws-mark-${s.resumable ? "ended" : s.status}`}><ClaudeMark /></span>,
        label: s.title,
        hint: whereOf.get(s.id) ?? (s.chat ? "Standalone chat" : shortPath(s.cwd, 2)),
        meta: s.service ? "service" : s.terminal ? "terminal" : s.resumable ? "resume" : (s.why ?? STATUS_LABEL[s.status]).toLowerCase(),
        state: STATE_OF[s.status],
        boost: waiting && !s.resumable ? 60 : s.resumable || s.status === "ended" ? 5 : 40,
        canFull: !s.resumable,
        run: (opts) => (s.resumable ? void agentApi.restore(s.id).catch(() => {}) : onOpenSession(s.id, opts)),
      });
    }

    // ── projects and their workspaces ───────────────────────────────────────
    for (const p of work) {
      const inside = (payload?.workspaces ?? []).filter((w) => w.projectId === p.id && w.status !== "archived");
      add({
        id: `p:${p.id}`,
        group: "Projects",
        icon: <ProjectIcon project={p} size={16} />,
        label: p.name,
        hint: p.generalKey ? "main checkout" : "project",
        meta: `${inside.length} workspace${inside.length === 1 ? "" : "s"}`,
        boost: p.generalKey ? 9 : 16,
        deep: !!p.generalKey,
        run: () => onOpenProject(p.id),
      });
      for (const w of inside) {
        add({
          id: `w:${w.id}`,
          group: "Projects",
          icon: <ProjectMark projectKey={w.repoKey} name={w.repoName} size={16} />,
          label: p.generalKey ? w.goal.trim() || w.repoName : `${p.name} › ${w.repoName}`,
          hint: w.branch ?? shortPath(w.folder, 2),
          meta: "workspace",
          boost: 12,
          deep: true,
          run: () => onOpenWorkspace(w),
        });
      }
    }

    // ── tasks, notes, drawings, pages ───────────────────────────────────────
    for (const t of (tasks?.tasks ?? []).filter((x) => x.completedAt === null)) {
      const due = t.dueDate !== null && t.dueDate <= today;
      add({
        id: `t:${t.id}`,
        group: "Tasks",
        icon: <i className={`palette-task tasks-p${t.priority}`} />,
        label: t.content,
        hint: nameOf(t.workProjectId) ?? tasks?.projects.find((p) => p.id === t.projectId)?.name,
        meta: t.dueDate ? `${dayLabel(t.dueDate, today)}${t.dueTime ? ` ${t.dueTime}` : ""}` : undefined,
        boost: due ? 14 : 4,
        deep: !due,
        run: () => onOpenTask(t.id),
      });
    }
    for (const n of notes.filter((x) => !x.archived)) {
      add({ id: `n:${n.path}`, group: "Notes", icon: <DocIcon />, label: n.title, hint: nameOf(n.projectId) ?? noteRoot(n.path).rel, meta: fmtAgo(n.modifiedAt), deep: true, canFull: true, run: (opts) => onOpenSession(noteKey(n.path), opts) });
    }
    for (const d of drawings.filter((x) => !x.archived)) {
      add({ id: `d:${d.slug}`, group: "Drawings", icon: <DrawingIcon />, label: d.title, hint: nameOf(d.projectId) ?? "no project", meta: fmtAgo(d.modifiedAt), deep: true, canFull: true, run: (opts) => onOpenSession(drawingKey(d.slug), opts) });
    }
    for (const a of artifacts) {
      add({ id: `a:${a.slug}`, group: "Artifacts", icon: <ArtifactIcon />, label: a.title, hint: nameOf(a.link?.projectId) ?? "no project", meta: fmtAgo(a.modifiedTs ?? 0), deep: true, canFull: true, run: (opts) => onOpenSession(artifactKey(a.slug), opts) });
    }

    // ── places ──────────────────────────────────────────────────────────────
    // A page turned off in settings is not reachable from here either: otherwise
    // the palette is a back door into a view the dock says you do not want.
    for (const { key: t, label, hint } of visiblePages(hiddenPages, pageOrder)) {
      add({ id: `go:${t}`, group: "Go to", icon: pageIcons[t] ? pageIcons[t]!() : "→", label, hint, words: `go to open page ${t}`, boost: 8, run: () => onTab(t) });
    }
    for (const t of templates) {
      add({
        id: `tpl:${t.id}`,
        group: "Templates",
        icon: "▶",
        label: `Run ${t.name || "template"}`,
        hint: t.research ? "research" : t.cwd ? shortPath(t.cwd, 2) : "asks where",
        boost: 10,
        run: () => onRunTemplate?.(t.id),
      });
    }

    // ── past sessions from the index ────────────────────────────────────────
    const listed = new Set(sessions.flatMap((s) => s.ids));
    const seen = new Set<string>();
    for (const s of [...recent.slice(0, 12), ...found]) {
      if (listed.has(s.id) || seen.has(s.id)) continue;
      seen.add(s.id);
      add({ id: `h:${s.id}`, group: "Past sessions", icon: <span className="ws-mark ws-mark-ended"><ClaudeMark /></span>, label: s.title ?? s.id.slice(0, 8), hint: shortPath(s.cwd, 2), meta: fmtAgo(s.last_ts), boost: 3, deep: true, canFull: true, run: (opts) => onOpenSession(s.id, opts) });
    }

    // ── appearance ──────────────────────────────────────────────────────────
    add({ id: "look:theme", group: "Appearance", icon: "◐", label: appearance.theme === "dark" ? "Switch to light theme" : "Switch to dark theme", words: "dark light mode", boost: 2, run: () => onAppearance({ theme: appearance.theme === "dark" ? "light" : "dark" }) });
    add({ id: "look:motion", group: "Appearance", icon: "◍", label: appearance.motion ? "Stop animating the icon" : "Animate the icon while working", deep: true, run: () => onAppearance({ motion: !appearance.motion }) });
    for (const c of ACCENTS) {
      add({ id: `look:accent:${c.name}`, group: "Appearance", icon: "●", label: `Accent: ${c.label}`, words: "colour color", deep: true, run: () => onAppearance({ accent: c.name }) });
    }

    for (const p of projects.slice(0, 40)) {
      add({ id: `f:${p.project_slug}`, group: "Start in a folder", icon: <FolderIcon />, label: shortPath(p.path, 2), hint: "start a session here", meta: `${p.sessions} session${p.sessions === 1 ? "" : "s"}`, deep: true, run: () => onNewIn(p.path) });
    }
    return out;
    // The callbacks are stable enough for one open palette; the data is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, payload, tasks, artifacts, notes, drawings, context, projects, recent, found, appearance, hiddenPages, pageOrder, templates, pageIcons, today]);

  const { shown, more } = useMemo(() => {
    if (ask) return { shown: [] as PaletteItem[], more: 0 };
    const parts = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hits = parts.length
      ? items
          .map((i) => ({ i, s: score(i, parts) }))
          .filter((r) => r.s >= 0)
          .sort((a, b) => b.s - a.s)
          .map((r) => r.i)
      : items.filter((i) => !i.deep).sort((a, b) => (b.boost ?? 0) - (a.boost ?? 0));
    // Group headings only make sense if the rows are contiguous. With nothing
    // typed the groups keep one fixed order; while typing, the group holding
    // the best hit comes first.
    const rank = new Map<Group, number>();
    if (parts.length) hits.forEach((i, n) => rank.has(i.group) || rank.set(i.group, n));
    else GROUP_ORDER.forEach((g, n) => rank.set(g, n));
    const sorted = hits
      .map((i, n) => ({ i, n }))
      .sort((a, b) => rank.get(a.i.group)! - rank.get(b.i.group)! || a.n - b.n)
      .map((r) => r.i);
    return { shown: sorted.slice(0, LIMIT), more: Math.max(0, sorted.length - LIMIT) };
  }, [items, q, ask]);

  useEffect(() => setActive(0), [q]);

  // Keep the highlighted row on screen when arrowing past the fold.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (item: PaletteItem | undefined, full = false) => {
    if (!item) return;
    if (item.ask) {
      setAsk(item.ask);
      setText("");
      setError(null);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    item.run(full ? { full: true } : undefined);
    onClose();
  };

  const leave = () => {
    setAsk(null);
    setError(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const submit = async () => {
    const line = text.trim();
    if (!ask || !line || busy) return;
    setBusy(true);
    setError(null);
    try {
      await ask.submit(line);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  /**
   * Escape and the arrows live on the window, not the input: the rows are real
   * buttons, so clicking or tabbing into the list used to take focus off the input
   * and Escape silently stopped closing the palette.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (ask) leave();
        else onClose();
      } else if (ask) {
        if (e.key === "Enter") {
          e.preventDefault();
          void submit();
        } else if (e.key === "Backspace" && text === "") {
          e.preventDefault();
          leave();
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % Math.max(shown.length, 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + shown.length) % Math.max(shown.length, 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        choose(shown[active], e.metaKey || e.ctrlKey);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const read = ask?.kind === "task" && text.trim() ? parseQuickAdd(text.trim()) : null;
  const activeItem = shown[active];
  return (
    <>
      <div className="scrim palette-scrim" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-bar">
          {ask ? (
            <button className="palette-step" onClick={leave} title="Back to everything (esc)">
              {ask.title}
            </button>
          ) : (
            <span className="palette-search" aria-hidden="true">
              ⌕
            </span>
          )}
          <input
            ref={inputRef}
            className="palette-input"
            autoFocus
            value={ask ? text : q}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={activeItem ? `palette-row-${active}` : undefined}
            aria-label={ask ? ask.title : "Search and commands"}
            placeholder={ask ? ask.placeholder : "Do something, or jump to a session, project, task, note…"}
            onChange={(e) => (ask ? setText(e.target.value) : setQ(e.target.value))}
          />
          {!ask && q && (
            <button className="palette-clear" aria-label="Clear the search" onClick={() => setQ("")}>
              ×
            </button>
          )}
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {ask && (
            <div className="palette-ask">
              {read ? (
                <div className="tasks-preview">
                  <span className="tasks-preview-text">{read.content || "…"}</span>
                  {read.due && (
                    <span className="task-chip due">
                      {dayLabel(read.due.date, today)}
                      {read.due.time ? ` ${read.due.time}` : ""}
                    </span>
                  )}
                  {read.due?.recurrence && <span className="task-chip">{describeRecurrence(read.due.recurrence)}</span>}
                  {read.priority && <span className={`task-chip tasks-p${read.priority}`}>P{read.priority}</span>}
                  {read.project && <span className="task-chip">#{read.project}</span>}
                  {read.labels.map((l) => (
                    <span key={l} className="task-chip">
                      @{l}
                    </span>
                  ))}
                </div>
              ) : (
                <p>
                  {ask.kind === "task"
                    ? "Type the task. A date or time, a priority (p1 to p3), a #list and @labels are picked out of the text."
                    : text.trim()
                      ? `Press ↵ to make “${text.trim()}”.`
                      : "Type it and press ↵."}
                </p>
              )}
              {error && <div className="chat-error">{error}</div>}
            </div>
          )}
          {!ask && shown.length === 0 && (
            <div className="empty">
              Nothing matches <strong>{q.trim()}</strong>.
            </div>
          )}
          {shown.map((item, i) => {
            const first = i === 0 || shown[i - 1]!.group !== item.group;
            const count = shown.filter((s) => s.group === item.group).length;
            return (
              <div key={item.id}>
                {first && (
                  <div className="palette-group">
                    {item.group}
                    <span className="palette-count">{count}</span>
                  </div>
                )}
                <button
                  data-idx={i}
                  id={`palette-row-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={`palette-row ${i === active ? "on" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={(e) => choose(item, e.metaKey || e.ctrlKey)}
                >
                  <span className={`palette-icon ${item.state ?? ""}`} aria-hidden="true">
                    {item.icon}
                  </span>
                  <span className="palette-label">{item.label}</span>
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                  {item.meta && <span className={`palette-meta ${item.state ?? ""}`}>{item.meta}</span>}
                  <span className="palette-enter" aria-hidden="true">
                    {item.ask ? "…" : "↵"}
                  </span>
                </button>
              </div>
            );
          })}
          {more > 0 && <div className="palette-more">{more} more — keep typing to narrow.</div>}
        </div>
        <div className="palette-foot">
          {ask ? (
            <>
              <span>
                <kbd>↵</kbd> {ask.kind === "task" ? "add" : "create"}
              </span>
              <span>
                <kbd>esc</kbd> back
              </span>
            </>
          ) : (
            <>
              <span>
                <kbd>↑↓</kbd> move
              </span>
              <span>
                <kbd>↵</kbd> {activeItem?.ask ? "choose" : "open"}
              </span>
              {/* Only advertised when the highlighted row can actually do it, so the
                  footer never promises something the row will ignore. */}
              {activeItem?.canFull && (
                <span>
                  <kbd>⌘↵</kbd> full view
                </span>
              )}
              <span>
                <kbd>esc</kbd> close
              </span>
              <span className="spacer" style={{ flex: 1 }} />
              <span>
                {shown.length + more} result{shown.length + more === 1 ? "" : "s"}
              </span>
            </>
          )}
        </div>
      </div>
    </>
  );
}
