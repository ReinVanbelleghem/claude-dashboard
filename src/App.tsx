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
import { SunMoonIcon } from "./components/Icons.tsx";
import { BrandMark } from "./components/BrandMark.tsx";
import { AnswerNext } from "./components/AnswerNext.tsx";
import { Tile } from "./components/Charts.tsx";
import { FindBar } from "./components/FindBar.tsx";
import { HistoryView } from "./components/HistoryView.tsx";
import { LiveView } from "./components/LiveView.tsx";
import { FoldersModal } from "./components/FoldersModal.tsx";
import { NewSessionModal } from "./components/NewSessionModal.tsx";
import { Palette } from "./components/Palette.tsx";
import { SessionDrawer } from "./components/SessionDrawer.tsx";
import { SessionPage } from "./components/SessionPage.tsx";
import { invalidateStatusCache } from "./components/useGitRepo.ts";
import { SettingsView } from "./components/SettingsView.tsx";
import { PageScrollJump } from "./components/scroll.tsx";
import { UsageView } from "./components/UsageView.tsx";
import { WorktreesView } from "./components/WorktreesView.tsx";

type Tab = "live" | "history" | "worktrees" | "usage" | "settings";
const TAB_LABEL: Record<Tab, string> = {
  live: "Live",
  history: "History",
  worktrees: "Worktrees",
  usage: "Usage",
  settings: "Settings",
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
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  /**
   * `full` overrides the preference: it is what a ⌘/Ctrl-click, a middle click or a
   * ⌘-Enter asks for, and the point of asking is to bypass the drawer.
   */
  const openSession = useCallback(
    (id: string, opts?: { full?: boolean }) => {
      if (opts?.full || settings?.ui.openSessionsIn === "page")
        window.location.hash = `#/session/${encodeURIComponent(id)}`;
      else setOpenId(id);
    },
    [settings?.ui.openSessionsIn],
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

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          {/* Same glyph as the tab icon, badge included, so the window and the
              tab strip read as one thing. The rings are the in-page equivalent
              of the tab badge: they only run while a session is waiting. */}
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
            Claude Sessions
          </button>
          {/* Both kinds, because the header is the one place that should answer "is
              anything running". live.counts.alive is external sessions only — the
              dashboard's own are deliberately excluded from that payload — so on its
              own it read "0 live" with two sessions on screen, one of them thinking. */}
          <small title={`${liveHere} started here · ${liveExternal} external`}>
            {liveHere + liveExternal} live
          </small>
        </div>
        <span className={`conn ${connected ? "" : "off"}`}>
          <i className="dot" />
          {connected ? "streaming" : "reconnecting"}
        </span>
        <span className="spacer" />
        <nav className="tabs">
          {(["live", "history", "worktrees", "usage", "settings"] as Tab[]).map((t) => (
            <button
              key={t}
              aria-selected={tab === t && !pageId}
              onClick={() => {
                setTab(t);
                // Leaving the full-page view is implicit in picking a tab.
                if (pageId) window.location.hash = "";
              }}
            >
              {TAB_LABEL[t]}
              {t === "live" && blocked > 0 && <span className="badge">{blocked}</span>}
            </button>
          ))}
        </nav>
        {/* The icon is the mode you are about to get, which is what the word here used
            to say. Its label carries the same sentence for anything not looking. */}
        <button
          className="icon-btn mode-toggle"
          title={`Switch to ${appearance.theme === "dark" ? "light" : "dark"} mode — full theme and icon options live in Settings → Appearance`}
          aria-label={`Switch to ${appearance.theme === "dark" ? "light" : "dark"} mode`}
          onClick={() => changeAppearance({ theme: appearance.theme === "dark" ? "light" : "dark" })}
        >
          <SunMoonIcon />
        </button>
      </header>

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
          past to reach the thing you came for. */}
      {!pageId && usage && tab !== "worktrees" && tab !== "settings" && (
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
