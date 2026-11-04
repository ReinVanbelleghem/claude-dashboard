import type { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ARTIFACT_PORT, artifactsDir } from "./paths.ts";

/**
 * Generated HTML artifacts.
 *
 * The filesystem is the source of truth for what exists — a folder under the
 * artifact root with an HTML page in it is an artifact, whoever put it there. The
 * transcript index is the source of truth for provenance, and lives in
 * `artifact_writes` (see indexer.ts). This module never writes that table, and the
 * indexer never writes this one.
 */

export type Artifact = {
  slug: string;
  title: string;
  entry: string;
  createdTs: number | null;
  modifiedTs: number | null;
  size: number;
  fileCount: number;
  missing: boolean;
  pinned: boolean;
  /** Tucked away: out of the grid unless hidden ones are shown. */
  hidden: boolean;
  /** Every tag, page-declared first. */
  tags: string[];
  /** The subset declared by the page itself, which the dashboard cannot remove. */
  metaTags: string[];
  sessions: ArtifactSession[];
};

export type ArtifactSession = {
  id: string;
  title: string | null;
  cwd: string | null;
  ts: number | null;
};

/** Enough of a page to hold a <title>, and not enough to matter if it is huge. */
const TITLE_SNIFF_BYTES = 16_384;
/** Defence against a stray node_modules landing in the artifact root. */
const MAX_WALK_ENTRIES = 2_000;
const SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store"]);

export function ensureArtifactsDir(): void {
  mkdirSync(artifactsDir(), { recursive: true });
}

function humanise(slug: string): string {
  const words = slug.replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "").replace(/[-_]+/g, " ").trim();
  if (!words) return slug;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** The page's own title and tags, from its first few KB. */
