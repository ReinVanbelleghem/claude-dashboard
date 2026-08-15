import { basename, isAbsolute } from "node:path";

/**
 * Git access for the dashboard. Every command goes through run(), which never uses
 * a shell and always passes `--no-optional-locks` so inspecting a repo can't
 * contend with the index lock of a session that is working in it.
 *
 * Reading is unrestricted. Writing is deliberately narrow — only the operations
 * below the "writes" divider mutate a repo, they all take a repo-wide lock, and
 * every ref name they are handed is validated by git itself before it reaches argv.
 */

export type ChangedFile = {
  path: string;
  /** Porcelain code: M, A, D, R, C, ? (untracked) or U (conflict). */
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  /** Old path, for renames. */
  from: string | null;
  insertions: number;
  deletions: number;
};

export type RepoStatus = {
  isRepo: boolean;
  root: string | null;
  /** Display name for the repo — its directory name. */
  name: string | null;
  branch: string | null;
  detached: boolean;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Ref we compare the branch against, e.g. origin/main. Null when undetectable. */
  base: string | null;
  /** True when HEAD *is* the base branch, so "commits on this branch" is empty by definition. */
  onBase: boolean;
  files: ChangedFile[];
  counts: { staged: number; unstaged: number; untracked: number };
  /** Commits on this branch that the base doesn't have. */
  aheadOfBase: number;
  error: string | null;
};

export type Commit = {
  sha: string;
  short: string;
  author: string;
  ts: number;
  subject: string;
  insertions: number;
  deletions: number;
  files: number;
};

const UNIT = "\x1f";
const RECORD = "\x1e";

