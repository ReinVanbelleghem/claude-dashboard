import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  agentApi,
  agentBus,
  api,
  settingsApi,
  fmtResets,
  fmtTokens,
  fmtUsd,
  type AgentSummary,
  type LivePayload,
  type Overview,
  type Restorable,
  type NotifyPayload,
  type Settings,
  type SessionRow,
  type UsagePayload,
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
import { ChartIcon, ClockIcon, GearIcon, NineDotsIcon, PulseIcon, SunMoonIcon, WorktreeIcon } from "./components/Icons.tsx";
import { BrandMark } from "./components/BrandMark.tsx";
import { AnswerNext } from "./components/AnswerNext.tsx";
import { Tile } from "./components/Charts.tsx";
import { DesktopView } from "./components/DesktopView.tsx";
import { FindBar } from "./components/FindBar.tsx";
import { HistoryView } from "./components/HistoryView.tsx";
import { LiveView } from "./components/LiveView.tsx";
import { FoldersModal } from "./components/FoldersModal.tsx";
import { NewSessionModal } from "./components/NewSessionModal.tsx";
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
  hitTestTile,
  readTiles,
  rectForZone,
  writeTiles,
  SESSION_DRAG_MIME,
  type TileRect,
  type TileState,
} from "./tiles.ts";

type Tab = "desktop" | "live" | "history" | "worktrees" | "usage" | "settings";
const TAB_LABEL: Record<Tab, string> = {
  // Icon-only — see the dock nav render, which special-cases this one.
  desktop: "",
  live: "Live",
  history: "History",
  worktrees: "Worktrees",
  usage: "Usage",
  settings: "Settings",
};

/** Icons for the non-desktop dock tabs, keyed the same way so a glyph is trivial
 * to swap: change the value here, nothing else. `desktop` is deliberately
 * excluded — it stays icon-only via NineDotsIcon in the dock render. */
const TAB_ICON: Record<Exclude<Tab, "desktop">, () => JSX.Element> = {
  live: PulseIcon,
  history: ClockIcon,
  worktrees: WorktreeIcon,
  usage: ChartIcon,
  settings: GearIcon,
};

