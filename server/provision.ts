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

export type ProvisionRule = { path: string; mode: "symlink" | "copy" };

export type ProvisionOutcome = {
  path: string;
  mode: "symlink" | "copy";
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