async function run(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const proc = Bun.spawn(["git", "--no-optional-locks", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      // A pager or a prompt would hang the request forever.
      env: { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    /**
     * Reads are quick and unattended, but a commit runs the repo's hooks and a push
     * talks to a server — either can wedge. Killing the process frees the repo lock
     * this write holds; without it one stuck hook would block every later write.
     */
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, opts.timeoutMs)
      : null;
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (timer) clearTimeout(timer);
    if (timedOut)
      return { ok: false, out, err: `git ${args[0]} timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s` };
    return { ok: code === 0, out, err: err.trim() };
  } catch (e) {
    return { ok: false, out: "", err: e instanceof Error ? e.message : String(e) };
  }
}

async function line(cwd: string, args: string[]): Promise<string | null> {
  const r = await run(cwd, args);
  const v = r.out.trim();
  return r.ok && v ? v : null;
}

/** Reject anything that isn't a plain hex object name before it reaches argv. */
export function isSha(v: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(v);
}

/**
 * A pathspec we were handed by the browser. Absolute paths and anything starting
 * with a dash could escape the repo or be read as a flag; `--` handles the rest.
 */
export function safePath(p: string): boolean {
  return !!p && !p.startsWith("-") && !isAbsolute(p) && !p.split("/").includes("..");
}

// ── base branch detection ─────────────────────────────────────────────────────
/**
 * Repos here use main, master, develop and deployment as trunk depending on their
 * age, so the base cannot be hardcoded. origin/HEAD is authoritative when the
 * remote published it; otherwise fall back to the first candidate that exists.
 */
const BASE_CANDIDATES = ["origin/main", "origin/master", "main", "master", "develop"];

async function detectBase(root: string, branch: string | null): Promise<string | null> {
  const head = await line(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) {
    // Not a useful comparison when you're standing on it.
    if (branch && (head === branch || head === `origin/${branch}`)) return head;
    return head;
  }
  for (const cand of BASE_CANDIDATES) {
    if (await line(root, ["rev-parse", "--verify", "--quiet", cand])) return cand;
  }
  return null;
}

// ── status ────────────────────────────────────────────────────────────────────
const NOT_A_REPO: RepoStatus = {
  isRepo: false,
  root: null,
  name: null,
  branch: null,
  detached: false,
  head: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  base: null,
  onBase: false,
  files: [],
  counts: { staged: 0, unstaged: 0, untracked: 0 },
  aheadOfBase: 0,
  error: null,
};

/**
 * Cached briefly: the live view polls every 3s per session and several sessions
 * often share one repo, so without this a handful of cards would spawn dozens of
 * git processes a minute.
 */
const CACHE_MS = 1_500;
const cache = new Map<string, { at: number; value: Promise<RepoStatus> }>();

/**
 * Drop cached status. Called after anything that writes, so the next read reflects
 * the new state instead of a copy taken up to 1.5s earlier. Every cwd is dropped,
 * not just the one that was written: several sessions can sit in different
 * subdirectories of the same repo and they all just changed branch together.
 */
export function invalidateStatus(): void {
  cache.clear();
}

export function repoStatus(cwd: string, force = false): Promise<RepoStatus> {
  if (!cwd || !isAbsolute(cwd)) return Promise.resolve(NOT_A_REPO);
  const hit = cache.get(cwd);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = computeStatus(cwd).catch((e) => ({
    ...NOT_A_REPO,
    error: e instanceof Error ? e.message : String(e),
  }));
  cache.set(cwd, { at: Date.now(), value });
  return value;
}

async function computeStatus(cwd: string): Promise<RepoStatus> {
  const root = await line(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return NOT_A_REPO;

  const [branchRaw, head, upstream] = await Promise.all([
    line(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    line(root, ["rev-parse", "--short", "HEAD"]),
    line(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
  ]);

  const detached = branchRaw === "HEAD" || branchRaw === null;
  const branch = detached ? null : branchRaw;

  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await line(root, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
    if (counts) {
      const [b, a] = counts.split(/\s+/).map(Number);
      behind = b || 0;
      ahead = a || 0;
    }
  }

  const base = await detectBase(root, branch);
  const onBase = !!base && !!branch && (base === branch || base === `origin/${branch}`);

  let aheadOfBase = 0;
  if (base && !onBase) {
    const n = await line(root, ["rev-list", "--count", `${base}..HEAD`]);
    aheadOfBase = Number(n ?? 0) || 0;
  }

  const files = await workingFiles(root);

  return {
    isRepo: true,
    root,
    name: basename(root),
    branch,
    detached,
    head,
    upstream,
    ahead,
    behind,
    base,
    onBase,
    files,
    counts: {
      staged: files.filter((f) => f.staged).length,
      unstaged: files.filter((f) => f.unstaged).length,
      untracked: files.filter((f) => f.untracked).length,
    },
    aheadOfBase,
    error: null,
  };
}

/**
 * Working-tree changes with line counts. Porcelain v1 with -z is used because it
 * survives paths containing spaces or quotes, which the non-z form escapes into
 * something you have to un-escape by hand.
 */
async function workingFiles(root: string): Promise<ChangedFile[]> {
  const [status, unstagedStat, stagedStat] = await Promise.all([
    run(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    run(root, ["diff", "--numstat", "-z"]),
    run(root, ["diff", "--cached", "--numstat", "-z"]),
  ]);
  if (!status.ok) return [];

  const stats = new Map<string, { insertions: number; deletions: number }>();
  for (const raw of [unstagedStat, stagedStat]) {
    if (!raw.ok) continue;
    for (const [path, ins, del] of parseNumstatZ(raw.out)) {
      const prev = stats.get(path) ?? { insertions: 0, deletions: 0 };
      stats.set(path, { insertions: prev.insertions + ins, deletions: prev.deletions + del });
    }
  }

  const out: ChangedFile[] = [];
  const parts = status.out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const x = entry[0] ?? " ";
    const y = entry[1] ?? " ";
    let path = entry.slice(3);
    let from: string | null = null;
    // A rename or copy is followed by its source path in the next NUL field.
    if (x === "R" || x === "C") {
      from = parts[++i] ?? null;
    }
    const untracked = x === "?" && y === "?";
    const stat = stats.get(path) ?? { insertions: 0, deletions: 0 };
    out.push({
      path,
      status: untracked ? "?" : x !== " " ? x : y,
      staged: !untracked && x !== " " && x !== "?",
      unstaged: !untracked && y !== " ",
      untracked,
      from,
      insertions: stat.insertions,
      deletions: stat.deletions,
    });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** `--numstat -z` emits "ins\tdel\tpath\0", with renames spending two extra fields. */
function parseNumstatZ(raw: string): [string, number, number][] {
  const out: [string, number, number][] = [];
  const fields = raw.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    const m = f.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (!m) continue;
    const ins = m[1] === "-" ? 0 : Number(m[1]);
    const del = m[2] === "-" ? 0 : Number(m[2]);
    let path = m[3];
    // An empty trailing path means the real ones are the next two fields.
    if (path === "") {
      i += 1;
      path = fields[i + 1] ?? "";
      i += 1;
    }
    if (path) out.push([path, ins, del]);
  }
  return out;
}

/**
 * Every file in the repo worth offering to open: tracked, plus untracked ones git
 * would add, minus everything .gitignore excludes. That last part is the point — a
 * plain directory walk of a working repo is mostly node_modules and build output.
 */
export async function listFiles(cwd: string): Promise<string[]> {
  const status = await repoStatus(cwd);
  if (!status.isRepo || !status.root) return [];
  const r = await run(status.root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (!r.ok) return [];
  return r.out.split("\0").filter(Boolean);
}

// ── diffs ─────────────────────────────────────────────────────────────────────
export type DiffScope = "worktree" | "branch";

/**
 * A unified diff, as text, for the whole scope or one file.
 *
 * "worktree" is everything not yet committed, staged or not, against HEAD — the
 * answer to "what is different right now". "branch" is the three-dot diff against
 * the base, i.e. what this branch introduces, ignoring what landed on the base
 * since it was cut.
 */
export async function diff(opts: {
  cwd: string;
  scope: DiffScope;
  path?: string;
  ignoreWhitespace?: boolean;
  context?: number;
}): Promise<{ ok: boolean; patch: string; error: string | null }> {
  const status = await repoStatus(opts.cwd);
  if (!status.isRepo || !status.root) return { ok: false, patch: "", error: "not a git repository" };
  const root = status.root;

  const flags = ["--no-color", `--unified=${clampContext(opts.context)}`];
  if (opts.ignoreWhitespace) flags.push("--ignore-all-space");

  if (opts.path && !safePath(opts.path)) return { ok: false, patch: "", error: "bad path" };

  // An untracked file has no blob to diff against, so compare it to /dev/null.
  if (opts.path && opts.scope === "worktree") {
    const f = status.files.find((x) => x.path === opts.path);
    if (f?.untracked) {
      const r = await run(root, ["diff", ...flags, "--no-index", "--", "/dev/null", opts.path]);
      // --no-index exits 1 whenever the files differ, which is the normal case.
      return { ok: true, patch: r.out, error: null };
    }
  }

  const args =
    opts.scope === "branch"
      ? status.base && !status.onBase
        ? ["diff", ...flags, `${status.base}...HEAD`]
        : null
      : ["diff", ...flags, "HEAD"];

  if (!args) return { ok: true, patch: "", error: null };
  if (opts.path) args.push("--", opts.path);

  const r = await run(root, args);
  if (!r.ok && !r.out) return { ok: false, patch: "", error: r.err || "git diff failed" };
  return { ok: true, patch: r.out, error: null };
}

function clampContext(n: number | undefined): number {
  if (!Number.isFinite(n)) return 3;
  return Math.min(20, Math.max(0, Math.floor(n as number)));
}

/** Files a branch touches relative to its base, with line counts. */
export async function branchFiles(cwd: string): Promise<ChangedFile[]> {
  const status = await repoStatus(cwd);
  if (!status.isRepo || !status.root || !status.base || status.onBase) return [];
  const r = await run(status.root, [
    "diff",
    "--numstat",
    "-z",
    `${status.base}...HEAD`,
  ]);
  if (!r.ok) return [];
  return parseNumstatZ(r.out).map(([path, insertions, deletions]) => ({
    path,
    status: "M",
    staged: false,
    unstaged: false,
    untracked: false,
    from: null,
    insertions,
    deletions,
  }));
}

// ── history ───────────────────────────────────────────────────────────────────
/**
 * Commits on this branch but not on the base. Falls back to the last 30 commits
 * when there is no base to compare against, so a trunk checkout still shows
 * history instead of an empty panel.
 */
export async function log(cwd: string, limit = 50): Promise<{ commits: Commit[]; range: string }> {
  const status = await repoStatus(cwd);
  if (!status.isRepo || !status.root) return { commits: [], range: "" };

  const range = status.base && !status.onBase ? `${status.base}..HEAD` : "HEAD";
  const args = [
    "log",
    `--max-count=${Math.min(200, Math.max(1, limit))}`,
    `--format=${RECORD}%H${UNIT}%h${UNIT}%an${UNIT}%at${UNIT}%s`,
    "--numstat",
    range,
  ];
  const r = await run(status.root, args);
  if (!r.ok) return { commits: [], range };

  const commits: Commit[] = [];
  for (const rec of r.out.split(RECORD)) {
    if (!rec.trim()) continue;
    const nl = rec.indexOf("\n");
    const headerLine = nl === -1 ? rec : rec.slice(0, nl);
    const body = nl === -1 ? "" : rec.slice(nl + 1);
    const [sha, short, author, at, subject] = headerLine.split(UNIT);
    if (!sha) continue;

    let insertions = 0;
    let deletions = 0;
    let files = 0;
    for (const l of body.split("\n")) {
      const m = l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      files++;
      if (m[1] !== "-") insertions += Number(m[1]);
      if (m[2] !== "-") deletions += Number(m[2]);
    }

    commits.push({
      sha,
      short: short ?? sha.slice(0, 7),
      author: author ?? "",
      ts: Number(at ?? 0) * 1000,
      subject: subject ?? "",
      insertions,
      deletions,
      files,
    });
  }
  return { commits, range };
}

// ── branches ──────────────────────────────────────────────────────────────────
export type Branch = {
  /** Short name: "feat/x" for a local branch, "origin/feat/x" for a remote one. */
  name: string;
  /** Remote this ref lives on, or null for a local branch. */
  remote: string | null;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Committer date of the tip, ms. */
  ts: number;
  head: string;
  subject: string;
  /**
   * Remote branches only: a local branch of the same name already exists, so
   * checking this out would just switch to that local branch. The UI hides these.
   */
  hasLocal: boolean;
};

export type BranchList = {
  ok: boolean;
  current: string | null;
  detached: boolean;
  /** The page of branches asked for: locals first, then remotes, recent first. */
  branches: Branch[];
  /** How many exist in the repo, before the query and the limit. */
  total: { local: number; remote: number };
  /** How many the query matched, so the UI can say what it is not showing. */
  matched: number;
  /**
   * The branch whose name is exactly the query, if there is one — reported
   * separately because paging can push it out of `branches`, and "does this name
   * already exist" is the question that decides whether to offer creating it.
   */
  exact: Branch | null;
  error: string | null;
};

const BRANCH_LIMIT_DEFAULT = 60;

/**
 * Local and remote-tracking branches, filtered and paged.
 *
 * The filtering has to happen here rather than in the browser: a long-lived repo
 * accumulates thousands of remote branches — the TMS backend has ~5,800 — and
 * shipping all of them is a megabyte-and-a-half of JSON per popover open, then
 * thousands of DOM nodes nobody scrolls to. So the query goes to the server and
 * comes back as one screenful.
 *
 * for-each-ref is used rather than `branch -vv` because its format is explicit:
 * `branch` output has to be scraped and its columns shift with terminal width and
 * with whether a branch is checked out in another worktree.
 */
export async function branches(
  cwd: string,
  opts: { q?: string; limit?: number } = {},
): Promise<BranchList> {
  const empty = { total: { local: 0, remote: 0 }, matched: 0, exact: null };
  const status = await repoStatus(cwd);
  if (!status.isRepo || !status.root)
    return {
      ok: false,
      current: null,
      detached: false,
      branches: [],
      ...empty,
      error: "not a git repository",
    };

  /**
   * The full refname comes along with the short one so locality is read off
   * `refs/heads/` vs `refs/remotes/` rather than guessed from the short name. It
   * matters: git permits a *local* branch called `origin/foo`, whose short name is
   * indistinguishable from a remote-tracking ref by inspection alone.
   */
  const fmt = [
    "%(refname)",
    "%(refname:short)",
    "%(upstream:short)",
    "%(upstream:track)",
    "%(committerdate:unix)",
    "%(objectname:short)",
    "%(HEAD)",
    "%(contents:subject)",
  ].join(UNIT);

  const r = await run(status.root, [
    "for-each-ref",
    `--format=${fmt}`,
    "--sort=-committerdate",
    "refs/heads",
    "refs/remotes",
  ]);
  if (!r.ok)
    return {
      ok: false,
      current: status.branch,
      detached: status.detached,
      branches: [],
      ...empty,
      error: r.err || "git for-each-ref failed",
    };

  const remoteNames = (await run(status.root, ["remote"])).out.split("\n").map((s) => s.trim()).filter(Boolean);

  const out: Branch[] = [];
  const localNames = new Set<string>();

  for (const l of r.out.split("\n")) {
    if (!l.trim()) continue;
    const [ref, name, upstream, track, at, head, headMark, subject] = l.split(UNIT);
    if (!ref || !name) continue;
    // origin/HEAD is a symbolic alias for the default branch, not a branch of its own.
    if (ref.endsWith("/HEAD")) continue;

    const isRemote = ref.startsWith("refs/remotes/");
    // Which remote, taken from the ref path so a slashed branch name can't confuse it.
    const remote = isRemote
      ? (remoteNames.find((rn) => ref.startsWith(`refs/remotes/${rn}/`)) ?? ref.split("/")[2] ?? null)
      : null;
    if (!isRemote) localNames.add(name);

    const { ahead, behind } = parseTrack(track ?? "");
    out.push({
      name,
      remote,
      current: headMark === "*",
      upstream: upstream || null,
      ahead,
      behind,
      ts: Number(at ?? 0) * 1000,
      head: head ?? "",
      subject: subject ?? "",
      hasLocal: false,
    });
  }

  for (const b of out) {
    if (b.remote) b.hasLocal = localNames.has(b.name.slice(b.remote.length + 1));
  }

  const total = {
    local: out.filter((b) => !b.remote).length,
    remote: out.filter((b) => b.remote).length,
  };

  /**
   * Two refs are dropped here, both because a local branch already answers to the
   * same click: a remote ref whose local branch exists, and — in the pathological
   * case of a local branch literally named `origin/foo` — a remote ref sharing its
   * short name. Leaving the second in would also duplicate a React key.
   */
  const distinct = out.filter((b) => !b.remote || (!b.hasLocal && !localNames.has(b.name)));

  const q = opts.q?.trim().toLowerCase() ?? "";
  const matched = q ? distinct.filter((b) => b.name.toLowerCase().includes(q)) : distinct;

  /**
   * Locals before remotes, current branch first, recent before old. Grouping this
   * way rather than sorting purely by date matters on a repo where every recent
   * commit is on someone else's remote branch: without it the branches you actually
   * work on are pushed off the end of the page.
   */
  const rank = (b: Branch) => (b.current ? 0 : b.remote ? 2 : 1);
  const paged = [...matched]
    .sort((a, b) => rank(a) - rank(b) || b.ts - a.ts)
    .slice(0, Math.min(500, Math.max(1, opts.limit ?? BRANCH_LIMIT_DEFAULT)));

  return {
    ok: true,
    current: status.branch,
    detached: status.detached,
    branches: paged,
    total,
    matched: matched.length,
    exact: q ? (distinct.find((b) => nameMatchesExactly(b, q)) ?? null) : null,
    error: null,
  };
}

/**
 * Whether a typed name *is* this branch. A remote branch matches on its bare name
 * too, because typing "feat/x" when only origin/feat/x exists means that one — the
 * checkout path resolves it the same way.
 */
function nameMatchesExactly(b: Branch, q: string): boolean {
  const name = b.name.toLowerCase();
  return name === q || (!!b.remote && name === `${b.remote.toLowerCase()}/${q}`);
}

/** `%(upstream:track)` renders as "[ahead 2, behind 1]", "[gone]" or empty. */
function parseTrack(track: string): { ahead: number; behind: number } {
  const ahead = track.match(/ahead (\d+)/);
  const behind = track.match(/behind (\d+)/);
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0 };
}

/** One commit: its metadata and its full patch. */
export async function show(
  cwd: string,
  sha: string,
  opts: { ignoreWhitespace?: boolean } = {},
): Promise<{ ok: boolean; commit: Commit | null; patch: string; error: string | null }> {
  if (!isSha(sha)) return { ok: false, commit: null, patch: "", error: "bad revision" };
  const status = await repoStatus(cwd);
  if (!status.isRepo || !status.root)
    return { ok: false, commit: null, patch: "", error: "not a git repository" };

  const flags = ["--no-color"];
  if (opts.ignoreWhitespace) flags.push("--ignore-all-space");

  const [meta, patch] = await Promise.all([
    run(status.root, [
      "show",
      "--no-patch",
      `--format=%H${UNIT}%h${UNIT}%an${UNIT}%at${UNIT}%s`,
      sha,
    ]),
    run(status.root, ["show", ...flags, `--format=`, sha]),
  ]);
  if (!meta.ok) return { ok: false, commit: null, patch: "", error: meta.err || "unknown revision" };

  const [full, short, author, at, subject] = meta.out.trim().split(UNIT);
  return {
    ok: true,
    commit: {
      sha: full ?? sha,
      short: short ?? sha.slice(0, 7),
      author: author ?? "",
      ts: Number(at ?? 0) * 1000,
      subject: subject ?? "",
      insertions: 0,
      deletions: 0,
      files: 0,
    },
    patch: patch.out,
    error: null,
  };
}

// ═══ writes ═══════════════════════════════════════════════════════════════════
/**
 * Everything below mutates a repository. Three rules hold throughout:
 *
 *  1. Ref names are validated by `git check-ref-format` before they reach argv, so
 *     the browser cannot smuggle a flag or a path in as a branch name.
 *  2. One write at a time per repo. Two checkouts racing on the same index leaves a
 *     lock file behind and a confusing half-switched worktree.
 *  3. Cached status is dropped afterwards, and the fresh status is returned, so the
 *     caller never has to guess whether the write landed.
 */

/**
 * Fresh status for a write to validate against.
 *
 * `repoStatus` caches for 1.5s so a wall of polling session cards can't spawn dozens
 * of git processes a minute — correct for reading, wrong for deciding. A cached read
 * here let a pull check "is HEAD detached?" against a copy taken before someone
 * detached it, and answer "already up to date" about a branch it was no longer on.
 * Guards get the real thing.
 */
function freshStatus(cwd: string): Promise<RepoStatus> {
  return repoStatus(cwd, true);
}

/** Serialises writes per repo root. */
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(root) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    root,
    next.catch(() => {}),
  );
  // Don't leak an entry per repo forever once the queue has drained.
  void next.catch(() => {}).finally(() => {
    if (locks.get(root) === next || locks.get(root) === undefined) locks.delete(root);
  });
  return next;
}

export type WriteResult = {
  ok: boolean;
  /** Repo state after the attempt, successful or not. */
  status: RepoStatus | null;
  /** git's own stderr, shown verbatim — it explains refusals better than we could. */
  error: string | null;
  /** Something we can add that git doesn't say, e.g. "commit or stash first". */
  hint: string | null;
  /**
   * What a *successful* write did, when that isn't self-evident. "Already up to
   * date" and "fast-forwarded 3 commits" are the same green tick otherwise.
   */
  note?: string | null;
};

/**
 * Cheap rejection of names that are obviously not refs, before spending a process
 * on check-ref-format. `-` would be read as a flag and `..` as a range.
 */
function plausibleRef(v: string): boolean {
  return (
    !!v &&
    v.length < 255 &&
    !v.startsWith("-") &&
    !v.includes("..") &&
    !/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(v) &&
    !v.startsWith("/") &&
    !v.endsWith("/") &&
    !v.endsWith(".lock")
  );
}

/** git's own opinion on whether a branch name is legal. */
async function validBranchName(root: string, name: string): Promise<boolean> {
  if (!plausibleRef(name)) return false;
  const r = await run(root, ["check-ref-format", "--branch", name]);
  return r.ok;
}

async function refExists(root: string, ref: string): Promise<boolean> {
  return !!(await line(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]));
}

async function localBranchExists(root: string, name: string): Promise<boolean> {
  return !!(await line(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]));
}

/** Remote-tracking refs for a bare branch name, e.g. "feat/x" → ["origin/feat/x"]. */
async function remoteBranchesNamed(root: string, name: string): Promise<string[]> {
  const r = await run(root, ["for-each-ref", "--format=%(refname:short)", `refs/remotes/*/${name}`]);
  if (!r.ok) return [];
  return r.out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.endsWith("/HEAD"));
}