async function readHead(absEntry: string): Promise<{ title: string | null; tags: string[] }> {
  try {
    const head = await Bun.file(absEntry).slice(0, TITLE_SNIFF_BYTES).text();
    const m = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    let title = m ? decodeEntities(m[1]!).replace(/\s+/g, " ").trim() : "";
    if (!title) {
      // A deck or report with no <title> usually still leads with an <h1>.
      const h1 = head.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      title = h1 ? decodeEntities(h1[1]!.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : "";
    }
    return { title: title || null, tags: metaTags(head) };
  } catch {
    return { title: null, tags: [] };
  }
}

/** `<meta name="tags" content="a, b">` or `keywords`, as normalised tags. */
function metaTags(head: string): string[] {
  const out: string[] = [];
  const re = /<meta\s+[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(head))) {
    const tag = m[0];
    const name = tag.match(/name\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (name !== "tags" && name !== "keywords") continue;
    const content = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    for (const t of content.split(",")) {
      const n = normaliseTag(decodeEntities(t));
      if (n && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

export const normaliseTag = (t: string): string =>
  t.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._/-]/g, "").slice(0, 40);

type DiskArtifact = {
  slug: string;
  entry: string;
  createdTs: number;
  modifiedTs: number;
  size: number;
  fileCount: number;
};

/** Total bytes, newest mtime and file count under a folder, breadth-capped. */
function walk(dir: string): { size: number; modified: number; created: number; count: number } {
  let size = 0;
  let modified = 0;
  let created = Number.MAX_SAFE_INTEGER;
  let count = 0;
  const queue = [dir];
  while (queue.length > 0 && count < MAX_WALK_ENTRIES) {
    const current = queue.shift()!;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(current, { withFileTypes: true }) as never;
    } catch {
      continue;
    }
    for (const e of entries as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(current, e.name);
      if (e.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = statSync(full);
        size += st.size;
        count++;
        modified = Math.max(modified, Math.floor(st.mtimeMs));
        created = Math.min(created, Math.floor(st.birthtimeMs || st.mtimeMs));
      } catch {
        /* vanished mid-walk */
      }
      if (count >= MAX_WALK_ENTRIES) break;
    }
  }
  return { size, modified, created: created === Number.MAX_SAFE_INTEGER ? modified : created, count };
}

/** Pick the page that represents a folder: index.html, else the only/first .html. */
function entryFor(dir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const html = names.filter((n) => n.toLowerCase().endsWith(".html"));
  if (html.length === 0) return null;
  const index = html.find((n) => n.toLowerCase() === "index.html");
  return index ?? html.sort()[0]!;
}

function scanDisk(): DiskArtifact[] {
  ensureArtifactsDir();
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = readdirSync(artifactsDir(), { withFileTypes: true }) as never;
  } catch {
    return [];
  }

  const out: DiskArtifact[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const full = join(artifactsDir(), e.name);

    if (e.isDirectory()) {
      const entry = entryFor(full);
      if (!entry) continue;
      const w = walk(full);
      out.push({
        slug: e.name,
        entry: `${e.name}/${entry}`,
        createdTs: w.created,
        modifiedTs: w.modified,
        size: w.size,
        fileCount: w.count,
      });
      continue;
    }

    // A loose page at the root is an artifact too — not everything arrives in a folder.
    if (e.isFile() && e.name.toLowerCase().endsWith(".html")) {
      try {
        const st = statSync(full);
        out.push({
          slug: e.name.slice(0, -5),
          entry: e.name,
          createdTs: Math.floor(st.birthtimeMs || st.mtimeMs),
          modifiedTs: Math.floor(st.mtimeMs),
          size: st.size,
          fileCount: 1,
        });
      } catch {
        /* vanished mid-scan */
      }
    }
  }
  return out;
}

/**
 * Bring the `artifacts` table in line with the folder. Returns the number of rows
 * that actually changed, so a caller can stay quiet on the overwhelming majority
 * of passes where nothing has.
 */
export async function reconcileArtifacts(db: Database): Promise<number> {
  const disk = scanDisk();
  const rows = db
    .query<{ slug: string; title: string | null; modified_ts: number | null; size: number; missing: number }, []>(
      "SELECT slug, title, modified_ts, size, missing FROM artifacts",
    )
    .all();
  const known = new Map(rows.map((r) => [r.slug, r]));

  let changed = 0;
  const upsert = db.query(
    `INSERT INTO artifacts (slug, title, entry, created_ts, modified_ts, size, file_count, missing)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(slug) DO UPDATE SET
       title = excluded.title, entry = excluded.entry, modified_ts = excluded.modified_ts,
       size = excluded.size, file_count = excluded.file_count, missing = 0`,
  );

  for (const a of disk) {
    const prev = known.get(a.slug);
    const unchanged = prev && prev.modified_ts === a.modifiedTs && prev.size === a.size && prev.missing === 0;
    if (unchanged) continue;
    // Re-sniffing the title is the only I/O here, so it is only done when the
    // bytes moved — which, on a steady-state tick, is never.
    const head = await readHead(join(artifactsDir(), a.entry));
    upsert.run(a.slug, head.title ?? humanise(a.slug), a.entry, a.createdTs, a.modifiedTs, a.size, a.fileCount);
    replaceMetaTags(db, a.slug, head.tags);
    changed++;
  }

  const live = new Set(disk.map((a) => a.slug));
  const markMissing = db.query("UPDATE artifacts SET missing = 1 WHERE slug = ?");
  for (const r of rows) {
    if (live.has(r.slug) || r.missing === 1) continue;
    markMissing.run(r.slug);
    changed++;
  }
  return changed;
}

type ArtifactRow = {
  slug: string;
  title: string | null;
  entry: string;
  created_ts: number | null;
  modified_ts: number | null;
  size: number;
  file_count: number;
  missing: number;
  pinned: number;
  hidden: number;
};

function replaceMetaTags(db: Database, slug: string, tags: string[]): void {
  db.query("DELETE FROM artifact_tags WHERE slug = ? AND source = 'meta'").run(slug);
  const ins = db.query("INSERT OR IGNORE INTO artifact_tags (slug, tag, source) VALUES (?, ?, 'meta')");
  for (const t of tags) ins.run(slug, t);
}

/** Replace the user's tags on an artifact; page-declared tags are left alone. */
export function setUserTags(db: Database, slug: string, tags: string[]): Artifact | null {
  if (!db.query("SELECT 1 FROM artifacts WHERE slug = ?").get(slug)) return null;
  const clean = [...new Set(tags.map(normaliseTag).filter(Boolean))];
  db.query("DELETE FROM artifact_tags WHERE slug = ? AND source = 'user'").run(slug);
  const ins = db.query("INSERT OR IGNORE INTO artifact_tags (slug, tag, source) VALUES (?, ?, 'user')");
  for (const t of clean) ins.run(slug, t);
  return artifactDetail(db, slug);
}

export function setHidden(db: Database, slug: string, hidden: boolean): Artifact | null {
  db.query("UPDATE artifacts SET hidden = ? WHERE slug = ?").run(hidden ? 1 : 0, slug);
  return artifactDetail(db, slug);
}

export function setPinned(db: Database, slug: string, pinned: boolean): Artifact | null {
  db.query("UPDATE artifacts SET pinned = ? WHERE slug = ?").run(pinned ? 1 : 0, slug);
  return artifactDetail(db, slug);
}

/** Every tag in use, with how many artifacts carry it. */
export function allTags(db: Database): { tag: string; count: number }[] {
  return db
    .query<{ tag: string; count: number }, []>(
      "SELECT tag, COUNT(*) AS count FROM artifact_tags GROUP BY tag ORDER BY count DESC, tag ASC",
    )
    .all();
}

function attachSessions(db: Database, rows: ArtifactRow[]): Artifact[] {
  if (rows.length === 0) return [];
  const q = db.query<
    { slug: string; id: string; title: string | null; cwd: string | null; ts: number | null },
    [string]
  >(
    `SELECT w.slug AS slug, w.session_id AS id, s.title AS title, s.cwd AS cwd, w.ts AS ts
       FROM artifact_writes w
       LEFT JOIN sessions s ON s.id = w.session_id
      WHERE w.slug = ?
      ORDER BY COALESCE(w.ts, 0) ASC`,
  );
  const tagsQ = db.query<{ tag: string; source: string }, [string]>(
    "SELECT tag, source FROM artifact_tags WHERE slug = ? ORDER BY source DESC, tag ASC",
  );
  return rows.map((r) => ({
    slug: r.slug,
    title: r.title ?? r.slug,
    entry: r.entry,
    createdTs: r.created_ts,
    modifiedTs: r.modified_ts,
    size: r.size,
    fileCount: r.file_count,
    missing: r.missing === 1,
    pinned: r.pinned === 1,
    hidden: r.hidden === 1,
    tags: tagsQ.all(r.slug).map((t) => t.tag),
    metaTags: tagsQ.all(r.slug).filter((t) => t.source === "meta").map((t) => t.tag),
    sessions: q.all(r.slug).map(({ id, title, cwd, ts }) => ({ id, title, cwd, ts })),
  }));
}

export function listArtifacts(db: Database, opts: { q?: string; sessionId?: string } = {}): Artifact[] {
  const where: string[] = [];
  const args: string[] = [];
  if (opts.sessionId) {
    where.push("a.slug IN (SELECT slug FROM artifact_writes WHERE session_id = ?)");
    args.push(opts.sessionId);
  }
  if (opts.q?.trim()) {
    where.push("(a.title LIKE ? OR a.slug LIKE ?)");
    const like = `%${opts.q.trim()}%`;
    args.push(like, like);
  }
  const rows = db
    .query<ArtifactRow, string[]>(
      `SELECT a.* FROM artifacts a
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY a.missing ASC, COALESCE(a.modified_ts, 0) DESC`,
    )
    .all(...args);
  return attachSessions(db, rows);
}

export function artifactDetail(db: Database, slug: string): Artifact | null {
  const row = db.query<ArtifactRow, [string]>("SELECT * FROM artifacts WHERE slug = ?").get(slug);
  return row ? (attachSessions(db, [row])[0] ?? null) : null;
}

/**
 * Delete the bytes and the row.
 *
 * The row used to survive as a tombstone, on the theory that a session's history
 * should still record it. It should — but that record is `artifact_writes`, which
 * this never touches, so the tombstone bought nothing and left an entry in the grid
 * whose only remaining action was to delete it again.
 *
 * One path covers both cases: an artifact you are deleting loses its files and its
 * row, and one that vanished from disk behind our back (already flagged `missing`,
 * no files left to remove) just loses the row — which is what "Forget" means in the
 * UI. Point the artifact folder back, or put the file back, and the reconciler
 * rediscovers it with its sessions still attached.
 */
export function deleteArtifact(db: Database, slug: string): boolean {
  const row = db.query<ArtifactRow, [string]>("SELECT * FROM artifacts WHERE slug = ?").get(slug);
  if (!row) return false;
  const base = baseDirFor(row.entry);
  try {
    // Only ever a path we resolved out of our own table, and re-checked here.
    const target = resolve(base === artifactsDir() ? join(artifactsDir(), row.entry) : base);
    if (target !== resolve(artifactsDir()) && target.startsWith(resolve(artifactsDir()) + sep)) {
      rmSync(target, { recursive: true, force: true });
    }
  } catch {
    /* already gone */
  }
  db.query("DELETE FROM artifacts WHERE slug = ?").run(slug);
  db.query("DELETE FROM artifact_tags WHERE slug = ?").run(slug);
  return true;
}

/** The directory an artifact's relative URLs resolve against. */
function baseDirFor(entry: string): string {
  const parts = entry.split("/");
  return parts.length > 1 ? join(artifactsDir(), parts[0]!) : artifactsDir();
}

// ── API routes (on the daemon port) ──────────────────────────────────────────

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

export async function handleArtifactRoute(
  req: Request,
  url: URL,
  db: Database,
): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/artifacts")) return null;

  if (p === "/api/artifacts" && req.method === "GET") {
    return json({
      artifacts: listArtifacts(db, {
        q: url.searchParams.get("q") ?? undefined,
        sessionId: url.searchParams.get("session") ?? undefined,
      }),
      // The browser builds the artifact origin from its own hostname: the daemon
      // has no idea whether it is being reached over localhost or a tunnel.
      port: ARTIFACT_PORT,
      root: artifactsDir(),
      tags: allTags(db),
    });
  }

  if (p === "/api/artifacts/refresh" && req.method === "POST") {
    const changed = await reconcileArtifacts(db);
    return json({ changed, artifacts: listArtifacts(db) });
  }

  const rest = p.slice("/api/artifacts/".length);
  const [rawSlug, sub] = rest.split("/");
  const slug = decodeURIComponent(rawSlug ?? "");
  if (!slug) return json({ error: "not found" }, 404);

  if (sub === "tags" && req.method === "PUT") {
    const body = (await req.json().catch(() => ({}))) as { tags?: unknown };
    const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
    const a = setUserTags(db, slug, tags);
    return a ? json({ artifact: a, tags: allTags(db) }) : json({ error: "not found" }, 404);
  }
  if (sub === "hide" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { hidden?: unknown };
    const a = setHidden(db, slug, body.hidden !== false);
    return a ? json({ artifact: a }) : json({ error: "not found" }, 404);
  }
  if (sub === "pin" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { pinned?: unknown };
    const a = setPinned(db, slug, body.pinned !== false);
    return a ? json({ artifact: a }) : json({ error: "not found" }, 404);
  }
  if (sub) return json({ error: "not found" }, 404);

  if (req.method === "GET") {
    const a = artifactDetail(db, slug);
    return a ? json({ artifact: a }) : json({ error: "not found" }, 404);
  }
  if (req.method === "DELETE") {
    return deleteArtifact(db, slug) ? json({ ok: true }) : json({ error: "not found" }, 404);
  }
  return json({ error: "method not allowed" }, 405);
}

