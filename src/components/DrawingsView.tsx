import { parseProjectFileId } from "../../shared/projectFiles.ts";
import { useEffect, useMemo, useState } from "react";
import { drawingApi, type Drawing, type Project } from "../api.ts";
import { drawingKey } from "../../shared/drawings.ts";
import { DRAWINGS_CHANGED } from "./drawingEvents.ts";
import { hasOwnMark, OwnProjectMark, ProjectIcon } from "./ProjectMark.tsx";
import { DrawingIcon, FolderIcon, MoreVerticalIcon, PlusIcon, TrashIcon } from "./Icons.tsx";
import { Popover } from "./Popover.tsx";

type OpenOpts = { full?: boolean; option?: boolean };

const DAY = 86_400_000;
function ago(at: number): string {
  const gone = Date.now() - at;
  if (gone < 60_000) return "just now";
  if (gone < 3_600_000) return `${Math.floor(gone / 60_000)}m ago`;
  if (gone < DAY) return `${Math.floor(gone / 3_600_000)}h ago`;
  return `${Math.floor(gone / DAY)}d ago`;
}

/** The drawings in the folder, re-read whenever the daemon says it changed. */
export function useDrawings(): { drawings: Drawing[]; root: string; loaded: boolean } {
  const [state, setState] = useState<{ drawings: Drawing[]; root: string; loaded: boolean }>({ drawings: [], root: "", loaded: false });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener(DRAWINGS_CHANGED, bump);
    return () => window.removeEventListener(DRAWINGS_CHANGED, bump);
  }, []);
  useEffect(() => {
    let stale = false;
    drawingApi
      .list()
      .then((r) => !stale && setState({ ...r, loaded: true }))
      .catch(() => !stale && setState((s) => ({ ...s, loaded: true })));
    return () => {
      stale = true;
    };
  }, [tick]);
  return state;
}

/** One drawing as a card: its preview, its name and when it last changed. */
export function DrawingCard({
  drawing,
  onOpen,
  onMenu,
}: {
  drawing: Drawing;
  onOpen: (opts: OpenOpts) => void;
  onMenu?: (anchor: HTMLElement) => void;
}) {
  return (
    <div className="drawing-card">
      <button className="drawing-card-open" title={`Open ${drawing.title}`} onClick={(e) => onOpen({ full: e.metaKey || e.ctrlKey, option: e.altKey })}>
        <span className="drawing-thumb">
          {drawing.hasPreview ? <img src={drawingApi.previewUrl(drawing)} alt="" loading="lazy" draggable={false} /> : <DrawingIcon />}
        </span>
        <span className="drawing-card-foot">
          <strong>{drawing.title}</strong>
          <small>{ago(drawing.modifiedAt)}</small>
        </span>
      </button>
      {onMenu && (
        <button className="icon-btn ghost square drawing-card-more" title="Drawing actions" aria-label={`Actions for ${drawing.title}`} onClick={(e) => onMenu(e.currentTarget)}>
          <MoreVerticalIcon />
        </button>
      )}
    </div>
  );
}

/**
 * Every drawing, grouped by the project it belongs to. A drawing made here
 * belongs to none until it is moved into one; one made on a project's or a
 * workspace's page starts there.
 */
export function DrawingsView({
  projects,
  onOpen,
}: {
  projects: Project[];
  onOpen: (key: string, opts?: OpenOpts) => void;
}) {
  const { drawings, root, loaded } = useDrawings();
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ drawing: Drawing; anchor: HTMLElement; moving: boolean; confirming: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = drawings.filter((d) => !d.archived && (!q || d.title.toLowerCase().includes(q) || d.slug.includes(q)));
    const out = new Map<number | null, Drawing[]>();
    for (const d of shown) {
      const home = d.projectId !== null && byId.has(d.projectId) ? d.projectId : null;
      out.set(home, [...(out.get(home) ?? []), d]);
    }
    return [...out.entries()].sort(([a], [b]) => Number(a === null) - Number(b === null));
  }, [drawings, query, byId]);

  const create = () =>
    drawingApi
      .create({})
      .then((r) => onOpen(drawingKey(r.drawing.slug), { full: true }))
      .catch(fail);

  const movable = projects.filter((p) => !p.generalKey?.startsWith("review:"));

  return (
    <div className="drawings">
      <div className="drawings-head">
        <input className="drawings-search" type="search" placeholder="Search drawings" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="drawings-root" title="Drawings that belong to no project are kept here; a project's own are in its folder. Change both under Settings → Folders.">
          {root.replace(/^\/Users\/[^/]+/, "~")} and each project's folder
        </span>
        <button className="icon-btn primary" onClick={() => void create()}>
          <PlusIcon /> New drawing
        </button>
      </div>
      {error && <div className="chat-error">{error}</div>}
      {loaded && drawings.length === 0 && (
        <div className="empty">
          No drawings yet. Start one here, or from a workspace's page to keep it with that work. A session can also write an <code>.excalidraw</code> file
          into {root.replace(/^\/Users\/[^/]+/, "~") || "the drawings folder"}.
        </div>
      )}
      {groups.map(([home, list]) => {
        const project = home === null ? null : byId.get(home)!;
        return (
          <section key={home ?? "none"} className="drawings-group">
            <h2>
              {project ? (
                <a href={`#/project/${project.id}`}>
                  {hasOwnMark(project) ? <OwnProjectMark project={project} /> : <FolderIcon />}
                  {project.name}
                </a>
              ) : (
                "No project"
              )}
              <em>{list.length}</em>
            </h2>
            <div className="drawing-grid">
              {list.map((d) => (
                <DrawingCard
                  key={d.slug}
                  drawing={d}
                  onOpen={(opts) => onOpen(drawingKey(d.slug), opts)}
                  onMenu={(anchor) => setMenu({ drawing: d, anchor, moving: false, confirming: false })}
                />
              ))}
            </div>
          </section>
        );
      })}
      {menu && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)} className="drawing-menu">
          {menu.moving ? (
            <>
              <div className="svc-menu-heading">Move to</div>
              <button
                role="menuitem"
                onClick={() => {
                  void drawingApi.update(menu.drawing.slug, { projectId: null }).catch(fail);
                  setMenu(null);
                }}
              >
                <span className="ws-menu-label">No project</span>
              </button>
              {movable.map((p) => (
                <button
                  key={p.id}
                  role="menuitem"
                  disabled={p.id === menu.drawing.projectId && (!!p.generalKey || parseProjectFileId(menu.drawing.slug).projectId !== null)}
                  onClick={() => {
                    void drawingApi.update(menu.drawing.slug, { projectId: p.id }).catch(fail);
                    setMenu(null);
                  }}
                >
                  <ProjectIcon project={p} size={15} />
                  <span className="ws-menu-label">{p.generalKey ? `${p.name} (general)` : p.name}</span>
                </button>
              ))}
            </>
          ) : (
            <>
              <button role="menuitem" onClick={() => setMenu({ ...menu, moving: true })}>
                <span className="ws-menu-label">Move to a project…</span>
              </button>
              <hr />
              <button
                role="menuitem"
                className="danger"
                onClick={() => {
                  if (!menu.confirming) return setMenu({ ...menu, confirming: true });
                  void drawingApi.remove(menu.drawing.slug).catch(fail);
                  setMenu(null);
                }}
              >
                <TrashIcon />
                <span className="ws-menu-label">{menu.confirming ? "Delete the file for good" : "Delete…"}</span>
              </button>
            </>
          )}
        </Popover>
      )}
    </div>
  );
}