async function finish(
  cwd: string,
  ok: boolean,
  error: string | null,
  hint: string | null,
  note: string | null = null,
): Promise<WriteResult> {
  invalidateStatus();
  return { ok, status: await repoStatus(cwd, true), error, hint, note };
}

/**
 * Switch to an existing branch, or create one.
 *
 * `git switch` is used rather than `checkout` because it only ever changes
 * branches: a typo'd branch name is an error instead of a silent detach onto a
 * commit, or worse, a pathspec checkout that overwrites the file you named.
 *
 * Local changes are carried across when git can do so cleanly and the switch is
 * refused when it can't. That refusal is the useful answer, so it is passed
 * straight through — this never discards work to force a switch through.
 */
export async function checkout(
  cwd: string,
  opts: { branch: string; create?: boolean; from?: string },
): Promise<WriteResult> {
  const status = await freshStatus(cwd);
  if (!status.isRepo || !status.root)
    return { ok: false, status, error: "not a git repository", hint: null };
  const root = status.root;

  const name = opts.branch.trim();
  if (!(await validBranchName(root, name)))
    return { ok: false, status, error: `not a valid branch name: ${name}`, hint: null };

  return withLock(root, async () => {
    if (opts.create) {
      if (await localBranchExists(root, name))
        return finish(cwd, false, `branch already exists: ${name}`, "Switch to it instead of creating it.");

      /**
       * A name that already exists on a remote is refused rather than created. git
       * would happily branch off HEAD instead, leaving a local branch that shares a
       * name with someone else's work but none of its commits, and no tracking to
       * make that visible — a mistake that only shows up at push time.
       */
      const shadowed = await remoteBranchesNamed(root, name);
      if (shadowed.length)
        return finish(
          cwd,
          false,
          `${shadowed.join(", ")} already exists`,
          "Check that out instead — creating a local branch of the same name would not share its commits.",
        );

      const from = opts.from?.trim();
      if (from) {
        if (!plausibleRef(from) || !(await refExists(root, from)))
          return finish(cwd, false, `unknown start point: ${from}`, null);
      }
      const r = await run(root, ["switch", "--create", name, ...(from ? [from] : [])]);
      return finish(cwd, r.ok, r.ok ? null : r.err || "git switch failed", null);
    }

    /**
     * The name may be local ("feat/x") or remote ("origin/feat/x"). A remote one
     * is checked out as a new local tracking branch — except when that local
     * branch already exists, in which case switching to it is what was meant.
     */
    let args: string[];
    if (await localBranchExists(root, name)) {
      args = ["switch", name];
    } else {
      const remotes = (await run(root, ["remote"])).out.split("\n").map((s) => s.trim()).filter(Boolean);
      const remote = remotes.find((rn) => name.startsWith(`${rn}/`));
      if (remote) {
        const local = name.slice(remote.length + 1);
        args = (await localBranchExists(root, local))
          ? ["switch", local]
          : ["switch", "--track", name];
      } else {
        // Not local and not remote-prefixed: let git's DWIM find a unique remote
        // branch by this name, and fail cleanly if there isn't one.
        args = ["switch", name];
      }
    }

    const r = await run(root, args);
    if (r.ok) return finish(cwd, true, null, null);

    return finish(cwd, false, r.err || "git switch failed", switchHint(r.err));
  });
}

