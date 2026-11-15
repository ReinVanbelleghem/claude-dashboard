import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { agentApi, artifactApi, fmtAgo, type AgentSummary, type Artifact, type Settings } from "../api.ts";
import { ArtifactOverlay } from "./ArtifactsView.tsx";
import {
  ArtifactIcon,
  BellIcon,
  CheckIcon,
  ChevronIcon,
  FullPageIcon,
  MoreVerticalIcon,
  RefreshIcon,
  StopIcon,
  TrashIcon,
} from "./Icons.tsx";
import { GloballyOffNote, MUTE_KINDS, useMute } from "./MuteMenu.tsx";
import { Popover } from "./Popover.tsx";

type Sub = "notify" | "artifacts";

/**
 * Everything a tile or the drawer can do to the session it is showing, behind
 * one ⋮.
 *
 * A tile header is a few hundred pixels wide and was spending most of them on
 * four controls — Open full page, Notify, Restart, Stop — that are each wanted
 * rarely and never together. One button collapses them, and the room that frees
 * is what lets the artifact list live here too rather than only on the full page.
 *
 * The two long lists fly out to the side, as their `›` promises, rather than
 * replacing the menu in place: a tile's menu usually opens hard against the
 * right edge of the window, so the flyout takes whichever side has room.
 */
export function SessionMenu({
  id,
  agent,
  label,
  settings,
  onSettings,
  onEnded,
  fullPage = false,
}: {
  /** The indexed session id — what artifacts are attributed to. */
  id: string;
  agent: AgentSummary | null;
  label: string;
  settings: Settings | null;
  onSettings: (s: Settings) => void;
  /** Ending a session leaves the tile with nothing to show. */
  onEnded: () => void;
  /** On the full page itself, where "Open full page" would go nowhere. */
  fullPage?: boolean;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [sub, setSub] = useState<Sub | null>(null);
  // Hoisted out of the popover on purpose: picking an artifact dismisses the menu,
  // and an overlay rendered inside it would be unmounted by its own click.
  const [preview, setPreview] = useState<{ artifact: Artifact; port: number } | null>(null);
  const muteId = agent?.sessionId ?? agent?.key ?? id;
  const { muted, busy, write, globallyOff } = useMute(muteId, label, settings, onSettings);

  const close = () => {
    setAnchor(null);
    setSub(null);
  };

  const live = !!agent && agent.status !== "ended" && agent.status !== "error";
  const mid = agent?.status === "thinking" || agent?.status === "starting";

  return (
    <>
      <button
        className={`icon-btn square sess-menu-btn ${muted.length > 0 ? "muted" : ""}`}
        title="Session actions"
        aria-label="Session actions"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(e) => (anchor ? close() : setAnchor(e.currentTarget))}
      >
        <MoreVerticalIcon />
      </button>

      {anchor && (
        <Popover anchor={anchor} onClose={close} className="sess-menu">
          <Flyout
            open={sub === "notify"}
            onToggle={() => setSub(sub === "notify" ? null : "notify")}
            icon={<BellIcon muted={muted.length > 0} />}
            label={muted.length === 0 ? "Notifications" : `Notifications — ${muted.length} muted`}
            heading="Silence for this session"
          >
            {MUTE_KINDS.map((k) => {
              const off = muted.includes(k.kind);
              return (
                <button
                  key={k.kind}
                  role="menuitemcheckbox"
                  aria-checked={off}
                  title={`${k.label} — ${k.hint}`}
                  disabled={busy}
                  onClick={() => void write(off ? muted.filter((m) => m !== k.kind) : [...muted, k.kind])}
                >
                  <span className={`sess-menu-tick ${off ? "on" : ""}`}>{off && <CheckIcon />}</span>
                  <span className="sess-menu-label">{k.label}</span>
                </button>
              );
            })}
            {/* Both shortcuts, because the two useful states are opposite ends: a loop
                wants everything off, and undoing a mute set weeks ago wants one click. */}
            <div className="mute-foot">
              <button
                className="icon-btn tiny"
                disabled={busy || muted.length === MUTE_KINDS.length}
                onClick={() => void write(MUTE_KINDS.map((k) => k.kind))}
              >
                Mute all
              </button>
              <button className="icon-btn tiny" disabled={busy || muted.length === 0} onClick={() => void write([])}>
                Unmute
              </button>
            </div>
            <GloballyOffNote labels={globallyOff} />
          </Flyout>

          <Flyout
            open={sub === "artifacts"}
            onToggle={() => setSub(sub === "artifacts" ? null : "artifacts")}
            icon={<ArtifactIcon />}
            label="Artifacts"
            heading="Written by this session"
          >
            <ArtifactList
              sessionId={id}
              onPreview={(artifact, port) => {
                close();
                setPreview({ artifact, port });
              }}
            />
          </Flyout>

          {!fullPage && (
            <a className="sess-menu-link" role="menuitem" href={`#/session/${encodeURIComponent(id)}`} onClick={close}>
              <FullPageIcon />
              <span className="sess-menu-label">Open full page</span>
            </a>
          )}
          {live && agent?.sessionId && (
            <button
              role="menuitem"
              title="Same conversation, fresh process. Picks up an MCP server or setting authorized since it started."
              onClick={() => {
                close();
                agentApi.restart(agent.key).catch(() => {});
              }}
            >
              <RefreshIcon />
              Restart
            </button>
          )}
          {live && agent && (
            <button
              role="menuitem"
              className="danger"
              title={mid ? "Stop the current turn" : "End this session"}
              onClick={() => {
                close();
                if (mid) agentApi.interrupt(agent.key).catch(() => {});
                else agentApi.stop(agent.key).then(onEnded).catch(() => {});
              }}
            >
              {mid ? <StopIcon /> : <TrashIcon />}
              {mid ? "Stop this turn" : "End session"}
            </button>
          )}
        </Popover>
      )}

      {preview && (
        <ArtifactOverlay artifact={preview.artifact} port={preview.port} onClose={() => setPreview(null)} />
      )}
    </>
  );
}

