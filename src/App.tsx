import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WeekStartContext } from "./components/DatePicker.tsx";
import { setProjectMarks } from "./projectMarks.ts";
import {
  agentApi,
  agentBus,
  type AgentSummary,
  api,
  fmtResets,
  fmtTokens,
  fmtUsd,
  type LivePayload,
  type NotifyPayload,
  type Overview,
  type Restorable,
  servicesApi,
  type SessionRow,
  type Settings,
  type Task,
  type TaskProject,
  taskApi,
  type TasksPayload,
  settingsApi,
  type UsagePayload,
  templateApi,
  workspaceApi,
  type WorkspacesPayload,
  inboxApi,
  type InboxPayload,
  terminalApi,
  type WorkspaceTerminal,
  artifactApi,
  type Artifact,
} from "./api.ts";
import {
  applyAppearance,
  currentIconUrl,
  normalizeAppearance,
  readStored,
  setAttention,
  setBusy,
  type Appearance,
} from "./appearance.ts";
import { shell } from "./shell.ts";
import {
  ArtifactIcon,
  DrawingIcon,
  DocIcon,
  FolderIcon,
  ChartIcon,
  ClockIcon,
  GearIcon,
  NineDotsIcon,
  PanelLeftIcon,
  PullRequestIcon,
  HomeIcon,
  PulseIcon,
  SearchIcon,
  SunMoonIcon,
  TasksIcon,
  CalendarIcon,
  TemplateIcon,
  ServiceIcon,
  WorktreeIcon,
} from "./components/Icons.tsx";
import { NOTIFY_KINDS, NotificationBell, NotificationCenter } from "./components/NotificationCenter.tsx";
import { Toaster, toast, type OpenGesture } from "./components/Toasts.tsx";
import { PrPage, routePr, type PrRoute } from "./components/pr/PrPage.tsx";
import { ReviewsView } from "./components/pr/ReviewsView.tsx";
import { usePrWatches } from "./components/pr/prState.ts";
import { ServicesView } from "./components/services/ServicesView.tsx";
import { TemplatesView } from "./components/TemplatesView.tsx";
import { TasksView } from "./components/tasks/TasksView.tsx";
import { CalendarView } from "./components/calendar/CalendarView.tsx";
import { localDay } from "../shared/taskDates.ts";
import type { ServicesState } from "../shared/services.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { NewWorkspaceDialog } from "./components/sidebar/NewWorkspaceDialog.tsx";
import { sidebarPrefs, useSidebarPrefs } from "./components/sidebar/prefs.ts";
import { RailSessions } from "./components/sidebar/RailSessions.tsx";
import { buildSessions } from "./components/sidebar/sessions.ts";
import { WorkspaceTree } from "./components/sidebar/WorkspaceTree.tsx";
import { useAnswerNextKey } from "./components/AnswerNext.tsx";
import { Tile } from "./components/Charts.tsx";
import { DesktopBar } from "./components/DesktopBar.tsx";
import { DesktopView } from "./components/DesktopView.tsx";
import { FindBar } from "./components/FindBar.tsx";
import { ArtifactsView } from "./components/ArtifactsView.tsx";
import { HistoryView } from "./components/HistoryView.tsx";
import { HomeView } from "./components/HomeView.tsx";
import { FoldersModal } from "./components/FoldersModal.tsx";
import { NewSessionModal } from "./components/NewSessionModal.tsx";
import { WorkspacePage } from "./components/WorkspacePage.tsx";
import { TerminalPage } from "./components/TerminalPane.tsx";
import { isTerminalKey, terminalKey } from "../shared/terminals.ts";
import { artifactKey, artifactSlugOf, isArtifactKey } from "../shared/artifacts.ts";
import { drawingKey } from "../shared/drawings.ts";
import { ARTIFACTS_CHANGED } from "./components/ArtifactPane.tsx";
import { ArtifactPage } from "./components/ArtifactPane.tsx";
import { DrawingPage } from "./components/DrawingPane.tsx";
import { ProjectPage } from "./components/ProjectPage.tsx";
import { ProjectsView } from "./components/ProjectsView.tsx";
import { DrawingsView } from "./components/DrawingsView.tsx";
import { DRAWINGS_CHANGED } from "./components/drawingEvents.ts";
import { isDrawingKey } from "../shared/drawings.ts";
import { isNoteKey, noteKey, noteName, notePathOf } from "../shared/notes.ts";
import { isServiceKey, serviceKey, serviceSessionOf, sessionPath } from "../shared/services.ts";
import { ServicePage, ServicesContext } from "./components/services/ServicePane.tsx";
import { NotePage } from "./components/NotePane.tsx";
import { NotesView } from "./components/NotesView.tsx";
import { NOTES_CHANGED } from "./components/noteEvents.ts";
import { setProjectList } from "./projectList.ts";
import { isChatPath, workspaceTitle } from "../shared/workspaces.ts";
import { Palette } from "./components/Palette.tsx";
import { SessionDrawer } from "./components/SessionDrawer.tsx";
import { SessionPage } from "./components/SessionPage.tsx";
import { TileLayer } from "./components/TileLayer.tsx";
import { invalidateStatusCache } from "./components/useGitRepo.ts";
import { SettingsView } from "./components/SettingsView.tsx";
import { PageScrollJump } from "./components/scroll.tsx";
import { UsageView } from "./components/UsageView.tsx";
import { WorktreesView } from "./components/WorktreesView.tsx";
import {
  clampRect,
  defaultRect,
  dropSessionTile,
  layerPoint,
  newDesktopId,
  nextDesktopName,
  readDesktops,
  refitDesktops,
  showTile,
  rectForZone,
  writeDesktops,
  SESSION_DRAG_MIME,
  type DesktopsState,
  type LayerSize,
  type TileRect,
  type TileState,
} from "./tiles.ts";
import { PAGES, isPageVisible, visiblePages, type Tab } from "./pages.ts";

const dropGeometry = { defaultRect, clampRect, rectForZone };
const NO_TILES: TileState[] = [];

const TAB_LABEL: Record<Tab, string> = Object.fromEntries(PAGES.map((p) => [p.key, p.label])) as Record<Tab, string>;

/** Icons for the non-desktop dock tabs, keyed the same way so a glyph is trivial
 * to swap: change the value here, nothing else. `desktop` is deliberately
 * excluded — it stays icon-only via NineDotsIcon in the dock render. */
const TAB_ICON: Record<Exclude<Tab, "desktop">, () => JSX.Element> = {
  live: HomeIcon,
  tasks: TasksIcon,
  calendar: CalendarIcon,
  history: ClockIcon,
  artifacts: ArtifactIcon,
  drawings: DrawingIcon,
  notes: DocIcon,
  projects: () => <FolderIcon />,
  worktrees: WorktreeIcon,
  services: ServiceIcon,
  templates: TemplateIcon,
  reviews: PullRequestIcon,
  usage: ChartIcon,
  settings: GearIcon,
};