/**
 * What to do about a refused switch. git names the files but leaves the remedy
 * implicit, and the remedy differs: tracked changes can be stashed, untracked ones
 * need `-u` or they stay behind and block the switch again.
 */
function switchHint(err: string): string | null {
  if (/untracked working tree files/i.test(err))
    return "Those files aren't tracked, so a plain stash won't move them — use `git stash -u`, or delete them.";
  if (/local changes|would be overwritten|commit your changes or stash/i.test(err))
    return "Commit or stash the files it names, then switch again.";
  return null;
}

/**
 * Bring the upstream's new commits onto this branch, fast-forward only.
 *
 * Deliberately not `git pull`. Two reasons:
 *
 *  - `pull` reads `pull.rebase`, `pull.ff` and `rebase.autoStash` from config, so
 *    the same click would merge for one person, rebase for another, and silently
 *    stash-and-restore for a third. Fetch-then-`merge --ff-only` does one thing.
 *  - Fast-forward only means this can never write a merge commit, never start a
 *    rebase, and never leave a conflicted tree behind. If the histories have
 *    diverged it stops and says so, which is a state the dashboard can explain.
 *    Merging, rebasing and resolving conflicts stay in a terminal.
 *
 * A dirty worktree is not blanket-refused: git already declines a fast-forward that
 * would overwrite a locally modified file, and does it per file, so unrelated edits
 * elsewhere in the repo are no reason to block the whole pull.
 */
