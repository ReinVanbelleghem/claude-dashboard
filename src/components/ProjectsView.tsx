import { useMemo, useState } from "react";
import { workspaceApi, type Project, type Workspace } from "../api.ts";
import type { Task } from "../../shared/tasks.ts";
import { useDrawings } from "./DrawingsView.tsx";
import { ArchiveIcon, FolderIcon, GitIcon, MoreVerticalIcon, PlayIcon, PlusIcon, TrashIcon } from "./Icons.tsx";
import { useNotes } from "./NotePane.tsx";
import { Popover } from "./Popover.tsx";
import { hasOwnMark, OwnProjectMark, ProjectMark } from "./ProjectMark.tsx";
import { DeleteProjectDialog } from "./sidebar/DeleteWorkspaceDialog.tsx";
import type { SidebarSession } from "./sidebar/sessions.ts";

function ago(at: number): string {
  if (!at) return "never";
  const gone = Date.now() - at;
  if (gone < 3_600_000) return `${Math.max(1, Math.floor(gone / 60_000))}m ago`;
  if (gone < 86_400_000) return `${Math.floor(gone / 3_600_000)}h ago`;
  return `${Math.floor(gone / 86_400_000)}d ago`;
}

type Row = {
  project: Project;
  workspaces: Workspace[];
  running: number;
  waiting: number;
  notes: number;
  drawings: number;
  tasks: number;
  activity: number;
  /** Archived by you, or simply over: made by the daemon for a checkout that has since been archived, with nothing else in it. */
  away: boolean;
};

/**
 * Every project in one place, with what each holds. Archiving puts a project
 * away without losing anything: its checkouts are archived, and its notes,
 * drawings and pages drop out of the lists until it is brought back.
 */
