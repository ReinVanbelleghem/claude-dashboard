import { useEffect, useState } from "react";
import { fmtUsd, prApi, type AgentSummary, type Finding, type FindingSeverity, type FindingTarget, type PrRun, type Settings } from "../../api.ts";
import { LiveConversation } from "../Conversation.tsx";
import { Markdown } from "../Markdown.tsx";
import { CommentIcon, TrashIcon } from "../Icons.tsx";
import { prHash, usePrRuns } from "./prState.ts";

/**
 * "Runs": every session an action started against this PR. The selected run shows
 * its findings (when the action asked for them) above the live conversation, so a
 * follow-up typed in the composer updates the list.
 */
export const RUN_LABEL: Record<PrRun["status"], string> = {
  starting: "starting",
  running: "running",
  succeeded: "done",
  failed: "failed",
  ended: "ended",
};

export function RunStatusBadge({ status }: { status: PrRun["status"] }) {
  const cls = status === "running" || status === "starting" ? "accent" : status === "succeeded" ? "ok" : status === "failed" ? "bad" : "";
  return <span className={`pr-badge ${cls}`}>{RUN_LABEL[status]}</span>;
}

export function PrRunsTab({
  pr,
  runId,
  agents,
  settings,
  onSettings,
}: {
  pr: PrRun["pr"];
  runId: string | null;
  agents: AgentSummary[];
  settings: Settings | null;
  onSettings: (s: Settings) => void;
}) {
  const { runs } = usePrRuns(pr);
  const selected = runs.find((r) => r.id === runId) ?? runs[0] ?? null;

  useEffect(() => {
    if (!runId && runs[0]) window.location.replace(prHash(pr, `/runs/${runs[0].id}`));
  }, [runId, runs[0]?.id]);

  return (
    <div className="pr-runs">
      <aside className="pr-runs-side">
        {runs.length === 0 && <div className="empty">No runs yet. Start one from the buttons in the header.</div>}
        {runs.map((r) => (
          <a key={r.id} href={prHash(pr, `/runs/${r.id}`)} className={`pr-run-row ${selected?.id === r.id ? "on" : ""}`}>
            <div className="pr-run-row-top">
              <RunStatusBadge status={r.status} />
              <span>{r.actionName}</span>
            </div>
            <div className="pr-run-row-sub">
              {new Date(r.createdAt).toLocaleString()}
              {r.costUsd != null && ` · ${fmtUsd(r.costUsd)}`}
            </div>
          </a>
        ))}
      </aside>
      <div className="pr-run-main">
        {selected ? <RunView key={selected.id} run={selected} agents={agents} settings={settings} onSettings={onSettings} /> : <div className="empty">Select a run.</div>}
      </div>
    </div>
  );
}

