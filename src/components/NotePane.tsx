import { lazy, Suspense, useEffect, useMemo, useState, type PointerEvent, type ReactNode } from "react";
import { noteApi, type Note, type NoteFolderLink } from "../api.ts";
import { noteFolder, noteKey, noteName, notePathOf, noteRoot, resolveWikilink, wikilinksIn } from "../../shared/notes.ts";
import { useProjectList } from "../projectList.ts";
import { CodeIcon, DocIcon, FolderIcon, PencilIcon } from "./Icons.tsx";
import { ProjectIcon, ProjectMark } from "./ProjectMark.tsx";
import { Select } from "./Select.tsx";
import { NOTES_CHANGED } from "./noteEvents.ts";
import type { NoteState } from "./NoteEditor.tsx";

/** The editor is large, so it is fetched the first time a note is opened and not with the app. */
const NoteEditor = lazy(() => import("./NoteEditor.tsx"));

/** Every note in the folder, re-read whenever the daemon says it changed. */
export function useNotes(): { notes: Note[]; folders: NoteFolderLink[]; dirs: string[]; root: string; loaded: boolean } {
  const [state, setState] = useState<{ notes: Note[]; folders: NoteFolderLink[]; dirs: string[]; root: string; loaded: boolean }>({
    notes: [],
    folders: [],
    dirs: [],
    root: "",
    loaded: false,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener(NOTES_CHANGED, bump);
    return () => window.removeEventListener(NOTES_CHANGED, bump);
  }, []);
  useEffect(() => {
    let stale = false;
    noteApi
      .list()
      .then((r) => !stale && setState({ notes: r.notes ?? [], folders: r.folders ?? [], dirs: r.dirs ?? [], root: r.root ?? "", loaded: true }))
      .catch(() => !stale && setState((s) => ({ ...s, loaded: true })));
    return () => {
      stale = true;
    };
  }, [tick]);
  return state;
}

const STATE_LABEL: Record<NoteState, string> = { saved: "Saved", saving: "Saving…", dirty: "Edited", error: "Not saved" };

/**
 * One note with what goes around it: which project it belongs to, the notes it
 * links to, and the switch between the block editor and the Markdown itself.
 */
