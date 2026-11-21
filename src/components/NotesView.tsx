import { useEffect, useMemo, useRef, useState } from "react";
import { noteApi, type Note } from "../api.ts";
import { noteRoot, noteFolder, noteKey, noteName } from "../../shared/notes.ts";
import { useProjectList } from "../projectList.ts";
import { ChevronIcon, CollapseAllIcon, DocIcon, ExpandAllIcon, FolderIcon, FolderPlusIcon, FullPageIcon, PencilIcon, PlusIcon, TileWindowIcon, TrashIcon } from "./Icons.tsx";
import { Popover } from "./Popover.tsx";
import { Select } from "./Select.tsx";
import { TitleEditInput } from "./EditableTitle.tsx";
import { ProjectIcon } from "./ProjectMark.tsx";
import { NoteView, useNotes } from "./NotePane.tsx";

const OPEN_KEY = "notes-open";
const FOLDS_KEY = "notes-folds";

type Folder = { name: string; path: string; folders: Folder[]; notes: Note[] };

function treeOf(notes: Note[], dirs: string[]): Folder {
  const root: Folder = { name: "", path: "", folders: [], notes: [] };
  const folder = (path: string) => {
    let at = root;
    for (const part of path.split("/").filter(Boolean)) {
      let next = at.folders.find((f) => f.name === part);
      if (!next) at.folders.push((next = { name: part, path: at.path ? `${at.path}/${part}` : part, folders: [], notes: [] }));
      at = next;
    }
    return at;
  };
  for (const d of [...dirs].sort()) folder(d);
  for (const n of [...notes].sort((a, b) => a.path.localeCompare(b.path))) folder(noteFolder(n.path)).notes.push(n);
  const ofProject = (f: Folder) => Number(noteRoot(f.path).projectId !== null);
  root.folders.sort((a, b) => ofProject(b) - ofProject(a));
  return root;
}

const countIn = (f: Folder): number => f.notes.length + f.folders.reduce((n, x) => n + countIn(x), 0);
const pathsIn = (f: Folder): string[] => f.folders.flatMap((x) => [x.path, ...pathsIn(x)]);