function RunView({ run, agents, settings, onSettings }: { run: PrRun; agents: AgentSummary[]; settings: Settings | null; onSettings: (s: Settings) => void }) {
  const agent = run.agentKey ? agents.find((a) => a.key === run.agentKey) : null;
  const live = !!agent && agent.status !== "ended" && agent.status !== "error";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pr-run">
      <div className="pr-run-bar">
        <RunStatusBadge status={run.status} />
        <strong>{run.actionName}</strong>
        {run.costUsd != null && <span className="hint">{fmtUsd(run.costUsd)}</span>}
        {run.cwd && (
          <span className="hint pr-run-cwd" title={run.cwd}>
            {run.cwd.split("/").slice(-3).join("/")}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {run.sessionId && (
          <a className="icon-btn tiny" href={`#/session/${encodeURIComponent(run.sessionId)}`} title="Open the session on its own page">
            Open session
          </a>
        )}
        {!live && run.sessionId && (
          <button className="icon-btn tiny primary" disabled={busy} onClick={() => act(() => prApi.resumeRun(run.id))}>
            Resume
          </button>
        )}
        <button
          className="icon-btn tiny"
          disabled={busy || live}
          title={live ? "End the session first" : "Delete this run's record (the session transcript stays)"}
          onClick={() => {
            if (window.confirm(`Delete this ${run.actionName} run? Its findings are removed; the session transcript stays in History.`))
              void act(() => prApi.deleteRun(run.id));
          }}
        >
          <TrashIcon />
        </button>
      </div>
      {error && <div className="pr-error">{error}</div>}
      {run.findings && <FindingsPanel run={run} />}
      {live && agent ? (
        <div className="panel chat-pane page-live pr-run-chat">
          <LiveConversation agentKey={agent.key} settings={settings} onSettings={onSettings} />
        </div>
      ) : (
        <div className="pr-run-replies">
          {run.replies.map((r, i) => (
            <div key={i} className="md-wrap">
              <Markdown text={r} />
            </div>
          ))}
          {run.replies.length === 0 && run.status !== "failed" && <div className="hint">The session has ended. Resume it to continue the conversation.</div>}
        </div>
      )}
    </div>
  );
}

// ── findings ──────────────────────────────────────────────────────────────────
const SEVERITIES: { key: FindingSeverity; label: string; cls: string }[] = [
  { key: "high", label: "High", cls: "bad" },
  { key: "medium", label: "Medium", cls: "warn" },
  { key: "low", label: "Low", cls: "" },
];
const RANK: Record<FindingSeverity, number> = { high: 2, medium: 1, low: 0 };

function FindingsPanel({ run }: { run: PrRun }) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [hideChecked, setHideChecked] = useState(false);
  const [targets, setTargets] = useState<Record<string, FindingTarget>>({});
  const { summary, findings, dropped = [] } = run.findings!;
  const checked = findings.filter((f) => run.checkedFindings.includes(f.id)).length;

  useEffect(() => {
    if (!findings.length) return;
    prApi
      .findingTargets(run.id)
      .then((r) => setTargets(r.targets))
      .catch(() => {});
  }, [run.id, findings.length]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="pr-findings">
      <button className="pr-findings-head" onClick={() => setOpen((o) => !o)}>
        <span className={`diff-caret ${open ? "open" : ""}`} aria-hidden="true" />
        <strong>Findings</strong>
        {SEVERITIES.map(({ key, label, cls }) => {
          const n = findings.filter((f) => f.severity === key).length;
          return n > 0 ? (
            <span key={key} className={`pr-badge ${cls}`}>
              {n} {label}
            </span>
          ) : null;
        })}
        <span style={{ flex: 1 }} />
        <span className="hint">
          {checked}/{findings.length} handled
        </span>
      </button>
      {open && (
        <>
          <div className="pr-findings-summary">
            <Markdown text={summary} />
            <div className="pr-findings-tools">
              <button className="link-btn inline" onClick={() => setExpanded(new Set(findings.map((f) => f.id)))}>
                Expand all
              </button>
              <button className="link-btn inline" onClick={() => setExpanded(new Set())}>
                Collapse all
              </button>
              <label className="check" style={{ marginLeft: "auto" }}>
                <input type="checkbox" checked={hideChecked} onChange={(e) => setHideChecked(e.target.checked)} />
                <span>Hide handled</span>
              </label>
            </div>
          </div>
          {SEVERITIES.map(({ key, label, cls }) => {
            const group = findings.filter((f) => f.severity === key);
            if (!group.length) return null;
            const visible = hideChecked ? group.filter((f) => !run.checkedFindings.includes(f.id)) : group;
            return (
              <div key={key}>
                <div className="pr-findings-group">
                  <span className={`pr-badge ${cls}`}>{label}</span>
                  <span>{group.length}</span>
                </div>
                {visible.map((f) => (
                  <FindingRow key={f.id} run={run} finding={f} expanded={expanded.has(f.id)} onToggle={() => toggle(f.id)} target={targets[f.id]} />
                ))}
              </div>
            );
          })}
          {dropped.length > 0 && <Dropped dropped={dropped} />}
        </>
      )}
    </div>
  );
}

