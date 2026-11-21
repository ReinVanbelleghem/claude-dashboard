import { stalledReason, type AgentSummary, type LivePayload, type SessionRow } from "../../api.ts";
import { folderName, isChatPath, workspaceSub, workspaceTitle, type Workspace, type WorkspacesPayload } from "../../../shared/workspaces.ts";

/** What a row asks of you, most urgent first. */
export type StatusKind = "needs" | "working" | "failed" | "done" | "idle" | "ended";
export const STATUS_RANK: StatusKind[] = ["needs", "working", "failed", "done", "idle", "ended"];
export const STATUS_LABEL: Record<StatusKind, string> = {
  needs: "Waiting on you",
  working: "Working",
  failed: "Stopped without finishing",
  done: "Finished, not looked at yet",
  idle: "Idle",
  ended: "Ended",
};

export const mostUrgent = (kinds: StatusKind[]): StatusKind =>
  STATUS_RANK.find((k) => kinds.includes(k)) ?? "idle";

/** Every session the sidebar lists, in one shape: the dashboard's own and the terminal's. */
export type SidebarSession = {
  /** Session id once known, else the agent key: what a drawer, tile or page opens. */
  id: string;
  /** Every name it goes by, for the workspace lookup. */
  ids: string[];
  agentKey: string | null;
  title: string;
  cwd: string;
  status: StatusKind;
  /** Second line, only for rows that wait on you or failed. */
  why: string | null;
  pending: number;
  at: number;
  since: number;
  /** Home-folder and research sessions: no project, no workspace. */
  chat: boolean;
  /** "opus-5.5", "haiku": empty when the model is not known yet. */
  model: string;
  /** Started in a terminal: listed here, driven there. */
  external: boolean;
  /** Ended with the daemon that ran it; its conversation can be picked up again. */
  resumable?: boolean;
  /** A shell rather than a Claude session: same row, same ways to open it. */
  terminal?: boolean;
  /** A running service: opens like a terminal, started and stopped from the services lists. */
  service?: boolean;
  /** For a service: whether every pane is alive, some crashed, or all did. */
  health?: "ok" | "partial" | "down";
};

export function modelTag(model: string | null | undefined): string {
  if (!model || model === "default") return "";
  const m = model
    .toLowerCase()
    .replace(/\[.*\]$/, "")
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "");
  const r = /^(opus|sonnet|haiku|fable)(?:-(\d+)(?:[-.](\d+))?)?/.exec(m);
  if (r) return `${r[1]}${r[2] ? `-${r[2]}${r[3] ? `.${r[3]}` : ""}` : ""}`;
  const old = /^(\d+)-(\d+)-(opus|sonnet|haiku)/.exec(m);
  return old ? `${old[3]}-${old[1]}.${old[2]}` : m;
}

export function buildSessions(opts: {
  agents: AgentSummary[];
  live: LivePayload | null;
  titles: Map<string, SessionRow>;
  seen: Record<string, number>;
  /** Sessions on screen right now: never "not looked at yet". */
  visible: Set<string>;
}): SidebarSession[] {
  const { agents, live, titles, seen, visible } = opts;
  const out: SidebarSession[] = [];

  for (const a of agents) {
    const id = a.sessionId ?? a.key;
    const stalled = stalledReason(a);
    const unseen = a.turns > 0 && !visible.has(id) && a.updatedAt > (seen[id] ?? 0);
    const status: StatusKind =
      a.status === "awaiting-permission"
        ? "needs"
        : a.status === "starting" || a.status === "thinking"
          ? "working"
          : a.status === "error"
            ? "failed"
            : a.status === "ended"
              ? "ended"
              : stalled
                ? "failed"
                : unseen
                  ? "done"
                  : "idle";
    out.push({
      id,
      ids: [a.sessionId, a.key].filter((x): x is string => !!x),
      agentKey: a.key,
      title: a.title ?? (a.sessionId ? titles.get(a.sessionId)?.title : null) ?? folderName(a.cwd),
      cwd: a.cwd,
      status,
      why:
        status === "needs"
          ? a.pending > 1
            ? `${a.pending} questions waiting`
            : "Needs your answer"
          : status === "failed"
            ? (stalled ?? a.error ?? a.endedReason)
            : null,
      pending: a.pending,
      at: a.updatedAt,
      since: a.createdAt,
      chat: a.research === true || isChatPath(a.cwd),
      model: modelTag(a.model ?? (a.sessionId ? titles.get(a.sessionId)?.model : null)),
      external: false,
    });
  }

  for (const s of live?.sessions ?? []) {
    if (!s.alive) continue;
    const needs = s.status === "needs_input" || s.status === "waiting" || !!s.waitingFor;
    const working = s.status === "busy" || s.status === "running" || s.status === "thinking";
    out.push({
      id: s.sessionId,
      ids: [s.sessionId],
      agentKey: null,
      title: s.name ?? titles.get(s.sessionId)?.title ?? folderName(s.cwd),
      cwd: s.cwd,
      status: needs ? "needs" : working ? "working" : "idle",
      why: needs ? (s.waitingFor ? `Waiting: ${s.waitingFor}` : "Waiting for your reply in the terminal") : null,
      pending: needs ? 1 : 0,
      at: s.statusUpdatedAt ?? s.updatedAt ?? s.startedAt ?? 0,
      since: s.startedAt ?? 0,
      chat: isChatPath(s.cwd),
      model: modelTag(titles.get(s.sessionId)?.model),
      external: true,
    });
  }
  return out;
}