export function ProjectsView({
  projects,
  workspaces,
  sessions,
  sessionHomes,
  tasks,
  onOpen,
}: {
  projects: Project[];
  workspaces: Workspace[];
  sessions: SidebarSession[];
  sessionHomes: Record<string, number>;
  tasks: Task[];
  onOpen: (projectId: number) => void;
}) {
  const [show, setShow] = useState<"current" | "archived">("current");
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ row: Row; anchor: HTMLElement } | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const notes = useNotes().notes;
  const drawings = useDrawings().drawings;

  const rows: Row[] = useMemo(
    () =>
      projects
        .filter((p) => !p.generalKey?.startsWith("review:"))
        .map((project) => {
          const all = workspaces.filter((w) => w.projectId === project.id);
          const mine = project.archivedAt ? all : all.filter((w) => w.status !== "archived");
          const ids = new Set(all.map((w) => w.id));
          const live = sessions.filter((s) => !s.terminal && s.ids.some((id) => ids.has(sessionHomes[id] ?? -1)));
          const noteCount = notes.filter((n) => n.projectId === project.id).length;
          const drawingCount = drawings.filter((d) => d.projectId === project.id).length;
          const over = !project.explicit && !project.generalKey && all.length > 0 && all.every((w) => w.status === "archived") && noteCount + drawingCount === 0;
          return {
            project,
            workspaces: project.archivedAt || over ? all : mine,
            away: !!project.archivedAt || over,
            running: live.length,
            waiting: live.filter((s) => s.status === "needs").length,
            notes: noteCount,
            drawings: drawingCount,
            tasks: tasks.filter((t) => t.completedAt === null && t.workspaceId !== null && ids.has(t.workspaceId)).length,
            activity: Math.max(project.createdAt, ...all.map((w) => w.lastActivityAt)),
          };
        }),
    [projects, workspaces, sessions, sessionHomes, notes, drawings, tasks],
  );
  const archivedCount = rows.filter((r) => r.away).length;
  const q = query.trim().toLowerCase();
  const shown = rows
    .filter((r) => (show === "archived") === r.away)
    .filter((r) => !q || r.project.name.toLowerCase().includes(q) || r.workspaces.some((w) => w.repoName.toLowerCase().includes(q) || (w.branch ?? "").toLowerCase().includes(q)))
    .sort((a, b) => Number(a.project.generalKey !== null) - Number(b.project.generalKey !== null) || b.activity - a.activity);

  const general = shown.filter((r) => r.project.generalKey);
  const cardOf = (row: Row) => {
          const { project: p } = row;
          const repos = [...new Map(row.workspaces.map((w) => [w.repoKey, w])).values()];
          return (
            <article key={p.id} className={`project-card${row.away ? " archived" : ""}`}>
              <a className="project-card-main" href={`#/project/${p.id}`} title="Open this project">
                <span className="project-card-marks">
                  {hasOwnMark(p) ? (
                    <OwnProjectMark project={p} size={30} />
                  ) : repos.length ? (
                    repos.slice(0, 3).map((w) => <ProjectMark key={w.repoKey} projectKey={w.repoKey} name={w.repoName} size={30} />)
                  ) : (
                    <span className="project-card-folder">
                      <FolderIcon />
                    </span>
                  )}
                </span>
                <span className="project-card-text">
                  <strong>{p.name}</strong>
                  <small>
                    {p.generalKey ? "Main checkout" : row.workspaces.length === 0 ? "No checkout" : `${row.workspaces.length} workspace${row.workspaces.length === 1 ? "" : "s"}`}
                    {" · "}
                    {ago(row.activity)}
                  </small>
                </span>
              </a>
              <button className="icon-btn ghost square project-card-more" title="Project actions" aria-label={`Actions for ${p.name}`} onClick={(e) => setMenu({ row, anchor: e.currentTarget })}>
                <MoreVerticalIcon />
              </button>
              {row.workspaces.length > 0 && (
                <ul className="project-card-ws">
                  {row.workspaces.slice(0, 4).map((w) => (
                    <li key={w.id}>
                      <a href={`#/workspace/${w.id}`} title={w.folder}>
                        <ProjectMark projectKey={w.repoKey} name={w.repoName} size={14} />
                        <span>{w.repoName}</span>
                        {w.branch && (
                          <code>
                            <GitIcon />
                            {w.branch}
                          </code>
                        )}
                      </a>
                    </li>
                  ))}
                  {row.workspaces.length > 4 && <li className="more">+{row.workspaces.length - 4} more</li>}
                </ul>
              )}
              <footer className="project-card-facts">
                <span className={row.running ? "" : "none"}>
                  {row.running} session{row.running === 1 ? "" : "s"}
                  {row.waiting > 0 && <em>{row.waiting} waiting</em>}
                </span>
                <span className={row.tasks ? "" : "none"}>{row.tasks} open task{row.tasks === 1 ? "" : "s"}</span>
                <span className={row.notes ? "" : "none"}>{row.notes} note{row.notes === 1 ? "" : "s"}</span>
                <span className={row.drawings ? "" : "none"}>{row.drawings} drawing{row.drawings === 1 ? "" : "s"}</span>
              </footer>
            </article>
          );
  };

  const create = () => {
    const name = window.prompt("Name the project");
    if (!name?.trim()) return;
    void workspaceApi
      .createProject(name.trim())
      .then((r) => onOpen(r.project.id))
      .catch(fail);
  };

  return (
    <div className="projects">
      <div className="projects-head">
        <input type="search" className="drawings-search" placeholder="Search projects, repositories and branches" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="seg" role="tablist" aria-label="Which projects">
          <button role="tab" aria-selected={show === "current"} className={show === "current" ? "active" : ""} onClick={() => setShow("current")}>
            Current <em>{rows.filter((r) => !r.away && !r.project.generalKey).length}</em>
          </button>
          <button role="tab" aria-selected={show === "archived"} className={show === "archived" ? "active" : ""} onClick={() => setShow("archived")}>
            Archived {archivedCount > 0 && <em>{archivedCount}</em>}
          </button>
        </div>
        <span style={{ flex: 1 }} />
        <button className="icon-btn primary" onClick={create}>
          <PlusIcon /> New project
        </button>
      </div>
      {error && <div className="chat-error">{error}</div>}
      {shown.length === 0 && (
        <div className="empty">{show === "archived" ? "Nothing is archived." : q ? "No project matches." : "No projects yet. Start one, or start a session in a repository."}</div>
      )}
      <div className="projects-grid">{shown.filter((r) => !r.project.generalKey).map(cardOf)}</div>
      {general.length > 0 && (
        <>
          <h2 className="projects-sub">
            Main checkouts
            <small>Work in a repository's own folder that is part of no project.</small>
          </h2>
          <div className="projects-grid">{general.map(cardOf)}</div>
        </>
      )}
      {menu && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)}>
          <button
            role="menuitem"
            onClick={() => {
              onOpen(menu.row.project.id);
              setMenu(null);
            }}
          >
            <FolderIcon open />
            <span className="ws-menu-label">Open project</span>
          </button>
          <hr />
          {menu.row.away && !menu.row.project.archivedAt ? null : menu.row.project.archivedAt ? (
            <button
              role="menuitem"
              onClick={() => {
                void workspaceApi.unarchiveProject(menu.row.project.id).catch(fail);
                setMenu(null);
              }}
            >
              <PlayIcon />
              <span className="ws-menu-label">Bring back</span>
            </button>
          ) : (
            <button
              role="menuitem"
              onClick={() => {
                const row = menu.row;
                setMenu(null);
                if (row.running > 0 && !window.confirm(`Archive “${row.project.name}”? Its ${row.running} running session${row.running === 1 ? "" : "s"} will be ended.`)) return;
                void workspaceApi.archiveProject(row.project.id).catch(fail);
              }}
            >
              <ArchiveIcon />
              <span className="ws-menu-label">Archive</span>
            </button>
          )}
          <button
            role="menuitem"
            className="danger"
            onClick={() => {
              setDeleting(menu.row);
              setMenu(null);
            }}
          >
            <TrashIcon />
            <span className="ws-menu-label">Delete…</span>
          </button>
        </Popover>
      )}
      {deleting && (
        <DeleteProjectDialog
          project={{ id: deleting.project.id, name: deleting.project.name }}
          workspaces={deleting.workspaces.length}
          sessions={deleting.running}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
