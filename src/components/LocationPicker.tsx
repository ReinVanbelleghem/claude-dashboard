import { useEffect, useState } from "react";
import { dirApi, gitApi, shortPath, type Favourite, type RepoStatus, type Worktree } from "../api.ts";
import { BranchPicker, type BranchChoice } from "./BranchPicker.tsx";
import { FoldersModal } from "./FoldersModal.tsx";
import { FolderIcon, GitIcon, PlusIcon, SearchIcon, WorktreeIcon } from "./Icons.tsx";

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

/**
 * Which checkout of the chosen repository to use: "here" for the directory as picked,
 * "new" for a fresh worktree, or the path of one that already exists.
 */
export type CheckoutChoice = "here" | "new" | (string & {});

/**
 * The state behind the directory and worktree pickers, shared by every dialog that asks
 * "where": the saved shortlist, the chosen directory, what git says about it, and which
 * checkout of it to use.
 */
export function useLocation(opts: { initialCwd: string | null; initialResearch?: boolean; projects: { path: string }[] }) {
  const { initialCwd, projects } = opts;
  const [favourites, setFavourites] = useState<Favourite[] | null>(null);
  const [cwd, setCwd] = useState(initialCwd ?? "");
  const [custom, setCustom] = useState(false);
  /**
   * Start with no project at all: an empty scratch directory, no CLAUDE.md and no
   * skills. For a general question, the nearest checkout is not context but noise —
   * it gives the model a codebase to answer from that nobody asked about.
   */
  const [research, setResearch] = useState(opts.initialResearch === true);
  const [wtSel, setWtSel] = useState<CheckoutChoice>("here");
  /** The branch a new worktree would hold: existing or freshly cut. */
  const [wtBranch, setWtBranch] = useState<BranchChoice | null>(null);
  const [repo, setRepo] = useState<RepoStatus | null>(null);
  const [trees, setTrees] = useState<Worktree[]>([]);
  /** A directory change is in flight; the tiles on screen describe the previous one. */
  const [probing, setProbing] = useState(false);
  const [manage, setManage] = useState(false);

  // Seed the shortlist from recent projects the first time, so the dialog is
  // useful before anything has been curated. Dependency directories excluded:
  // a session can land in one by accident, never on purpose.
  const recent = projects.filter((p) => !p.path.includes("/node_modules/")).slice(0, 6);

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
      ? [{ label: initialCwd.split("/").filter(Boolean).pop() ?? initialCwd, path: initialCwd }, ...shortlist]
      : shortlist;

  /**
   * The directory the choice comes down to, creating the worktree first when a new one
   * was asked for. A refusal stops here: git declining to make the checkout is an
   * answer, not something to work around by using the original directory instead.
   */
  const resolve = async (): Promise<{ dir: string } | { error: string }> => {
    const dir = cwd.trim();
    if (wtSel === "here") return { dir };
    if (wtSel !== "new") return { dir: repo?.root ? sameSpotIn(repo.root, dir, wtSel) : wtSel };
    if (!wtBranch) return { error: "Pick the branch for the new worktree." };
    const r = await gitApi.worktreeAdd(dir, wtBranch.name, { create: wtBranch.create });
    if (!r.ok || !r.path) {
      return { error: [r.error, r.hint].filter(Boolean).join(" — ") || "could not create the worktree" };
    }
    return { dir: repo?.root ? sameSpotIn(repo.root, dir, r.path) : r.path };
  };

  return {
    cwd,
    setCwd,
    custom,
    setCustom,
    research,
    setResearch,
    wtSel,
    setWtSel,
    wtBranch,
    setWtBranch,
    repo,
    trees,
    probing,
    manage,
    setManage,
    setFavourites,
    cards,
    resolve,
  };
}

export type LocationState = ReturnType<typeof useLocation>;

const NOUN = {
  session: { one: "session", many: "sessions", lives: "Runs" },
  workspace: { one: "workspace", many: "workspaces", lives: "Lives" },
} as const;

/**
 * The directory tiles and, for a repository, the worktree tiles under them. One
 * component because it is one decision — where the files live — whether the thing
 * being placed is a session or a workspace.
 */
