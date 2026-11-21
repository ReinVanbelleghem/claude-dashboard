import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { gitApi, prParam, type StackLayer, type WorkspaceStack } from "../api.ts";
import { DiffIcon, ExternalIcon, GitIcon, PullRequestIcon, RefreshIcon, WorktreeIcon } from "./Icons.tsx";
import { CiDot, DraftBadge, ReviewBadge, StateBadge } from "./pr/PrBadges.tsx";

/**
 * The stack a checkout's branch belongs to. Read again when the checkout's head
 * moves, since a commit or a switch changes what every layer is compared with.
 */
const lastStack = new Map<string, WorkspaceStack>();

export function useStack(cwd: string, headKey: string | null) {
  const [stack, setStack] = useState<WorkspaceStack | null>(() => lastStack.get(cwd) ?? null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const load = useCallback(
    (refresh: boolean) => {
      const mine = ++seq.current;
      setLoading(true);
      gitApi
        .stack(cwd, refresh)
        .then((s) => {
          lastStack.set(cwd, s);
          if (mine === seq.current) setStack(s);
        })
        .catch(() => mine === seq.current && setStack(null))
        .finally(() => mine === seq.current && setLoading(false));
    },
    [cwd],
  );
  useEffect(() => {
    if (!headKey) return setStack(null);
    setStack(lastStack.get(cwd) ?? null);
    load(false);
  }, [headKey, load]);
  return { stack, loading, refresh: () => load(true) };
}

const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

function LayerRow({
  layer,
  position,
  shown,
  onShow,
  onOpenCheckout,
  onSwitch,
}: {
  layer: StackLayer;
  position: number;
  shown: boolean;
  onShow: () => void;
  onOpenCheckout?: (path: string) => void;
  onSwitch?: (layer: StackLayer) => Promise<string | null>;
}) {
  const pr = layer.pr;
  const [switching, setSwitching] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const elsewhere = !!layer.checkout && !layer.current;
  const go = async () => {
    if (!onSwitch) return;
    setSwitching(true);
    setRefused(null);
    const error = await onSwitch(layer).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    setRefused(error);
    setSwitching(false);
  };
  return (
    <li className={`stack-layer${layer.current ? " current" : ""}${shown ? " shown" : ""}`}>
      <span className="stack-rail" aria-hidden="true">
        <i>{position}</i>
      </span>
      <div className="stack-body">
        <div className="stack-line">
          {pr ? (
            <a className="stack-title" href={`#/pr/${prParam(pr)}`} title="Open this pull request">
              <PullRequestIcon />
              <span className="stack-number">#{pr.number}</span>
              {pr.title}
            </a>
          ) : (
            <span className="stack-title none">
              <GitIcon />
              No pull request yet
            </span>
          )}
          {layer.current && <span className="pr-badge accent">you are here</span>}
        </div>
        <div className="stack-meta">
          <code className="stack-branch" title={`${layer.branch} builds on ${layer.baseBranch || "nothing known"}`}>
            {layer.branch}
          </code>
          {pr && pr.state !== "OPEN" && <StateBadge state={pr.state} />}
          {pr && <DraftBadge isDraft={pr.isDraft} />}
          {pr && <ReviewBadge decision={pr.reviewDecision} />}
          {pr && <CiDot state={pr.ciState} withLabel />}
          {layer.ref ? (
            <span className="stack-count">
              {layer.commits} commit{layer.commits === 1 ? "" : "s"}
            </span>
          ) : (
            <span className="stack-count muted">not fetched here</span>
          )}
          {pr && pr.additions > 0 && <span className="tok-add">+{pr.additions}</span>}
          {pr && pr.deletions > 0 && <span className="tok-del">−{pr.deletions}</span>}
          {layer.needsRebase && (
            <span className="pr-badge pending" title={`${layer.baseBranch} has commits this branch was not cut from`}>
              needs rebase
            </span>
          )}
          {layer.checkout && !layer.current && (
            <button className="stack-checkout" title={`Checked out at ${layer.checkout}`} onClick={() => onOpenCheckout?.(layer.checkout!)}>
              <WorktreeIcon />
              {home(layer.checkout)}
            </button>
          )}
        </div>
        {refused && <p className="stack-refused">{refused}</p>}
      </div>
      <span className="stack-actions">
        {onSwitch && !layer.current && (
          <button
            className="icon-btn"
            disabled={switching || elsewhere}
            onClick={() => void go()}
            title={
              elsewhere
                ? `${layer.branch} is checked out in ${home(layer.checkout!)}, and a branch can only be out in one place`
                : `Switch this checkout to ${layer.branch}. Uncommitted work is kept or the switch is refused; running services and sessions here see the files change.`
            }
          >
            <GitIcon />
            {switching ? "Switching…" : "Switch here"}
          </button>
        )}
        <button className="icon-btn" disabled={!layer.ref || !layer.baseRef} onClick={onShow} title={`What ${layer.branch} adds on top of ${layer.baseBranch}`}>
          <DiffIcon />
          {shown ? "Showing" : "Changes"}
        </button>
        {pr && (
          <a className="icon-btn square" href={pr.url} target="_blank" rel="noreferrer" title="Open on GitHub" aria-label="Open on GitHub">
            <ExternalIcon />
          </a>
        )}
      </span>
    </li>
  );
}

/** Switch a checkout to a layer's branch through the daemon; git's own message comes back when it refuses. */
export async function switchToLayer(cwd: string, layer: StackLayer): Promise<string | null> {
  const r = await gitApi.checkout(cwd, layer.branch);
  return r.ok ? null : [r.error, r.hint].filter(Boolean).join(" — ") || "git refused the switch";
}

/** A workspace's stack, top layer first, down to trunk. */
export function StackPanel({
  stack,
  loading,
  shownBranch,
  onRefresh,
  onShowLayer,
  onOpenCheckout,
  onSwitch,
  title = "Stack",
  embedded = false,
}: {
  /** Drawn inside another card: no frame and no heading of its own. */
  embedded?: boolean;
  /** Put the checkout on another layer's branch. Resolves to git's refusal, or null when it switched. */
  onSwitch?: (layer: StackLayer) => Promise<string | null>;
  /** What the panel is headed with; a linked workspace's stack names its project here. */
  title?: ReactNode;
  stack: WorkspaceStack | null;
  loading: boolean;
  /** The layer whose changes the page is showing. */
  shownBranch: string | null;
  onRefresh: () => void;
  onShowLayer: (layer: StackLayer) => void;
  onOpenCheckout?: (path: string) => void;
}) {
  const layers = stack?.layers ?? [];
  return (
    <section className={embedded ? "stack-panel embedded" : "panel stack-panel"}>
      {!embedded && (
        <header className="stack-head">
          <h2>
            {title}
            {layers.length > 1 && <em>{layers.length} layers</em>}
          </h2>
          {stack?.repo && (
            <span className="stack-repo">
              {stack.repo.owner}/{stack.repo.repo}
            </span>
          )}
          <button className="icon-btn square" onClick={onRefresh} disabled={loading} title="Read the pull requests again" aria-label="Refresh the stack">
            <RefreshIcon />
          </button>
        </header>
      )}
      {stack?.error && <p className="stack-error">The pull requests could not be read: {stack.error}</p>}
      {!stack && loading && <p className="hint">Reading the stack…</p>}
      {stack && layers.length === 0 && <p className="hint">This checkout is on {stack.trunk ?? "its base branch"}, so there is no stack to show.</p>}
      {layers.length > 0 && (
        <ol className="stack-list">
          {[...layers].reverse().map((layer, i) => (
            <LayerRow
              key={layer.branch}
              layer={layer}
              position={layers.length - i}
              shown={shownBranch === layer.branch}
              onShow={() => onShowLayer(layer)}
              onOpenCheckout={onOpenCheckout}
              onSwitch={onSwitch}
            />
          ))}
          <li className="stack-trunk">
            <span className="stack-rail" aria-hidden="true">
              <i />
            </span>
            <code>{stack?.trunk ?? layers[0]!.baseBranch}</code>
          </li>
        </ol>
      )}
    </section>
  );
}
