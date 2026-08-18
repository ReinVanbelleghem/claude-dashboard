import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  agentApi,
  agentBus,
  api,
  settingsApi,
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
  DEFAULT_APPEARANCE,
  faviconDataUrl,
  readStored,
  setAttention,
  setBusy,
  type Appearance,
} from "./appearance.ts";
import { useIconPhase } from "./useIconPhase.ts";
import { Tile } from "./components/Charts.tsx";
import { HistoryView } from "./components/HistoryView.tsx";
import { LiveView } from "./components/LiveView.tsx";
import { FoldersModal } from "./components/FoldersModal.tsx";
import { NewSessionModal } from "./components/NewSessionModal.tsx";
import { Palette } from "./components/Palette.tsx";
import { SessionDrawer } from "./components/SessionDrawer.tsx";
import { SessionPage } from "./components/SessionPage.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
import { PageScrollJump } from "./components/scroll.tsx";
import { UsageView } from "./components/UsageView.tsx";

type Tab = "live" | "history" | "usage" | "settings";
const TAB_LABEL: Record<Tab, string> = {
  live: "Live",
  history: "History",
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
  const [showFolders, setShowFolders] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
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
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowPalette((v) => !v);
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
        // Layered over the defaults rather than replacing them: a copy written before
        // a key existed would otherwise arrive as undefined and read as "off".
        if (r.settings.ui.appearance) {
          setAppearance({ ...DEFAULT_APPEARANCE, ...r.settings.ui.appearance });
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
  const awaiting = agents.filter((a) => a.status === "awaiting-permission").length;
  const blocked = needsInput + awaiting;
  // The other half of the pair: blocked is "you are the blocker", thinking is
  // "Claude is". The icon animates for the second and badges for the first, so the
  // two states stay distinguishable at a glance instead of both meaning "activity".
  const thinking = agents.filter((a) => a.status === "thinking").length;

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

  const openSession = useCallback(
    (id: string) => {
      if (settings?.ui.openSessionsIn === "page") window.location.hash = `#/session/${encodeURIComponent(id)}`;
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

  const brandPhase = useIconPhase(thinking > 0 && appearance.motion);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          {/* Same glyph as the tab icon, badge included, so the window and the
              tab strip read as one thing. The rings are the in-page equivalent
              of the tab badge: they only run while a session is waiting. */}
          <span
            className={`brand-mark ${blocked > 0 ? "waiting" : ""}`}
            title={blocked > 0 ? `${blocked} session${blocked > 1 ? "s" : ""} waiting on you` : undefined}
          >
            <img
              className="brand-icon"
              src={faviconDataUrl(
                appearance.favicon,
                appearance.faviconColor,
                appearance.theme,
                blocked > 0,
                brandPhase,
              )}
              alt=""
              width={22}
              height={22}
            />
          </span>
          Claude Sessions
          <small>{live ? `${live.counts.alive} live` : "—"}</small>
        </div>
        <span className={`conn ${connected ? "" : "off"}`}>
          <i className="dot" />
          {connected ? "streaming" : "reconnecting"}
        </span>
        <span className="spacer" />
        <nav className="tabs">
          {(["live", "history", "usage", "settings"] as Tab[]).map((t) => (
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
        <button
          className="icon-btn"
          title="Full theme and icon options live in Settings → Appearance"
          onClick={() => changeAppearance({ theme: appearance.theme === "dark" ? "light" : "dark" })}
        >
          {appearance.theme === "dark" ? "Light" : "Dark"}
        </button>
      </header>

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
        />
      )}

      {!pageId && usage && (
        <div className="kpis">
          {/* Tokens here are fresh tokens: cache reads are excluded and shown
              separately, since they are ~97% of raw volume at a tenth the rate. */}
          <Tile
            label="Last 5 hours"
            value={fmtTokens(usage.fiveHour.fresh)}
            sub={`${fmtUsd(usage.fiveHour.costUsd)} · ${fmtTokens(usage.fiveHour.cacheRead)} cached`}
            pct={usage.remaining.fiveHourPct}
            note={[
              `${Math.round(usage.remaining.fiveHourPct)}% of budget`,
              fmtTokens(usage.budgets.fiveHourTokens),
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
            label="Last 7 days"
            value={fmtTokens(usage.week.fresh)}
            sub={`${fmtUsd(usage.week.costUsd)} · ${fmtTokens(usage.week.cacheRead)} cached`}
            pct={usage.remaining.weeklyPct}
            note={[
              `${Math.round(usage.remaining.weeklyPct)}% of budget`,
              fmtTokens(usage.budgets.weeklyTokens),
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
          onOpenAgent={(a) => openSession(a.sessionId ?? a.key)}
          onNew={() => setShowNew(true)}
          onManageFolders={() => setShowFolders(true)}
        />
      )}
      {!pageId && tab === "history" && <HistoryView onOpen={openSession} />}
      {!pageId && tab === "usage" && <UsageView usage={usage} />}
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
          appearance={appearance}
          onClose={() => setShowPalette(false)}
          onOpenSession={openSession}
          onTab={(t) => {
            setTab(t);
            if (pageId) window.location.hash = "";
          }}
          onNewSession={() => setShowNew(true)}
          onAppearance={changeAppearance}
        />
      )}

      {showFolders && <FoldersModal onClose={() => setShowFolders(false)} />}

      {showNew && (
        <NewSessionModal
          projects={projects}
          onClose={() => setShowNew(false)}
          onStarted={(key) => {
            setShowNew(false);
            setTab("live");
            window.location.hash = "";
            setOpenId(key);
          }}
        />
      )}
    </div>
  );
}