export function LocationFields({
  loc,
  noun = "session",
  allowResearch = true,
  busy = false,
  onEnter,
}: {
  loc: LocationState;
  noun?: keyof typeof NOUN;
  /** The "no project" tile: a session can do without a directory, a workspace cannot. */
  allowResearch?: boolean;
  busy?: boolean;
  onEnter?: () => void;
}) {
  const { cwd, custom, research, wtSel, wtBranch, repo, trees, probing } = loc;
  const words = NOUN[noun];

  /**
   * The checkout you are standing in is the "here" option; every other one is a place
   * you can send this session instead.
   */
  const here = repo?.detached ? `detached at ${repo.head?.slice(0, 8)}` : (repo?.branch ?? "HEAD");
  const others = trees.filter((w) => w.path !== repo?.root);
  const chosen = others.find((w) => w.path === wtSel);

  return (
    <>
      <div className="folder-grid">
        {/* First, and separated from the folders, because it is not one: picking it
            means there is nothing to point at. */}
        {allowResearch && (
          <button
            type="button"
            className={`folder-card pick dashed ${research ? "active" : ""}`}
            onClick={() => {
              loc.setResearch(true);
              loc.setCustom(false);
            }}
            title="No file or shell access at all — connectors and web search only"
          >
            <span className="folder-ic">
              <SearchIcon />
            </span>
            <span className="folder-name">Research</span>
            <span className="folder-sub">connectors and web only</span>
          </button>
        )}
        {loc.cards.map((f) => (
          <button
            type="button"
            key={f.path}
            className={`folder-card pick ${!research && cwd === f.path ? "active" : ""}`}
            onClick={() => {
              loc.setCwd(f.path);
              loc.setCustom(false);
              loc.setResearch(false);
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
          type="button"
          className={`folder-card pick dashed ${custom ? "active" : ""}`}
          onClick={() => {
            loc.setCustom(true);
            loc.setCwd("");
            loc.setResearch(false);
          }}
        >
          <span className="folder-ic">
            <GitIcon />
          </span>
          <span className="folder-name">Other path…</span>
          <span className="folder-sub">type or paste it</span>
        </button>
      </div>

      {custom && !research && (
        <input
          className="search"
          autoFocus
          value={cwd}
          onChange={(e) => loc.setCwd(e.target.value)}
          placeholder="/Users/you/src/project"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            onEnter?.();
          }}
        />
      )}

      {/* Only offered for a real repository with a main working tree to hang a
          sibling off. The box stays put while the next directory is read, showing
          the previous answer greyed out rather than collapsing and springing back;
          it only disappears once git has said "not a repository". */}
      {repo?.mainRoot && !research && (
        <div className={`new-wt ${probing ? "probing" : ""}`} aria-busy={probing}>
          <span className="field-head">
            Worktree to work on
            {probing && <span className="hint">reading worktrees…</span>}
          </span>

          {/* Same tiles as the directory above, because it is the same kind of
              decision: where the files live. */}
          <div className="folder-grid">
            <button
              type="button"
              className={`folder-card pick ${wtSel === "here" ? "active" : ""}`}
              onClick={() => loc.setWtSel("here")}
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
                type="button"
                key={w.path}
                className={`folder-card pick ${wtSel === w.path ? "active" : ""}`}
                onClick={() => loc.setWtSel(w.path)}
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
              type="button"
              className={`folder-card pick dashed ${wtSel === "new" ? "active" : ""}`}
              onClick={() => loc.setWtSel("new")}
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
                onChange={loc.setWtBranch}
                /* A branch already checked out somewhere is not a worktree to create
                   but one to select, so the row lands on that tile. */
                onOpenWorktree={(path) => {
                  loc.setWtBranch(null);
                  loc.setWtSel(path);
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
                ? `${words.lives} in ${repo.name} itself. The other tiles are worktrees of this repository that already exist, each holding its own branch.`
                : `${words.lives} in ${repo.name} itself. A new worktree gives this ${words.one} its own checkout instead, so two ${words.many} can work two branches at once.`}
            </p>
          ) : (
            <p className="hint">
              {words.lives} in the existing worktree at{" "}
              {sameSpotIn(repo.root ?? "", cwd.trim(), chosen?.path ?? wtSel).replace(/^\/Users\/[^/]+/, "~")}.{" "}
              {repo.name} stays on {repo.branch ?? "its current commit"}.
            </p>
          )}
        </div>
      )}

      {loc.manage && (
        <FoldersModal
          stacked
          onClose={() => loc.setManage(false)}
          onChanged={(rows) => {
            loc.setFavourites(rows);
            // A directory that was just removed should not stay selected.
            if (rows.length > 0 && !rows.some((r) => r.path === cwd) && !custom) loc.setCwd(rows[0].path);
          }}
        />
      )}
    </>
  );
}