function ago(at: number): string {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 60 / 24)}d`;
}

const RECENT_SHOWN = 12;

/** A name being typed in the tree: a new note or folder in `folder`, or another name for the note at `path`. */
type Draft = { kind: "note" | "folder"; folder: string } | { kind: "rename"; path: string };

const filtering0 = (query: string, project: number | "all" | "none") => query.trim() !== "" || project !== "all";

const read = <T,>(key: string, fallback: T): T => {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "null") as T) ?? fallback;
  } catch {
    return fallback;
  }
};

/**
 * The notes folder as a tree beside the note that is open, the way a notes app
 * lays it out. The same files Obsidian opens: nothing here moves or rewrites a
 * note that was only looked at.
 */
export function NotesView({ onOpen }: { onOpen: (key: string, opts?: { full?: boolean; tile?: boolean }) => void }) {
  const { notes: every, folders, dirs, root, loaded } = useNotes();
  const [draft, setDraft] = useState<Draft | null>(null);
  const { projects, workspaces } = useProjectList();
  const [archived, setArchived] = useState(false);
  const notes = useMemo(() => every.filter((n) => !!n.archived === archived), [every, archived]);
  const hidden = every.length - every.filter((n) => !n.archived).length;
  type Menu = { anchor: HTMLElement; note?: Note; folder?: string; linking?: boolean; blank?: boolean };
  const [menu, setMenu] = useState<Menu | null>(null);
  const linkedFolder = (path: string) => folders.find((f) => f.folder === path) ?? null;
  /** The project a folder is the `notes` folder of, when it is the top of one. */
  const projectFolder = (path: string) => {
    const at = noteRoot(path);
    return at.projectId !== null && !at.rel ? (projects.find((p) => p.id === at.projectId) ?? null) : null;
  };
  const inProjectFolder = (path: string) => noteRoot(path).projectId !== null;
  const projectName = (id: number | null) => projects.find((p) => p.id === id)?.name ?? null;
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const pickable = projects.filter((p) => !p.generalKey?.startsWith("review:") && !p.archivedAt);
  const [open, setOpen] = useState<string | null>(() => read<string | null>(OPEN_KEY, null));
  const [shut, setShut] = useState<string[]>(() => read<string[]>(FOLDS_KEY, []));
  const [query, setQuery] = useState("");
  const [project, setProject] = useState<number | "all" | "none">("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(open));
    } catch {
      return;
    }
  }, [open]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return notes.filter(
      (n) =>
        (project === "all" || (project === "none" ? n.projectId === null : n.projectId === project)) &&
        (!q || n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)),
    );
  }, [notes, query, project]);
  const tree = useMemo(() => treeOf(shown, filtering0(query, project) ? [] : dirs), [shown, dirs, query, project]);
  const current = open && notes.some((n) => n.path === open) ? open : null;
  const filtering = query.trim() !== "" || project !== "all";

  const fold = (next: string[]) => {
    setShut(next);
    try {
      localStorage.setItem(FOLDS_KEY, JSON.stringify(next));
    } catch {
      return;
    }
  };
  const toggle = (path: string) => fold(shut.includes(path) ? shut.filter((p) => p !== path) : [...shut, path]);
  const everyFolder = useMemo(() => pathsIn(tree), [tree]);
  const allShut = everyFolder.length > 0 && everyFolder.every((p) => shut.includes(p));
  const recent = useMemo(() => [...notes].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, RECENT_SHOWN), [notes]);
  /** A folder that holds nothing but one other folder is shown on the same line as it, so a note is not three clicks deep. */
  const chainOf = (f: Folder): Folder[] => {
    const chain = [f];
    for (let at = f; !projectFolder(at.path) && at.notes.length === 0 && at.folders.length === 1 && !(draft && draft.kind !== "rename" && draft.folder === at.path); ) {
      at = at.folders[0]!;
      chain.push(at);
    }
    return chain;
  };

  const pin = useRef<HTMLSpanElement>(null);
  /** A menu opens where the pointer is, not against whatever element happened to be under it. */
  const pinAt = (e: { clientX: number; clientY: number }): HTMLElement => {
    const el = pin.current!;
    el.style.left = `${e.clientX}px`;
    el.style.top = `${e.clientY}px`;
    return el;
  };
  const start = (next: Draft) => {
    if (next.kind !== "rename" && next.folder && shut.includes(next.folder)) toggle(next.folder);
    setDraft(next);
  };
  const commit = (name: string) => {
    const d = draft;
    setDraft(null);
    const text = name.trim();
    if (!d || !text) return;
    if (d.kind === "rename") {
      if (text === noteName(d.path)) return;
      void noteApi
        .update(d.path, { rename: text })
        .then((r) => current === d.path && setOpen(r.note.path))
        .catch(fail);
    } else if (d.kind === "folder") {
      void noteApi.createFolder(d.folder ? `${d.folder}/${text}` : text).catch(fail);
    } else {
      void noteApi
        .create({ title: text, folder: d.folder, projectId: typeof project === "number" ? project : null })
        .then((r) => setOpen(r.note.path))
        .catch(fail);
    }
  };
  const draftRow = (kind: "note" | "folder", depth: number) => (
    <div key={`draft:${kind}`} className="wb-tree-row notes-draft" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="ws-chev none" />
      {kind === "folder" ? <FolderIcon /> : <DocIcon />}
      <TitleEditInput initial="" placeholder={kind === "folder" ? "Folder name" : "Note name"} onCommit={commit} onCancel={() => setDraft(null)} />
    </div>
  );
  const draftsIn = (path: string, depth: number) => (draft && draft.kind !== "rename" && draft.folder === path ? [draftRow(draft.kind, depth)] : []);

  const newItems = (folder: string) => (
    <>
      <button
        role="menuitem"
        onClick={() => {
          setMenu(null);
          start({ kind: "note", folder });
        }}
      >
        <PlusIcon />
        <span className="ws-menu-label">New note</span>
      </button>
      <button
        role="menuitem"
        onClick={() => {
          setMenu(null);
          start({ kind: "folder", folder });
        }}
      >
        <FolderIcon />
        <span className="ws-menu-label">New folder</span>
      </button>
    </>
  );

  const rows = (folder: Folder, depth: number): JSX.Element[] => [
    ...draftsIn(folder.path, depth),
    ...folder.folders.flatMap((top) => {
      const chain = chainOf(top);
      const f = chain[chain.length - 1]!;
      const closed = shut.includes(f.path) && !filtering;
      return [
        <button
          key={`d:${f.path}`}
          className="wb-tree-row dir"
          style={{ paddingLeft: 8 + depth * 14 }}
          aria-expanded={!closed}
          title={
            projectFolder(f.path)
              ? `The notes folder of ${projectFolder(f.path)!.name}${projectFolder(f.path)!.folder ? `\n${projectFolder(f.path)!.folder}/notes` : ""}`
              : linkedFolder(f.path)
                ? `${f.path}\nLinked to ${projectName(linkedFolder(f.path)!.projectId) ?? "a project"}`
                : noteRoot(f.path).rel
          }
          onClick={() => toggle(f.path)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu({ anchor: pinAt(e), folder: f.path });
          }}
        >
          <span className={`ws-chev${closed ? "" : " open"}`}>
            <ChevronIcon />
          </span>
          {projectFolder(f.path) ? <ProjectIcon project={projectFolder(f.path)!} size={15} /> : <FolderIcon open={!closed} />}
          <span className="wb-tree-name">
            {projectFolder(f.path)?.name ??
              chain.map((c, i) => (
                <span key={c.path}>
                  {i > 0 && <i className="notes-chain-sep">/</i>}
                  {projectFolder(c.path)?.name ?? c.name}
                </span>
              ))}
          </span>
          {linkedFolder(f.path) && <i className="notes-linked" />}
          <em className="notes-count">{countIn(f)}</em>
        </button>,
        ...(closed ? [] : rows(f, depth + 1)),
      ];
    }),
    ...folder.notes.map((n) =>
      draft?.kind === "rename" && draft.path === n.path ? (
        <div key={n.path} className="wb-tree-row notes-draft" style={{ paddingLeft: 8 + depth * 14 }}>
          <span className="ws-chev none" />
          <DocIcon />
          <TitleEditInput initial={noteName(n.path)} placeholder="Note name" onCommit={commit} onCancel={() => setDraft(null)} />
        </div>
      ) : (
      <button
        key={n.path}
        className={`wb-tree-row file${current === n.path ? " active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        title={`${n.title}\n${noteRoot(n.path).rel}`}
        onClick={(e) => (e.metaKey || e.ctrlKey ? onOpen(noteKey(n.path), { full: true }) : e.altKey ? onOpen(noteKey(n.path), { tile: true }) : setOpen(n.path))}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ anchor: pinAt(e), note: n });
        }}
      >
        <span className="ws-chev none" />
        <DocIcon />
        <span className="wb-tree-name">{noteName(n.path)}</span>
        {n.projectId !== null && <i className="notes-linked" title={projects.find((p) => p.id === n.projectId)?.name ?? "In a project"} />}
      </button>
      ),
    ),
  ];

  return (
    <div className="notes">
      <aside className="notes-side">
        <span ref={pin} className="notes-pin" aria-hidden="true" />
        <div className="notes-head">
          <strong>Notes</strong>
          <em>{shown.length}</em>
          <span style={{ flex: 1 }} />
          <button className="icon-btn ghost square" title="New note" aria-label="New note" onClick={() => start({ kind: "note", folder: "" })}>
            <PlusIcon />
          </button>
          <button className="icon-btn ghost square" title="New folder" aria-label="New folder" onClick={() => start({ kind: "folder", folder: "" })}>
            <FolderPlusIcon />
          </button>
          <button
            className="icon-btn ghost square"
            disabled={filtering || everyFolder.length === 0}
            title={allShut ? "Expand every folder" : "Collapse every folder"}
            aria-label={allShut ? "Expand every folder" : "Collapse every folder"}
            onClick={() => fold(allShut ? [] : everyFolder)}
          >
            {allShut ? <ExpandAllIcon /> : <CollapseAllIcon />}
          </button>
          {!allShut && shut.length > 0 && (
            <button className="icon-btn ghost square" disabled={filtering} title="Expand every folder" aria-label="Expand every folder" onClick={() => fold([])}>
              <ExpandAllIcon />
            </button>
          )}
        </div>
        <div className="notes-tools">
          <input type="search" placeholder="Search notes" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="notes-filter">
          <Select
            ariaLabel="Show notes of"
            searchable={projects.length > 8}
            value={String(project)}
            options={[
              { value: "all", label: archived ? "Archived notes" : "All notes", hint: String(notes.length) },
              { value: "none", label: "In no project" },
              ...projects
                .filter((p) => notes.some((n) => n.projectId === p.id))
                .map((p) => ({ value: String(p.id), label: p.name, hint: String(notes.filter((n) => n.projectId === p.id).length), icon: <ProjectIcon project={p} /> })),
            ]}
            onChange={(v) => setProject(v === "all" || v === "none" ? v : Number(v))}
          />
        </div>
        <div
          className="notes-tree"
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ anchor: pinAt(e), blank: true });
          }}
        >
          {loaded && shown.length === 0 && <p className="wb-side-note">{notes.length === 0 ? "No notes in this folder yet." : "Nothing matches."}</p>}
          {rows(tree, 0)}
        </div>
        <p className="notes-root" title="Notes that belong to no project are kept here; a project's own are in its folder. Change both under Settings → Folders.">
          {root.replace(/^\/Users\/[^/]+/, "~")} and each project's folder
          {(hidden > 0 || archived) && (
            <button className="link-btn inline notes-archived" onClick={() => setArchived((v) => !v)}>
              {archived ? "Back to current notes" : `${hidden} in archived projects`}
            </button>
          )}
        </p>
        {menu && (
          <Popover anchor={menu.anchor} onClose={() => setMenu(null)} align="start" className="notes-menu">
            {menu.linking ? (
              <>
                <div className="svc-menu-heading">{menu.folder ? `Link ${menu.folder} to` : "Move to"}</div>
                <button
                  role="menuitem"
                  onClick={() => {
                    void (menu.folder ? noteApi.linkFolder(menu.folder, {}) : noteApi.update(menu.note!.path, { projectId: null })).catch(fail);
                    setMenu(null);
                  }}
                >
                  <span className="ws-menu-label">{menu.folder ? "Nothing (unlink the folder)" : "No project"}</span>
                </button>
                {pickable.map((p) => (
                  <div key={p.id}>
                    <button
                      role="menuitem"
                      onClick={() => {
                        void (menu.folder ? noteApi.linkFolder(menu.folder, { projectId: p.id }) : noteApi.update(menu.note!.path, { projectId: p.id })).catch(fail);
                        setMenu(null);
                      }}
                    >
                      <ProjectIcon project={p} size={15} />
                      <span className="ws-menu-label">{p.generalKey ? `${p.name} (general)` : p.name}</span>
                    </button>
                    {workspaces
                      .filter((w) => w.projectId === p.id && w.status !== "archived" && !p.generalKey)
                      .map((w) => (
                        <button
                          key={w.id}
                          role="menuitem"
                          className="notes-menu-sub"
                          onClick={() => {
                            void (menu.folder ? noteApi.linkFolder(menu.folder, { workspaceId: w.id }) : noteApi.update(menu.note!.path, { workspaceId: w.id })).catch(fail);
                            setMenu(null);
                          }}
                        >
                          <span className="ws-menu-label">
                            {w.repoName}
                            {w.branch ? ` · ${w.branch}` : ""}
                          </span>
                        </button>
                      ))}
                  </div>
                ))}
              </>
            ) : menu.blank ? (
              newItems("")
            ) : menu.folder ? (
              <>
                {newItems(menu.folder)}
                {!inProjectFolder(menu.folder) && (
                  <>
                    <hr />
                    <button role="menuitem" onClick={() => setMenu({ ...menu, linking: true })}>
                      <FolderIcon open />
                      <span className="ws-menu-label">
                        {linkedFolder(menu.folder) ? `Linked to ${projectName(linkedFolder(menu.folder)!.projectId) ?? "a project"}. Change…` : "Link folder to a project…"}
                      </span>
                    </button>
                  </>
                )}
              </>
            ) : menu.note ? (
              <>
                <button
                  role="menuitem"
                  onClick={() => {
                    onOpen(noteKey(menu.note!.path), { tile: true });
                    setMenu(null);
                  }}
                >
                  <TileWindowIcon />
                  <span className="ws-menu-label">Open in tile</span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    onOpen(noteKey(menu.note!.path), { full: true });
                    setMenu(null);
                  }}
                >
                  <FullPageIcon />
                  <span className="ws-menu-label">Open full page</span>
                </button>
                <hr />
                <button
                  role="menuitem"
                  onClick={() => {
                    setDraft({ kind: "rename", path: menu.note!.path });
                    setMenu(null);
                  }}
                >
                  <PencilIcon />
                  <span className="ws-menu-label">Rename</span>
                </button>
                {newItems(noteFolder(menu.note.path))}
                <button role="menuitem" onClick={() => setMenu({ ...menu, linking: true })}>
                  <FolderIcon open />
                  <span className="ws-menu-label">
                    {menu.note.projectId !== null ? `In ${projectName(menu.note.projectId) ?? "a project"}${menu.note.via ? " (from its folder)" : ""}. Move…` : "Move to a project…"}
                  </span>
                </button>
                <hr />
                <button
                  role="menuitem"
                  className="danger"
                  onClick={() => {
                    const note = menu.note!;
                    setMenu(null);
                    if (!window.confirm(`Move “${noteName(note.path)}” to the trash?`)) return;
                    void noteApi.remove(note.path).then(() => current === note.path && setOpen(null));
                  }}
                >
                  <TrashIcon />
                  <span className="ws-menu-label">Move to trash</span>
                </button>
              </>
            ) : null}
          </Popover>
        )}
      </aside>
      <section className="notes-main">
        {error && <div className="chat-error">{error}</div>}
        {current ? (
          <>
            <NoteView key={current} path={current} onOpen={(key, opts) => (opts?.full ? onOpen(key, opts) : setOpen(key.slice("note:".length)))} onRenamed={setOpen} />
            <button
              className="icon-btn ghost notes-trash"
              title="Move this note to the folder's .trash, where it can be taken back out"
              onClick={() => {
                if (!window.confirm(`Move “${noteName(current)}” to the trash?`)) return;
                void noteApi.remove(current).then(() => setOpen(null));
              }}
            >
              <TrashIcon /> Move to trash
            </button>
          </>
        ) : (
          <div className="notes-recent">
            {!loaded && <div className="empty">Reading the notes…</div>}
            {loaded && recent.length === 0 && <div className="empty">No notes yet. Start one with the + on the left.</div>}
            {loaded && recent.length > 0 && (
              <>
                <h2>Recently edited</h2>
                {recent.map((n) => (
                  <button
                    key={n.path}
                    className="wsp-session notes-recent-row"
                    title={noteRoot(n.path).rel}
                    onClick={(e) => (e.metaKey || e.ctrlKey ? onOpen(noteKey(n.path), { full: true }) : e.altKey ? onOpen(noteKey(n.path), { tile: true }) : setOpen(n.path))}
                  >
                    <span className="ws-mark">
                      <DocIcon />
                    </span>
                    <span className="wsp-session-text">
                      <span className="wsp-session-title">{n.title}</span>
                      <span className="wsp-session-why">{projectName(n.projectId) ?? noteFolder(noteRoot(n.path).rel) ?? ""}</span>
                    </span>
                    <time>{ago(n.modifiedAt)}</time>
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
