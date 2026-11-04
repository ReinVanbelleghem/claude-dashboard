import { useCallback, useEffect, useState } from "react";
import { prApi, type AgentSummary, type PrDetail, type PrRef, type Settings } from "../../api.ts";
import { RefreshIcon } from "../Icons.tsx";
import { CiDot, ContextLinks, DraftBadge, ReviewBadge } from "./PrBadges.tsx";
import { PrCommitsTab } from "./PrCommitsTab.tsx";
import { PrFilesTab } from "./PrFilesTab.tsx";
import { PrOverviewTab } from "./PrOverviewTab.tsx";
import { PrRunsTab, RunStatusBadge } from "./PrRunsTab.tsx";
import { isTyping, prHash, usePrRuns } from "./prState.ts";

/**
 * One pull request, full page: header with the action buttons, then Files changed
 * or Runs. Reached via #/pr/<owner>/<repo>/<number>[/runs[/<runId>]].
 */
export type PrRoute = { pr: PrRef; tab: "overview" | "files" | "commits" | "runs"; runId: string | null; sha: string | null };

/** #/pr/<owner>/<repo>/<number>[/files | /runs[/<runId>] | /commits[/<sha>]] — the bare route is Overview. */
export function routePr(hash: string): PrRoute | null {
  const m = hash.match(/^#\/pr\/([^/]+)\/([^/]+)\/(\d+)(?:\/(overview|files|runs|commits)(?:\/([^/]+))?)?$/);
  if (!m) return null;
  const tab = m[4] === "runs" ? "runs" : m[4] === "commits" ? "commits" : m[4] === "files" ? "files" : "overview";
  return { pr: { owner: m[1], repo: m[2], number: Number(m[3]) }, tab, runId: tab === "runs" ? (m[5] ?? null) : null, sha: tab === "commits" ? (m[5] ?? null) : null };
}

export function PrPage({
  route,
  agents,
  settings,
  onSettings,
  onBack,
}: {
  route: PrRoute;
  agents: AgentSummary[];
  settings: Settings | null;
  onSettings: (s: Settings) => void;
  onBack: () => void;
}) {
  const { pr, tab } = route;
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [template, setTemplate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { runs, reload: reloadRuns } = usePrRuns(pr);
  const key = `${pr.owner}/${pr.repo}/${pr.number}`;
  /** Bumped by Refresh; keys the active tab so it remounts and fetches again. */
  const [generation, setGeneration] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const loadDetail = useCallback(() => {
    setError(null);
    return prApi
      .detail(pr)
      .then((r) => setDetail(r.pr))
      .catch((e: Error) => setError(e.message));
  }, [key]);

  useEffect(() => {
    setDetail(null);
    loadDetail();
    prApi
      .template(pr)
      .then((r) => setTemplate(r.body))
      .catch(() => {});
  }, [key]);

  const refresh = useCallback(() => {
    if (refreshing) return;
    setRefreshing(true);
    setGeneration((g) => g + 1);
    reloadRuns();
    loadDetail().finally(() => setRefreshing(false));
  }, [refreshing, loadDetail, reloadRuns]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "r") refresh();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refresh]);

  useEffect(() => {
    document.title = detail ? `#${pr.number} ${detail.title}` : `${pr.repo}#${pr.number}`;
  }, [detail?.title, key]);

  const actions = settings?.reviews.actions ?? [];
  /** The action whose button was pressed, until its session exists or the start fails. */
  const [starting, setStarting] = useState<{ actionId: string; runId: string | null } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const active = runs.filter((r) => r.status === "running" || r.status === "starting").length;
  const last = runs[0];

  const start = (actionId: string) => {
    setStartError(null);
    setStarting({ actionId, runId: null });
    prApi
      .startRun(pr, actionId)
      .then((r) => setStarting({ actionId, runId: r.run.id }))
      .catch((e: Error) => {
        setStartError(e.message);
        setStarting(null);
      });
  };

  /**
   * Checking out the PR takes a few seconds before a session exists. The button shows
   * that time as "Starting…", and the moment the run has its session the page opens it
   * on the Runs tab, where the live conversation sits under the findings.
   */
  useEffect(() => {
    if (!starting?.runId) return;
    const run = runs.find((r) => r.id === starting.runId);
    if (!run) return;
    if (run.status === "failed") {
      setStartError(run.replies[0] ?? "The run could not start");
      setStarting(null);
    } else if (run.agentKey) {
      setStarting(null);
      window.location.hash = prHash(pr, `/runs/${run.id}`);
    }
  }, [runs, starting]);

  return (
    <div className="page pr-page">
      <div className="pr-head">
        <button className="icon-btn" onClick={onBack}>
          ← Back
        </button>
        <div className="pr-head-main">
          <div className="pr-head-title">
            <h1 title={detail?.title}>{detail?.title ?? `${pr.repo}#${pr.number}`}</h1>
            <span className="pr-head-number">#{pr.number}</span>
            {detail && <ContextLinks body={detail.body} template={template} />}
            {detail && <DraftBadge isDraft={detail.isDraft} />}
            {detail && <ReviewBadge decision={detail.reviewDecision} />}
            {detail && <CiDot state={detail.ciState} withLabel />}
          </div>
          <div className="pr-head-sub">
            {detail && (
              <>
                {detail.authorAvatarUrl && <img src={detail.authorAvatarUrl} alt="" className="pr-avatar small" />}
                <span>{detail.author}</span>
                <span className="pr-dot">·</span>
                <span className="chip">
                  {detail.baseRefName} ← {detail.headRefName}
                </span>
                <span className="pr-dot">·</span>
                <a href={detail.url} target="_blank" rel="noreferrer" className="link-btn inline">
                  Open on GitHub ↗
                </a>
              </>
            )}
            {error && <span className="pr-error">{error}</span>}
          </div>
        </div>
        <div className="pr-head-actions">
          {startError && <span className="pr-error">{startError}</span>}
          <button className={`icon-btn ${refreshing ? "pr-refreshing" : ""}`} onClick={refresh} disabled={refreshing} title="Reload this PR from GitHub (r)">
            <RefreshIcon /> {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          {actions.map((a) => {
            const busy = starting?.actionId === a.id;
            return (
              <button
                key={a.id}
                className={`icon-btn ${busy ? "pr-starting" : ""}`}
                disabled={!!starting}
                onClick={() => start(a.id)}
                title={busy ? "Checking the PR out and starting the session…" : `Start a ${a.name} session on this PR`}
              >
                {busy && <span className="pr-spinner" aria-hidden="true" />}
                {busy ? "Starting…" : a.name}
              </button>
            );
          })}
          {active > 0 && (
            <a href={prHash(pr, "/runs")} className="pill thinking" title={`${active} active run${active === 1 ? "" : "s"}`}>
              <i className="dot" /> {active}
            </a>
          )}
        </div>
      </div>
      <nav className="pr-tabs">
        <a href={prHash(pr)} className={tab === "overview" ? "on" : ""}>
          Overview
        </a>
        <a href={prHash(pr, "/files")} className={tab === "files" ? "on" : ""}>
          Files changed
        </a>
        <a href={prHash(pr, "/commits")} className={tab === "commits" ? "on" : ""}>
          Commits
        </a>
        <a href={prHash(pr, "/runs")} className={tab === "runs" ? "on" : ""}>
          Runs{runs.length ? ` (${runs.length})` : ""}
          {last && <RunStatusBadge status={last.status} />}
        </a>
      </nav>
      {tab === "overview" && <PrOverviewTab key={generation} pr={pr} />}
      {tab === "files" && <PrFilesTab key={generation} pr={pr} settings={settings} onSettings={onSettings} />}
      {tab === "commits" && <PrCommitsTab key={generation} pr={pr} sha={route.sha} settings={settings} onSettings={onSettings} />}
      {tab === "runs" && <PrRunsTab key={generation} pr={pr} runId={route.runId} agents={agents} settings={settings} onSettings={onSettings} />}
    </div>
  );
}
