import { useEffect, useState } from "react";
import {
  agentApi,
  dirApi,
  gitApi,
  modelApi,
  shortPath,
  type Favourite,
  type PermissionMode,
  type RepoStatus,
  type Worktree,
} from "../api.ts";
import { MODES, MODE_HELP, MODE_LABEL, STARTER_MODELS } from "./Conversation.tsx";
import { BranchPicker, type BranchChoice } from "./BranchPicker.tsx";
import { FoldersModal } from "./FoldersModal.tsx";
import { FolderIcon, GitIcon, PlusIcon, SearchIcon, WorktreeIcon } from "./Icons.tsx";

/**
 * Start a session the dashboard owns: directory, model, permissions, title.
 * Permissions belong here as well as in the running session because one of the
 * modes — bypassPermissions — can only be chosen at spawn time.
 *
 * Directories come from the saved shortlist rather than a file browser: choosing
 * where to work should be one click, and curating that list is a separate job
 * with its own dialog.
 */
/**
 * Where a new worktree will land, mirrored from the daemon's own rule so the dialog can
 * say it before anything is created. The server decides for real — this only has to
 * agree with it.
 */
function worktreePathFor(mainRoot: string, branch: string): string {
  const slug =
    branch
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 80) || "worktree";
  const parent = mainRoot.split("/").slice(0, -1).join("/");
  const name = mainRoot.split("/").filter(Boolean).pop() ?? "repo";
  return `${parent}/${name}-${slug}`.replace(/^\/Users\/[^/]+/, "~");
}

/**
 * The same spot inside another checkout. Directories are picked at project level —
 * often a package deep inside the repo — so switching checkout has to keep that depth,
 * or a session aimed at one project lands at the repo root of another.
 */
function sameSpotIn(root: string, dir: string, checkout: string): string {
  const rel = dir === root ? "" : dir.startsWith(`${root}/`) ? dir.slice(root.length) : "";
  return `${checkout}${rel}`;
}

