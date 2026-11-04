import type { CommentKind, ExplainTarget, PrFilter, PrRef, ReviewEvent } from "../shared/pr.ts";
import { fetchAsset, githubError, resetGithub, viewerLogin } from "./github.ts";
import * as explain from "./prExplain.ts";
import * as review from "./prReview.ts";
import * as runs from "./prRuns.ts";
import { getPr, listPeople, listPrs, prOverview, prTemplate, trackedRepos } from "./prs.ts";
import * as watch from "./prWatch.ts";

/**
 * `/api/pr/...` — everything the review pages ask the daemon.
 *
 * Returns null for a path it does not own, so index.ts can fall through to the rest
 * of its routes. GitHub failures come back with GitHub's status and wording rather
 * than a bare 500, since "Resource not accessible by integration" is the message
 * worth reading.
 */
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });

/** Attachment hosts that only answer a signed-in request; everything else the browser loads itself. */
const PROXIED_IMAGE = /^https:\/\/(github\.com\/user-attachments\/|(?:private-)?user-images\.githubusercontent\.com\/)/i;

const body = async <T>(req: Request): Promise<T> => (await req.json().catch(() => ({}))) as T;

/** `/api/pr/<owner>/<repo>/<number>/...` → the PR and what follows it. */
function parsePr(segments: string[]): { pr: PrRef; rest: string[] } | null {
  const [owner, repo, number, ...rest] = segments;
  if (!owner || !repo || !/^\d+$/.test(number ?? "")) return null;
  return { pr: { owner, repo, number: Number(number) }, rest };
}

export async function handlePrRoute(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/pr")) return null;
  try {
    return await route(req, url, p.slice("/api/pr".length).split("/").filter(Boolean));
  } catch (e) {
    const { status, message } = githubError(e);
    return json({ error: message }, status);
  }
}