// ── static server (its own origin) ───────────────────────────────────────────

/**
 * What an artifact's own scripts are allowed to do.
 *
 * `connect-src 'self'` is the point of the exercise: 'self' here is the artifact
 * port, so a generated page cannot reach the daemon's API even though both are on
 * localhost. Inline script and style are allowed because every artifact we make is
 * a single self-contained file, and https: is allowed so a CDN chart library still
 * works.
 */
const CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "connect-src 'self' https:",
  "frame-ancestors 'self' http://localhost:* http://127.0.0.1:*",
].join("; ");

/**
 * Find-in-artifact, injected only when the framed preview asks for it (`?find=1`).
 *
 * The dashboard's own find walks this document's nodes, and an artifact is a
 * separate cross-origin document by design — so it cannot see a word of one. Rather
 * than give that isolation up, the search runs inside the frame and talks to the
 * find bar over postMessage: a query goes in, a count comes out.
 *
 * Deliberately not added to a direct open or to the bytes on disk. An artifact you
 * open in a tab is exactly the file you wrote.
 */
const FIND_BRIDGE = `<script>
/**
 * Find-in-artifact bridge.
 *
 * Injected only into the framed preview (\`?find=1\`), never into the file on disk or
 * a tab you open directly. The dashboard cannot search this document itself — the
 * frame is cross-origin on purpose — so the search runs here, in the artifact's own
 * origin, and only a query string comes in and a count goes out.
 */
(function () {
  if (window.__artifactFind) return;
  var LIMIT = 500;
  var ranges = [];
  var at = 0;
  var supported = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight === "function";

  function textNodes() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        var tag = p.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    var out = [], n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function search(q) {
    ranges = [];
    if (!q) return;
    var needle = q.toLowerCase();
    var nodes = textNodes();
    for (var i = 0; i < nodes.length && ranges.length < LIMIT; i++) {
      var text = nodes[i].nodeValue.toLowerCase();
      var from = 0, hit;
      while ((hit = text.indexOf(needle, from)) !== -1 && ranges.length < LIMIT) {
        var r = document.createRange();
        r.setStart(nodes[i], hit);
        r.setEnd(nodes[i], hit + needle.length);
        ranges.push(r);
        from = hit + needle.length;
      }
    }
  }

  function paint() {
    if (!supported) return;
    CSS.highlights.delete("artifact-find");
    CSS.highlights.delete("artifact-find-current");
    if (!ranges.length) return;
    var others = ranges.filter(function (_, i) { return i !== at; });
    if (others.length) CSS.highlights.set("artifact-find", new Highlight(...others));
    CSS.highlights.set("artifact-find-current", new Highlight(ranges[at]));
  }

  function reveal() {
    var r = ranges[at];
    if (!r) return;
    var rect = r.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > innerHeight) {
      scrollTo({ top: scrollY + rect.top - innerHeight / 3, behavior: "smooth" });
    }
  }

  function report() {
    parent.postMessage({ __artifactFind: "result", count: ranges.length, index: at, limit: LIMIT }, "*");
  }

  if (supported) {
    var css = document.createElement("style");
    css.textContent =
      "::highlight(artifact-find){background:#fde68a;color:#111}" +
      "::highlight(artifact-find-current){background:#fb923c;color:#111}";
    document.head.appendChild(css);
  }

  addEventListener("message", function (e) {
    var m = e.data;
    if (!m || m.__artifactFind !== "query") return;
    if (typeof m.query === "string") {
      search(m.query.trim());
      at = 0;
    }
    if (typeof m.step === "number" && ranges.length) {
      at = ((at + m.step) % ranges.length + ranges.length) % ranges.length;
    }
    paint();
    if (ranges.length) reveal();
    report();
  });

  window.__artifactFind = true;
  parent.postMessage({ __artifactFind: "ready" }, "*");
})();
</script>`;