export type Card = {
  /** `ws:<id>`, `own:<project id>` for sessions in a project's own folder, or `dir:<cwd>` for rows the daemon has not filed yet. */
  key: string;
  ws: Workspace | null;
  title: string;
  sub: string | null;
  rows: SidebarSession[];
  status: StatusKind;
  needs: number;
  /** Nothing to say beyond its project's heading: no goal, and the project's own folder. Drawn without a header. */
  bare: boolean;
  /** One of a project's checkouts, named after its repository and wearing that repository's mark. */
  byRepo: boolean;
};

export type Project = {
  /** `p<id>`, or `dir:<cwd>` for sessions the daemon has not filed yet. */
  key: string;
  /** Null for sessions the daemon has not filed yet. */
  id: number | null;
  name: string;
  /** A repository's standing project, for work in its main checkout that is part of no change. */
  general: boolean;
  /** The project's own folder, once it has one. */
  folder: string | null;
  /** The project's own mark, when it has one. */
  icon: string | null;
  color: string | null;
  /** The repositories its checkouts are of, each once. */
  repos: { key: string; name: string; root: string }[];
  cards: Card[];
  paused: Workspace[];
  archived: Workspace[];
};

export type Tree = { projects: Project[]; chats: SidebarSession[] };

/** How long an archived workspace stays listed under its project, for Reopen. */
export const ARCHIVE_SHOWN_MS = 14 * 86_400_000;

const card = (
  key: string,
  ws: Workspace | null,
  title: string,
  sub: string | null,
  rows: SidebarSession[],
  bare: boolean,
  placed: Record<string, number> = {},
): Card => {
  const place = (s: SidebarSession) => Math.min(Infinity, ...s.ids.flatMap((id) => (id in placed ? [placed[id]!] : [])));
  const sorted = [...rows].sort((a, b) => {
    const pa = place(a);
    const pb = place(b);
    if (pa !== pb) return pa < pb ? -1 : 1;
    return a.since - b.since || a.id.localeCompare(b.id);
  });
  return {
    key,
    ws,
    title,
    sub,
    rows: sorted,
    status: mostUrgent(sorted.map((r) => r.status)),
    needs: sorted.filter((r) => r.status === "needs").length,
    bare,
    byRepo: false,
  };
};

/**
 * Projects in the order you gave them, each with its active workspaces in
 * theirs and the sessions each holds, oldest first: nothing moves when a status
 * changes, and a project stays listed while empty until you delete it. A
 * project's workspaces always show, with or without sessions, until paused or
 * archived. In a repository's standing project, a workspace nobody named only
 * shows while it has sessions.
 */