function FindingRow({ run, finding, expanded, onToggle, target }: { run: PrRun; finding: Finding; expanded: boolean; onToggle: () => void; target?: FindingTarget }) {
  const isChecked = run.checkedFindings.includes(finding.id);
  const sev = SEVERITIES.find((s) => s.key === finding.severity)!;
  const moved = finding.previousSeverity && finding.previousSeverity !== finding.severity;
  const up = moved && RANK[finding.severity] > RANK[finding.previousSeverity!];
  const posted = run.postedFindings[finding.id];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = async () => {
    if (target?.mode !== "draft" && !window.confirm("Post this finding as a PR comment on GitHub now? Everyone on the PR will see it.")) return;
    setBusy(true);
    setError(null);
    try {
      await prApi.postFinding(run.id, finding.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`pr-finding ${isChecked ? "checked" : ""}`}>
      <div className="pr-finding-row" onClick={onToggle}>
        <input
          type="checkbox"
          checked={isChecked}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => prApi.checkFinding(run.id, finding.id, e.target.checked).catch(() => {})}
          title={isChecked ? "Handled — untick to bring it back" : "Mark as handled"}
        />
        <span className={`pr-badge ${sev.cls}`}>{finding.severity}</span>
        {finding.isNew && <span className="pr-badge accent">New</span>}
        {moved && (
          <span className={`pr-badge ${up ? "warn" : ""}`}>
            {up ? "↑" : "↓"} from {finding.previousSeverity}
          </span>
        )}
        <span className="pr-finding-title">
          {finding.title}
          {finding.file && (
            <span className="pr-finding-where">
              {finding.file}
              {finding.line ? `:${finding.line}` : ""}
            </span>
          )}
        </span>
        {posted && <span className={`pr-badge ${posted.kind === "draft" ? "pending" : "ok"}`}>{posted.kind === "draft" ? "in review" : "commented"}</span>}
      </div>
      {expanded && (
        <div className={`pr-finding-body sev-${finding.severity}`}>
          {finding.change && <div className="pr-finding-change">Changed in discussion: {finding.change}</div>}
          {finding.background && (
            <div className="pr-finding-section">
              <div className="pr-finding-label">Background</div>
              <Markdown text={finding.background} />
            </div>
          )}
          <div className="pr-finding-section">
            {finding.background && <div className="pr-finding-label">The problem</div>}
            <Markdown text={finding.body} />
          </div>
          {finding.suggestion && (
            <div className="pr-finding-section suggestion">
              <div className="pr-finding-label">Suggestion</div>
              <Markdown text={finding.suggestion} />
            </div>
          )}
          <div className="pr-finding-foot">
            {posted ? (
              posted.kind === "draft" ? (
                <span className="pr-finding-status">
                  <span className="pr-badge pending">in review</span>
                  Pending on {finding.file}:{finding.line}. It goes out when you submit the review in Files changed.
                </span>
              ) : (
                <span className="pr-finding-status">
                  <span className="pr-badge ok">commented</span>
                  <a href={posted.url} target="_blank" rel="noreferrer" className="link-btn inline">
                    Open the PR comment ↗
                  </a>
                </span>
              )
            ) : target ? (
              <>
                <button className="icon-btn primary" disabled={busy} onClick={() => void post()}>
                  <CommentIcon />
                  {target.mode === "draft" ? "Add to review" : "Post as PR comment"}
                </button>
                <span className="pr-finding-status">
                  {target.mode === "draft"
                    ? `Queues an inline comment on ${finding.file}:${finding.line}. Nothing reaches GitHub until you submit the review.`
                    : `${target.reason}, so it posts straight to the PR conversation.`}
                </span>
              </>
            ) : null}
            <label className="check pr-finding-done" onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" checked={isChecked} onChange={(e) => prApi.checkFinding(run.id, finding.id, e.target.checked).catch(() => {})} />
              <span>{isChecked ? "Handled" : "Mark as handled"}</span>
            </label>
            {error && <span className="pr-error">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function Dropped({ dropped }: { dropped: NonNullable<PrRun["findings"]>["dropped"] }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="pr-findings-group pr-dropped-head" onClick={() => setOpen((o) => !o)}>
        <span className={`diff-caret ${open ? "open" : ""}`} aria-hidden="true" />
        Dropped ({dropped!.length})
      </button>
      {open &&
        dropped!.map((f) => (
          <div key={f.id} className="pr-finding checked">
            <div className="pr-finding-row">
              <span className="pr-finding-title">{f.title}</span>
            </div>
            <div className="pr-finding-body hint">{f.reason}</div>
          </div>
        ))}
    </div>
  );
}
