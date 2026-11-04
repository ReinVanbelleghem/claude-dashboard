import { prApi, type PrRef, type PrWatch, type PrWatchChange } from "../../api.ts";
import { BellIcon, CheckIcon, CommentIcon, GitIcon, XIcon } from "../Icons.tsx";
import { CiDot } from "./PrBadges.tsx";
import { relativeTime } from "./prState.ts";

/**
 * The pieces of PR watch the table row and the PR page share: the bell that
 * toggles it, the chips that sum up what is unseen, and the strip that lists it.
 */
export function WatchToggle({ pr, watched, compact = false }: { pr: PrRef; watched: boolean; compact?: boolean }) {
  const toggle = () => void (watched ? prApi.unwatch(pr) : prApi.watch(pr)).catch(() => {});
  return (
    <button
      className={`${compact ? "pr-row-watch" : "icon-btn"} ${watched ? "on" : ""}`}
      title={watched ? "Stop watching this PR (w)" : "Watch this PR for changes (w)"}
      aria-label={watched ? "Unwatch" : "Watch"}
      aria-pressed={watched}
      onClick={(e) => {
        e.stopPropagation();
        toggle();
      }}
    >
      <BellIcon muted={!watched} />
      {!compact && (watched ? "Watching" : "Watch")}
    </button>
  );
}

/** Commits, reviews, comments and the CI verdict as icon-and-count chips, for the row. */
export function ActivityChips({ watch }: { watch: PrWatch }) {
  const changes = watch.unseen;
  if (!changes.length) return null;
  const commits = changes.filter((c) => c.kind === "commit").reduce((n, c) => n + (c.count ?? 1), 0);
  const reviews = changes.filter((c) => c.kind === "review");
  const comments = changes.filter((c) => c.kind === "comment").length;
  const ci = changes.filter((c) => c.kind === "ci").at(-1);
  const flags = changes.filter((c) => c.kind === "conflict" || c.kind === "merged" || c.kind === "closed" || c.kind === "decision");
  const worst = reviews.some((r) => r.state === "CHANGES_REQUESTED") ? "bad" : reviews.some((r) => r.state === "APPROVED") ? "ok" : "";
  return (
    <span className="pr-activity" title={changes.map((c) => c.text).join("\n")}>
      {commits > 0 && (
        <span className="pr-activity-chip">
          <GitIcon /> {commits}
        </span>
      )}
      {reviews.length > 0 && (
        <span className={`pr-activity-chip ${worst}`}>
          <CheckIcon /> {reviews.length}
        </span>
      )}
      {comments > 0 && (
        <span className="pr-activity-chip">
          <CommentIcon /> {comments}
        </span>
      )}
      {ci && (
        <span className="pr-activity-chip">
          <CiDot state={ci.state as PrWatch["ciState"]} /> CI
        </span>
      )}
      {flags.map((f, i) => (
        <span key={i} className={`pr-activity-chip ${f.kind === "conflict" || f.kind === "closed" ? "bad" : f.kind === "merged" ? "accent" : ""}`}>
          {f.kind === "decision" ? f.text : f.kind}
        </span>
      ))}
    </span>
  );
}

const KIND_LABEL: Record<PrWatchChange["kind"], string> = {
  commit: "Commit",
  review: "Review",
  comment: "Comment",
  decision: "Decision",
  ci: "CI",
  conflict: "Conflict",
  merged: "Merged",
  closed: "Closed",
};

/** "Since you last looked": every unseen change with a link to it, newest last. */
export function SinceStrip({ changes, onDismiss }: { changes: PrWatchChange[]; onDismiss: () => void }) {
  if (!changes.length) return null;
  return (
    <div className="pr-since" role="status">
      <div className="pr-since-head">
        <BellIcon />
        <strong>Since you last looked</strong>
        <span className="pr-since-count">
          {changes.length} change{changes.length === 1 ? "" : "s"}
        </span>
        <button className="pr-since-x" onClick={onDismiss} aria-label="Dismiss">
          <XIcon />
        </button>
      </div>
      <ul className="pr-since-list">
        {changes.map((c, i) => (
          <li key={i} className={`pr-since-item ${c.kind}`}>
            <span className={`pr-badge ${badgeTone(c)}`}>{KIND_LABEL[c.kind]}</span>
            {c.url ? (
              <a href={c.url} target="_blank" rel="noreferrer">
                {c.text}
              </a>
            ) : (
              <span>{c.text}</span>
            )}
            <span className="pr-since-when">{relativeTime(c.at)} ago</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function badgeTone(c: PrWatchChange): string {
  if (c.kind === "conflict" || c.kind === "closed") return "bad";
  if (c.kind === "merged") return "accent";
  if (c.kind === "ci") return c.state === "SUCCESS" ? "ok" : "bad";
  if (c.kind === "review" || c.kind === "decision") return c.state === "APPROVED" ? "ok" : c.state === "CHANGES_REQUESTED" ? "bad" : "pending";
  return "";
}
