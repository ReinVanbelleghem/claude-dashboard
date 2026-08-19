import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Making a fresh worktree usable.
 *
 * A new checkout contains exactly what git tracks, which is the problem: no
 * `node_modules`, no `.env`, no build output, no `.claude/settings.local.json`. A session
 * started there can read the code and not much else — it cannot run the tests it is
 * asked to write. That gap is the difference between worktrees being present and being
 * usable, so a small, declared set of paths is carried over at create time.
 *
 * Two mechanisms, because the two kinds of thing want opposite treatment:
 *
 *  - **symlink** for large, derived, shareable directories — `node_modules` above all.
 *    Copying one is slow and doubles the disk; linking is instant. The risk is real but
 *    narrow: an install run in the worktree writes through to the original. That is the
 *    same trade every worktree-plus-symlink setup makes, and it is why this is a list
 *    you opt into rather than a default that guesses.
 *  - **copy** for small, secret, per-checkout files — `.env` and friends. A symlink
 *    would mean editing one checkout's config silently edits every other one's.
 *
 * Nothing here overwrites: a path git already produced in the new tree is left exactly
 * as it is. And nothing is fatal — a worktree that exists with a missing symlink is far
 * better than a create that rolled itself back.
 */

/**
 * `off` is not something provisioning does — it is how a repository says "not this one"
 * about a rule the global list would otherwise apply. It is dropped by `mergeRules`, so
 * nothing downstream ever sees it.
 */
export type ProvisionMode = "symlink" | "copy" | "off";

export type ProvisionRule = { path: string; mode: ProvisionMode };

export type ProvisionOutcome = {
  path: string;
  mode: ProvisionMode;
  /** What happened, in a form the UI can state plainly. */
  result: "linked" | "copied" | "skipped-exists" | "skipped-missing" | "skipped-tracked" | "failed";
  error?: string;
};

/**
 * Defaults chosen to be useful in a JS repo and harmless everywhere else: each is
 * skipped when the source has no such path, so a Python or Go checkout simply gets
 * nothing rather than an error.
 */
export const DEFAULT_PROVISION: ProvisionRule[] = [
  { path: "node_modules", mode: "symlink" },
  { path: ".env", mode: "copy" },
  { path: ".env.local", mode: "copy" },
  { path: ".claude/settings.local.json", mode: "copy" },
];

/**
 * A path a rule may name.
 *
 * Repo-relative and no escaping, for the same reason every other path from outside is
 * checked: a rule is configuration, and configuration is edited by hand into a file the
 * daemon reads. `..` or an absolute path would let a rule reach outside the checkout
 * entirely, and a leading `-` is a flag waiting to happen.
 *
 * `*` and `**` are allowed and mean what they do in a shell — but only because this file
 * expands them itself, against the source tree, with `readdir`. Nothing here is ever
 * handed to a shell, so a wildcard is a matcher and not an injection.
 */
export function validRule(p: string): boolean {
  const v = p.trim();
  return (
    !!v &&
    !v.startsWith("-") &&
    !v.startsWith("/") &&
    !v.startsWith("~") &&
    !v.split("/").includes("..") &&
    !v.split("/").includes(".git")
  );
}

/** Guard against a resolved path leaving the tree it belongs to, symlinks included. */
function inside(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  return t !== r && t.startsWith(r + sep);
}

