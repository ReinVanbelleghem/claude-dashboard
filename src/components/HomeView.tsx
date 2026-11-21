import { useEffect, useMemo, useState } from "react";
import {
  agentApi,
  fmtAgo,
  prApi,
  prParam,
  taskApi,
  type Project,
  type TasksPayload,
  type UsagePayload,
  type Workspace,
  type WorkspacesPayload,
} from "../api.ts";
import type { PrSummary, PrWatch } from "../../shared/pr.ts";
import { localDay } from "../../shared/taskDates.ts";
import { CheckIcon, ClaudeMark, FolderIcon, PlayIcon, PlusIcon, PullRequestIcon, ServiceIcon, TerminalIcon, XIcon } from "./Icons.tsx";
import { openable, type OpenOpts } from "./openable.ts";
import { ProjectIcon } from "./ProjectMark.tsx";
import { buildTree, STATUS_LABEL, type SidebarSession } from "./sidebar/sessions.ts";
import { dayLabel, TaskQuickAdd } from "./tasks/TaskQuickAdd.tsx";
import { TodayMeetings } from "./tasks/TasksView.tsx";

const UPCOMING_SHOWN = 8;
const REVIEWS_SHOWN = 4;

type Place = { project: Project | null; projectName: string; workspace: Workspace | null };