export async function pull(cwd: string): Promise<WriteResult> {
  const status = await freshStatus(cwd);
  if (!status.isRepo || !status.root)
    return { ok: false, status, error: "not a git repository", hint: null };
  const root = status.root;

  if (status.detached)
    return {
      ok: false,
      status,
      error: "HEAD is detached",
      hint: "Switch to a branch first — there is nothing for a pull to advance.",
    };
  if (!status.branch)
    return { ok: false, status, error: "no current branch", hint: null };
  if (!status.upstream)
    return {
      ok: false,
      status,
      error: `${status.branch} has no upstream`,
      hint: "Nothing to pull from. Push it with `-u` first to set one.",
    };

  return withLock(root, async () => {
    /**
     * Which remote to contact comes from this branch's own config rather than from
     * splitting the upstream name on a slash — a branch may track a remote whose
     * name contains one, and it may track a differently-named branch there.
     */
    const remote = (await line(root, ["config", "--get", `branch.${status.branch}.remote`])) ?? "origin";
    if (!plausibleRef(remote)) return finish(cwd, false, `unusable remote name: ${remote}`, null);

    const fetched = await run(root, ["fetch", "--quiet", remote]);
    if (!fetched.ok) return finish(cwd, false, fetched.err || "git fetch failed", null);

    // Recounted after fetching: the pre-fetch numbers were about stale refs.
    const counts = await line(root, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
    const [behindRaw, aheadRaw] = (counts ?? "0\t0").split(/\s+/).map(Number);
    const behind = behindRaw || 0;
    const ahead = aheadRaw || 0;

    if (behind === 0)
      return finish(cwd, true, null, null, ahead > 0 ? `Already up to date — ${ahead} to push.` : "Already up to date.");

    /**
     * Checked before attempting rather than left to `merge --ff-only`, because the
     * useful part of the message is the count of local commits in the way, and git's
     * own refusal doesn't include it.
     */
    if (ahead > 0)
      return finish(
        cwd,
        false,
        `${status.branch} and ${status.upstream} have diverged — ${ahead} local commit${ahead === 1 ? "" : "s"} here, ${behind} there`,
        "A fast-forward can't apply. Rebase or merge in a terminal, where conflicts can be resolved.",
      );

    const merged = await run(root, ["merge", "--ff-only", "@{u}"]);
    if (!merged.ok) return finish(cwd, false, merged.err || "git merge --ff-only failed", switchHint(merged.err));

    return finish(cwd, true, null, null, `Fast-forwarded ${behind} commit${behind === 1 ? "" : "s"}.`);
  });
}

/**
 * Update remote refs so the branch list isn't stale. `--prune` drops branches that
 * were deleted on the remote, which is the main reason the list goes wrong. This
 * touches the network, so it is never called implicitly.
 */
export async function fetch(cwd: string): Promise<WriteResult> {
  const status = await freshStatus(cwd);
  if (!status.isRepo || !status.root)
    return { ok: false, status, error: "not a git repository", hint: null };

  return withLock(status.root, async () => {
    const r = await run(status.root!, ["fetch", "--all", "--prune", "--quiet"], { timeoutMs: 120_000 });
    return finish(cwd, r.ok, r.ok ? null : r.err || "git fetch failed", null);
  });
}

// ── staging ───────────────────────────────────────────────────────────────────
/**
 * Pathspecs from the browser, hardened before they reach argv.
 *
 * Two things are being prevented. `safePath` stops a path escaping the repo or
 * being read as a flag. `:(literal)` stops git reading the *contents* of a path as
 * a pattern: a file genuinely called `*.ts` or `foo[1].ts` would otherwise stage a
 * set of files nobody picked. The `--` separator handles the rest.
 */
function pathspecs(paths: string[]): string[] | null {
  const clean = paths.map((p) => p.trim()).filter(Boolean);
  if (!clean.length || clean.some((p) => !safePath(p))) return null;
  return clean.map((p) => `:(literal)${p}`);
}

/** Whether the repo has a commit yet — an empty one has no HEAD to restore from. */
async function hasHead(root: string): Promise<boolean> {
  return !!(await line(root, ["rev-parse", "--verify", "--quiet", "HEAD"]));
}

/**
 * Stage paths, or everything.
 *
 * `git add` is used for both, including for deletions and untracked files — the
 * `-A` semantics of modern git make one command cover every case, so the UI never
 * has to know which kind of change it is looking at.
 */
export async function stage(
  cwd: string,
  opts: { paths?: string[]; all?: boolean },
): Promise<WriteResult> {
  const status = await freshStatus(cwd);
  if (!status.isRepo || !status.root)
    return { ok: false, status, error: "not a git repository", hint: null };
  const root = status.root;

  const specs = opts.all ? [] : pathspecs(opts.paths ?? []);
  if (!specs) return { ok: false, status, error: "bad path", hint: null };

  return withLock(root, async () => {
    const r = await run(root, ["add", "--all", "--", ...specs]);
    if (!r.ok) return finish(cwd, false, r.err || "git add failed", null);
    const n = opts.all ? null : specs.length;
    return finish(cwd, true, null, null, n === null ? "Staged everything." : `Staged ${n} file${n === 1 ? "" : "s"}.`);
  });
}

/**
 * Take paths back out of the index, leaving the working tree alone.
 *
 * `restore --staged` needs a HEAD to restore the index entry from, so a repo with
 * no commits yet uses `rm --cached` instead — there, unstaging means removing the
 * entry outright rather than resetting it to a previous version.
 */
export async function unstage(
  cwd: string,
  opts: { paths?: string[]; all?: boolean },
): Promise<WriteResult> {
  const status = await freshStatus(cwd);
  if (!status.isRepo || !status.root)
    return { ok: false, status, error: "not a git repository", hint: null };
  const root = status.root;

  // `.` from the repo root is the whole tree, and is a literal pathspec already.
  const specs = opts.all ? ["."] : pathspecs(opts.paths ?? []);
  if (!specs) return { ok: false, status, error: "bad path", hint: null };

  return withLock(root, async () => {
    const args = (await hasHead(root))
      ? ["restore", "--staged", "--", ...specs]
      : ["rm", "--cached", "-r", "--quiet", "--", ...specs];
    const r = await run(root, args);
    if (!r.ok) return finish(cwd, false, r.err || "git restore --staged failed", null);
    const n = opts.all ? null : specs.length;
    return finish(
      cwd,
      true,
      null,
      null,
      n === null ? "Unstaged everything." : `Unstaged ${n} file${n === 1 ? "" : "s"}.`,
    );
  });
}

/**
 * Throw away a file's uncommitted changes.
 *
 * The one operation here that destroys work which exists nowhere else — an unstaged
 * edit is not in any git object, so nothing brings it back. Three things keep that
 * honest:
 *
 *  - It only ever takes an explicit list of paths. There is no `all`, so no single
 *    click can empty a working tree.
 *  - A tracked file goes back to HEAD, index and worktree together, which is what
 *    "discard" is asked to mean. An untracked file is deleted, and that is said in
 *    the result rather than left to be discovered.
 *  - Directories are refused. `git clean` on one would take everything beneath it,
 *    including files the caller never saw in the list it was choosing from.
 */
export async function discard(cwd: string, paths: string[]): Promise<WriteResult> {
  const status = await freshStatus(cwd);
  if (!status.isRepo || !status.root)
    return { ok: false, status, error: "not a git repository", hint: null };
  const root = status.root;

  const wanted = paths.map((p) => p.trim()).filter(Boolean);
  if (!wanted.length) return { ok: false, status, error: "no paths to discard", hint: null };
  if (wanted.some((p) => !safePath(p))) return { ok: false, status, error: "bad path", hint: null };

  /**
   * Every path has to be one the status listed. That is what rules out a directory,
   * a path outside the change set, and a stale name from a page that has been open
   * since before the last commit.
   */
  const known = new Map(status.files.map((f) => [f.path, f]));
  const unknown = wanted.filter((p) => !known.has(p));
  if (unknown.length)
    return {
      ok: false,
      status,
      error: `not an uncommitted change: ${unknown.join(", ")}`,
      hint: "Refresh — the file list is older than the repository.",
    };

  const untracked = wanted.filter((p) => known.get(p)!.untracked);
  const tracked = wanted.filter((p) => !known.get(p)!.untracked);

  return withLock(root, async () => {
    if (tracked.length) {
      if (!(await hasHead(root)))
        return finish(
          cwd,
          false,
          "this repository has no commits yet",
          "There is no committed version to restore these files to.",
        );
      // Index and worktree together: a half-discarded file is nobody's intent.
      const r = await run(root, [
        "restore",
        "--source=HEAD",
        "--staged",
        "--worktree",
        "--",
        ...tracked.map((p) => `:(literal)${p}`),
      ]);
      if (!r.ok) return finish(cwd, false, r.err || "git restore failed", null);
    }

    if (untracked.length) {
      // No -d: these are files the status listed individually, and -d would let a
      // directory take its contents with it.
      const r = await run(root, ["clean", "-f", "--", ...untracked.map((p) => `:(literal)${p}`)]);
      if (!r.ok) return finish(cwd, false, r.err || "git clean failed", null);
    }

    const n = wanted.length;
    const deleted = untracked.length ? `, ${untracked.length} deleted from disk` : "";
    return finish(cwd, true, null, null, `Discarded ${n} file${n === 1 ? "" : "s"}${deleted}.`);
  });
}

// ── commit ────────────────────────────────────────────────────────────────────
const MESSAGE_MAX = 20_000;

/**
 * Commit what is staged, and only what is staged.
 *
 * Deliberately never `-a`: the staging area is the review step, and a button that
 * quietly swept in every other edit in the tree would make it meaningless. The
 * message reaches git as one argv value, so no part of it can be read as a flag.
 *
 * Hooks run, because a repo that has them expects them to — but under a timeout,
 * since a hook that waits for input would otherwise hold this repo's write lock
 * forever with nothing on the far end to answer it.
 */
export async function commit(
  cwd: string,
  message: string,
  opts: { noVerify?: boolean } = {},
): Promise<WriteResult> {
  const status = await freshStatus(cwd);
  if (!status.isRepo || !status.root)
    return { ok: false, status, error: "not a git repository", hint: null };
  const root = status.root;

  const msg = message.replace(/\r\n/g, "\n").trim();
  if (!msg) return { ok: false, status, error: "a commit message is required", hint: null };
  if (msg.length > MESSAGE_MAX)
    return { ok: false, status, error: `message is too long (${msg.length} characters)`, hint: null };

  if (status.counts.staged === 0)
    return {
      ok: false,
      status,
      error: "nothing staged",
      hint: "Stage the files you want in this commit first — a commit only ever takes what is staged.",
    };

  return withLock(root, async () => {
    /**
     * Conflicted files are staged as far as porcelain is concerned, but committing
     * one writes the conflict markers into history. git's own refusal only covers
     * unmerged entries it still tracks as such, so this is checked up front.
     */
    const unmerged = await run(root, ["diff", "--name-only", "--diff-filter=U", "-z"]);
    const conflicted = unmerged.out.split("\0").filter(Boolean);
    if (conflicted.length)
      return finish(
        cwd,
        false,
        `unresolved conflicts in ${conflicted.slice(0, 5).join(", ")}${conflicted.length > 5 ? ` and ${conflicted.length - 5} more` : ""}`,
        "Resolve them in a terminal, then stage the results.",
      );

    const args = ["commit", "-m", msg];
    if (opts.noVerify) args.push("--no-verify");
    const r = await run(root, args, { timeoutMs: 180_000 });
    if (!r.ok) return finish(cwd, false, r.err || r.out.trim() || "git commit failed", commitHint(r.err + r.out));

    const short = (await line(root, ["rev-parse", "--short", "HEAD"])) ?? "";
    const subject = msg.split("\n")[0];
    return finish(cwd, true, null, null, `Committed ${short} — ${subject}`);
  });
}

/** git's commit failures are usually one of a few fixable setup problems. */
function commitHint(err: string): string | null {
  if (/Please tell me who you are|unable to auto-detect email|empty ident name/i.test(err))
    return "git doesn't know who you are here. Set `user.name` and `user.email`, then commit again.";
  if (/timed out/i.test(err))
    return "A commit hook is still running or is waiting for input. Run the commit in a terminal to see it.";
  if (/hook|pre-commit/i.test(err))
    return "A commit hook rejected this. Fix what it reports, or commit in a terminal to skip it.";
  return null;
}

// ── push ──────────────────────────────────────────────────────────────────────
/**
 * Publish this branch's commits.
 *
 * Never forced, and never with a refspec the browser chose: the destination is read
 * from the branch's own config (`branch.<name>.remote` / `.merge`), which is the
 * same place `git push` reads it from. A branch with no upstream gets one set, since
 * that is the only way the first push of a new branch can work at all.
 *
 * A branch known to be behind is refused before contacting the remote, because the
 * push would be rejected anyway and "pull first" is the answer either way.
 */
export async function push(cwd: string): Promise<WriteResult> {
  const status = await freshStatus(cwd);
  if (!status.isRepo || !status.root)
    return { ok: false, status, error: "not a git repository", hint: null };
  const root = status.root;

  if (status.detached)
    return {
      ok: false,
      status,
      error: "HEAD is detached",
      hint: "Switch to a branch first — there is nothing for a push to publish.",
    };
  if (!status.branch) return { ok: false, status, error: "no current branch", hint: null };
  const branch = status.branch;

  return withLock(root, async () => {
    const remotes = (await run(root, ["remote"])).out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!remotes.length)
      return finish(cwd, false, "this repository has no remote", "Add one with `git remote add`, then push.");

    const configured = await line(root, ["config", "--get", `branch.${branch}.remote`]);
    const remote = configured ?? (remotes.includes("origin") ? "origin" : remotes[0]);
    if (!plausibleRef(remote) || !remotes.includes(remote))
      return finish(cwd, false, `unusable remote: ${remote}`, null);

    if (!status.upstream) {
      const r = await run(root, ["push", "--set-upstream", remote, `HEAD:refs/heads/${branch}`], {
        timeoutMs: 180_000,
      });
      if (!r.ok) return finish(cwd, false, r.err || "git push failed", pushHint(r.err));
      return finish(cwd, true, null, null, `Pushed ${branch} to ${remote} and set it as the upstream.`);
    }

    if (status.behind > 0)
      return finish(
        cwd,
        false,
        `${branch} is ${status.behind} commit${status.behind === 1 ? "" : "s"} behind ${status.upstream}`,
        "Pull first — the remote would reject this push as non-fast-forward.",
      );
    if (status.ahead === 0) return finish(cwd, true, null, null, "Nothing to push — already up to date.");

    /**
     * The upstream branch may be named differently from the local one, so the
     * destination comes from `branch.<name>.merge` rather than from the local name.
     */
    const merge = await line(root, ["config", "--get", `branch.${branch}.merge`]);
    const dest = merge && plausibleRef(merge) ? merge : `refs/heads/${branch}`;

    const r = await run(root, ["push", remote, `HEAD:${dest}`], { timeoutMs: 180_000 });
    if (!r.ok) return finish(cwd, false, r.err || "git push failed", pushHint(r.err));

    const n = status.ahead;
    return finish(cwd, true, null, null, `Pushed ${n} commit${n === 1 ? "" : "s"} to ${status.upstream}.`);
  });
}

function pushHint(err: string): string | null {
  if (/non-fast-forward|fetch first|behind its remote/i.test(err))
    return "The remote has commits this branch doesn't. Pull first, then push again.";
  if (/timed out/i.test(err))
    return "The remote didn't answer, or it wants credentials this daemon can't supply. Try the push in a terminal.";
  if (/Authentication|could not read Username|Permission denied|publickey/i.test(err))
    return "git couldn't authenticate without a prompt. Set up a credential helper or an SSH key, then push again.";
  if (/protected branch|pre-receive hook declined/i.test(err))
    return "The remote refused the push. Open a pull request from a branch instead.";
  return null;
}