export function NoteView({
  path,
  onOpen,
  onRenamed,
  bare = false,
}: {
  path: string;
  /** Open another note, by the key sessions are opened with. */
  onOpen: (key: string, opts?: { full?: boolean }) => void;
  /** The note got another file name, and with it another path. */
  onRenamed?: (path: string) => void;
  /** Without the bar above the text: the host draws its own. */
  bare?: boolean;
}) {
  const { notes } = useNotes();
  const { projects, workspaces } = useProjectList();
  const note = notes.find((n) => n.path === path) ?? null;
  const [state, setState] = useState<NoteState>("saved");
  const [source, setSource] = useState(false);
  const [links, setLinks] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    noteApi
      .read(path)
      .then((r) => !stale && setLinks(wikilinksIn(r.content)))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [path, note?.modifiedAt]);

  const resolved = useMemo(() => links.map((target) => ({ target, path: resolveWikilink(target, notes, path) })), [links, notes, path]);
  const follow = (target: string) => {
    const hit = resolveWikilink(target, notes, path);
    if (hit) onOpen(noteKey(hit));
    else setError(`No note is called “${target}”.`);
  };
  const mine = workspaces.filter((w) => note?.projectId != null && w.projectId === note.projectId && w.status !== "archived");

  return (
    <div className="note-view">
      {!bare && (
        <div className="note-bar">
          <span className="note-path" title={noteRoot(path).rel}>
            {noteFolder(noteRoot(path).rel) ? `${noteFolder(noteRoot(path).rel)}/` : ""}
            <b>{noteName(path)}</b>
          </span>
          <span style={{ flex: 1 }} />
          <Select
            compact
            ariaLabel="Project"
            title="The project this note belongs to"
            searchable={projects.length > 8}
            value={note?.via ? "" : String(note?.projectId ?? "")}
            options={[
              { value: "", label: note?.via ? `From folder ${note.via}` : "No project", icon: <FolderIcon /> },
              ...projects
                .filter((p) => !p.generalKey?.startsWith("review:") && !p.archivedAt)
                .map((p) => ({ value: String(p.id), label: p.name, hint: p.generalKey ? "general" : undefined, icon: <ProjectIcon project={p} /> })),
            ]}
            onChange={(v) =>
              void noteApi
                .update(path, { projectId: v ? Number(v) : null })
                .then((r) => r.note.path !== path && onRenamed?.(r.note.path))
                .catch(() => {})
            }
          />
          {mine.length > 0 && (
            <Select
              compact
              ariaLabel="Workspace"
              title="The checkout in that project this note is about, when it is about one"
              value={String(note?.workspaceId ?? "")}
              options={[
                { value: "", label: "Whole project" },
                ...mine.map((w) => ({ value: String(w.id), label: w.repoName, hint: w.branch ?? undefined, icon: <ProjectMark projectKey={w.repoKey} name={w.repoName} /> })),
              ]}
              onChange={(v) =>
                void noteApi
                  .update(path, v ? { workspaceId: Number(v) } : { projectId: note?.projectId ?? null })
                  .then((r) => r.note.path !== path && onRenamed?.(r.note.path))
                  .catch(() => {})
              }
            />
          )}
          <span className={`drawing-state ${state === "error" ? "error" : state === "saving" ? "saving" : ""}`}>{STATE_LABEL[state]}</span>
          <button
            className={`icon-btn square${source ? " primary" : ""}`}
            aria-pressed={source}
            aria-label="Edit the Markdown itself"
            onClick={() => setSource((v) => !v)}
            title={source ? "Back to the block editor" : "Edit the Markdown itself"}
          >
            <CodeIcon />
          </button>
          {onRenamed && (
            <button
              className="icon-btn square"
              aria-label="Rename the file"
              title="Rename the file, in the folder it is in"
              onClick={() => {
                const next = window.prompt("File name", noteName(path));
                if (!next || next === noteName(path)) return;
                void noteApi
                  .update(path, { rename: next })
                  .then((r) => onRenamed(r.note.path))
                  .catch((e: Error) => setError(e.message));
              }}
            >
              <PencilIcon />
            </button>
          )}
        </div>
      )}
      {error && <div className="chat-error">{error}</div>}
      {resolved.length > 0 && (
        <div className="note-links">
          <span>Links to</span>
          {resolved.map((l) => (
            <button key={l.target} className={`note-link${l.path ? "" : " missing"}`} disabled={!l.path} title={l.path ?? "No note by that name"} onClick={() => follow(l.target)}>
              {l.target.split("/").pop()}
            </button>
          ))}
        </div>
      )}
      <Suspense fallback={<div className="empty">Loading the editor…</div>}>
        <NoteEditor key={path} path={path} source={source} onState={setState} onOpenLink={follow} />
      </Suspense>
    </div>
  );
}

/** A note where a session would be: the header a drawer or tile expects, then the note. */
export function NotePanel({
  id,
  onOpen,
  onHeadPointerDown,
  headStart,
}: {
  id: string;
  onOpen: (key: string, opts?: { full?: boolean }) => void;
  onHeadPointerDown?: (e: PointerEvent) => void;
  headStart?: ReactNode;
}) {
  const path = notePathOf(id);
  const { notes, loaded } = useNotes();
  const note = notes.find((n) => n.path === path);
  return (
    <>
      <div className="drawer-head term-head kind-artifact" onPointerDown={onHeadPointerDown}>
        {headStart}
        <h3>
          <DocIcon /> {note?.title ?? noteName(path)}
        </h3>
      </div>
      {loaded && !note ? <div className="empty">This note is no longer on disk.</div> : <NoteView path={path} onOpen={onOpen} />}
    </>
  );
}

/** A note on a page of its own. */
export function NotePage({ id, onBack, onOpen }: { id: string; onBack: () => void; onOpen: (key: string, opts?: { full?: boolean }) => void }) {
  const path = notePathOf(id);
  const { notes, loaded } = useNotes();
  const note = notes.find((n) => n.path === path);
  return (
    <div className="page session-chat note-page">
      <div className="page-head">
        <button className="icon-btn" onClick={onBack}>
          ← Back
        </button>
        <div>
          <h1>{note?.title ?? noteName(path)}</h1>
          <p className="page-sub">{path}</p>
        </div>
      </div>
      {loaded && !note ? (
        <div className="empty">This note is no longer on disk.</div>
      ) : (
        <div className="panel note-page-panel">
          <NoteView path={path} onOpen={onOpen} onRenamed={(next) => onOpen(noteKey(next), { full: true })} />
        </div>
      )}
    </div>
  );
}