export function NewSessionModal({
  projects,
  onClose,
  onStarted,
  /**
   * Directory to start on, when the caller already knows which one. It is shown as a
   * pinned card rather than written into the free-text field: the shortlist stays
   * visible, so a prefill you did not want is one click to leave.
   */
  initialCwd = null,
}: {
  projects: { path: string }[];
  onClose: () => void;
  onStarted: (key: string) => void;
  initialCwd?: string | null;
}) {
  const [favourites, setFavourites] = useState<Favourite[] | null>(null);
  const [cwd, setCwd] = useState(initialCwd ?? "");
  const [model, setModel] = useState("default");
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<PermissionMode>("auto");
  const [custom, setCustom] = useState(false);
  /**
   * Start with no project at all: an empty scratch directory, no CLAUDE.md and no
   * skills. For a general question, the nearest checkout is not context but noise —
   * it gives the model a codebase to answer from that nobody asked about.
   */
  const [research, setResearch] = useState(false);
  /**
   * Which checkout of the chosen repository to run in: "here" for the directory as
   * picked, "new" for a fresh worktree, or the path of one that already exists. A
   * worktree is only worth having if you can come back to it, so an existing one is a
   * first-class choice rather than something you retype as a custom path.
   */
  const [wtSel, setWtSel] = useState<"here" | "new" | (string & {})>("here");
  /** The branch a new worktree would hold: existing or freshly cut. */
  const [wtBranch, setWtBranch] = useState<BranchChoice | null>(null);
  const [repo, setRepo] = useState<RepoStatus | null>(null);
  const [trees, setTrees] = useState<Worktree[]>([]);
  /** A directory change is in flight; the tiles on screen describe the previous one. */
  const [probing, setProbing] = useState(false);
  const [manage, setManage] = useState(false);
  /**
   * Whether the directory and worktree pickers are on screen. Opened from a worktree
   * they are not: that click already answered both questions, and re-asking them is two
   * grids of tiles between you and the only thing left to decide. The answer is shown
   * as one card, with the pickers a click away.
   */
  const [picking, setPicking] = useState(initialCwd === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the shortlist from recent projects the first time, so the dialog is
  // useful before anything has been curated. Dependency directories excluded:
  // a session can land in one by accident, never on purpose.
  const recent = projects.filter((p) => !p.path.includes("/node_modules/")).slice(0, 6);

  // Whatever the CLI actually offers, learned from the last session that ran.
  // STARTER_MODELS is only the fallback for a dashboard that has never run one.
  const [models, setModels] = useState(STARTER_MODELS);
  useEffect(() => {
    modelApi
      .list()
      .then((r) => {
        if (r.models.length > 0) {
          setModels(r.models.map((m) => ({ value: m.value, label: m.displayName })));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    dirApi
      .favourites()
      .then((r) => {
        setFavourites(r.favourites);
        if (!initialCwd) setCwd(r.favourites[0]?.path ?? recent[0]?.path ?? "");
      })
      .catch(() => setFavourites([]));
    // Seeding is intentionally a mount-only concern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !manage && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, manage]);

  /**
   * Everything the worktree picker needs, read as one unit whenever the directory
   * changes: whether git knows the place at all, and which checkouts it has. Resolving
   * them together and swapping in one go is what keeps the tiles from rebuilding twice
   * on every click — the repository answering before its worktrees do would otherwise
   * show a one-tile grid on the way to the real one.
   */
  useEffect(() => {
    const dir = research ? "" : cwd.trim();
    if (!dir) {
      setRepo(null);
      setTrees([]);
      setProbing(false);
      return;
    }
    let alive = true;
    setProbing(true);
    void (async () => {
      let next: RepoStatus | null = null;
      let list: Worktree[] = [];
      try {
        const s = await gitApi.status(dir);
        next = s.isRepo ? s : null;
      } catch {
        next = null;
      }
      if (next?.root) {
        list = await gitApi
          .worktrees(next.root)
          .then((r) => r.worktrees.filter((w) => w.prunable === null && !w.bare))
          .catch(() => []);
      }
      if (!alive) return;
      setRepo(next);
      setTrees(list);
      // An option that no longer applies must not stay silently armed.
      setWtSel("here");
      setWtBranch(null);
      setProbing(false);
    })();
    return () => {
      alive = false;
    };
  }, [cwd, research]);

  const start = async () => {
    if (!research && !cwd.trim()) return;
    setBusy(true);
    setError(null);
    try {
      let dir = cwd.trim();
      if (research) {
        const { key } = await agentApi.start({
          research: true,
          model: model === "default" ? undefined : model,
          permissionMode: mode,
          title: title.trim() || undefined,
        });
        onStarted(key);
        return;
      }
      if (wtSel !== "here" && wtSel !== "new") {
        dir = repo?.root ? sameSpotIn(repo.root, dir, wtSel) : wtSel;
      } else if (wtSel === "new") {
        if (!wtBranch) {
          setError("Pick the branch for the new worktree.");
          setBusy(false);
          return;
        }
        /**
         * The worktree is created before the session, and a refusal stops here: git
         * declining to make the checkout is an answer, not something to work around by
         * starting the session in the original directory instead.
         */
        const r = await gitApi.worktreeAdd(dir, wtBranch.name, { create: wtBranch.create });
        if (!r.ok || !r.path) {
          setError([r.error, r.hint].filter(Boolean).join(" — ") || "could not create the worktree");
          setBusy(false);
          return;
        }
        dir = repo?.root ? sameSpotIn(repo.root, dir, r.path) : r.path;
      }
      const { key } = await agentApi.start({
        cwd: dir,
        model: model === "default" ? undefined : model,
        permissionMode: mode,
        title: title.trim() || undefined,
      });
      onStarted(key);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const shortlist: Favourite[] =
    favourites && favourites.length > 0
      ? favourites
      : recent.map((p) => ({ label: p.path.split("/").filter(Boolean).pop() ?? p.path, path: p.path }));

  /**
   * A prefilled directory is pinned to the front unless the shortlist already has it.
   * Without this a worktree nobody has saved would be selected but invisible, which
   * reads as the dialog having ignored the click.
   */
  const cards: Favourite[] =
    initialCwd && !shortlist.some((f) => f.path === initialCwd)
      ? [
          { label: initialCwd.split("/").filter(Boolean).pop() ?? initialCwd, path: initialCwd },
          ...shortlist,
        ]
      : shortlist;

  /**
   * The checkout you are standing in is the "here" option; every other one is a place
   * you can send this session instead.
   */
  const here = repo?.detached ? `detached at ${repo.head?.slice(0, 8)}` : (repo?.branch ?? "HEAD");
  const others = trees.filter((w) => w.path !== repo?.root);
  const chosen = others.find((w) => w.path === wtSel);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal wide scroll" role="dialog" aria-modal="true" aria-label="New session">
        <div className="modal-head">
          <div>
            <h3>New session</h3>
            <p className="hint">
              {research
                ? "No repository, no files, no shell — nothing on this machine is reachable, so a general question is answered on its own terms. Your MCP connectors and web search still work."
                : "Runs on this machine as a child of the dashboard, with your settings, CLAUDE.md, skills and MCP servers — the same as a terminal session, but you drive it from here."}
            </p>
          </div>
        </div>

        <div className="field">
          <span className="field-head">
            {research ? "No project" : "Working directory"}
            {picking ? (
              <button className="link-btn inline" onClick={() => setManage(true)}>
                Manage folders
              </button>
            ) : (
              <button className="link-btn inline" onClick={() => setPicking(true)}>
                Change
              </button>
            )}
          </span>

          {!picking && research && (
            <div className="folder-card locked">
              <span className="folder-ic">
                <SearchIcon />
              </span>
              <span className="folder-name">Research</span>
              <span className="folder-sub">connectors and web only</span>
            </div>
          )}

          {!picking && !research && (
            <div className="folder-card locked" title={cwd}>
              <span className="folder-ic">
                <FolderIcon open />
              </span>
              <span className="folder-name">
                {cwd.split("/").filter(Boolean).pop() ?? cwd}
                {repo?.branch && <span className="chip muted">{repo.branch}</span>}
              </span>
              <span className="folder-sub">{cwd.replace(/^\/Users\/[^/]+/, "~")}</span>
            </div>
          )}

          {picking && <div className="folder-grid">
            {/* First, and separated from the folders, because it is not one: picking it
                means there is nothing to point at. */}
            <button
              className={`folder-card pick dashed ${research ? "active" : ""}`}
              onClick={() => {
                setResearch(true);
                setCustom(false);
              }}
              title="No file or shell access at all — connectors and web search only"
            >
              <span className="folder-ic">
                <SearchIcon />
              </span>
              <span className="folder-name">Research</span>
              <span className="folder-sub">connectors and web only</span>
            </button>
            {cards.map((f) => (
              <button
                key={f.path}
                className={`folder-card pick ${!research && cwd === f.path ? "active" : ""}`}
                onClick={() => {
                  setCwd(f.path);
                  setCustom(false);
                  setResearch(false);
                }}
                title={f.path}
              >
                <span className="folder-ic">
                  <FolderIcon open={cwd === f.path} />
                </span>
                <span className="folder-name">{f.label}</span>
                <span className="folder-sub">{f.path.replace(/^\/Users\/[^/]+/, "~")}</span>
              </button>
            ))}
            <button
              className={`folder-card pick dashed ${custom ? "active" : ""}`}
              onClick={() => {
                setCustom(true);
                setCwd("");
                setResearch(false);
              }}
            >
              <span className="folder-ic">
                <GitIcon />
              </span>
              <span className="folder-name">Other path…</span>
              <span className="folder-sub">type or paste it</span>
            </button>
          </div>}

          {picking && custom && !research && (
            <input
              className="search"
              autoFocus
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/Users/you/src/project"
              spellCheck={false}
              onKeyDown={(e) => e.key === "Enter" && void start()}
            />
          )}

          {/* Only offered for a real repository with a main working tree to hang a
              sibling off. The box stays put while the next directory is read, showing
              the previous answer greyed out rather than collapsing and springing back;
              it only disappears once git has said "not a repository". */}
          {picking && repo?.mainRoot && !research && (
            <div className={`new-wt ${probing ? "probing" : ""}`} aria-busy={probing}>
              <span className="field-head">
                Worktree to work on
                {probing && <span className="hint">reading worktrees…</span>}
              </span>

              {/* Same tiles as the directory above, because it is the same kind of
                  decision: where this session's files live. */}
              <div className="folder-grid">
                <button
                  className={`folder-card pick ${wtSel === "here" ? "active" : ""}`}
                  onClick={() => setWtSel("here")}
                  title={repo.root ?? undefined}
                >
                  <span className="folder-ic">
                    <FolderIcon open={wtSel === "here"} />
                  </span>
                  <span className="folder-name">{here}</span>
                  <span className="folder-sub">{repo.name} as it is now</span>
                </button>

                {others.map((w) => (
                  <button
                    key={w.path}
                    className={`folder-card pick ${wtSel === w.path ? "active" : ""}`}
                    onClick={() => setWtSel(w.path)}
                    title={w.path}
                  >
                    <span className="folder-ic">
                      <WorktreeIcon />
                    </span>
                    <span className="folder-name">
                      {w.detached ? `detached at ${w.head?.slice(0, 8)}` : (w.branch ?? "—")}
                    </span>
                    <span className="folder-sub">{shortPath(w.path, 2)}</span>
                  </button>
                ))}

                <button
                  className={`folder-card pick dashed ${wtSel === "new" ? "active" : ""}`}
                  onClick={() => setWtSel("new")}
                >
                  <span className="folder-ic">
                    <PlusIcon />
                  </span>
                  <span className="folder-name">New worktree…</span>
                  <span className="folder-sub">on a new branch</span>
                </button>
              </div>

              {wtSel === "new" ? (
                <>
                  <BranchPicker
                    cwd={repo.root ?? cwd.trim()}
                    from={repo.detached ? (repo.head ?? "HEAD") : (repo.branch ?? "HEAD")}
                    value={wtBranch}
                    onChange={setWtBranch}
                    /* A branch already checked out somewhere is not a worktree to create
                       but one to select, so the row lands on that tile. */
                    onOpenWorktree={(path) => {
                      setWtBranch(null);
                      setWtSel(path);
                    }}
                    disabled={busy}
                    autoFocus
                  />
                  {wtBranch && (
                    <p className="hint">
                      {wtBranch.create
                        ? `Creates ${wtBranch.name} off ${wtBranch.from ?? "HEAD"} and checks it out at ${worktreePathFor(repo.mainRoot, wtBranch.name)}.`
                        : `Checks ${wtBranch.name} out at ${worktreePathFor(repo.mainRoot, wtBranch.name)}.`}{" "}
                      Nothing in {repo.name} moves.
                    </p>
                  )}
                </>
              ) : wtSel === "here" ? (
                <p className="hint">
                  {others.length > 0
                    ? `Runs in ${repo.name} itself. The other tiles are worktrees of this repository that already exist, each holding its own branch.`
                    : `Runs in ${repo.name} itself. A new worktree gives this session its own checkout instead, so two sessions can work two branches at once.`}
                </p>
              ) : (
                <p className="hint">
                  Runs in the existing worktree at{" "}
                  {sameSpotIn(repo.root ?? "", cwd.trim(), chosen?.path ?? wtSel).replace(
                    /^\/Users\/[^/]+/,
                    "~",
                  )}
                  . {repo.name} stays on {repo.branch ?? "its current commit"}.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="modal-cols">
          <label className="field">
            <span>Model</span>
            <span className="select-wrap">
              <select
                className="search select"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {models.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </span>
          </label>

          <label className="field">
            <span>Permissions</span>
            <span className="select-wrap">
              <select
                className="search select"
                value={mode}
                onChange={(e) => setMode(e.target.value as PermissionMode)}
              >
                {MODES.map((m) => (
                  <option key={m} value={m} title={MODE_HELP[m]}>
                    {MODE_LABEL[m]}
                  </option>
                ))}
              </select>
            </span>
          </label>
        </div>

        <p className="mode-help">{MODE_HELP[mode]}</p>

        <label className="field">
          <span>Title</span>
          <input
            className="search"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Optional — otherwise generated from your first message"
            onKeyDown={(e) => e.key === "Enter" && void start()}
          />
        </label>

        {error && <div className="chat-error">{error}</div>}

        <div className="modal-actions">
          <button className="icon-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="icon-btn primary"
            disabled={busy || (!research && !cwd.trim())}
            onClick={start}
          >
            {busy ? "Starting…" : "Start session"}
          </button>
        </div>
      </div>

      {manage && (
        <FoldersModal
          stacked
          onClose={() => setManage(false)}
          onChanged={(rows) => {
            setFavourites(rows);
            // A directory that was just removed should not stay selected.
            if (rows.length > 0 && !rows.some((r) => r.path === cwd) && !custom) setCwd(rows[0].path);
          }}
        />
      )}
    </>
  );
}