function withFindBridge(html: string): string {
  const close = html.lastIndexOf("</body>");
  return close === -1 ? html + FIND_BRIDGE : html.slice(0, close) + FIND_BRIDGE + html.slice(close);
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
};

function contentType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return TYPES[ext] ?? "application/octet-stream";
}

/**
 * Resolve a request path to a real file inside the artifact root, or null.
 *
 * realpath on both sides, compared after resolution, so a symlink planted in the
 * artifact folder cannot be used to read the rest of the disk — the same check
 * files.ts makes for repository files.
 */
function safeResolve(rel: string): string | null {
  try {
    const root = realpathSync(artifactsDir());
    const target = realpathSync(resolve(join(artifactsDir(), rel)));
    if (target !== root && !target.startsWith(root + sep)) return null;
    if (!statSync(target).isFile()) return null;
    return target;
  } catch {
    return null;
  }
}

export function startArtifactServer(db: Database) {
  return Bun.serve({
    port: ARTIFACT_PORT,
    // Same reasoning as the daemon: never reachable from the network.
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const p = decodeURIComponent(url.pathname);
      if (!p.startsWith("/a/")) return new Response("Not found", { status: 404 });

      const rest = p.slice("/a/".length);
      const slash = rest.indexOf("/");
      const slug = slash === -1 ? rest : rest.slice(0, slash);
      const sub = slash === -1 ? "" : rest.slice(slash + 1);
      if (!slug) return new Response("Not found", { status: 404 });

      const row = db.query<{ entry: string }, [string]>("SELECT entry FROM artifacts WHERE slug = ?").get(slug);
      if (!row) return new Response("Not found", { status: 404 });

      // No sub-path means the entry page; anything else is an asset resolved
      // against whichever directory that page lives in.
      const relBase = row.entry.includes("/") ? `${row.entry.split("/")[0]}/` : "";
      const rel = sub ? `${relBase}${sub}` : row.entry;
      const file = safeResolve(rel);
      if (!file) return new Response("Not found", { status: 404 });

      const headers = {
        "content-type": contentType(file),
        "content-security-policy": CSP,
        "x-content-type-options": "nosniff",
        "cache-control": "no-cache",
      };

      // Only the entry page, and only when the framed preview asked for it. An
      // asset never needs it, and a direct open must get the file untouched.
      const wantsFind = !sub && url.searchParams.get("find") === "1";
      if (wantsFind && contentType(file).startsWith("text/html")) {
        const html = await Bun.file(file).text();
        return new Response(withFindBridge(html), { headers });
      }

      return new Response(Bun.file(file), { headers });
    },
  });
}
