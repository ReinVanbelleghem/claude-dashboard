import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/** Claude Code's own state. We only ever READ from here. */
export const CLAUDE_HOME = process.env.CLAUDE_HOME ?? join(homedir(), ".claude");
export const SESSIONS_DIR = join(CLAUDE_HOME, "sessions");
export const PROJECTS_DIR = join(CLAUDE_HOME, "projects");

/** Our own state, deliberately outside ~/.claude so we never corrupt Claude Code. */
export const DATA_DIR = process.env.DASHBOARD_HOME ?? join(homedir(), ".claude-dashboard");
export const DB_PATH = join(DATA_DIR, "index.db");

export const PORT = Number(process.env.PORT ?? 5757);

/**
 * The environment for any spawn of the `claude` binary.
 *
 * Sessions are meant to behave like a Claude started in the same terminal, so this
 * is `process.env` as-is apart from `XPC_FLAGS`. With the 0x2 bit set — which some
 * terminals (Supacode) export, while Terminal.app uses 0x0 — the binary fails to
 * read the login out of the macOS Keychain and every turn answers "Not logged in"
 * in ~50ms without an API call. The daemon inherits whatever the launching shell
 * happened to have, so it is pinned here rather than left to how it was started.
 */
export function claudeEnv(extra?: Record<string, string>): Record<string, string | undefined> {
  return { ...process.env, ...extra, XPC_FLAGS: "0x0" };
}

/** ~/.claude/projects dirs are the cwd with / replaced by -; recover a display path. */
export function slugToPath(slug: string): string {
  return slug.replace(/^-/, "/").replace(/-/g, "/");
}

/**
 * Home for sessions started without a project. Empty and outside every checkout,
 * so nothing on disk invites the model into a codebase it was not asked about.
 */
export const SCRATCH_DIR = join(DATA_DIR, "scratch");

/**
 * Files pasted or dropped into a composer.
 *
 * A browser never reveals a file's real path — `File` carries a name and bytes and
 * nothing else — so a path can only be produced by storing the bytes ourselves. That
 * is also the only version that works when the dashboard is open on a different
 * machine from the daemon: the session reads the copy that lives next to it, not one
 * that only ever existed on the laptop that did the pasting.
 */
export const DROPPED_DIR = join(DATA_DIR, "dropped");

/**
 * Where generated HTML artifacts live.
 *
 * Deliberately outside both ~/.claude and the dashboard's own state: an artifact is
 * something you keep and open months later, not cache the dashboard owns. Deleting
 * ~/.claude-dashboard must never take your work with it.
 *
 * Mutable, because Settings can repoint it without a restart. The environment
 * variable, when set, is the starting value rather than a lock — a setting the UI
 * offers but silently ignores is worse than no setting at all.
 */
export const DEFAULT_ARTIFACTS_DIR =
  process.env.CLAUDE_ARTIFACTS_DIR ?? join(homedir(), "Notes", "artifacts");

let artifactsDirValue = DEFAULT_ARTIFACTS_DIR;

export function artifactsDir(): string {
  return artifactsDirValue;
}

/** Returns true when the root actually moved, so the caller knows to re-scan. */
export function setArtifactsDir(dir: string): boolean {
  const next = dir.trim() ? resolve(dir.trim().replace(/^~(?=$|\/)/, homedir())) : DEFAULT_ARTIFACTS_DIR;
  if (next === artifactsDirValue) return false;
  artifactsDirValue = next;
  artifactPathRe = buildArtifactPathRe();
  return true;
}

/**
 * Artifacts get their own port, and therefore their own origin.
 *
 * Artifact HTML is model-written and runs with whatever scripts it pleases. Served
 * from the API port it would be same-origin with a daemon that can start Claude
 * sessions with real file access; served from here it is cross-origin, so the
 * browser refuses both the read and (with the Origin check in index.ts) the write.
 */
export const ARTIFACT_PORT = Number(process.env.ARTIFACT_PORT ?? 5759);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Absolute-looking references to the artifact root inside a shell command. Not a
 * parser — it only has to be good enough to attribute a heredoc write to a session,
 * and the reconciler finds the folder either way.
 */
function buildArtifactPathRe(): RegExp {
  const dir = artifactsDirValue;
  const alts = [escapeRe(dir)];
  if (dir.startsWith(homedir() + sep)) {
    const tail = dir.slice(homedir().length);
    alts.push(`~${escapeRe(tail)}`, `\\$HOME${escapeRe(tail)}`);
  }
  return new RegExp(`(?:${alts.join("|")})[^\\s'"\`;|&)>]*`, "g");
}

let artifactPathRe = buildArtifactPathRe();

/**
 * The artifact a path belongs to, or null if it is not under the artifact root.
 *
 * One folder is one artifact, so every asset inside it maps to the same slug. A
 * bare `.html` file sitting at the root counts too — an artifact does not have to
 * have been given a folder to be real.
 */
export function artifactSlug(filePath: string): string | null {
  if (!filePath) return null;
  const expanded = filePath.startsWith("~/") ? join(homedir(), filePath.slice(2)) : filePath;
  const abs = resolve(expanded);
  const root = resolve(artifactsDirValue);
  if (!abs.startsWith(root + sep)) return null;
  const parts = abs.slice(root.length + 1).split(sep).filter(Boolean);
  if (parts.length === 0) return null;
  const first = parts[0]!;
  // A loose file at the root is only an artifact if it is the page itself.
  if (parts.length === 1) return first.toLowerCase().endsWith(".html") ? first.slice(0, -5) : null;
  return first;
}

/** Every artifact slug a shell command appears to touch. */
export function artifactSlugsInCommand(command: string): string[] {
  const out = new Set<string>();
  for (const m of command.matchAll(artifactPathRe)) {
    const slug = artifactSlug(m[0].replace(/^\$HOME/, homedir()));
    if (slug) out.add(slug);
  }
  return [...out];
}