export function provision(
  from: string,
  to: string,
  rules: ProvisionRule[] = DEFAULT_PROVISION,
  /**
   * Which of the rule paths git ignores in the source. Only these are carried over.
   *
   * The reason is not tidiness. Anything git does *not* ignore arrives in the new
   * checkout as untracked work: it turns up in the diff, in `stage all`, and — because a
   * dirty worktree is deliberately refused — it would make a freshly created worktree
   * impossible to remove again. Resolved by the caller, which is where git lives.
   */
  ignored?: Set<string>,
): ProvisionOutcome[] {
  const out: ProvisionOutcome[] = [];

  for (const rule of rules) {
    const rel = rule.path.trim();
    // Defensive: mergeRules already drops these, and a stray one must not fall through
    // to the copy branch below.
    if (rule.mode === "off") continue;
    if (!validRule(rel)) {
      out.push({ path: rel, mode: rule.mode, result: "failed", error: "not an allowed path" });
      continue;
    }

    const src = join(from, rel);
    const dst = join(to, rel);
    if (!inside(from, src) || !inside(to, dst)) {
      out.push({ path: rel, mode: rule.mode, result: "failed", error: "path escapes the worktree" });
      continue;
    }

    // Nothing to carry over. Normal, not an error: most rules miss in most repos.
    if (!existsSync(src)) {
      out.push({ path: rel, mode: rule.mode, result: "skipped-missing" });
      continue;
    }
    if (ignored && !ignored.has(rel)) {
      out.push({ path: rel, mode: rule.mode, result: "skipped-tracked" });
      continue;
    }
    /**
     * lstat, not exists: a broken symlink left by an earlier run still occupies the
     * name, and symlinkSync would fail on it rather than replace it.
     */
    let taken = false;
    try {
      lstatSync(dst);
      taken = true;
    } catch {
      taken = false;
    }
    if (taken) {
      out.push({ path: rel, mode: rule.mode, result: "skipped-exists" });
      continue;
    }

    try {
      // A nested rule like .claude/settings.local.json needs its parent to exist first.
      mkdirSync(dirname(dst), { recursive: true });
      if (rule.mode === "symlink") {
        // Absolute target, so the link does not depend on where the worktree sits
        // relative to the original — those are siblings today and need not stay so.
        symlinkSync(resolve(src), dst);
        out.push({ path: rel, mode: rule.mode, result: "linked" });
      } else {
        if (lstatSync(src).isDirectory()) {
          copyDir(src, dst);
        } else {
          copyFileSync(src, dst);
        }
        out.push({ path: rel, mode: rule.mode, result: "copied" });
      }
    } catch (e) {
      out.push({
        path: rel,
        mode: rule.mode,
        result: "failed",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return out;
}

/**
 * Copy a directory tree, following nothing.
 *
 * Symlinks inside a copied directory are skipped rather than followed: a `copy` rule is
 * for small per-checkout config, and following a link out of the tree is how a rule
 * meant to carry `.env` ends up duplicating a dependency directory.
 */
function copyDir(src: string, dst: string) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) copyFileSync(s, d);
  }
}

/**
 * Undo one provisioned path.
 *
 * Needed because whether git ignores something can only be settled once it exists, and
 * in the shape it ends up in. `node_modules/` in a `.gitignore` matches a directory and
 * not a symlink to one, so the very rule that makes linking worth doing can leave the
 * link showing as untracked — which would make the new worktree impossible to remove.
 * Cheaper to place it and take it back in that case than to try to predict it.
 */
export function unprovision(to: string, rel: string): boolean {
  try {
    rmSync(join(to, rel), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Make git ignore these paths locally, by adding them to the repository's own exclude
 * file.
 *
 * This exists for one specific, very common trap. The conventional `.gitignore` line is
 * `node_modules/`, and a trailing slash means *directory* — so a symlink to a directory
 * is not matched, and the symlink provisioning just created shows up as untracked work.
 * The path written here has no trailing slash, so it matches either.
 *
 * `info/exclude` is the right file for it: git never commits it, it is per-clone personal
 * configuration, and it is exactly where "ignore this in my copy" belongs. Note it lives
 * in the *common* directory, so it is shared by every worktree of the repository — which
 * is what makes it work at all, and also why it is off by default. In the main checkout
 * it changes nothing, since a real `node_modules` directory was already ignored.
 *
 * Appends only, never rewrites, and skips anything already listed.
 */
export function excludeLocally(commonDir: string, paths: string[]): string[] {
  const file = join(commonDir, "info", "exclude");
  let existing = "";
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    // No exclude file yet is normal; it is created below.
  }
  const listed = new Set(
    existing
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
  const missing = paths.filter((p) => validRule(p) && !listed.has(p));
  if (missing.length === 0) return [];

  try {
    mkdirSync(dirname(file), { recursive: true });
    const lead = existing && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(
      file,
      `${lead}# added by claude-dashboard, so worktree symlinks are ignored\n${missing.join("\n")}\n`,
    );
    return missing;
  } catch {
    // Not fatal: provisioning simply reports the path as left behind instead.
    return [];
  }
}

/** One line summarising what provisioning did, for the write's `note`. */
export function summarise(rows: ProvisionOutcome[]): string | null {
  const linked = rows.filter((r) => r.result === "linked").map((r) => r.path);
  const copied = rows.filter((r) => r.result === "copied").map((r) => r.path);
  const failed = rows.filter((r) => r.result === "failed");
  const tracked = rows.filter((r) => r.result === "skipped-tracked").map((r) => r.path);
  const parts: string[] = [];
  if (linked.length) parts.push(`linked ${linked.join(", ")}`);
  if (copied.length) parts.push(`copied ${copied.join(", ")}`);
  // Worth saying: the path exists and was asked for, and was still left behind.
  if (tracked.length) parts.push(`left ${tracked.join(", ")} behind (git does not ignore it)`);
  if (failed.length) parts.push(`could not carry over ${failed.map((f) => f.path).join(", ")}`);
  return parts.length ? parts.join("; ") : null;
}

// ── layering ──────────────────────────────────────────────────────────────────

/**
 * One repository's effective rules: the global list, with that repository's own list
 * laid over it.
 *
 * Extending rather than replacing, because the global list is the part that is true
 * everywhere — `.env`, `node_modules`, `.claude/settings.local.json` — and making each
 * repository restate it would mean a repo that only needs its venvs silently losing its
 * env file the day someone adds the override.
 *
 * Same path in both: the repository wins, which is what makes `off` work. Order is
 * global first, then the repository's additions, so what runs reads the way the UI
 * lists it.
 */
export function mergeRules(global: ProvisionRule[], repo: ProvisionRule[] = []): ProvisionRule[] {
  const byPath = new Map<string, ProvisionMode>();
  for (const r of global) byPath.set(r.path.trim(), r.mode);
  for (const r of repo) byPath.set(r.path.trim(), r.mode);
  return [...byPath.entries()]
    .filter(([path, mode]) => path && mode !== "off")
    .map(([path, mode]) => ({ path, mode }));
}

// ── globs ─────────────────────────────────────────────────────────────────────

/**
 * Why a rule may be a pattern.
 *
 * A monorepo does not have one `venv`, it has one per project — nine, in the repository
 * that prompted this. Nine rules is not configuration, it is a list that goes stale the
 * next time someone adds a project, and the failure is silent: the worktree is created,
 * and only a test run inside it, minutes later, says anything is missing. One pattern is
 * the same intent stated once, and it covers the tenth project too.
 *
 * Expansion is deliberately narrow. `*` matches within one path segment, `**` matches any
 * number of segments, and both are resolved by walking the source tree with `readdir` —
 * never by a shell, so a wildcard here is a matcher and not an injection. The walk is
 * capped in three directions, because a pattern is typed by hand and one ending in `**`
 * would otherwise be an accidental full-disk crawl on the hot path of creating a
 * worktree.
 */
/**
 * Directories that hold dependencies rather than source. Two jobs: they are what a scan
 * offers to carry over, and they are where a `**` walk stops descending.
 */
const DEP_DIRS = new Set([
  "node_modules",
  "venv",
  ".venv",
  "vendor",
  ".direnv",
  ".tox",
  ".gradle",
  "Pods",
  "target",
]);

const GLOB_MAX_MATCHES = 400;
const GLOB_MAX_DEPTH = 8;
const GLOB_MAX_DIRS = 4000;

export function hasGlob(p: string): boolean {
  return /[*?]/.test(p);
}

function segMatcher(seg: string): RegExp {
  const src = seg
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${src}$`);
}

/**
 * Every path in `from` that this pattern names. A pattern with no wildcard returns itself
 * when it exists, so callers need not care which kind they were handed.
 *
 * Matched a segment at a time, breadth-first, and that ordering is the point. The walk is
 * capped, so some pattern somewhere will hit the cap — and when it does, the results it
 * has already found should be the shallow ones. A depth-first walk of `projects/**` spends
 * its entire budget inside the first project and reports three venvs out of nine, which
 * is the worst possible failure here: a silent partial provision that looks like success.
 * Level by level, the cap costs you the deep tail instead.
 */
export function expandPath(from: string, pattern: string): string[] {
  const budget = { dirs: 0 };
  let frontier: string[] = [""];

  for (const seg of pattern.split("/").filter(Boolean)) {
    if (frontier.length === 0) return [];

    if (seg === "**") {
      frontier = descendants(from, frontier, budget);
      continue;
    }

    /**
     * A literal segment costs one stat per candidate rather than a directory read, which
     * is what keeps the common case — a list with no wildcard in it at all — exactly as
     * cheap as it was before patterns existed.
     */
    if (!hasGlob(seg)) {
      frontier = frontier
        .map((p) => (p ? `${p}/${seg}` : seg))
        .filter((p) => {
          try {
            lstatSync(join(from, p));
            return true;
          } catch {
            return false;
          }
        });
      continue;
    }

    const re = segMatcher(seg);
    const next: string[] = [];
    for (const p of frontier) {
      for (const e of readDir(p ? join(from, p) : from, budget)) {
        if (e.name === ".git" || !re.test(e.name)) continue;
        next.push(p ? `${p}/${e.name}` : e.name);
      }
    }
    frontier = next;
  }

  return frontier.filter(Boolean).slice(0, GLOB_MAX_MATCHES);
}

/**
 * Every directory at or below these, level by level.
 *
 * The descent stops at dependency directories, and that is not an optimisation — it is
 * what makes `**` usable. Walking into one `node_modules` or one `venv` is tens of
 * thousands of directories, enough to exhaust the budget before the pattern reaches the
 * second project. Nothing is lost: a dependency directory is still matched, since it is
 * in the frontier before it would be descended into, and a rule pointing *inside* one is
 * not what this feature is for.
 */
function descendants(from: string, roots: string[], budget: { dirs: number }): string[] {
  const out = [...roots];
  let level = roots;

  for (let depth = 0; depth < GLOB_MAX_DEPTH; depth++) {
    if (level.length === 0 || budget.dirs >= GLOB_MAX_DIRS) break;
    const next: string[] = [];
    for (const p of level) {
      for (const e of readDir(p ? join(from, p) : from, budget)) {
        if (!e.isDirectory() || e.name === ".git" || DEP_DIRS.has(e.name)) continue;
        next.push(p ? `${p}/${e.name}` : e.name);
      }
    }
    out.push(...next);
    level = next;
  }

  return out;
}

function readDir(dir: string, budget: { dirs: number }) {
  if (budget.dirs >= GLOB_MAX_DIRS) return [];
  budget.dirs++;
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    // A directory that cannot be read contributes no matches. Not worth failing a
    // worktree creation over.
    return [];
  }
}

/**
 * Turn a rule list into the literal paths to carry over, resolved against the source
 * tree.
 *
 * Non-glob rules pass through untouched, present or not, so `skipped-missing` is still
 * reported for them: "you asked for `.env` and this repo has none" is worth saying, while
 * "that pattern matched nothing" is not a fact about any particular path.
 */
export function expandRules(from: string, rules: ProvisionRule[]): ProvisionRule[] {
  const out: ProvisionRule[] = [];
  const seen = new Set<string>();
  const add = (path: string, mode: ProvisionMode) => {
    if (seen.has(path)) return;
    seen.add(path);
    out.push({ path, mode });
  };

  for (const rule of rules) {
    const rel = rule.path.trim();
    // An invalid rule is passed along rather than dropped, so provision() is the one
    // place that reports it and the UI hears about it once.
    if (!validRule(rel) || !hasGlob(rel)) {
      add(rel, rule.mode);
      continue;
    }
    for (const hit of expandPath(from, rel)) add(hit, rule.mode);
  }

  return out;
}

// ── scanning ──────────────────────────────────────────────────────────────────

/**
 * What a repository has that a fresh checkout would want, found by looking rather than
 * by being told.
 *
 * This exists because a hand-written list is exactly how the gap it closes happened: a
 * repository with nine venvs got the default list built for a JS repo, and the only
 * symptom was a test run failing several minutes later, inside a session, in a worktree
 * that looked fine. Reading the main checkout answers the question the user cannot
 * reasonably answer from memory.
 *
 * Named paths only, and deliberately so. `dist` and `build` are ignored and often large,
 * and carrying them over is worse than useless — a shared build directory means one
 * checkout's build silently overwrites another's. What is offered is dependencies
 * (expensive to reproduce, safe to share) and per-checkout config (small, secret,
 * copied).
 */
/** Small per-checkout config: copied, never linked, so editing one edits one. */
const CONFIG_FILES = [".claude/settings.local.json", ".env", "local.properties"];
const ENV_FILE = /^\.env(\..+)?$/;

const SCAN_MAX_DEPTH = 3;

/**
 * Literal candidate paths in `root`. The caller decides which survive: only git can say
 * whether a path is ignored, and a path git tracks must never be carried over.
 */
export function scanCandidates(root: string): ProvisionRule[] {
  const found: ProvisionRule[] = [];
  const budget = { dirs: 0 };

  const visit = (rel: string, depth: number) => {
    for (const e of readDir(rel ? join(root, rel) : root, budget)) {
      if (e.name === ".git") continue;
      const child = rel ? `${rel}/${e.name}` : e.name;

      if (e.isDirectory()) {
        if (DEP_DIRS.has(e.name)) {
          // Found what we came for. Record it and do not walk into it — walking a
          // node_modules is how a scan turns into a minute of disk.
          found.push({ path: child, mode: "symlink" });
          continue;
        }
        if (depth < SCAN_MAX_DEPTH && !e.name.startsWith(".")) visit(child, depth + 1);
        continue;
      }

      if (e.isFile() && ENV_FILE.test(e.name)) found.push({ path: child, mode: "copy" });
    }
  };

  visit("", 0);

  /**
   * The nested config files are known by name rather than found by pattern: a scan that
   * descended into dot-directories to reach `.claude/settings.local.json` would also be
   * walking every cache directory in the repo for nothing.
   */
  for (const rel of CONFIG_FILES) {
    try {
      lstatSync(join(root, rel));
      if (!found.some((f) => f.path === rel)) found.push({ path: rel, mode: "copy" });
    } catch {
      // Not there — the common case, and not a finding.
    }
  }

  return found;
}

/**
 * Fold sibling matches into one pattern, so nine `projects/<name>/venv` are offered as a
 * single rule.
 *
 * Not cosmetic. The literal list is correct only until the next project is added, so
 * suggesting literals would be suggesting something that goes stale by design. Only the
 * last-but-one segment is generalised, and only when at least two siblings agree: one
 * `venv` under one project is a fact about that project, not yet a pattern.
 */
export function compressRules(rules: ProvisionRule[]): ProvisionRule[] {
  const groups = new Map<string, { rules: ProvisionRule[]; pattern: string; mode: ProvisionMode }>();
  const out: ProvisionRule[] = [];

  for (const rule of rules) {
    const segs = rule.path.split("/");
    if (segs.length < 3) {
      out.push(rule);
      continue;
    }
    const pattern = [...segs.slice(0, -2), "*", segs[segs.length - 1]].join("/");
    const key = `${pattern} ${rule.mode}`;
    const g = groups.get(key) ?? { rules: [], pattern, mode: rule.mode };
    g.rules.push(rule);
    groups.set(key, g);
  }

  for (const g of groups.values()) {
    if (g.rules.length > 1) out.push({ path: g.pattern, mode: g.mode });
    else out.push(...g.rules);
  }

  return out;
}

/** Does an existing rule already cover this literal path, pattern or not? */
export function covers(rules: ProvisionRule[], path: string, from: string): boolean {
  return rules.some((r) => {
    const rel = r.path.trim();
    if (rel === path) return true;
    return hasGlob(rel) && expandPath(from, rel).includes(path);
  });
}