export function buildTree(
  sessions: SidebarSession[],
  payload: WorkspacesPayload | null,
  now = Date.now(),
  /** Projects to list although nothing runs in them, because they hold something else worth reaching: a drawing. */
  keep: Set<number> = new Set(),
): Tree {
  const byId = new Map((payload?.workspaces ?? []).map((w) => [w.id, w]));
  const held = new Map<number, SidebarSession[]>();
  const own = new Map<number, SidebarSession[]>();
  const shown = new Set((payload?.projects ?? []).filter((p) => !p.archivedAt).map((p) => p.id));
  const loose = new Map<string, SidebarSession[]>();
  const chats: SidebarSession[] = [];

  for (const s of sessions) {
    if (s.chat) {
      chats.push(s);
      continue;
    }
    const wsId = s.ids.map((id) => payload?.sessions[id]).find((x) => x !== undefined);
    const ws = wsId === undefined ? undefined : byId.get(wsId);
    const home = ws ? undefined : s.ids.map((id) => payload?.projectSessions?.[id]).find((x) => x !== undefined && shown.has(x));
    if (ws) held.set(ws.id, [...(held.get(ws.id) ?? []), s]);
    else if (home !== undefined) own.set(home, [...(own.get(home) ?? []), s]);
    else loose.set(s.cwd, [...(loose.get(s.cwd) ?? []), s]);
  }

  const projects = new Map<string, Project>();
  const node = (key: string, id: number | null, name: string, general: boolean) => {
    let p = projects.get(key);
    if (!p) projects.set(key, (p = { key, id, name, general, folder: known.get(id ?? -1)?.folder ?? null, icon: known.get(id ?? -1)?.icon ?? null, color: known.get(id ?? -1)?.color ?? null, repos: [], cards: [], paused: [], archived: [] }));
    return p;
  };
  const known = new Map((payload?.projects ?? []).map((p) => [p.id, p]));
  const put = new Set((payload?.projects ?? []).filter((p) => !!p.archivedAt).map((p) => p.id));
  for (const p of payload?.projects ?? []) if (!put.has(p.id)) node(`p${p.id}`, p.id, p.name, p.generalKey !== null);
  const project = (w: Workspace) => {
    const p = node(`p${w.projectId}`, w.projectId, known.get(w.projectId)?.name ?? w.repoName, known.get(w.projectId)?.generalKey != null);
    if (w.status !== "archived" && !p.repos.some((r) => r.key === w.repoKey)) p.repos.push({ key: w.repoKey, name: w.repoName, root: w.repoRoot });
    return p;
  };
  /** Inside a project a checkout goes by its repository; a goal of its own is kept when it says more than the project's name. */
  const titleIn = (w: Workspace, p: Project) => {
    const goal = w.goal.trim();
    return goal && goal !== p.name ? goal : w.repoName;
  };

  for (const w of [...byId.values()].sort((a, b) => a.order - b.order || a.id - b.id)) {
    const rows = held.get(w.id) ?? [];
    if (put.has(w.projectId)) continue;
    if (w.status === "paused") project(w).paused.push(w);
    else if (w.status === "archived") {
      if (now - (w.archivedAt ?? 0) < ARCHIVE_SHOWN_MS && (w.explicit || w.goal.trim())) project(w).archived.push(w);
    } else if (rows.length > 0 || w.explicit || known.get(w.projectId)?.generalKey == null) {
      const p = project(w);
      const bare = p.general && !w.goal.trim() && !w.explicit && w.folder === w.repoRoot;
      const made = card(`ws:${w.id}`, w, p.general ? workspaceTitle(w) : titleIn(w, p), workspaceSub(w), rows, bare, payload?.sessionOrder);
      p.cards.push({ ...made, byRepo: !p.general && made.title === w.repoName });
    }
  }
  for (const [id, rows] of own) {
    const p = known.get(id)!;
    node(`p${id}`, id, p.name, false).cards.push(card(`own:${id}`, null, p.name, null, rows, true, payload?.sessionOrder));
  }
  for (const [cwd, rows] of loose) {
    node(`dir:${cwd}`, null, folderName(cwd), true).cards.push(card(`dir:${cwd}`, null, folderName(cwd), null, rows, true));
  }

  for (const p of projects.values()) p.cards.sort((a, b) => Number(b.bare) - Number(a.bare));

  const kept = new Set((payload?.projects ?? []).filter((p) => p.explicit).map((p) => `p${p.id}`));
  return {
    projects: [...projects.values()].filter(
      (p) => kept.has(p.key) || (p.id !== null && keep.has(p.id)) || p.cards.length || p.paused.length || p.archived.length,
    ),
    chats: chats.sort((a, b) => a.since - b.since),
  };
}

export function ageShort(at: number, now = Date.now()): string {
  if (!at) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}