/**
 * A menu row whose panel opens beside it.
 *
 * Rendered inside the parent popover rather than portaled alongside it: that is
 * what keeps a click in the flyout from reading as a click outside the menu,
 * which would dismiss the thing the flyout belongs to. Side and vertical offset
 * are measured once it is on screen — against the viewport, since the parent is
 * fixed-positioned and can sit anywhere.
 */
function Flyout({
  open,
  onToggle,
  icon,
  label,
  heading,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  icon: ReactNode;
  label: string;
  heading: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<"right" | "left">("right");
  const [shift, setShift] = useState(0);

  useLayoutEffect(() => {
    const el = panel.current;
    if (!open || !el) {
      setShift(0);
      return;
    }
    const place = () => {
      // Measured with the shift undone, so a second pass cannot compound it.
      el.style.marginTop = "0px";
      const r = el.getBoundingClientRect();
      const row = (el.parentElement as HTMLElement).getBoundingClientRect();
      const noRoomRight = row.right + r.width + 14 > window.innerWidth;
      setSide(noRoomRight && row.left - r.width - 14 > 0 ? "left" : "right");
      const over = r.bottom - (window.innerHeight - 10);
      setShift(over > 0 ? -Math.min(over, Math.max(0, r.top - 10)) : 0);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  return (
    <div className={`sess-sub-row ${open ? "open" : ""}`}>
      <button role="menuitem" aria-haspopup="menu" aria-expanded={open} onClick={onToggle}>
        {icon}
        <span className="sess-menu-label">{label}</span>
        <span className="sess-menu-more">
          <ChevronIcon />
        </span>
      </button>
      {open && (
        <div ref={panel} className={`svc-menu sess-menu sess-sub ${side}`} role="menu" style={{ marginTop: shift }}>
          <div className="svc-menu-heading">{heading}</div>
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * What this session wrote into the artifact folder, as a list rather than the
 * thumbnail grid the full page uses: a flyout this size can show six names or
 * one and a half pictures.
 */
function ArtifactList({
  sessionId,
  onPreview,
}: {
  sessionId: string;
  onPreview: (artifact: Artifact, port: number) => void;
}) {
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [port, setPort] = useState<number | null>(null);

  useEffect(() => {
    let liveReq = true;
    artifactApi
      .list({ sessionId })
      .then((r) => {
        if (!liveReq) return;
        setArtifacts(r.artifacts);
        setPort(r.port);
      })
      .catch(() => liveReq && setArtifacts([]));
    return () => {
      liveReq = false;
    };
  }, [sessionId]);

  return (
    <>
      {artifacts === null && <p className="sess-menu-note">Loading…</p>}
      {artifacts?.length === 0 && <p className="sess-menu-note">This session has not written one yet.</p>}
      {artifacts?.map((a) => (
        <button
          key={a.slug}
          role="menuitem"
          disabled={a.missing || port === null}
          title={a.missing ? "No longer on disk" : a.title}
          onClick={() => port !== null && onPreview(a, port)}
        >
          <ArtifactIcon />
          <span className="sess-menu-label">{a.title}</span>
          <span className="sess-menu-hint">{a.missing ? "gone" : fmtAgo(a.modifiedTs)}</span>
        </button>
      ))}
    </>
  );
}