/** #/session/<id> for the full-page session view; #/pr/… is the other full page. */
function routeSessionId(): string | null {
  const m = window.location.hash.match(/^#\/session\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** #/project/<id> for the page of one project. */
function routeProjectId(): number | null {
  const m = window.location.hash.match(/^#\/project\/(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** #/workspace/<id> for the page of one workspace. */
function routeWorkspaceId(): number | null {
  const m = window.location.hash.match(/^#\/workspace\/(\d+)$/);
  return m ? Number(m[1]) : null;
}

const routePrNow = () => routePr(window.location.hash);
const TAB_ROUTES: Record<string, Tab> = { "#/tasks": "tasks", "#/calendar": "calendar" };
/** #/calendar/<epoch ms>: the calendar, on the week that moment falls in. */
const CALENDAR_AT = /^#\/calendar\/(\d+)$/;

const NO_ARTIFACTS: Artifact[] = [];
const NO_WORKSPACES: WorkspacesPayload["workspaces"] = [];
const NO_HOMES: Record<string, number> = {};
const NO_PROJECT_LIST: WorkspacesPayload["projects"] = [];

/**
 * A further window of the macOS app. It keeps its own look in its own browser
 * storage: the daemon's copy belongs to the first window, so this one neither
 * takes it over on load nor writes its own choice there.
 */
const EXTRA_WINDOW = (shell?.windowSlot ?? 1) !== 1;

const SIDEBAR_PIN_KEY = "sidebar-pinned";

function storedSidebarCollapsed(): boolean | null {
  try {
    const raw = localStorage.getItem("sidebar-collapsed");
    return raw === null ? null : raw === "1";
  } catch {
    return null;
  }
}
const NO_TASKS: Task[] = [];
const NO_PROJECTS: TaskProject[] = [];

export default function App() {
  const [tab, setTab] = useState<Tab>("live");
  const [live, setLive] = useState<LivePayload | null>(null);
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [connected, setConnected] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pageId, setPageId] = useState<string | null>(routeSessionId);
  const [workspacePageId, setWorkspacePageId] = useState<number | null>(routeWorkspaceId);
  const [projectPageId, setProjectPageId] = useState<number | null>(routeProjectId);
  const [prRoute, setPrRoute] = useState<PrRoute | null>(routePrNow);
  /** Bumped when the daemon reports the artifact folder changed, to re-pull the list. */
  const [artifactTick, setArtifactTick] = useState(0);
  /** Pushed by the daemon whenever the tmux picture changes; null until the first. */
  const [services, setServices] = useState<ServicesState | null>(null);
  const [templateRunsKey, setTemplateRunsKey] = useState(0);
  useEffect(() => {
    if ((tab !== "services" && workspacePageId === null && projectPageId === null) || services) return;
    servicesApi.state().then(setServices).catch(() => {});
  }, [tab, workspacePageId, projectPageId, services]);
  const [desks, setDesks] = useState<DesktopsState>(readDesktops);
  const tiles = useMemo(() => desks.desktops.find((d) => d.id === desks.active)?.tiles ?? NO_TILES, [desks]);
  const nextZ = useRef(1 + desks.desktops.reduce((m, d) => d.tiles.reduce((n, t) => Math.max(n, t.z), m), 0));
  /** Change the tiles of one desktop, the showing one unless another is named. */
  const setTilesOf = useCallback((desktopId: string | null, update: (prev: TileState[]) => TileState[]) => {
    setDesks((prev) => {
      const target = desktopId ?? prev.active;
      let changed = false;
      const desktops = prev.desktops.map((d) => {
        if (d.id !== target) return d;
        const next = update(d.tiles);
        if (next === d.tiles) return d;
        changed = true;
        return { ...d, tiles: next };
      });
      return changed ? { ...prev, desktops } : prev;
    });
  }, []);
  const setTiles = useCallback((update: (prev: TileState[]) => TileState[]) => setTilesOf(null, update), [setTilesOf]);
  const fitDesktops = useCallback((size: LayerSize) => setDesks((prev) => refitDesktops(prev, size)), []);
  const setAllTiles = useCallback((update: (prev: TileState[]) => TileState[]) => {
    setDesks((prev) => {
      let changed = false;
      const desktops = prev.desktops.map((d) => {
        const next = update(d.tiles);
        if (next === d.tiles) return d;
        changed = true;
        return { ...d, tiles: next };
      });
      return changed ? { ...prev, desktops } : prev;
    });
  }, []);
  const selectDesktop = useCallback((id: string) => setDesks((prev) => (prev.active === id ? prev : { ...prev, active: id })), []);
  const addDesktop = useCallback(() => {
    setDesks((prev) => {
      const id = newDesktopId();
      return { ...prev, desktops: [...prev.desktops, { id, name: nextDesktopName(prev.desktops), tiles: [] }], active: id };
    });
  }, []);
  const renameDesktop = useCallback((id: string, name: string) => {
    const next = name.trim();
    if (!next) return;
    setDesks((prev) => ({ ...prev, desktops: prev.desktops.map((d) => (d.id === id ? { ...d, name: next } : d)) }));
  }, []);
  const moveDesktop = useCallback((from: number, to: number) => {
    setDesks((prev) => {
      const desktops = [...prev.desktops];
      const [moved] = desktops.splice(from, 1);
      if (!moved) return prev;
      desktops.splice(to, 0, moved);
      return { ...prev, desktops };
    });
  }, []);
  const closeDesktop = useCallback((id: string) => {
    setDesks((prev) => {
      if (prev.desktops.length < 2) return prev;
      const at = prev.desktops.findIndex((d) => d.id === id);
      if (at < 0) return prev;
      const desktops = prev.desktops.filter((d) => d.id !== id);
      return { ...prev, desktops, active: prev.active === id ? desktops[Math.max(0, at - 1)].id : prev.active };
    });
  }, []);
  const copyTileToDesktop = useCallback(
    (tileId: string, desktopId: string, rect: TileRect) => {
      setTilesOf(desktopId, (prev) => showTile(prev, [tileId], rect, () => nextZ.current++, dropGeometry));
    },
    [setTilesOf],
  );

  /**
   * ⌘⇧M: "show desktop" for tiles. Minimizes every open one, tagging each
   * with `hiddenByShortcut`; pressed again with nothing open, it restores
   * exactly the tiles still carrying that tag. Tagging per-tile rather than
   * snapshotting the id list into one ref is what makes this safe against a
   * tile opening in between presses: hiding it later only adds its tag to
   * the set, it can never clobber the memory of tiles tagged by an earlier
   * press the way overwriting a single snapshot did. Pressed with some tiles
   * open and others already docked from earlier, it only touches the open
   * ones — the docked ones were a deliberate choice already, not this
   * chord's to undo.
   */
  const toggleMinimizeAll = useCallback(() => {
    setTiles((prev) => {
      const openIds = new Set(prev.filter((t) => !t.minimized).map((t) => t.id));
      if (openIds.size > 0) {
        return prev.map((t) => (openIds.has(t.id) ? { ...t, minimized: true, hiddenByShortcut: true } : t));
      }
      if (prev.some((t) => t.hiddenByShortcut)) {
        return prev.map((t) =>
          t.hiddenByShortcut
            ? { ...t, minimized: false, hiddenByShortcut: false, z: nextZ.current++ }
            : t,
        );
      }
      return prev;
    });
  }, []);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  /**
   * A tile opened the moment a session starts is keyed by the agent key, because
   * the CLI has not reported a session id yet. Everything else — the dock, the
   * roster, history — keys by session id once there is one, so the same session
   * would show twice. Re-key the tile as soon as the id lands; if a tile under the
   * id already exists, the key-named one is the duplicate and goes.
   */
  useEffect(() => {
    setAllTiles((prev) => {
      let changed = false;
      const next: TileState[] = [];
      for (const t of prev) {
        const a = agents.find((x) => x.key === t.id);
        if (!a?.sessionId || a.sessionId === t.id) {
          next.push(t);
          continue;
        }
        changed = true;
        if (!prev.some((x) => x.id === a.sessionId)) next.push({ ...t, id: a.sessionId });
      }
      return changed ? next : prev;
    });
  }, [agents]);
  const [restorable, setRestorable] = useState<Restorable[]>([]);
  const [projects, setProjects] = useState<Overview["projects"]>([]);
  const [showNew, setShowNew] = useState(false);
  const [newChat, setNewChat] = useState(false);
  /**
   * Directory the new-session dialog should open on, set when something else picked
   * it for you — opening a worktree that already holds the branch you wanted, say.
   * Null means the dialog falls back to its own shortlist.
   */
  const [newIn, setNewIn] = useState<string | null>(null);
  /** The workspace a session started from the dialog should be filed in, when one asked for it. */
  const [newInWorkspace, setNewInWorkspace] = useState<number | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspacesPayload | null>(null);
  useEffect(() => {
    if (workspaces) setProjectMarks(workspaces.repos);
    if (workspaces) setProjectList(workspaces.projects, workspaces.workspaces);
  }, [workspaces]);
  /** The New workspace dialog, with the folder it opens on. */
  const [newWorkspace, setNewWorkspace] = useState<{ folder: string | null; task?: Task; projectId?: number } | null>(null);
  const [tasks, setTasks] = useState<TasksPayload | null>(null);
  const [calendarChanged, setCalendarChanged] = useState(0);
  const [focusTaskId, setFocusTaskId] = useState<number | null>(null);
  const clearFocusTask = useCallback(() => setFocusTaskId(null), []);
  const [showFolders, setShowFolders] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [terminals, setTerminals] = useState<WorkspaceTerminal[]>([]);
  useEffect(() => {
    terminalApi.list().then((r) => setTerminals(r.terminals)).catch(() => {});
  }, []);
  const [inbox, setInbox] = useState<InboxPayload>({ items: [], unread: 0 });
  const followRef = useRef<(href: string, gesture?: OpenGesture) => void>(() => {});
  const [showInbox, setShowInbox] = useState(false);
  const [calendarGoTo, setCalendarGoTo] = useState<{ day: string; at: number } | null>(null);
  useEffect(() => {
    inboxApi.list().then(setInbox).catch(() => {});
  }, []);
  const [showFind, setShowFind] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const prWatches = usePrWatches();
  // Each window keeps its own: what this browser storage remembers wins, and the
  // daemon's copy only fills in for a window that has never chosen. Following the
  // daemon afterwards would make every open window fold together.
  const sidebarChosen = useRef<boolean>(storedSidebarCollapsed() !== null);
  /** Pinned, the sidebar keeps its place beside the page. Unpinned, it is out of sight until the pointer reaches the left edge. */
  const [sidebarPinned, setSidebarPinned] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_PIN_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const toggleSidebarPin = () =>
    setSidebarPinned((v) => {
      try {
        localStorage.setItem(SIDEBAR_PIN_KEY, v ? "0" : "1");
      } catch {
        return !v;
      }
      return !v;
    });
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => storedSidebarCollapsed() ?? false);
  useEffect(() => {
    if (sidebarChosen.current || settings?.ui.sidebarCollapsed === undefined) return;
    sidebarChosen.current = true;
    setSidebarCollapsed(settings.ui.sidebarCollapsed);
  }, [settings?.ui.sidebarCollapsed]);
  useEffect(() => {
    document.documentElement.dataset.sidebar = !sidebarPinned ? "hidden" : sidebarCollapsed ? "rail" : "open";
    try {
      localStorage.setItem("sidebar-collapsed", sidebarCollapsed ? "1" : "0");
    } catch {
      // Private mode; the setting still round-trips through the daemon.
    }
  }, [sidebarCollapsed, sidebarPinned]);
  /** A sidebar folded out of sight opens over the page while the pointer is at the left edge, and goes again once it has left. */
  const [sidebarPeek, setSidebarPeek] = useState(false);
  const peekTimer = useRef<number | null>(null);
  const peekSidebar = useCallback((on: boolean) => {
    if (peekTimer.current !== null) window.clearTimeout(peekTimer.current);
    const settle = () => {
      const typing = document.activeElement instanceof HTMLInputElement && document.activeElement.closest(".sidebar") !== null;
      const busy = !on && (document.querySelector(".svc-menu") !== null || typing);
      if (busy) peekTimer.current = window.setTimeout(settle, 400);
      else setSidebarPeek(on);
    };
    peekTimer.current = window.setTimeout(settle, on ? 140 : 280);
  }, []);
  const sidebarAway = !sidebarPinned;
  useEffect(() => {
    if (!sidebarAway) setSidebarPeek(false);
  }, [sidebarAway]);
  const sidebarPinnedRef = useRef(sidebarPinned);
  sidebarPinnedRef.current = sidebarPinned;
  /** An unpinned sidebar is out of sight, so a change of its size is shown for a moment. */
  const flashSidebar = useCallback(() => {
    if (sidebarPinnedRef.current) return;
    if (peekTimer.current !== null) window.clearTimeout(peekTimer.current);
    setSidebarPeek(true);
    peekTimer.current = window.setTimeout(() => setSidebarPeek(false), 1600);
  }, []);
  const toggleSidebar = useCallback(() => {
    sidebarChosen.current = true;
    flashSidebar();
    setSidebarCollapsed((v) => {
      void settingsApi.save({ ui: { sidebarCollapsed: !v } }).then((r) => setSettings(r.settings)).catch(() => {});
      return !v;
    });
  }, []);
  // Read from localStorage rather than settings.json so the first paint is
  // already in the right theme; the server copy syncs in a moment later.
  const [appearance, setAppearance] = useState<Appearance>(readStored);

  // Titles for live cards come from the index, keyed by session id.
  const [recent, setRecent] = useState<SessionRow[]>([]);
  const titles = useMemo(() => new Map(recent.map((r) => [r.id, r])), [recent]);

  // Hash routing: the drawer's "Open full page" link and the browser's back
  // button both flow through here, so there is one source of truth.
  useEffect(() => {
    const onHash = () => {
      const calendarAt = window.location.hash.match(CALENDAR_AT);
      if (calendarAt) {
        setCalendarGoTo({ day: localDay(new Date(Number(calendarAt[1]))), at: Date.now() });
        setTab("calendar");
        window.location.hash = "";
        return;
      }
      const routed = TAB_ROUTES[window.location.hash];
      if (routed) {
        setTab(routed);
        window.location.hash = "";
        return;
      }
      const id = routeSessionId();
      setPageId(id);
      setWorkspacePageId(routeWorkspaceId());
      setProjectPageId(routeProjectId());
      if (id || routePrNow()) setOpenId(null);
      setPrRoute(routePrNow());
    };
    if (TAB_ROUTES[window.location.hash] || CALENDAR_AT.test(window.location.hash)) onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => applyAppearance(appearance), [appearance]);

  /**
   * ⌘K / Ctrl-K opens the palette from anywhere, including with the composer
   * focused — it is a modifier chord, so it cannot collide with typing. The
   * browser binds ⌘K to the address bar in some setups, hence preventDefault.
   * Escape is left to the palette itself: the drawer and the modals each have
   * their own Escape listener, and stacking another one here would close two
   * things with one press.
   *
   * ⌘F is taken over for the same reason ⌘K is: the native find cannot see a
   * clamped transcript turn or a folded diff, so it reports "not found" for text
   * the session really does contain. ⇧⌘F is deliberately left alone as the way
   * back to the browser's own find.
   *
   * ⌘⇧M minimizes every open tile, or restores whichever set it last
   * minimized — the tile equivalent of "show desktop". Plain ⌘M is left
   * alone: that's the browser's own "minimize this window", not ours to
   * take.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowPalette((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "f") {
        /**
         * An open artifact is a cross-origin iframe, so this find — which walks the
         * current document's nodes — cannot see a word of it, and would quietly
         * search the page behind the overlay instead. The overlay runs its own ⌘F
         * against a bridge inside the frame, so the only thing to do here is stand
         * down and let that handler take the key.
         */
        if (document.querySelector(".artifact-overlay")) return;
        e.preventDefault();
        setShowFind(true);
        document.querySelector<HTMLInputElement>(".find-input")?.select();
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        toggleMinimizeAll();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleMinimizeAll]);

  // Changing appearance writes both places: local for instant application on the
  // next load here, settings.json so another browser opens the same dashboard.
  const changeAppearance = useCallback((patch: Partial<Appearance>) => {
    setAppearance((prev) => {
      const next = { ...prev, ...patch };
      if (!EXTRA_WINDOW) settingsApi.save({ ui: { appearance: next } }).catch(() => {});
      return next;
    });
  }, []);

  const refreshRecent = useCallback(() => {
    api.sessions("", 300).then((r) => setRecent(r.sessions)).catch(() => {});
  }, []);

  useEffect(refreshRecent, [refreshRecent]);

  useEffect(() => {
    workspaceApi.list().then(setWorkspaces).catch(() => {});
    taskApi.list().then(setTasks).catch(() => {});
  }, []);

  useEffect(() => {
    settingsApi
      .get()
      .then((r) => {
        setSettings(r.settings);
        // The daemon's copy wins on load, so a choice made in one browser shows up
        // in the next one you open. Local storage only covers the pre-paint gap.
        // Normalised rather than spread: the nested slider and colour objects need
        // filling out too, or a copy written before a key existed arrives missing it.
        if (r.settings.ui.appearance && !EXTRA_WINDOW) {
          setAppearance(normalizeAppearance(r.settings.ui.appearance));
        }
      })
      .catch(() => {});
  }, []);

  // Known project paths feed the directory picker when starting a session.
  useEffect(() => {
    api.overview().then((o) => setProjects(o.projects)).catch(() => {});
  }, []);

  // Turning off the page you are standing on, or reopening with one already off,
  // would otherwise leave the dock with nothing selected and the body blank. Live
  // is never hideable, so there is always somewhere to land.
  useEffect(() => {
    if (!settings) return;
    if (!isPageVisible(tab, settings.ui.hiddenPages)) setTab("live");
  }, [settings, tab]);

  // One SSE connection drives every view. EventSource reconnects on its own, so
  // the only thing to manage here is the connected flag.
  const esRef = useRef<EventSource | null>(null);
  useEffect(() => {
    const es = new EventSource("/api/events");
    esRef.current = es;
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener("live", (e) => {
      setConnected(true);
      setLive(JSON.parse((e as MessageEvent).data));
    });
    es.addEventListener("usage", (e) => setUsage(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("settings", (e) => setSettings(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("workspaces", (e) => setWorkspaces(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("tasks", (e) => setTasks(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("calendar", () => setCalendarChanged((n) => n + 1));
    es.addEventListener("inbox", (e) => setInbox(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("terminals", (e) => setTerminals(JSON.parse((e as MessageEvent).data).terminals));
    // The daemon owns the decision to notify; the tab only raises the banner.
    es.addEventListener("notify", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as NotifyPayload;
      const href = p.href ?? (p.sessionId ? `#/session/${encodeURIComponent(p.sessionId)}` : "");
      const follow = (gesture?: OpenGesture) => followRef.current(href, gesture);
      if (p.toast !== false) {
        const kind = NOTIFY_KINDS[p.kind] ?? NOTIFY_KINDS.needsInput;
        toast({
          key: p.key,
          kicker: kind.label,
          title: p.label ?? p.title.split(" · ").slice(1).join(" · ") ?? p.title,
          description: p.body,
          meta: p.context,
          tone: kind.tone,
          icon: kind.icon,
          duration: p.urgent ? 0 : undefined,
          onOpen: (gesture) => {
            follow(gesture);
            if (p.inboxId) void inboxApi.read([p.inboxId]).then(setInbox).catch(() => {});
          },
        });
      }
      if (shell) {
        if (p.banner !== false) shell.notify({ key: p.key, title: p.title, body: `${p.body}\n${p.context}`, href });
        return;
      }
      if (p.banner === false || (p.toast !== false && document.visibilityState === "visible")) return;
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      const note = new Notification(p.title, {
        body: `${p.body}\n${p.context}`,
        tag: p.key,
        icon: currentIconUrl(),
        // A newer banner for the same session replaces the old one, and says so.
        renotify: true,
        // Something blocked on you should not slide away while you are elsewhere.
        requireInteraction: p.urgent === true,
      } as NotificationOptions);
      note.onclick = () => {
        window.focus();
        follow();
        note.close();
      };
    });
    es.addEventListener("index", () => refreshRecent());
    const follow = (key: (slug: string) => string, data: string | undefined) => {
      let moved: { from?: string; to?: string } | undefined;
      try {
        moved = (JSON.parse(data ?? "{}") as { moved?: { from?: string; to?: string } }).moved;
      } catch {
        return;
      }
      if (!moved?.from || !moved.to) return;
      const from = key(moved.from);
      const to = key(moved.to);
      setOpenId((id) => (id === from ? to : id));
      setPageId((id) => (id === from ? to : id));
      setTiles((prev) => prev.map((t) => (t.id === from ? { ...t, id: to } : t)));
    };
    es.addEventListener("artifacts", (e) => {
      follow(artifactKey, (e as MessageEvent).data);
      setArtifactTick((n) => n + 1);
      window.dispatchEvent(new Event(ARTIFACTS_CHANGED));
    });
    es.addEventListener("notes", (e) => {
      follow(noteKey, (e as MessageEvent).data);
      window.dispatchEvent(new CustomEvent(NOTES_CHANGED, { detail: JSON.parse((e as MessageEvent).data) }));
    });
    es.addEventListener("drawings", (e) => {
      follow(drawingKey, (e as MessageEvent).data);
      window.dispatchEvent(new CustomEvent(DRAWINGS_CHANGED, { detail: JSON.parse((e as MessageEvent).data) }));
    });
    es.addEventListener("services", (e) => setServices(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("template-runs", () => setTemplateRunsKey((k) => k + 1));

    /**
     * Something wrote to a repository, possibly in another tab or another worktree of it.
     * Dropping the shared status cache is what makes every branch badge on the page — and
     * the worktree list, which watches the same signal — re-read instead of showing a
     * branch that has since moved.
     */
    // A burst of git events (one commit fires several) collapses into one refetch.
    let wroteTimer: ReturnType<typeof setTimeout> | undefined;
    const wrote = () => {
      clearTimeout(wroteTimer);
      wroteTimer = setTimeout(invalidateStatusCache, 500);
    };
    const stopWrote = () => clearTimeout(wroteTimer);
    es.addEventListener("git", wrote);
    es.addEventListener("worktrees", wrote);
    // Owned-session traffic: the roster lives here, the rest goes to the bus for
    // whichever chat pane is open.
    es.addEventListener("agents", (e) => {
      const roster = JSON.parse((e as MessageEvent).data) as {
        agents: AgentSummary[];
        restorable: Restorable[];
      };
      setAgents(roster.agents);
      setRestorable(roster.restorable);
      agentBus.publish({ type: "agents", ...roster });
    });
    for (const name of ["agent-item", "agent-delta", "agent-models", "agent-commands", "agent-tasks", "agent-suggestion", "agent-meter"] as const) {
      es.addEventListener(name, (e) =>
        agentBus.publish({ type: name, ...JSON.parse((e as MessageEvent).data) }),
      );
    }
    // Review pages: a run's record or an explanation changed on the daemon.
    es.addEventListener("pr-run", (e) => agentBus.publish({ type: "pr-run", run: JSON.parse((e as MessageEvent).data) }));
    es.addEventListener("pr-explain", (e) =>
      agentBus.publish({ type: "pr-explain", explanation: JSON.parse((e as MessageEvent).data) }),
    );
    es.addEventListener("pr-watch", (e) => agentBus.publish({ type: "pr-watch", ...JSON.parse((e as MessageEvent).data) }));
    return () => {
      stopWrote();
      es.close();
    };
  }, [refreshRecent]);

  const needsInput = live?.counts.needsInput ?? 0;
  // A parked permission request is the same kind of "you are the blocker" signal
  // as a terminal session waiting for input, so it shares the badge.
  // Oldest first: the session that has been blocked longest is the one costing you
  // time, and it is the one "answer next" should hand you.
  const blockedQueue = agents
    .filter((a) => a.status === "awaiting-permission")
    .sort((a, b) => a.updatedAt - b.updatedAt);
  const awaiting = blockedQueue.length;
  const blocked = needsInput + awaiting;
  // The other half of the pair: blocked is "you are the blocker", thinking is
  // "Claude is". The icon animates for the second and badges for the first, so the
  // two states stay distinguishable at a glance instead of both meaning "activity".
  const thinking = agents.filter((a) => a.status === "thinking").length;

  // "Live" means a process exists: started or working or waiting on you, but not one
  // that has ended or died.
  const liveHere = agents.filter((a) => a.status !== "ended" && a.status !== "error").length;
  const liveExternal = live?.counts.alive ?? 0;

  /**
   * A session can be addressed by its transcript id or, before that exists, by the
   * key of the agent driving it. Both resolve here so the drawer and the page never
   * need to care which one they were handed.
   */
  const agentFor = useCallback(
    (id: string | null) =>
      id ? (agents.find((a) => a.sessionId === id || a.key === id) ?? null) : null,
    [agents],
  );
  const sessionIdFor = useCallback(
    (id: string | null) => (id ? (agentFor(id)?.sessionId ?? id) : null),
    [agentFor],
  );
  /**
   * Opening a session: the drawer keeps you on the list, the page gives it room.
   * Cards also carry an explicit link that always goes to the page.
   */
  /**
   * Back goes to where you came from when that was a page in here, and
   * otherwise one level up: a workspace's project, else the tab behind it.
   */
  const navDepth = useRef(0);
  const upFromHere = useRef("");
  useEffect(() => {
    const moved = () => {
      navDepth.current += 1;
    };
    window.addEventListener("hashchange", moved);
    return () => window.removeEventListener("hashchange", moved);
  }, []);
  const closePage = useCallback(() => {
    if (navDepth.current > 0) {
      navDepth.current -= 2;
      window.history.back();
    } else window.location.hash = upFromHere.current;
  }, []);
  // A PR page is a full page too: tiles hide and the dock deselects the same way.
  const workspacePage = workspacePageId === null ? null : (workspaces?.workspaces.find((w) => w.id === workspacePageId) ?? null);
  const projectPage = projectPageId === null ? null : (workspaces?.projects.find((p) => p.id === projectPageId) ?? null);
  const projectWorkspaces = useMemo(
    () => (projectPage ? (workspaces?.workspaces ?? []).filter((w) => w.projectId === projectPage.id && w.status !== "archived") : NO_WORKSPACES),
    [projectPage, workspaces],
  );
  const onFullPage = !!pageId || !!prRoute || !!workspacePage || !!projectPage;
  const openProject = useCallback((id: number) => {
    window.location.hash = `#/project/${id}`;
  }, []);
  const openWorkspace = useCallback((w: { id: number }) => {
    window.location.hash = `#/workspace/${w.id}`;
  }, []);
  const closeDrawer = useCallback(() => setOpenId(null), []);
  const openServiceSettings = useCallback(() => {
    localStorage.setItem("settings-section", "services");
    window.location.hash = "";
    setTab("settings");
  }, []);

  // Persisted so a reload finds the same windows in the same places; re-saved
  // on every change rather than only on close, since a crash or a stray
  // reload should not lose a layout you just spent time arranging.
  useEffect(() => writeDesktops(desks), [desks]);

  const frontTileId = useMemo(() => {
    const shown = tiles.filter((t) => !t.minimized);
    return shown.length ? shown.reduce((a, b) => (b.z > a.z ? b : a)).id : null;
  }, [tiles]);

  const focusTile = useCallback((id: string) => {
    setTiles((prev) => prev.map((t) => (t.id === id ? { ...t, z: nextZ.current++ } : t)));
  }, []);

  const openTile = useCallback((id: string) => {
    setTiles((prev) => {
      if (prev.some((t) => t.id === id))
        return prev.map((t) =>
          t.id === id
            ? { ...t, minimized: false, hiddenByShortcut: false, hiddenByTab: false, z: nextZ.current++ }
            : t,
        );
      return [...prev, { id, rect: defaultRect(prev.length), z: nextZ.current++ }];
    });
  }, []);

  const closeTile = useCallback((id: string) => {
    setTiles((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // The dock is just `tiles` filtered by this flag, rendered by the same
  // always-mounted TileLayer — so "visible from anywhere in the app" falls
  // out for free rather than needing a second piece of global state.
  // A deliberate minimize through the yellow light or a dock chip is not
  // either automatic mechanism's doing, so it clears both tags — otherwise a
  // tile someone manually restored-then-reminimized could stay flagged from
  // a stale shortcut/tab press and pop back open on the next unrelated
  // restore of that mechanism.
  const minimizeTile = useCallback((id: string) => {
    setTiles((prev) =>
      prev.map((t) =>
        t.id === id ? { ...t, minimized: true, hiddenByShortcut: false, hiddenByTab: false } : t,
      ),
    );
  }, []);

  // Leaving the Desktop tab — by picking another tab, or by opening a tile
  // full-page even from Desktop itself — hides tiles the same way ⌘⇧M does,
  // and landing back on Desktop (tab and page both) restores exactly what
  // this hid. Kept as its own `hiddenByTab` tag rather than reusing
  // `hiddenByShortcut` so the two never interfere: pressing ⌘⇧M on, say,
  // Live must not resurrect tiles this put away, and arriving at Desktop
  // must not react to whatever the shortcut separately minimized.
  //
  // `tab` and `pageId` are watched together, as one "am I actually looking
  // at Desktop" value, rather than as two separate hide/restore effects —
  // opening a full page while already on the Desktop tab doesn't change
  // `tab` at all, so a `tab`-only effect never saw it leave and never fired
  // the restore when the page closed back to Desktop. Skipped on the very
  // first run so a reload that happens to land off Desktop doesn't hide
  // tiles nobody asked to hide — only an actual change should trigger it.
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const desktopMounted = useRef(false);
  useEffect(() => {
    const onDesktop = tab === "desktop" && !onFullPage;
    if (!desktopMounted.current) {
      desktopMounted.current = true;
      return;
    }
    if (onDesktop) {
      setTiles((prev) => {
        if (!prev.some((t) => t.hiddenByTab)) return prev;
        return prev.map((t) =>
          t.hiddenByTab ? { ...t, minimized: false, hiddenByTab: false } : t,
        );
      });
      return;
    }
    setTiles((prev) => {
      const openIds = new Set(prev.filter((t) => !t.minimized).map((t) => t.id));
      if (openIds.size === 0) return prev;
      return prev.map((t) => (openIds.has(t.id) ? { ...t, minimized: true, hiddenByTab: true } : t));
    });
  }, [tab, onFullPage]);

  const updateTileRect = useCallback((id: string, rect: TileRect) => {
    setTiles((prev) => prev.map((t) => (t.id === id ? { ...t, rect } : t)));
  }, []);

  // The green light's short press: the same "one source of truth" hash route
  // the drawer's own "Open full page" link uses. Hiding the rest of the
  // tiles (this one included) happens above, reacting to `pageId` rather
  // than here, so it also covers the browser's back button landing on the
  // same session some other way.
  const openTileFull = useCallback(
    (id: string) => {
      window.location.hash = `#/session/${encodeURIComponent(sessionIdFor(id) ?? id)}`;
    },
    [sessionIdFor],
  );

  // A session card dragged onto empty ground opens where it was dropped; dragged
  // onto an existing tile, it splits the screen with it instead — the same "snap
  // assist" idea as dragging one to a screen edge, just reached by dropping a
  // second session directly on the first rather than moving it there by hand.
  useEffect(() => {
    function onDragOver(e: DragEvent) {
      if (!e.dataTransfer?.types.includes(SESSION_DRAG_MIME)) return;
      e.preventDefault();
    }
    function onDrop(e: DragEvent) {
      const id = e.dataTransfer?.getData(SESSION_DRAG_MIME);
      if (!id) return;
      e.preventDefault();
      setTab("desktop");
      if (window.location.hash) window.location.hash = "";
      const point = layerPoint(e.clientX, e.clientY);
      const agent = agentsRef.current.find((x) => x.sessionId === id || x.key === id);
      const ids = [...new Set([id, agent?.sessionId, agent?.key].filter((x): x is string => !!x))];
      const onTab = (e.target as Element | null)?.closest?.("[data-desktop]")?.getAttribute("data-desktop") ?? null;
      if (onTab) {
        selectDesktop(onTab);
        setTilesOf(onTab, (prev) => showTile(prev, ids, null, () => nextZ.current++, dropGeometry));
        return;
      }
      setTiles((prev) => dropSessionTile(prev, ids, point, () => nextZ.current++, dropGeometry));
    }
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  /**
   * Gesture-based destinations, one per gesture — Settings → Sessions is
   * where each is configured. `full` (⌘/Ctrl-click, middle click) and
   * `option` (⌥/Option-click, ⌥-Enter) each look up their own setting rather
   * than being hardcoded to "page"/"tile"; a plain click looks up
   * `clickOpensIn`. `tile` and `drawer` bypass the settings entirely: they're
   * the dedicated tile/drawer buttons' explicit ask, not a gesture, and with
   * the gestures independently reconfigurable neither is guaranteed to still
   * be reachable through a setting.
   */
  const showInTasks = useCallback((task: Task) => {
    setFocusTaskId(task.id);
    setTab("tasks");
  }, []);
  const openSession = useCallback(
    (id: string, opts?: { full?: boolean; tile?: boolean; drawer?: boolean; option?: boolean }) => {
      if (opts?.drawer) {
        setOpenId(id);
        return;
      }
      if (opts?.tile) {
        openTile(id);
        return;
      }
      const target = opts?.option
        ? (settings?.ui.optionClickOpensIn ?? "tile")
        : opts?.full
          ? (settings?.ui.cmdClickOpensIn ?? "page")
          : (settings?.ui.clickOpensIn ?? "drawer");
      if (target === "tile") {
        openTile(id);
        return;
      }
      if (target === "page") window.location.hash = `#/session/${encodeURIComponent(id)}`;
      else setOpenId(id);
    },
    [settings?.ui.clickOpensIn, settings?.ui.cmdClickOpensIn, settings?.ui.optionClickOpensIn, openTile],
  );
  useAnswerNextKey(blockedQueue, pageId ?? openId, openSession);
  const servicesContext = useMemo(() => ({ state: services, open: openSession }), [services, openSession]);
  const followLink = useCallback(
    (href: string, gesture?: OpenGesture) => {
      if (!href) return;
      const session = href.match(/^#\/session\/(.+)$/);
      if (session) openSession(decodeURIComponent(session[1]!), { full: !!gesture && (gesture.metaKey || gesture.ctrlKey), option: gesture?.altKey });
      else window.location.hash = href;
    },
    [openSession],
  );
  followRef.current = followLink;

  /** Terminal-owned and still alive: cannot be adopted without a transcript clash. */
  const isLiveExternal = (id: string | null) =>
    !!id && (live?.sessions.some((s) => s.sessionId === id && s.alive) ?? false);

  /**
   * Report what is on screen so the daemon can stay quiet about it. Both the open
   * session and tab visibility matter: a session in a background tab is not being
   * watched, and should still notify.
   */
  const focused = sessionIdFor(pageId ?? openId);
  useEffect(() => {
    const report = () => void settingsApi.focus(focused, document.visibilityState === "visible");
    report();
    document.addEventListener("visibilitychange", report);
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    return () => {
      document.removeEventListener("visibilitychange", report);
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
    };
  }, [focused]);

  // Surface the blocked-session count in the tab title so it is visible from
  // another desktop, which is the whole point of the dashboard.
  useEffect(() => {
    if (prRoute) return;
    const name = settings?.ui.appName?.trim() || "Claude Dashboard";
    document.title = blocked > 0 ? `(${blocked}) ${name}` : name;
    // The title only reads if the tab is wide enough to show it; the favicon dot
    // survives a tab squeezed down to its icon, and the Dock badge survives the
    // window being hidden altogether, which is where this matters most.
    setAttention(blocked);
  }, [blocked, prRoute, settings?.ui.appName]);

  // A tab icon cannot animate on its own — a favicon is rendered as one static frame,
  // so SMIL and CSS inside it never run. This hands the driver the on/off signal and
  // it swaps the <link> href frame by frame.
  useEffect(() => {
    setBusy(thinking > 0);
    return () => setBusy(false);
  }, [thinking]);

  // The header used to hold these three groups; they now live at the two ends
  // and the nav slot of the always-on dock bar (built once here, per render,
  // and handed to TileLayer/TileDock to place around the session chips).
  const appName = settings?.ui.appName?.trim() || "Claude Dashboard";
  const pageIcon = (t: Tab) => (t === "desktop" ? NineDotsIcon : TAB_ICON[t]);
  const goTo = (t: Tab) => {
    setTab(t);
    setOpenId(null);
    // Leaving the full-page view is implicit in picking a page.
    if (onFullPage) window.location.hash = "";
  };

  const sidebarSeen = useSidebarPrefs().seen;
  const onScreen = useMemo(() => {
    const ids = new Set<string>();
    const add = (id: string | null) => {
      if (!id) return;
      ids.add(id);
      const sid = sessionIdFor(id);
      if (sid) ids.add(sid);
    };
    add(pageId ?? openId);
    for (const t of tiles) if (!t.minimized) add(t.id);
    return ids;
  }, [pageId, openId, tiles, sessionIdFor]);
  useEffect(() => {
    if (document.visibilityState !== "visible") return;
    const seen = sidebarPrefs.get().seen;
    const stale = agents
      .map((a) => ({ id: a.sessionId ?? a.key, at: a.updatedAt }))
      .filter((a) => onScreen.has(a.id) && a.at > (seen[a.id] ?? 0));
    if (stale.length > 0) sidebarPrefs.markSeen(stale.map((a) => a.id));
  }, [agents, onScreen]);
  /** Running services that belong to a workspace: the ones started in its checkout. */
  const runningServices = useMemo(
    () =>
      (services?.sessions ?? []).flatMap((session) => {
        const path = sessionPath(services, session.name);
        const ws = path ? workspaces?.workspaces.find((w) => w.folder === path && w.status === "active") : undefined;
        return path && ws ? [{ session, path, workspaceId: ws.id }] : [];
      }),
    [services, workspaces],
  );
  const sidebarSessions = useMemo(
    () => [
      ...buildSessions({ agents, live, titles, seen: sidebarSeen, visible: onScreen }),
      ...restorable
        .filter((r) => !agents.some((a) => a.sessionId === r.sessionId))
        .map((r) => ({
          id: r.sessionId,
          ids: [r.sessionId],
          agentKey: null,
          title: r.title ?? titles.get(r.sessionId)?.title ?? r.cwd.split("/").filter(Boolean).pop() ?? "Session",
          cwd: r.cwd,
          status: "ended" as const,
          why: "Ended when the dashboard restarted",
          pending: 0,
          at: r.lastSeen,
          since: r.lastSeen,
          chat: isChatPath(r.cwd),
          model: (r.model ?? "").replace(/^claude-/, "").replace(/\[.*\]$/, ""),
          external: false,
          resumable: true,
        })),
      ...terminals.map((t) => ({
        id: terminalKey(t.id),
        ids: [terminalKey(t.id)],
        agentKey: null,
        title: t.title,
        cwd: t.folder,
        status: "idle" as const,
        why: null,
        pending: 0,
        at: t.createdAt,
        since: t.createdAt,
        chat: t.workspaceId === null && isChatPath(t.folder),
        model: "",
        external: false,
        terminal: true,
      })),
      ...runningServices.map((x) => {
        const dead = x.session.panes.filter((p) => !p.alive).length;
        return {
          id: serviceKey(x.session.name),
          ids: [serviceKey(x.session.name)],
          agentKey: null,
          title: x.session.serviceLabel,
          cwd: x.path,
          status: "idle" as const,
          why: dead > 0 ? (dead === x.session.panes.length ? "Crashed" : `${dead} of ${x.session.panes.length} panes crashed`) : null,
          pending: 0,
          at: x.session.createdAt,
          since: x.session.createdAt,
          chat: false,
          model: "",
          external: false,
          terminal: true,
          service: true,
          health: x.session.health,
        };
      }),
    ],
    [agents, live, titles, sidebarSeen, onScreen, terminals, restorable, runningServices],
  );
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  useEffect(() => {
    artifactApi
      .list()
      .then((r) => setArtifacts(r.artifacts.filter((a) => !a.missing && !a.hidden)))
      .catch(() => {});
  }, [artifactTick]);
  /** Artifacts under the workspace whose sessions wrote them, newest first. */
  const workspaceArtifacts = useMemo(() => {
    const out = new Map<number, Artifact[]>();
    for (const a of artifacts) {
      const homes = a.link
        ? new Set(a.link.workspaceId === null ? [] : [a.link.workspaceId])
        : new Set(a.sessions.map((s) => workspaces?.sessions[s.id]).filter((id): id is number => id !== undefined));
      for (const id of homes) out.set(id, [...(out.get(id) ?? []), a]);
    }
    return out;
  }, [artifacts, workspaces]);
  /** Artifacts put on a project as a whole, by hand. */
  const projectArtifacts = useMemo(() => {
    const out = new Map<number, Artifact[]>();
    for (const a of artifacts) {
      if (a.link && a.link.workspaceId === null && a.link.projectId !== null) out.set(a.link.projectId, [...(out.get(a.link.projectId) ?? []), a]);
    }
    return out;
  }, [artifacts]);
  const sessionArtifacts = useMemo(() => {
    const out = new Map<string, Artifact[]>();
    for (const a of artifacts) for (const s of a.sessions) out.set(s.id, [...(out.get(s.id) ?? []), a]);
    return out;
  }, [artifacts]);
  const filedWorkspaces = useMemo(() => {
    if (!workspaces) return workspaces;
    const filed = { ...workspaces.sessions };
    const own = { ...(workspaces.projectSessions ?? {}) };
    const folders = workspaces.projects.flatMap((p) => (p.folder ? [{ id: p.id, folder: p.folder }] : []));
    for (const t of terminals) {
      if (t.workspaceId !== null) filed[terminalKey(t.id)] = t.workspaceId;
      else {
        const home = folders
          .filter((p) => t.folder === p.folder || t.folder.startsWith(`${p.folder}/`))
          .sort((a, b) => b.folder.length - a.folder.length)[0];
        if (home) own[terminalKey(t.id)] = home.id;
      }
    }
    for (const x of runningServices) filed[serviceKey(x.session.name)] = x.workspaceId;
    return { ...workspaces, sessions: filed, projectSessions: own };
  }, [workspaces, terminals, runningServices]);
  const newTerminal = useCallback(
    (folder: string, workspaceId: number | null) => {
      terminalApi
        .create(folder, workspaceId)
        .then((r) => openSession(terminalKey(r.terminal.id)))
        .catch(() => {});
    },
    [openSession],
  );
  const tasksDue = useMemo(() => {
    const today = localDay(new Date());
    return (tasks?.tasks ?? []).filter((t) => t.completedAt === null && t.dueDate !== null && t.dueDate <= today).length;
  }, [tasks]);
  const workspaceTasks = useMemo(() => {
    const out = new Map<number, string[]>();
    for (const t of tasks?.tasks ?? []) {
      if (t.workspaceId === null || t.completedAt !== null) continue;
      out.set(t.workspaceId, [...(out.get(t.workspaceId) ?? []), t.content]);
    }
    return out;
  }, [tasks]);
  const pageTasks = useMemo(
    () =>
      (tasks?.tasks ?? [])
        .filter((t) => t.workspaceId === workspacePageId)
        .sort((a, b) => Number(a.completedAt !== null) - Number(b.completedAt !== null) || a.order - b.order),
    [tasks, workspacePageId],
  );
  const minimizedTiles = useMemo(() => {
    const ids = new Set<string>();
    for (const t of tiles) {
      if (!t.minimized) continue;
      ids.add(t.id);
      const sid = sessionIdFor(t.id);
      if (sid) ids.add(sid);
    }
    return ids;
  }, [tiles, sessionIdFor]);
  const workspaceOf = (id: string | null) => {
    const ws = id ? workspaces?.sessions[id] : undefined;
    return ws === undefined ? null : (workspaces?.workspaces.find((w) => w.id === ws) ?? null);
  };
  const startSessionIn = useCallback((folder: string, workspaceId?: number) => {
    setNewIn(folder);
    setNewInWorkspace(workspaceId ?? null);
    setShowNew(true);
  }, []);
  const newProjectTerminal = useCallback(
    (projectId: number) => {
      workspaceApi
        .projectFolder(projectId)
        .then((r) => newTerminal(r.folder, null))
        .catch((e) => window.alert(e instanceof Error ? e.message : String(e)));
    },
    [newTerminal],
  );
  const startProjectSession = useCallback(
    (projectId: number) => {
      workspaceApi
        .projectFolder(projectId)
        .then((r) => startSessionIn(r.folder))
        .catch((e) => window.alert(e instanceof Error ? e.message : String(e)));
    },
    [startSessionIn],
  );

  const sidebar = (
    <Sidebar
      pages={visiblePages(settings?.ui.hiddenPages, settings?.ui.pageOrder)}
      footerPages={settings?.ui.footerPages}
      tab={onFullPage ? null : tab}
      onSelect={goTo}
      iconFor={pageIcon}
      collapsed={sidebarCollapsed}
      away={sidebarAway}
      peek={sidebarAway && sidebarPeek}
      onPeek={sidebarAway ? peekSidebar : undefined}
      onPin={toggleSidebarPin}
      appearance={appearance}
      blocked={blocked}
      thinking={thinking}
      liveCount={liveHere + liveExternal}
      reviewsUnseen={prWatches.unseenCount}
      tasksDue={tasksDue}
      connected={connected}
      name={appName}
      onHome={() => {
        setTab("live");
        if (onFullPage) closePage();
      }}
    >
      <WorkspaceTree
        sessions={sidebarSessions}
        payload={filedWorkspaces}
        activeId={pageId ?? openId ?? frontTileId}
        minimized={minimizedTiles}
        workspaceTasks={workspaceTasks}
        workspaceArtifacts={workspaceArtifacts}
        projectArtifacts={projectArtifacts}
        sessionArtifacts={sessionArtifacts}
        onOpen={openSession}
        onNewWorkspace={(folder, projectId) => setNewWorkspace({ folder: folder ?? null, projectId })}
        onOpenProject={openProject}
        activeProjectId={pageId ? null : (projectPage?.id ?? null)}
        onNewSession={startSessionIn}
        onNewProjectSession={startProjectSession}
        onNewProjectTerminal={newProjectTerminal}
        onOpenWorkspace={openWorkspace}
        onNewTerminal={newTerminal}
        activeWorkspaceId={pageId ? null : (workspacePage?.id ?? null)}
        onNewChat={() => {
          setNewIn(null);
          setNewInWorkspace(null);
          setNewChat(true);
          setShowNew(true);
        }}
      />
      <RailSessions sessions={sidebarSessions} payload={filedWorkspaces} activeId={pageId ?? openId} onOpen={openSession} />
    </Sidebar>
  );

  const projectOf = (id: number | null | undefined) => (id == null ? null : (workspaces?.projects.find((p) => p.id === id) ?? null));
  const pageWorkspace = pageId
    ? (workspaceOf(pageId) ?? workspaces?.workspaces.find((w) => w.id === filedWorkspaces?.sessions[pageId]) ?? null)
    : workspacePage;
  const pageProject = projectPage
    ? null
    : (projectOf(pageWorkspace?.projectId) ??
      projectOf(pageId ? filedWorkspaces?.projectSessions?.[pageId] : null) ??
      projectOf(pageId && isArtifactKey(pageId) ? artifacts.find((a) => a.slug === artifactSlugOf(pageId))?.link?.projectId : null));
  upFromHere.current = workspacePage && pageProject && !pageProject.generalKey ? `#/project/${pageProject.id}` : "";
  /** What the page on screen sits inside, outermost first: the tab, then its project and workspace when it has them. */
  const parents: { label: string; go: () => void }[] = [
    ...(projectPage || pageProject ? [{ label: TAB_LABEL.projects || "Projects", go: () => goTo("projects") }] : []),
    ...(pageProject ? [{ label: pageProject.name, go: () => openProject(pageProject.id) }] : []),
    ...(pageId && pageWorkspace ? [{ label: pageWorkspace.repoName, go: () => openWorkspace(pageWorkspace) }] : []),
  ];
  const crumb = pageId
    ? isServiceKey(pageId)
      ? (services?.sessions.find((x) => x.name === serviceSessionOf(pageId))?.serviceLabel ?? "Service")
      : isTerminalKey(pageId)
      ? (terminals.find((t) => terminalKey(t.id) === pageId)?.title ?? "Terminal")
      : isArtifactKey(pageId)
        ? (artifacts.find((a) => a.slug === artifactSlugOf(pageId))?.title ?? "Artifact")
        : isDrawingKey(pageId)
          ? "Drawing"
          : isNoteKey(pageId)
            ? noteName(notePathOf(pageId))
        : (agentFor(pageId)?.title ?? "Session")
    : projectPage
      ? projectPage.name
      : workspacePage
      ? pageProject && !pageProject.generalKey
        ? `${workspacePage.repoName}${workspacePage.branch ? ` · ${workspacePage.branch}` : ""}`
        : workspaceTitle(workspacePage)
      : prRoute
        ? "Pull request"
        : TAB_LABEL[tab] || "Desktop";

  const topbar = (
    <header className="topbar">
      <button
        className="icon-btn square topbar-collapse"
        onClick={toggleSidebar}
        title={sidebarCollapsed ? "Expand sidebar (⌘B)" : "Collapse sidebar (⌘B)"}
        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <PanelLeftIcon />
      </button>
      <nav className="topbar-crumbs" aria-label="Breadcrumb">
        <button className="topbar-crumb" onClick={() => goTo("live")}>
          {appName}
        </button>
        {parents.map((p) => (
          <Fragment key={p.label}>
            <span className="topbar-crumb-sep" aria-hidden>
              ›
            </span>
            <button className="topbar-crumb" onClick={p.go}>
              {p.label}
            </button>
          </Fragment>
        ))}
        <span className="topbar-crumb-sep" aria-hidden>
          ›
        </span>
        <span className="topbar-crumb current">{crumb}</span>
      </nav>
      <span style={{ flex: 1 }} />
      <button className="topbar-search" onClick={() => setShowPalette(true)} title="Search sessions, pages and commands">
        <SearchIcon />
        <span>Search…</span>
        <kbd>⌘K</kbd>
      </button>
      <NotificationBell unread={inbox.unread} open={showInbox} onToggle={() => setShowInbox((v) => !v)} />
      <button
        className="icon-btn square mode-toggle"
        title={`Switch to ${appearance.theme === "dark" ? "light" : "dark"} mode — full theme and icon options live in Settings → Appearance`}
        aria-label={`Switch to ${appearance.theme === "dark" ? "light" : "dark"} mode`}
        onClick={() => changeAppearance({ theme: appearance.theme === "dark" ? "light" : "dark" })}
      >
        <SunMoonIcon />
      </button>
    </header>
  );

  return (
    <WeekStartContext.Provider value={settings?.ui.calendarWeekStart ?? 1}>
    <ServicesContext.Provider value={servicesContext}>
    <div className="app">
      {sidebar}
      {sidebarAway && <div className="sidebar-edge" aria-hidden="true" onMouseEnter={() => peekSidebar(true)} onMouseLeave={() => peekSidebar(false)} />}
      <div className="app-main">
        {topbar}
        <div className="shell">
      {pageId && isServiceKey(pageId) && <ServicePage id={pageId} onBack={closePage} />}
      {pageId && isTerminalKey(pageId) && (
        <TerminalPage id={pageId} onBack={closePage} onOpenWorkspace={(id) => openWorkspace({ id })} />
      )}
      {pageId && isArtifactKey(pageId) && <ArtifactPage id={pageId} onBack={closePage} />}
      {pageId && isDrawingKey(pageId) && <DrawingPage id={pageId} onBack={closePage} />}
      {pageId && isNoteKey(pageId) && <NotePage id={pageId} onBack={closePage} onOpen={(key) => openSession(key, { full: true })} />}
      {pageId && !isTerminalKey(pageId) && !isServiceKey(pageId) && !isArtifactKey(pageId) && !isDrawingKey(pageId) && !isNoteKey(pageId) && (
        <SessionPage
          id={sessionIdFor(pageId) ?? pageId}
          agent={agentFor(pageId)}
          live={isLiveExternal(pageId)}
          settings={settings}
          onSettings={setSettings}
          onBack={closePage}
          // Adopting a past session: resume it under dashboard ownership. The route
          // already points at this session id, so the page turns interactive in place.
          onContinue={async (sessionId, cwd, title) => {
            await agentApi.start({ cwd, resume: sessionId, title: title ?? undefined });
          }}
          // A branch checked out in another worktree cannot be switched to here, so
          // the offer is to start a session in the checkout that does hold it.
          workspace={workspaceOf(sessionIdFor(pageId) ?? pageId) ?? workspaceOf(pageId)}
          onOpenWorkspace={openWorkspace}
        />
      )}

      {workspacePage && !pageId && (
        <WorkspacePage
          key={workspacePage.id}
          workspace={workspacePage}
          sessions={sidebarSessions.filter((s) => s.ids.some((id) => filedWorkspaces?.sessions[id] === workspacePage.id))}
          onNewTerminal={newTerminal}
          artifacts={workspaceArtifacts.get(workspacePage.id) ?? NO_ARTIFACTS}
          tasks={pageTasks}
          shared={(workspaces?.workspaces ?? []).filter((o) => o.id !== workspacePage.id && o.status !== "archived" && o.folder === workspacePage.folder).length}
          settings={settings}
          onSettings={setSettings}
          onBack={closePage}
          onOpenSession={openSession}
          onNewSession={startSessionIn}
          onOpenWorktree={(path) => {
            setNewIn(path);
            setShowNew(true);
          }}
          services={services}
          onOpenServiceSettings={openServiceSettings}
          project={workspaces?.projects.find((p) => p.id === workspacePage.projectId) ?? null}
          siblings={(workspaces?.workspaces ?? []).filter((o) => o.id !== workspacePage.id && o.projectId === workspacePage.projectId && o.status !== "archived").length}
        />
      )}

      {projectPage && !pageId && (
        <ProjectPage
          key={projectPage.id}
          project={projectPage}
          workspaces={projectWorkspaces}
          sessions={sidebarSessions.filter((s) =>
            s.ids.some(
              (id) => projectWorkspaces.some((w) => filedWorkspaces?.sessions[id] === w.id) || filedWorkspaces?.projectSessions?.[id] === projectPage.id,
            ),
          )}
          sessionHomes={filedWorkspaces?.sessions ?? NO_HOMES}
          artifacts={[
            ...new Map(
              [...(projectArtifacts.get(projectPage.id) ?? NO_ARTIFACTS), ...projectWorkspaces.flatMap((w) => workspaceArtifacts.get(w.id) ?? NO_ARTIFACTS)].map((a) => [a.slug, a]),
            ).values(),
          ]}
          tasks={(tasks?.tasks ?? [])
            .filter((t) => (t.workspaceId !== null && projectWorkspaces.some((w) => w.id === t.workspaceId)) || (t.workProjectId ?? null) === projectPage.id)
            .sort((a, b) => Number(a.completedAt !== null) - Number(b.completedAt !== null) || a.order - b.order)}
          services={services}
          onBack={closePage}
          onOpenSession={openSession}
          onNewSession={startSessionIn}
          onNewProjectSession={startProjectSession}
          onNewProjectTerminal={newProjectTerminal}
          onNewTerminal={newTerminal}
          onNewWorkspace={(folder, projectId) => setNewWorkspace({ folder: folder ?? null, projectId })}
          onOpenServiceSettings={openServiceSettings}
        />
      )}

      {/* Budget tiles answer "how much have I spent", which is a question the Live and
          Usage tabs are about. On Worktrees and Settings they are a header you scroll
          past to reach the thing you came for, and Desktop is meant to be blank on
          purpose — a clean backdrop for arranging tiles against, not another page
          with its own content competing for the same space. */}
      {prRoute && !pageId && !workspacePage && (
        <PrPage
          route={prRoute}
          agents={agents}
          watches={prWatches.watches}
          settings={settings}
          onSettings={setSettings}
          onBack={() => {
            setTab("reviews");
            window.location.hash = "";
          }}
        />
      )}

      {!onFullPage && usage && tab !== "live" && tab !== "worktrees" && tab !== "settings" && tab !== "desktop" && tab !== "reviews" && tab !== "artifacts" && tab !== "drawings" && tab !== "notes" && tab !== "projects" && tab !== "services" && tab !== "templates" && tab !== "tasks" && tab !== "calendar" && tab !== "history" && (
        <div className="kpis">
          {/* Tokens here are fresh tokens: cache reads are excluded and shown
              separately, since they are ~97% of raw volume at a tenth the rate. */}
          {usage.plan?.fiveHour ? (
            <Tile
              label="Current session"
              value={`${Math.round(usage.plan.fiveHour.pct)}%`}
              sub={usage.plan.fiveHour.resetsAt ? fmtResets(usage.plan.fiveHour.resetsAt - usage.now) : "5-hour window"}
              pct={usage.plan.fiveHour.pct}
              note={[`${fmtTokens(usage.session.fresh)} fresh tokens here`, "from Claude"]}
            />
          ) : (
            <Tile
              label="Current session"
              value={fmtTokens(usage.session.fresh)}
              sub={fmtResets(usage.sessionWindow.resetsInMs)}
              pct={usage.remaining.sessionPct}
              note={[
                `${Math.round(usage.remaining.sessionPct)}% used`,
                fmtTokens(usage.budgets.sessionTokens),
              ]}
            />
          )}
          {/* API-list-price estimate of today's traffic, for scale. No bar: on a
              subscription nothing is metered in dollars, so a budget here was a
              made-up ceiling that only ever looked like an alarm. */}
          <Tile
            label="Today"
            value={fmtUsd(usage.day.costUsd)}
            sub={`${fmtTokens(usage.day.fresh)} fresh tokens · at API list prices`}
          />
          {usage.plan?.sevenDay ? (
            <Tile
              label="Weekly · all models"
              value={`${Math.round(usage.plan.sevenDay.pct)}%`}
              sub={usage.plan.sevenDay.resetsAt ? fmtResets(usage.plan.sevenDay.resetsAt - usage.now) : "7-day window"}
              pct={usage.plan.sevenDay.pct}
              note={[`${fmtTokens(usage.week.fresh)} fresh tokens here`, "from Claude"]}
            />
          ) : (
            <Tile
              label="Weekly · all models"
              value={fmtTokens(usage.week.fresh)}
              sub={fmtResets(usage.weeklyWindow.resetsInMs)}
              pct={usage.remaining.weeklyPct}
              note={[
                `${Math.round(usage.remaining.weeklyPct)}% used`,
                `${fmtTokens(usage.budgets.weeklyTokens)}${usage.boostActive ? " boosted" : ""}`,
              ]}
            />
          )}
          <Tile
            label="All time"
            value={fmtTokens(usage.allTime.fresh)}
            sub={`${fmtUsd(usage.allTime.costUsd)} across ${recent.length} sessions`}
          />
        </div>
      )}

      {!onFullPage && tab === "desktop" && (
        <>
          <DesktopBar desktops={desks.desktops} active={desks.active} onSelect={selectDesktop} onAdd={addDesktop} onRename={renameDesktop} onClose={closeDesktop} onMove={moveDesktop} />
          <DesktopView />
        </>
      )}
      {!onFullPage && tab === "reviews" && (
        <ReviewsView
          settings={settings}
          watches={prWatches.watches}
          onSettings={setSettings}
          onOpenSettings={() => {
            localStorage.setItem("settings-section", "code");
            setTab("settings");
          }}
        />
      )}
      {!onFullPage && tab === "live" && (
        <HomeView
          sessions={sidebarSessions}
          payload={filedWorkspaces}
          tasks={tasks}
          usage={usage}
          watches={prWatches.watches}
          calendarHidden={settings?.ui.calendarHidden ?? []}
          onOpen={openSession}
          onNew={() => setShowNew(true)}
          onOpenProject={openProject}
          onOpenWorkspace={openWorkspace}
          onGo={goTo}
        />
      )}
      {!onFullPage && tab === "tasks" && (
        <TasksView
          payload={tasks}
          calendarHidden={settings?.ui.calendarHidden ?? []}
          onOpenCalendar={() => goTo("calendar")}
          focusTaskId={focusTaskId}
          onFocused={clearFocusTask}
          workspaces={workspaces?.workspaces ?? []}
          workProjects={workspaces?.projects ?? NO_PROJECT_LIST}
          onOpenWorkProject={openProject}
          onStartWorkspace={(task) => {
            const repo = tasks?.projects.find((p) => p.id === task.projectId)?.repoKey ?? null;
            const folder = repo?.startsWith("repo:") ? repo.slice(5).replace(/\/\.git$/, "") : null;
            setNewWorkspace({ folder, task });
          }}
          onOpenWorkspace={(w) => {
            const first = sidebarSessions.find((s) => s.ids.some((id) => workspaces?.sessions[id] === w.id));
            if (first) openSession(first.id);
            else startSessionIn(w.folder, w.id);
          }}
        />
      )}
      {!onFullPage && tab === "calendar" && <CalendarView tasks={tasks?.tasks ?? NO_TASKS} projects={tasks?.projects ?? NO_PROJECTS} settings={settings}
          onSettings={setSettings}
          changed={calendarChanged}
          goTo={calendarGoTo}
          onOpenSession={openSession}
          onOpenInTasks={showInTasks}
        />}
      {!onFullPage && tab === "history" && (
        <HistoryView
          onOpen={openSession}
          liveIds={
            new Set(
              agents
                .filter((a) => a.sessionId && a.status !== "ended" && a.status !== "error")
                .map((a) => a.sessionId!),
            )
          }
        />
      )}
      {!onFullPage && tab === "artifacts" && (
        <ArtifactsView projects={workspaces?.projects ?? NO_PROJECT_LIST} onOpenSession={openSession} reloadKey={artifactTick} />
      )}
      {!onFullPage && tab === "projects" && (
        <ProjectsView
          projects={workspaces?.projects ?? NO_PROJECT_LIST}
          workspaces={workspaces?.workspaces ?? NO_WORKSPACES}
          sessions={sidebarSessions}
          sessionHomes={filedWorkspaces?.sessions ?? NO_HOMES}
          tasks={tasks?.tasks ?? NO_TASKS}
          onOpen={openProject}
        />
      )}
      {!onFullPage && tab === "notes" && <NotesView onOpen={openSession} />}
      {!onFullPage && tab === "drawings" && <DrawingsView projects={workspaces?.projects ?? NO_PROJECT_LIST} onOpen={openSession} />}
      {!onFullPage && tab === "worktrees" && (
        <WorktreesView
          settings={settings}
          onSettings={setSettings}
          // The same offer the session page makes: a checkout is only useful with a
          // session in it, and the new-session dialog is where a session is configured.
          onOpenWorktree={(path) => {
            setNewIn(path);
            setShowNew(true);
          }}
        />
      )}
      {!onFullPage && tab === "templates" && (
        <TemplatesView
          settings={settings}
          onSettings={setSettings}
          agents={agents}
          runsKey={templateRunsKey}
          onOpenSession={(key) => openSession(key)}
        />
      )}
      {!onFullPage && tab === "services" && (
        <ServicesView
          state={services}
          workspaces={workspaces}
          settings={settings}
          onSettings={setSettings}
          onOpenSettings={() => {
            localStorage.setItem("settings-section", "services");
            setTab("settings");
          }}
        />
      )}
      {!onFullPage && tab === "usage" && <UsageView usage={usage} onOpen={openSession} />}
      {!onFullPage && tab === "settings" && (
        <SettingsView
          settings={settings}
          onSettings={setSettings}
          appearance={appearance}
          onAppearance={changeAppearance}
        />
      )}

      {/* Below the drawer in the DOM (and in z-index) so opening a session in the
          drawer is never lost behind a tile someone left open. */}
      <TileLayer
        tiles={tiles}
        agentFor={agentFor}
        sessionIdFor={sessionIdFor}
        settings={settings}
        onSettings={setSettings}
        onClose={closeTile}
        onFocus={focusTile}
        onRectChange={updateTileRect}
        onLayerSize={fitDesktops}
        onOpenFull={openTileFull}
        onMinimize={minimizeTile}
        onCopyToDesktop={copyTileToDesktop}
      />

      {openId && (
        <SessionDrawer
          id={sessionIdFor(openId) ?? openId}
          agent={agentFor(openId)}
          settings={settings}
          onSettings={setSettings}
          onClose={closeDrawer}
        />
      )}

      {/* Suppressed while an overlay owns the screen: its own control is there. */}
      {!openId && !showNew && !showFolders && !showPalette && <PageScrollJump />}

      <Toaster />
      {showInbox && (
        <NotificationCenter
          inbox={inbox}
          onInbox={setInbox}
          onFollow={followLink}
          onClose={() => setShowInbox(false)}
          onOpenSettings={() => {
            localStorage.setItem("settings-section", "notifications");
            setShowInbox(false);
            goTo("settings");
          }}
        />
      )}
      {showPalette && (
        <Palette
          sessions={sidebarSessions}
          payload={filedWorkspaces}
          tasks={tasks}
          artifacts={artifacts}
          context={
            projectPage
              ? { projectId: projectPage.id, workspaceId: null, name: projectPage.name }
              : workspacePage
                ? { projectId: workspacePage.projectId, workspaceId: workspacePage.id, name: workspaceTitle(workspacePage) }
                : null
          }
          onNewChat={() => {
            setNewChat(true);
            setShowNew(true);
          }}
          onNewWorkspace={(projectId) => setNewWorkspace({ folder: null, projectId })}
          onNewProjectSession={startProjectSession}
          onNewProjectTerminal={newProjectTerminal}
          onOpenProject={openProject}
          onOpenWorkspace={openWorkspace}
          onOpenTask={(id) => {
            setFocusTaskId(id);
            goTo("tasks");
          }}
          pageIcons={TAB_ICON}
          projects={projects}
          recent={recent}
          appearance={appearance}
          hiddenPages={settings?.ui.hiddenPages}
          pageOrder={settings?.ui.pageOrder}
          onClose={() => setShowPalette(false)}
          onOpenSession={openSession}
          onTab={goTo}
          onNewSession={() => setShowNew(true)}
          onNewIn={(cwd) => {
            setNewIn(cwd);
            setShowNew(true);
          }}
          onManageFolders={() => setShowFolders(true)}
          templates={settings?.templates ?? []}
          onRunTemplate={(id) => {
            const t = settings?.templates.find((x) => x.id === id);
            if (!t) return;
            if (!t.research && !t.cwd) {
              setTab("templates");
              return;
            }
            void templateApi.run(id).then((r) => openSession(r.key)).catch(() => setTab("templates"));
          }}
          onFind={() => {
            setShowFind(true);
            requestAnimationFrame(() =>
              document.querySelector<HTMLInputElement>(".find-input")?.select(),
            );
          }}
          onAppearance={changeAppearance}
        />
      )}

      {showFind && <FindBar onClose={() => setShowFind(false)} />}

      {showFolders && <FoldersModal onClose={() => setShowFolders(false)} />}

      {newWorkspace && (
        <NewWorkspaceDialog
          initialFolder={newWorkspace.folder}
          initialGoal={newWorkspace.task?.content ?? ""}
          projectId={newWorkspace.projectId}
          project={workspaces?.projects.find((p) => p.id === newWorkspace.projectId && !p.generalKey) ?? null}
          projects={projects}
          onClose={() => setNewWorkspace(null)}
          onCreated={(w, startChat) => {
            const task = newWorkspace.task;
            if (task) void taskApi.link(task.id, w.id).catch(() => {});
            setNewWorkspace(null);
            if (startChat) startSessionIn(w.folder, w.id);
          }}
        />
      )}

      {showNew && (
        <NewSessionModal
          projects={projects}
          initialCwd={newIn}
          initialResearch={newChat}
          workspaceId={newInWorkspace}
          settings={settings}
          onClose={() => {
            setNewChat(false);
            setShowNew(false);
            setNewIn(null);
            setNewInWorkspace(null);
          }}
          onStarted={(key) => {
            setNewChat(false);
            setShowNew(false);
            setNewIn(null);
            setNewInWorkspace(null);
            setTab("live");
            window.location.hash = "";
            setOpenId(key);
          }}
        />
      )}
        </div>
      </div>
    </div>
    </ServicesContext.Provider>
    </WeekStartContext.Provider>
  );
}
