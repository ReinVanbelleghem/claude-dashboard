import { execFileSync } from "node:child_process";

/**
 * GitHub access for the review pages — plain fetch against the REST and GraphQL
 * APIs, with the token `gh` already holds.
 *
 * No client library: the daemon talks to GitHub the way it talks to everything else,
 * with a handful of small helpers. Nothing new is stored on disk and logging in is
 * `gh auth login` like everywhere else. The token is read lazily so a machine without
 * `gh` still runs the rest of the dashboard.
 */
const API = "https://api.github.com";

let token: string | null = null;
let login: Promise<string> | null = null;

function readToken(): string {
  if (token) return token;
  if (process.env.GITHUB_TOKEN) return (token = process.env.GITHUB_TOKEN);
  try {
    const out = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (out) return (token = out);
  } catch {
    // Reported below with a message the UI can show.
  }
  throw new Error("No GitHub token: run `gh auth login`, or set GITHUB_TOKEN for the daemon.");
}

/** Forget what we know, so a fresh `gh auth login` is picked up without a restart. */
export function resetGithub() {
  token = null;
  login = null;
  teams = null;
}

export class GithubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** HTTP status and message for a failed call, in the shape the routes answer with. */
export function githubError(e: unknown): { status: number; message: string } {
  if (e instanceof GithubError) return { status: e.status, message: e.message };
  return { status: 502, message: e instanceof Error ? e.message : String(e) };
}

async function request<T>(method: string, path: string, body?: unknown, raw = false): Promise<{ data: T; headers: Headers }> {
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${readToken()}`,
      accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      const parsed = JSON.parse(text) as { message?: string; errors?: unknown[] };
      const details = (parsed.errors ?? [])
        .map((x) => (typeof x === "string" ? x : ((x as { message?: string }).message ?? JSON.stringify(x))))
        .join("; ");
      message = details ? `${parsed.message}: ${details}` : (parsed.message ?? text);
    } catch {
      // Not JSON; the raw text is the message.
    }
    throw new GithubError(res.status, message || `${method} ${path} → ${res.status}`);
  }
  if (res.status === 204) return { data: undefined as T, headers: res.headers };
  return { data: (raw ? await res.text() : await res.json()) as T, headers: res.headers };
}

/**
 * A comment attachment, fetched as the token's user. GitHub answers with a
 * redirect to a short-lived signed URL, which is followed by hand so the token
 * does not travel to the storage host.
 */
export async function fetchAsset(url: string): Promise<Response> {
  let res = await fetch(url, { headers: { authorization: `Bearer ${readToken()}` }, redirect: "manual" });
  for (let hop = 0; hop < 4 && res.status >= 300 && res.status < 400; hop++) {
    const next = res.headers.get("location");
    if (!next) break;
    res = await fetch(new URL(next, url), { redirect: "manual" });
  }
  if (!res.ok) throw new GithubError(res.status, `${url} → ${res.status}`);
  return res;
}

export const rest = {
  get: <T>(path: string) => request<T>("GET", path).then((r) => r.data),
  /** The file as bytes rather than a JSON envelope, for templates and the like. */
  getRaw: (path: string) => request<string>("GET", path, undefined, true).then((r) => r.data),
  post: <T>(path: string, body: unknown) => request<T>("POST", path, body).then((r) => r.data),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body).then((r) => r.data),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body).then((r) => r.data),
  del: <T>(path: string, body?: unknown) => request<T>("DELETE", path, body).then((r) => r.data),
  /** Follow `Link: rel="next"` until the end. Caps at 20 pages — a PR with 2000 files is not a PR to review here. */
  async paginate<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    for (let page = 0; url && page < 20; page++) {
      const { data, headers } = await request<T[]>("GET", url);
      out.push(...data);
      const next = /<([^>]+)>;\s*rel="next"/.exec(headers.get("link") ?? "");
      url = next ? next[1] : null;
    }
    return out;
  },
};

export async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { authorization: `Bearer ${readToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string; type?: string }[]; message?: string };
  if (!res.ok) throw new GithubError(res.status, body.message ?? `GraphQL → ${res.status}`);
  if (body.errors?.length) {
    const status = body.errors.some((e) => e.type === "NOT_FOUND") ? 404 : 400;
    throw new GithubError(status, body.errors.map((e) => e.message).join("; "));
  }
  return body.data as T;
}

/** The login the token belongs to. Cached for the daemon's lifetime. */
export function viewerLogin(): Promise<string> {
  login ??= rest.get<{ login: string }>("/user").then(
    (u) => u.login,
    (e) => {
      login = null;
      throw e;
    },
  );
  return login;
}

let teams: Promise<Set<string>> | null = null;

/** `org/team-slug` for every team the viewer is on, so a team review request counts as "requested from me". */
export function viewerTeams(): Promise<Set<string>> {
  teams ??= (async () => {
    const me = await viewerLogin();
    const out = new Set<string>();
    try {
      const data = await graphql<{ viewer: { organizations: { nodes: { login: string }[] } } }>(
        `{ viewer { organizations(first: 20) { nodes { login } } } }`,
      );
      for (const org of data.viewer.organizations.nodes) {
        try {
          const res = await graphql<{ organization: { teams: { nodes: { slug: string }[] } } }>(
            `query($org: String!, $login: String!) { organization(login: $org) { teams(first: 100, userLogins: [$login]) { nodes { slug } } } }`,
            { org: org.login, login: me },
          );
          for (const t of res.organization.teams.nodes) out.add(`${org.login}/${t.slug}`);
        } catch {
          continue;
        }
      }
    } catch (e) {
      teams = null;
      throw e;
    }
    return out;
  })();
  return teams;
}