/** One session or terminal as a row: what it is, where it runs, and how it is doing. */
function SessionLine({
  s,
  where,
  action,
  onOpen,
}: {
  s: SidebarSession;
  /** Shown after the title when the row is not already under its project. */
  where?: string | null;
  action?: React.ReactNode;
  onOpen: (id: string, opts?: OpenOpts) => void;
}) {
  const state = s.why ?? STATUS_LABEL[s.status];
  return (
    <div className={`home-row home-${s.status}`}>
      <button className="home-row-main" {...openable((opts) => onOpen(s.id, opts))} title={s.cwd}>
        <span className={`ws-mark${s.service ? ` ws-mark-service svc-${s.health ?? "ok"}` : s.terminal ? "" : ` ws-mark-${s.status}`}`}>{s.service ? <ServiceIcon /> : s.terminal ? <TerminalIcon /> : <ClaudeMark />}</span>
        <span className="home-row-text">
          <span className="home-row-title">{s.title}</span>
          <span className="home-row-sub">
            {[where, s.service ? (s.why ?? "Service running") : s.terminal ? "Terminal" : state, s.model || null, s.external && !s.terminal ? "started in a terminal, read-only here" : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        <time>{fmtAgo(s.at)}</time>
      </button>
      {action}
    </div>
  );
}

/**
 * Home: what wants you now, what is running and for which piece of work, what
 * the day holds, and what was left half done. Everything is grouped by project,
 * the way the sidebar is.
 */
export function HomeView({
  sessions,
  payload,
  tasks,
  usage,
  watches,
  calendarHidden,
  onOpen,
  onNew,
  onOpenProject,
  onOpenWorkspace,
  onGo,
}: {
  sessions: SidebarSession[];
  payload: WorkspacesPayload | null;
  tasks: TasksPayload | null;
  usage: UsagePayload | null;
  watches: PrWatch[];
  calendarHidden: string[];
  onOpen: (id: string, opts?: OpenOpts) => void;
  onNew: () => void;
  onOpenProject: (id: number) => void;
  onOpenWorkspace: (w: Workspace) => void;
  onGo: (tab: "tasks" | "calendar" | "reviews" | "usage" | "history") => void;
}) {
  const today = localDay(new Date());
  const tree = useMemo(() => buildTree(sessions, payload), [sessions, payload]);
  const projects = payload?.projects ?? [];

  const placeOf = useMemo(() => {
    const out = new Map<string, Place>();
    for (const p of tree.projects) {
      const project = projects.find((x) => x.id === p.id) ?? null;
      for (const c of p.cards) for (const s of c.rows) out.set(s.id, { project, projectName: p.name, workspace: c.ws });
    }
    return out;
  }, [tree, projects]);
  const whereOf = (s: SidebarSession) => {
    const at = placeOf.get(s.id);
    if (!at) return s.chat ? "Standalone chat" : null;
    return at.workspace && at.workspace.repoName !== at.projectName ? `${at.projectName} › ${at.workspace.repoName}` : at.projectName;
  };

  const waiting = sessions.filter((s) => !s.resumable && (s.status === "needs" || s.status === "failed"));
  const [toReview, setToReview] = useState<PrSummary[]>([]);
  useEffect(() => {
    let alive = true;
    prApi
      .list({ repos: [], reviewRequestedFromMe: true })
      .then((r) => alive && setToReview(r.prs))
      .catch(() => alive && setToReview([]));
    return () => {
      alive = false;
    };
  }, []);
  const updated = watches.filter((w) => w.state === "OPEN" && w.unseen.length > 0 && !toReview.some((p) => prParam(p) === prParam(w)));
  const needs = waiting.length + toReview.length + updated.length;

  const running = (s: SidebarSession) => !s.resumable && s.status !== "ended";
  const live = tree.projects
    .map((p) => ({ p, cards: p.cards.map((c) => ({ c, rows: c.rows.filter(running) })).filter((x) => x.rows.length > 0) }))
    .filter((x) => x.cards.length > 0);
  const liveChats = tree.chats.filter(running);
  const liveCount = live.reduce((n, x) => n + x.cards.reduce((m, c) => m + c.rows.length, 0), 0) + liveChats.length;

  const dated = (tasks?.tasks ?? [])
    .filter((t) => t.completedAt === null && t.dueDate !== null)
    .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!) || (a.dueTime ?? "99").localeCompare(b.dueTime ?? "99") || a.priority - b.priority);
  const due = dated.filter((t) => t.dueDate! <= today);
  const upcoming = dated.slice(0, UPCOMING_SHOWN);

  const left = sessions.filter((s) => s.resumable).sort((a, b) => b.at - a.at);
  const leftName = (s: SidebarSession) => placeOf.get(s.id)?.projectName ?? (s.chat ? "Standalone chats" : "No project");
  const leftBy = [...new Set(left.map(leftName))].map((name) => {
    const rows = left.filter((s) => leftName(s) === name);
    return { name, project: placeOf.get(rows[0]!.id)?.project ?? null, rows };
  });
  const [allLeft, setAllLeft] = useState(false);

  const pct = (n: number) => `${Math.round(n)}%`;
  const session = usage ? (usage.plan?.fiveHour ? usage.plan.fiveHour.pct : usage.remaining.sessionPct) : null;
  const week = usage ? (usage.plan?.sevenDay ? usage.plan.sevenDay.pct : usage.remaining.weeklyPct) : null;

  return (
    <div className="home">
      <header className="home-head">
        <div>
          <h1>{new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</h1>
          <p>
            {needs > 0 ? `${needs} thing${needs === 1 ? "" : "s"} waiting on you` : "Nothing is waiting on you"} · {liveCount} running
            {due.length > 0 ? ` · ${due.length} task${due.length === 1 ? "" : "s"} due` : ""}
          </p>
        </div>
        <span className="home-head-actions">
          <button className="icon-btn primary" onClick={onNew}>
            <PlusIcon /> New session
          </button>
        </span>
      </header>

      {needs > 0 && (
        <section className="panel home-needs">
          <div className="panel-head">
            <h2>
              Needs you <em>{needs}</em>
            </h2>
          </div>
          {waiting.map((s) => (
            <SessionLine key={s.id} s={s} where={whereOf(s)} onOpen={onOpen} />
          ))}
          {toReview.slice(0, REVIEWS_SHOWN).map((pr) => (
            <a key={prParam(pr)} className="home-row home-pr" href={`#/pr/${prParam(pr)}`}>
              <span className="home-row-main">
                <span className="ws-mark">
                  <PullRequestIcon />
                </span>
                <span className="home-row-text">
                  <span className="home-row-title">{pr.title}</span>
                  <span className="home-row-sub">
                    {pr.repo}#{pr.number} · your review is requested{pr.author ? ` by ${pr.author}` : ""}
                  </span>
                </span>
              </span>
            </a>
          ))}
          {toReview.length > REVIEWS_SHOWN && (
            <button className="link-btn inline home-more" onClick={() => onGo("reviews")}>
              {toReview.length - REVIEWS_SHOWN} more waiting on your review
            </button>
          )}
          {updated.map((w) => (
            <a key={prParam(w)} className="home-row home-pr" href={`#/pr/${prParam(w)}`}>
              <span className="home-row-main">
                <span className="ws-mark">
                  <PullRequestIcon />
                </span>
                <span className="home-row-text">
                  <span className="home-row-title">{w.title}</span>
                  <span className="home-row-sub">
                    {w.repo}#{w.number} · {w.unseen.length} update{w.unseen.length === 1 ? "" : "s"} since you looked
                  </span>
                </span>
              </span>
            </a>
          ))}
        </section>
      )}

      <div className="home-cols">
        <div className="home-main">
          <section className="panel home-running">
            <div className="panel-head">
              <h2>
                Running now {liveCount > 0 && <em>{liveCount}</em>}
              </h2>
            </div>
            {liveCount === 0 && (
              <p className="home-none">
                Nothing is running.{" "}
                <button className="link-btn inline" onClick={onNew}>
                  Start a session
                </button>
              </p>
            )}
            {live.map(({ p, cards }) => {
              const project = projects.find((x) => x.id === p.id) ?? null;
              return (
                <div key={p.key} className="home-project">
                  <button className="home-project-head" disabled={p.id === null} onClick={() => p.id !== null && onOpenProject(p.id)} title="Open this project">
                    {project ? <ProjectIcon project={project} size={16} /> : <FolderIcon />}
                    <span>{p.name}</span>
                  </button>
                  {cards.map(({ c, rows }) => (
                    <div key={c.key} className="home-card">
                      {c.ws && !c.bare && (
                        <button className="home-card-head" onClick={() => onOpenWorkspace(c.ws!)} title={`Open this workspace\n${c.ws.folder}`}>
                          {c.title}
                          {c.ws.branch && <small>{c.ws.branch}</small>}
                        </button>
                      )}
                      {rows.map((s) => (
                        <SessionLine key={s.id} s={s} onOpen={onOpen} />
                      ))}
                    </div>
                  ))}
                </div>
              );
            })}
            {liveChats.length > 0 && (
              <div className="home-project">
                <span className="home-project-head">
                  <span>Standalone chats</span>
                </span>
                {liveChats.map((s) => (
                  <SessionLine key={s.id} s={s} onOpen={onOpen} />
                ))}
              </div>
            )}
          </section>
      {left.length > 0 && (
          <section className="panel home-left">
            <div className="panel-head">
              <h2>
                Pick up where you left off <em>{left.length}</em>
              </h2>
              <button className="link-btn inline" onClick={() => onGo("history")}>
                History
              </button>
            </div>
            {leftBy.slice(0, allLeft ? undefined : 3).map((g) => (
              <div key={g.name} className="home-project">
                <button className="home-project-head" disabled={!g.project} onClick={() => g.project && onOpenProject(g.project.id)} title="Open this project">
                  {g.project && <ProjectIcon project={g.project} size={16} />}
                  <span>{g.name}</span>
                </button>
                {g.rows.slice(0, allLeft ? undefined : 4).map((s) => (
                  <SessionLine
                    key={s.id}
                    s={s}
                    where={placeOf.get(s.id)?.workspace?.repoName ?? null}
                    onOpen={onOpen}
                    action={
                      <span className="home-row-actions">
                        <button className="icon-btn tiny" onClick={() => void agentApi.restore(s.id).catch(() => {})} title="Start it again on the same conversation">
                          <PlayIcon /> Resume
                        </button>
                        <button className="icon-btn tiny square" onClick={() => void agentApi.forget(s.id).catch(() => {})} title="Take it off this list. The transcript stays in History." aria-label={`Forget ${s.title}`}>
                          <XIcon />
                        </button>
                      </span>
                    }
                  />
                ))}
              </div>
            ))}
            {!allLeft && (leftBy.length > 3 || leftBy.some((g) => g.rows.length > 4)) && (
              <button className="link-btn inline home-more" onClick={() => setAllLeft(true)}>
                Show all {left.length}
              </button>
            )}
          </section>
        )}
        </div>

        <div className="home-side">
          <section className="panel home-today">
            <div className="panel-head">
              <h2>
                Upcoming {dated.length > 0 && <em>{dated.length}</em>}
              </h2>
              <button className="link-btn inline" onClick={() => onGo("tasks")}>
                All tasks
              </button>
            </div>
            <TaskQuickAdd placeholder="Add a task…  call Amir friday 14:00 p1" onAdd={(text, read) => taskApi.add({ text, ...(read.due ? {} : { due: "today" }) })} />
            {dated.length === 0 && <p className="home-none">Nothing with a date is coming up.</p>}
            {upcoming.map((t) => (
              <div key={t.id} className="task-row wsp-task">
                <button className={`task-check tasks-p${t.priority}`} title="Mark done" aria-label={`Complete ${t.content}`} onClick={() => void taskApi.complete(t.id).catch(() => {})}>
                  <CheckIcon />
                </button>
                <button className="home-task" onClick={() => onGo("tasks")} title="Open in Tasks">
                  <span className="task-content">{t.content}</span>
                  <small className={t.dueDate! < today ? "late" : t.dueDate === today ? "today" : ""}>
                    {dayLabel(t.dueDate!, today)} {t.dueTime ?? ""}
                  </small>
                </button>
              </div>
            ))}
            {dated.length > upcoming.length && (
              <button className="link-btn inline home-more" onClick={() => onGo("tasks")}>
                {dated.length - upcoming.length} more with a date
              </button>
            )}
          </section>
          <TodayMeetings today={today} hidden={calendarHidden} onOpenCalendar={() => onGo("calendar")} />
        </div>
      </div>

      {usage && (
        <button className="home-usage" onClick={() => onGo("usage")} title="Open Usage">
          {session !== null && (
            <span>
              Session <b>{pct(session)}</b>
              <i style={{ "--pct": `${Math.min(100, session)}%` } as React.CSSProperties} />
            </span>
          )}
          {week !== null && (
            <span>
              Week <b>{pct(week)}</b>
              <i style={{ "--pct": `${Math.min(100, week)}%` } as React.CSSProperties} />
            </span>
          )}
          <span>
            Today <b>${usage.day.costUsd.toFixed(usage.day.costUsd >= 100 ? 0 : 2)}</b> <small>at API list prices</small>
          </span>
        </button>
      )}
    </div>
  );
}