async function route(req: Request, url: URL, seg: string[]): Promise<Response> {
  const method = req.method;

  if (seg.length === 0) {
    // Who the token belongs to — the page's "signed in as" line and the sign that gh works.
    if (seg.length === 0 && method === "GET") {
      try {
        return json({ ok: true, login: await viewerLogin(), repos: trackedRepos() });
      } catch (e) {
        return json({ ok: false, login: null, repos: trackedRepos(), error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  if (seg[0] === "watch" && method === "GET") return json({ watches: watch.listWatches() });

  if (seg[0] === "reset" && method === "POST") {
    resetGithub();
    return json({ ok: true });
  }

  if (seg[0] === "image" && method === "GET") {
    const target = url.searchParams.get("url") ?? "";
    if (!PROXIED_IMAGE.test(target)) return json({ error: "Not a GitHub attachment" }, 400);
    const res = await fetchAsset(target);
    return new Response(res.body, {
      status: 200,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": "private, max-age=600",
        "access-control-allow-origin": "*",
      },
    });
  }

  if (seg[0] === "list" && method === "GET") {
    const raw = url.searchParams.get("filter");
    const filter = raw ? (JSON.parse(raw) as PrFilter) : { repos: [] };
    return json(await listPrs({ ...filter, repos: filter.repos ?? [] }, url.searchParams.get("refresh") === "1"));
  }

  if (seg[0] === "people" && method === "GET") {
    const repos = (url.searchParams.get("repos") ?? "").split(",").filter(Boolean);
    return json({ people: await listPeople(url.searchParams.get("q") ?? "", repos) });
  }

  if (seg[0] === "runs" && method === "GET") return json({ runs: runs.listRuns(), summary: runs.runSummary() });

  if (seg[0] === "run") {
    const id = seg[1];
    if (!id) return json({ error: "not found" }, 404);
    if (!seg[2] && method === "GET") {
      const run = runs.getRun(id);
      return run ? json({ run }) : json({ error: "not found" }, 404);
    }
    if (!seg[2] && method === "DELETE") return json({ ok: runs.deleteRun(id) });
    if (seg[2] === "resume" && method === "POST") {
      const r = runs.resumeRun(id);
      return "error" in r ? json(r, 409) : json({ run: r });
    }
    if (seg[2] === "finding-targets" && method === "GET") {
      const run = runs.getRun(id);
      if (!run?.findings) return json({ error: "run has no findings" }, 404);
      return json({ targets: await runs.findingTargets(run.pr, run.findings.findings) });
    }
    if (seg[2] === "finding" && seg[3]) {
      if (seg[4] === "post" && method === "POST") {
        const r = await runs.postFinding(id, seg[3]);
        return "error" in r ? json({ error: r.error }, r.status) : json({ run: r });
      }
      if (method === "POST") {
        const b = await body<{ checked?: boolean }>(req);
        const run = runs.setChecked(id, seg[3], b.checked === true);
        return run ? json({ run }) : json({ error: "finding not found" }, 404);
      }
    }
    return json({ error: "not found" }, 404);
  }

  if (seg[0] === "explain" && seg[1]) {
    const id = seg[1];
    if (seg[2] === "drill" && method === "POST") {
      const b = await body<{ partIndex?: number; text?: string; question?: string }>(req);
      const r = explain.drill(id, b);
      return "httpStatus" in r ? json({ error: r.error }, r.httpStatus) : json({ explanation: r });
    }
    if (!seg[2] && method === "DELETE") return json({ ids: explain.deleteExplanation(id) });
    return json({ error: "not found" }, 404);
  }

  const parsed = parsePr(seg);
  if (!parsed) return json({ error: "not found" }, 404);
  const { pr, rest } = parsed;
  const action = rest[0];

  if (!action && method === "GET") return json({ pr: await getPr(pr.owner, pr.repo, pr.number) });
  if (action === "template" && method === "GET") return json({ body: await prTemplate(pr.owner, pr.repo) });
  if (action === "overview" && method === "GET") return json(await prOverview(pr.owner, pr.repo, pr.number));
  if (action === "watch" && method === "POST") return json({ watches: watch.watch(pr) });
  if (action === "unwatch" && method === "POST") return json({ watches: watch.unwatch(pr) });
  if (action === "seen" && method === "POST") return json({ watches: watch.markSeen(pr) });

  if (action === "comment" && method === "POST") {
    const b = await body<{ body?: string }>(req);
    if (!b.body?.trim()) return json({ error: "body is required" }, 400);
    return json({ url: await review.postIssueComment(pr, b.body) });
  }
  if (action === "files" && method === "GET") return json(await review.listFiles(pr));

  if (action === "file" && method === "GET") {
    const sha = url.searchParams.get("sha");
    const path = url.searchParams.get("path");
    if (!sha || !path) return json({ error: "sha and path are required" }, 400);
    try {
      return json({ content: await review.fileContent(pr, sha, path) });
    } catch (e) {
      return json({ content: null, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // The same file's diff with more context than GitHub gives, from the local clone.
  if (action === "file-diff" && method === "GET") {
    const base = url.searchParams.get("base");
    const head = url.searchParams.get("head");
    const path = url.searchParams.get("path");
    if (!base || !head || !path) return json({ error: "base, head and path are required" }, 400);
    try {
      const patch = await review.expandedDiff(pr, base, head, path, url.searchParams.get("previous"), Number(url.searchParams.get("context") ?? 10));
      return json({ ok: true, patch, error: null });
    } catch (e) {
      return json({ ok: false, patch: "", error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (action === "commits" && method === "GET") return json({ commits: await review.listCommits(pr) });

  if (action === "commit" && method === "GET") {
    const sha = url.searchParams.get("sha") ?? "";
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return json({ error: "sha is required" }, 400);
    try {
      return json({ ok: true, ...(await review.commitDiff(pr, sha, Number(url.searchParams.get("context") ?? 3))), error: null });
    } catch (e) {
      return json({ ok: false, patch: "", source: null, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (action === "viewed" && method === "POST") {
    const b = await body<{ path?: string; viewed?: boolean }>(req);
    if (!b.path) return json({ error: "path is required" }, 400);
    await review.setViewed(pr, b.path, b.viewed === true);
    return json({ ok: true });
  }

  if (action === "comments" && rest[1]) {
    const id = decodeURIComponent(rest[1]);
    const kindOf = (k: unknown): CommentKind | null => (k === "issue" || k === "review" ? k : null);
    if (method === "PATCH") {
      const b = await body<{ body?: string; kind?: string }>(req);
      const kind = kindOf(b.kind);
      if (!kind || !b.body?.trim()) return json({ error: "kind and a non-empty body are required" }, 400);
      await review.updateComment(id, kind, b.body);
      return json({ ok: true });
    }
    if (method === "DELETE") {
      const kind = kindOf(url.searchParams.get("kind"));
      if (!kind) return json({ error: "kind is required" }, 400);
      await review.deleteComment(id, kind);
      return json({ ok: true });
    }
  }

  if (action === "reviewers" && (method === "POST" || method === "DELETE")) {
    const b = await body<{ reviewers?: string[]; teams?: string[] }>(req);
    const logins = (b.reviewers ?? []).filter((l) => typeof l === "string" && l);
    const teams = (b.teams ?? []).filter((t) => typeof t === "string" && t);
    if (!logins.length && !teams.length) return json({ error: "reviewers or teams are required" }, 400);
    if (method === "POST") await review.requestReviewers(pr, logins, teams);
    else await review.removeReviewers(pr, logins, teams);
    return json({ ok: true });
  }

  if (action === "threads") {
    if (method === "GET" && !rest[1]) return json({ threads: await review.listThreads(pr) });
    const threadId = rest[1] ? decodeURIComponent(rest[1]) : null;
    if (threadId && rest[2] === "reply" && method === "POST") {
      const b = await body<{ body?: string }>(req);
      if (!b.body?.trim()) return json({ error: "body is required" }, 400);
      return json({ comment: await review.replyToThread(threadId, b.body) });
    }
    if (threadId && rest[2] === "resolved" && method === "POST") {
      const b = await body<{ resolved?: boolean }>(req);
      await review.setThreadResolved(threadId, b.resolved === true);
      return json({ ok: true });
    }
  }

  if (action === "drafts") {
    if (method === "GET") return json({ drafts: review.listDrafts(pr) });
    if (method === "POST" && !rest[1]) {
      const b = await body<{ path?: string; side?: string; line?: number; startLine?: number | null; body?: string }>(req);
      if (!b.path || !b.body?.trim() || !b.line || (b.side !== "LEFT" && b.side !== "RIGHT"))
        return json({ error: "path, side, line and a non-empty body are required" }, 400);
      return json({ draft: review.addDraft(pr, { path: b.path, side: b.side, line: b.line, startLine: b.startLine ?? null, body: b.body }) });
    }
    if (rest[1] && method === "POST") {
      const b = await body<{ body?: string }>(req);
      if (!b.body?.trim()) return json({ error: "body must not be empty" }, 400);
      const draft = review.updateDraft(pr, rest[1], b.body);
      return draft ? json({ draft }) : json({ error: "draft not found" }, 404);
    }
    if (rest[1] && method === "DELETE") {
      review.deleteDraft(pr, rest[1]);
      return json({ ok: true });
    }
  }

  if (action === "pending-review" && method === "GET") return json({ pending: await review.pendingGithubReview(pr) });

  if (action === "submit" && method === "POST") {
    const b = await body<{ event?: ReviewEvent; body?: string }>(req);
    if (!b.event || !["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(b.event)) return json({ error: "invalid event" }, 400);
    try {
      return json(await review.submitReview(pr, b.event, b.body ?? ""));
    } catch (e) {
      const { status, message } = githubError(e);
      return json({ ok: false, reviewUrl: null, submittedDrafts: 0, error: message }, status);
    }
  }

  if (action === "runs" && method === "GET") return json({ runs: runs.listRuns(pr) });

  if (action === "run" && method === "POST") {
    const b = await body<{ actionId?: string }>(req);
    const act = b.actionId ? runs.actionById(b.actionId) : null;
    if (!act) return json({ error: "action not found" }, 404);
    return json({ run: await runs.startRun(act, pr) });
  }

  if (action === "explain") {
    if (method === "GET") return json({ explanations: explain.listExplanations(pr) });
    if (method === "POST") {
      const b = await body<Partial<ExplainTarget> & { question?: string }>(req);
      if (!b.path || !b.code?.trim() || !b.startLine || !b.endLine || (b.side !== "base" && b.side !== "head"))
        return json({ error: "side, path, startLine, endLine and code are required" }, 400);
      const target: ExplainTarget = { side: b.side, path: b.path, startLine: b.startLine, endLine: b.endLine, code: b.code };
      return json({ explanation: await explain.startExplanation(pr, target, b.question?.trim() || null) });
    }
  }

  return json({ error: "not found" }, 404);
}
