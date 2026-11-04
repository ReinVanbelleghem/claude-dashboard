import { useEffect, useState } from "react";
import { prApi, settingsApi, type PrCommit, type PrRef, type Settings } from "../../api.ts";
import { DiffView } from "../DiffView.tsx";
import { isTyping, prHash, relativeTime } from "./prState.ts";

/**
 * The PR's commits, oldest first, and the diff each one introduced — the view for
 * following how a change was built up rather than reading its end state. The patch
 * comes from the daemon's local clone when it has one, so it carries the same
 * headers the git panel's diffs do and renders through the same DiffView.
 */
const CONTEXT_STEPS = [3, 10, 30, 100_000];

export function PrCommitsTab({ pr, sha, settings, onSettings }: { pr: PrRef; sha: string | null; settings: Settings | null; onSettings: (s: Settings) => void }) {
  const [commits, setCommits] = useState<PrCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${pr.owner}/${pr.repo}/${pr.number}`;

  useEffect(() => {
    setCommits(null);
    setError(null);
    prApi
      .commits(pr)
      .then((r) => setCommits(r.commits))
      .catch((e: Error) => setError(e.message));
  }, [key]);

  const selected = commits?.find((c) => c.sha === sha || c.short === sha) ?? (sha ? null : (commits?.at(-1) ?? null));

  // The newest commit is the default: the one whose diff you most likely came to see.
  useEffect(() => {
    if (!sha && commits?.length) window.location.replace(prHash(pr, `/commits/${commits.at(-1)!.short}`));
  }, [sha, commits]);

  // j/k walk the list, like the file list does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey || !commits?.length || !selected) return;
      const i = commits.indexOf(selected);
      if (e.key === "j" && i < commits.length - 1) window.location.hash = prHash(pr, `/commits/${commits[i + 1].short}`);
      if (e.key === "k" && i > 0) window.location.hash = prHash(pr, `/commits/${commits[i - 1].short}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commits, selected, key]);

  if (error) return <div className="pr-error">{error}</div>;
  if (!commits) return <div className="empty">Loading commits…</div>;
  if (!commits.length) return <div className="empty">No commits on this pull request.</div>;

  return (
    <div className="pr-commits">
      <aside className="pr-commits-side">
        <div className="pr-side-label">
          {commits.length} commit{commits.length === 1 ? "" : "s"} · oldest first
        </div>
        {commits.map((c) => (
          <a key={c.sha} href={prHash(pr, `/commits/${c.short}`)} className={`pr-commit-row ${selected?.sha === c.sha ? "on" : ""}`} title={c.subject}>
            <div className="pr-commit-row-top">
              <span className="pr-commit-sha">{c.short}</span>
              <span className="pr-commit-subject">{c.subject}</span>
            </div>
            <div className="pr-commit-row-sub">
              {c.authorAvatarUrl && <img src={c.authorAvatarUrl} alt="" className="pr-avatar small" />}
              <span>{c.author}</span>
              {c.date && (
                <span title={new Date(c.date).toLocaleString()}>
                  · {relativeTime(c.date)} ago
                </span>
              )}
            </div>
          </a>
        ))}
      </aside>
      <div className="pr-commit-main">
        {selected ? <CommitView key={selected.sha} pr={pr} commit={selected} settings={settings} onSettings={onSettings} /> : <div className="empty">Unknown commit.</div>}
      </div>
    </div>
  );
}

function CommitView({ pr, commit, settings, onSettings }: { pr: PrRef; commit: PrCommit; settings: Settings | null; onSettings: (s: Settings) => void }) {
  const [patch, setPatch] = useState<string | null>(null);
  const [source, setSource] = useState<"clone" | "github" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const mode = settings?.ui.diffMode ?? "unified";

  useEffect(() => {
    let stale = false;
    setError(null);
    prApi
      .commit(pr, commit.sha, CONTEXT_STEPS[step])
      .then((r) => {
        if (stale) return;
        if (r.ok) {
          setPatch(r.patch);
          setSource(r.source);
        } else setError(r.error ?? "could not load the diff");
      })
      .catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [commit.sha, step]);

  const setMode = (m: "unified" | "split") =>
    settingsApi
      .save({ ui: { diffMode: m } })
      .then((r) => onSettings(r.settings))
      .catch(() => {});

  return (
    <div className="pr-commit">
      <div className="pr-commit-head">
        <div className="pr-commit-title">
          <h2>{commit.subject}</h2>
          {commit.body && <pre className="pr-commit-body">{commit.body}</pre>}
          <div className="pr-commit-meta">
            <span className="chip">{commit.short}</span>
            <span>{commit.author}</span>
            {commit.date && <span title={new Date(commit.date).toLocaleString()}>· {new Date(commit.date).toLocaleString()}</span>}
            <a href={commit.url} target="_blank" rel="noreferrer" className="link-btn inline">
              Open on GitHub ↗
            </a>
            {source === "github" && <span className="hint">· from GitHub: large files may lack a patch</span>}
          </div>
        </div>
        <div className="pr-commit-tools">
          <button
            className="icon-btn tiny"
            disabled={step === CONTEXT_STEPS.length - 1 || patch === null}
            onClick={() => setStep((s) => Math.min(s + 1, CONTEXT_STEPS.length - 1))}
            title="Show more lines around each change"
          >
            {step === CONTEXT_STEPS.length - 1 ? "whole files" : "more context"}
          </button>
          <div className="seg">
            <button className={mode === "unified" ? "active" : ""} onClick={() => setMode("unified")}>
              Unified
            </button>
            <button className={mode === "split" ? "active" : ""} onClick={() => setMode("split")}>
              Split
            </button>
          </div>
        </div>
      </div>
      {error ? <div className="pr-error">{error}</div> : patch === null ? <div className="empty">Loading diff…</div> : <DiffView patch={patch} mode={mode} emptyLabel="This commit changed nothing textual." />}
    </div>
  );
}