/** The only route: #/session/<id> for the full-page session view. */
function routeSessionId(): string | null {
  const m = window.location.hash.match(/^#\/session\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("live");
  const [live, setLive] = useState<LivePayload | null>(null);
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [connected, setConnected] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pageId, setPageId] = useState<string | null>(routeSessionId);
  const [tiles, setTiles] = useState<TileState[]>(readTiles);
  const nextZ = useRef(1 + tiles.reduce((m, t) => Math.max(m, t.z), 0));
  // Live sessions explicitly closed out of the dock (red light) rather than just
  // minimized — cleared the moment one is reopened, from openTile.
  const [dismissedLive, setDismissedLive] = useState<Set<string>>(new Set());

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
  const [restorable, setRestorable] = useState<Restorable[]>([]);
  const [projects, setProjects] = useState<Overview["projects"]>([]);
  const [showNew, setShowNew] = useState(false);
  /**
   * Directory the new-session dialog should open on, set when something else picked
   * it for you — opening a worktree that already holds the branch you wanted, say.
   * Null means the dialog falls back to its own shortlist.
   */
  const [newIn, setNewIn] = useState<string | null>(null);
  const [showFolders, setShowFolders] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showFind, setShowFind] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
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
      const id = routeSessionId();
      setPageId(id);
      if (id) setOpenId(null);
    };
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
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "f") {
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
      settingsApi.save({ ui: { appearance: next } }).catch(() => {});
      return next;
    });
  }, []);

  const refreshRecent = useCallback(() => {
    api.sessions("", 300).then((r) => setRecent(r.sessions)).catch(() => {});
  }, []);

  useEffect(refreshRecent, [refreshRecent]);

  useEffect(() => {
    settingsApi
      .get()
      .then((r) => {
        setSettings(r.settings);
        // The daemon's copy wins on load, so a choice made in one browser shows up
        // in the next one you open. Local storage only covers the pre-paint gap.
        // Normalised rather than spread: the nested slider and colour objects need
        // filling out too, or a copy written before a key existed arrives missing it.
        if (r.settings.ui.appearance) {
          setAppearance(normalizeAppearance(r.settings.ui.appearance));
        }
      })
      .catch(() => {});
  }, []);

  // Known project paths feed the directory picker when starting a session.
  useEffect(() => {
    api.overview().then((o) => setProjects(o.projects)).catch(() => {});
  }, []);

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
    // The daemon owns the decision to notify; the tab only raises the banner.
    es.addEventListener("notify", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as NotifyPayload;
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
        if (p.sessionId) window.location.hash = `#/session/${encodeURIComponent(p.sessionId)}`;
        note.close();
      };
    });
    es.addEventListener("index", () => refreshRecent());

    /**
     * Something wrote to a repository, possibly in another tab or another worktree of it.
     * Dropping the shared status cache is what makes every branch badge on the page — and
     * the worktree list, which watches the same signal — re-read instead of showing a
     * branch that has since moved.
     */
    const wrote = () => invalidateStatusCache();
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
    for (const name of ["agent-item", "agent-delta", "agent-models", "agent-commands", "agent-tasks"] as const) {
      es.addEventListener(name, (e) =>
        agentBus.publish({ type: name, ...JSON.parse((e as MessageEvent).data) }),
      );
    }
    return () => es.close();
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
  const closePage = useCallback(() => {
    window.location.hash = "";
  }, []);
  const closeDrawer = useCallback(() => setOpenId(null), []);

  // Persisted so a reload finds the same windows in the same places; re-saved
  // on every change rather than only on close, since a crash or a stray
  // reload should not lose a layout you just spent time arranging.
  useEffect(() => writeTiles(tiles), [tiles]);

  // A width/height saved on a bigger monitor, or a window just resized
  // narrower, should not strand a tile off-screen with no way to reach it —
  // the same lesson the drawer's own width already learned.
  useEffect(() => {
    function onResize() {
      setTiles((prev) => prev.map((t) => ({ ...t, rect: clampRect(t.rect) })));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const focusTile = useCallback((id: string) => {
    setTiles((prev) => prev.map((t) => (t.id === id ? { ...t, z: nextZ.current++ } : t)));
  }, []);

  const openTile = useCallback((id: string) => {
    setDismissedLive((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
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

  // Closing drops the tile entirely, minimized or not — the dock is a shelf
  // for windows you're keeping around, not a second place a closed one lingers.
  // For a still-live session, that shelf spot would otherwise reappear on its
  // own (a live agent always earns a dock icon) — so closing also dismisses
  // it from the dock until it's reopened from the Live tab, the same way
  // quitting an app removes its Dock icon instead of leaving it running.
  const closeTile = useCallback((id: string) => {
    setTiles((prev) => prev.filter((t) => t.id !== id));
    setDismissedLive((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
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
  const desktopMounted = useRef(false);
  useEffect(() => {
    const onDesktop = tab === "desktop" && !pageId;
    if (!desktopMounted.current) {
      desktopMounted.current = true;
      return;
    }
    if (onDesktop) {
      setTiles((prev) => {
        if (!prev.some((t) => t.hiddenByTab)) return prev;
        return prev.map((t) =>
          t.hiddenByTab ? { ...t, minimized: false, hiddenByTab: false, z: nextZ.current++ } : t,
        );
      });
      return;
    }
    setTiles((prev) => {
      const openIds = new Set(prev.filter((t) => !t.minimized).map((t) => t.id));
      if (openIds.size === 0) return prev;
      return prev.map((t) => (openIds.has(t.id) ? { ...t, minimized: true, hiddenByTab: true } : t));
    });
  }, [tab, pageId]);

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
      const point = { x: e.clientX, y: e.clientY };
      setTiles((prev) => {
        const target = hitTestTile(prev, point);
        if (target && target.id !== id) {
          const dropOnRight = point.x > target.rect.x + target.rect.w / 2;
          const targetRect = rectForZone(dropOnRight ? "left" : "right");
          const droppedRect = rectForZone(dropOnRight ? "right" : "left");
          const z = nextZ.current++;
          const rest = prev.filter((t) => t.id !== id && t.id !== target.id);
          const dropped = prev.find((t) => t.id === id);
          return [
            ...rest,
            { ...target, rect: targetRect },
            { id, rect: droppedRect, z: dropped?.z ?? z },
          ];
        }
        const existing = prev.find((t) => t.id === id);
        const size = existing?.rect ?? defaultRect(prev.length);
        const rect = clampRect({ x: point.x - size.w / 2, y: Math.max(0, point.y - 18), w: size.w, h: size.h });
        if (existing) return prev.map((t) => (t.id === id ? { ...t, rect, z: nextZ.current++ } : t));
        return [...prev, { id, rect, z: nextZ.current++ }];
      });
    }
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  /**
   * Three independent destinations, one per gesture — Settings → Sessions is
   * where each is configured. `full`/`tile` (⌘/Ctrl-click, middle click,
   * ⌥/Option-click) each look up their own setting rather than being
   * hardcoded to "page"/"tile"; a plain click looks up `clickOpensIn`. `tile`
   * wins over `full` if somehow both fire, matching the old hardcoded
   * priority — a floating window is more specific than "give it the whole
   * page" either way. `drawer` bypasses the settings entirely: it's the
   * dedicated drawer button's explicit ask, not a gesture, and with the
   * other three all independently reconfigurable none of them is guaranteed
   * to still reach the drawer.
   */
  const openSession = useCallback(
    (id: string, opts?: { full?: boolean; tile?: boolean; drawer?: boolean }) => {
      if (opts?.drawer) {
        setOpenId(id);
        return;
      }
      const target = opts?.tile
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
    document.title = blocked > 0 ? `(${blocked}) Claude Sessions` : "Claude Sessions";
    // The title only reads if the tab is wide enough to show it; the favicon dot
    // survives a tab squeezed down to its icon, and the Dock badge survives the
    // window being hidden altogether, which is where this matters most.
    setAttention(blocked);
  }, [blocked]);

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
  const dockLeading = (
    <div className="brand">
      {/* Same glyph as the tab icon, badge included, so the window and the dock
          read as one thing. The rings are the in-page equivalent of the tab
          badge: they only run while a session is waiting. */}
      <button
        className="brand-home"
        title="Back to Live"
        aria-label="Back to Live"
        onClick={() => {
          setTab("live");
          if (pageId) closePage();
        }}
      >
        <BrandMark appearance={appearance} blocked={blocked} thinking={thinking} />
      </button>
      {/* Both kinds, because this is the one place that should answer "is
          anything running". live.counts.alive is external sessions only — the
          dashboard's own are deliberately excluded from that payload — so on
          its own it read "0 live" with two sessions on screen, one thinking. */}
      <small title={`${liveHere} started here · ${liveExternal} external`}>
        {liveHere + liveExternal} live
      </small>
      <span
        className={`conn ${connected ? "" : "off"}`}
        title={connected ? "streaming" : "reconnecting"}
      >
        <i className="dot" />
      </span>
    </div>
  );

  const dockNav = (
    <nav className="dock-nav">
      {(["desktop", "live", "history", "worktrees", "usage", "settings"] as Tab[]).map((t) => {
        const Icon = t === "desktop" ? NineDotsIcon : TAB_ICON[t];
        return (
          <button
            key={t}
            className="dock-nav-btn dock-nav-btn-icon"
            aria-selected={tab === t && !pageId}
            title={t === "desktop" ? "Desktop — a blank canvas for arranging tiles" : TAB_LABEL[t]}
            onClick={() => {
              setTab(t);
              // Leaving the full-page view is implicit in picking a tab.
              if (pageId) window.location.hash = "";
            }}
          >
            <Icon />
            {t === "live" && blocked > 0 && <span className="badge">{blocked}</span>}
          </button>
        );
      })}
    </nav>
  );

  // The icon is the mode you are about to get, which is what the word here used
  // to say. The tooltip carries the same sentence for anything not looking.
  const dockTrailing = (
    <button
      className="icon-btn mode-toggle"
      title={`Switch to ${appearance.theme === "dark" ? "light" : "dark"} mode — full theme and icon options live in Settings → Appearance`}
      aria-label={`Switch to ${appearance.theme === "dark" ? "light" : "dark"} mode`}
      onClick={() => changeAppearance({ theme: appearance.theme === "dark" ? "light" : "dark" })}
    >
      <SunMoonIcon />
    </button>
  );

  return (
      <div className="shell">
      <AnswerNext
        queue={blockedQueue}
        external={needsInput}
        openId={pageId ?? openId}
        onOpen={openSession}
      />

      {pageId && (
        <SessionPage
          id={sessionIdFor(pageId) ?? pageId}
          agent={agentFor(pageId)}
          live={isLiveExternal(pageId)}
          settings={settings}
          onSettings={setSettings}
          onBack={closePage}
          // Adopting a past session: resume it under dashboard ownership. The route
          // already points at this session id, so the page turns interactive in place.
          onContinue={async (sessionId, cwd) => {
            await agentApi.start({ cwd, resume: sessionId });
          }}
          // A branch checked out in another worktree cannot be switched to here, so
          // the offer is to start a session in the checkout that does hold it.
          onOpenWorktree={(path) => {
            setNewIn(path);
            setShowNew(true);
          }}
        />
      )}

      {/* Budget tiles answer "how much have I spent", which is a question the Live and
          Usage tabs are about. On Worktrees and Settings they are a header you scroll
          past to reach the thing you came for, and Desktop is meant to be blank on
          purpose — a clean backdrop for arranging tiles against, not another page
          with its own content competing for the same space. */}
      {!pageId && usage && tab !== "worktrees" && tab !== "settings" && tab !== "desktop" && (
        <div className="kpis">
          {/* Tokens here are fresh tokens: cache reads are excluded and shown
              separately, since they are ~97% of raw volume at a tenth the rate. */}
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
          <Tile
            label="Today"
            value={fmtUsd(usage.day.costUsd)}
            sub={`${fmtTokens(usage.day.fresh)} fresh tokens`}
            pct={usage.remaining.dailyCostPct}
            note={[
              `${Math.round(usage.remaining.dailyCostPct)}% of budget`,
              fmtUsd(usage.budgets.dailyCostUsd),
            ]}
          />
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
          <Tile
            label="All time"
            value={fmtTokens(usage.allTime.fresh)}
            sub={`${fmtUsd(usage.allTime.costUsd)} across ${recent.length} sessions`}
          />
        </div>
      )}

      {!pageId && tab === "desktop" && <DesktopView />}
      {!pageId && tab === "live" && (
        <LiveView
          live={live}
          agents={agents}
          restorable={restorable}
          titles={titles}
          onOpen={openSession}
          // Before init lands there is no session id yet, so the key stands in.
          onOpenAgent={(a, opts) => openSession(a.sessionId ?? a.key, opts)}
          onNew={() => setShowNew(true)}
          onManageFolders={() => setShowFolders(true)}
          settings={settings}
          onSettings={setSettings}
        />
      )}
      {!pageId && tab === "history" && <HistoryView onOpen={openSession} />}
      {!pageId && tab === "worktrees" && (
        <WorktreesView
          settings={settings}
          // The same offer the session page makes: a checkout is only useful with a
          // session in it, and the new-session dialog is where a session is configured.
          onOpenWorktree={(path) => {
            setNewIn(path);
            setShowNew(true);
          }}
        />
      )}
      {!pageId && tab === "usage" && <UsageView usage={usage} onOpen={openSession} />}
      {!pageId && tab === "settings" && (
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
        agents={agents}
        dismissedLive={dismissedLive}
        agentFor={agentFor}
        sessionIdFor={sessionIdFor}
        settings={settings}
        onSettings={setSettings}
        onClose={closeTile}
        onFocus={focusTile}
        onRectChange={updateTileRect}
        onOpenFull={openTileFull}
        onMinimize={minimizeTile}
        onOpen={openTile}
        onToggleMinimizeAll={toggleMinimizeAll}
        dockLeading={dockLeading}
        dockNav={dockNav}
        dockTrailing={dockTrailing}
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

      {showPalette && (
        <Palette
          agents={agents}
          projects={projects}
          recent={recent}
          appearance={appearance}
          onClose={() => setShowPalette(false)}
          onOpenSession={openSession}
          onTab={(t) => {
            setTab(t);
            if (pageId) window.location.hash = "";
          }}
          onNewSession={() => setShowNew(true)}
          onNewIn={(cwd) => {
            setNewIn(cwd);
            setShowNew(true);
          }}
          onManageFolders={() => setShowFolders(true)}
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

      {showNew && (
        <NewSessionModal
          projects={projects}
          initialCwd={newIn}
          onClose={() => {
            setShowNew(false);
            setNewIn(null);
          }}
          onStarted={(key) => {
            setShowNew(false);
            setNewIn(null);
            setTab("live");
            window.location.hash = "";
            setOpenId(key);
          }}
        />
      )}
      </div>
  );
}
