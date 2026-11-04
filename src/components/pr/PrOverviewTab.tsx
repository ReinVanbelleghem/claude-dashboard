import { useEffect, useMemo, useState } from "react";
import { prApi, type Person, type PrCheck, type PrInlineComment, type PrOverview, type PrRef, type PrReviewer, type PrTimelineItem, type ThreadReply } from "../../api.ts";
import { Markdown } from "../Markdown.tsx";
import { CommentEditor, EditableComment, HunkSnippet, commentTime } from "./PrComments.tsx";
import { prHash } from "./prState.ts";

/**
 * The conversation page: the description, then every top-level comment and review
 * in order, with the facts GitHub keeps in its sidebar — who was asked to review and
 * what they said, assignees, labels, milestone, checks, and whether it merges clean.
 */
const REVIEW_STATE: Record<NonNullable<PrTimelineItem["state"]>, { label: string; cls: string }> = {
  APPROVED: { label: "approved", cls: "ok" },
  CHANGES_REQUESTED: { label: "requested changes", cls: "bad" },
  COMMENTED: { label: "reviewed", cls: "" },
  DISMISSED: { label: "review dismissed", cls: "" },
};

const REVIEWER_DOT: Record<PrReviewer["state"], { cls: string; title: string }> = {
  APPROVED: { cls: "ok", title: "Approved" },
  CHANGES_REQUESTED: { cls: "bad", title: "Requested changes" },
  COMMENTED: { cls: "", title: "Commented" },
  DISMISSED: { cls: "", title: "Review dismissed" },
  PENDING: { cls: "wait", title: "Review requested, no answer yet" },
};

const CHECK_DOT: Record<PrCheck["status"], string> = { success: "ok", failure: "bad", pending: "wait", neutral: "", skipped: "" };

/** GitHub task lists, which the dashboard's markdown does not know, as ticked and empty boxes. */
const taskLists = (md: string) => md.replace(/^(\s*[-*]\s+)\[([ xX])\]\s+/gm, (_, bullet: string, mark: string) => `${bullet}${mark === " " ? "☐" : "☑"} `);

function InlineComment({ pr, c, viewer, onSaved, onDeleted }: { pr: PrRef; c: PrInlineComment; viewer: string | null; onSaved: (body: string) => void; onDeleted: () => void }) {
  return (
    <div className="pr-inline-comment">
      {c.authorAvatarUrl ? <img src={c.authorAvatarUrl} alt="" className="pr-avatar" /> : <span className="pr-avatar blank" />}
      <EditableComment
        pr={pr}
        id={c.id}
        kind="review"
        body={c.body}
        mine={c.author === viewer}
        format={taskLists}
        bodyClass="pr-inline-body"
        meta={
          <>
            <span className="pr-comment-author">{c.author}</span>{" "}
            <a href={c.url} target="_blank" rel="noreferrer" title={new Date(c.createdAt).toLocaleString()}>
              {commentTime(c.createdAt)}
            </a>
          </>
        }
        onSaved={onSaved}
        onDeleted={onDeleted}
      />
    </div>
  );
}

type InlineThread = { root: PrInlineComment; replies: PrInlineComment[] };

const groupThreads = (inline: PrInlineComment[]): InlineThread[] => {
  const threads: InlineThread[] = [];
  const byRoot = new Map<string, InlineThread>();
  for (const c of inline) {
    const parent = c.inReplyTo ? byRoot.get(c.inReplyTo) : undefined;
    if (parent) {
      parent.replies.push(c);
      byRoot.set(c.id, parent);
    } else {
      const t = { root: c, replies: [] };
      threads.push(t);
      byRoot.set(c.id, t);
    }
  }
  return threads;
};

function InlineThreadView({
  pr,
  thread,
  viewer,
  onChanged,
  onReplied,
  onEdited,
}: {
  pr: PrRef;
  thread: InlineThread;
  viewer: string | null;
  onChanged: () => Promise<void>;
  onReplied: (reply: ThreadReply) => void;
  onEdited: (commentId: string, body: string) => void;
}) {
  const { root, replies } = thread;
  const [collapsed, setCollapsed] = useState(root.resolved);
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadId = root.threadId;
  const count = replies.length + 1;

  const resolve = async () => {
    if (!threadId) return;
    setBusy(true);
    setError(null);
    try {
      await prApi.resolve(pr, threadId, !root.resolved);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`pr-inline-thread ${root.resolved ? "resolved" : ""}`}>
      <div
        className="pr-inline-head clickable"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setCollapsed((c) => !c);
          }
        }}
      >
        <a href={prHash(pr, "/files")} className="link-btn inline pr-thread-where" title={`${root.path} — open in Files changed`} onClick={(e) => e.stopPropagation()}>
          {root.path.split("/").pop()}
          {root.line != null && `:${root.line}`}
        </a>
        {root.resolved && <span className="pr-badge ok">Resolved</span>}
        {collapsed && (
          <span className="pr-thread-peek">
            {root.author}: {root.body.replace(/\s+/g, " ").slice(0, 80)}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {collapsed && <span className="hint">{count} comment{count === 1 ? "" : "s"}</span>}
        <span className={`pr-chevron ${collapsed ? "" : "open"}`} aria-hidden="true" />
      </div>
      {!collapsed && (
        <>
          {root.diffHunk && <HunkSnippet hunk={root.diffHunk} rangeLines={1} maxLines={3} />}
          <div className="pr-inline-comments">
            {[root, ...replies].map((c) => (
              <InlineComment key={c.id} pr={pr} c={c} viewer={viewer} onSaved={(body) => onEdited(c.id, body)} onDeleted={() => void onChanged()} />
            ))}
          </div>
          {error && <div className="pr-error">{error}</div>}
          {threadId && (
            <div className="pr-inline-foot">
              {replying ? (
                <CommentEditor
                  submitLabel="Reply"
                  placeholder="Reply"
                  onCancel={() => setReplying(false)}
                  onSubmit={async (body) => {
                    const { comment } = await prApi.reply(pr, threadId, body);
                    onReplied(comment);
                    setReplying(false);
                    void onChanged();
                  }}
                />
              ) : (
                <>
                  <button className="link-btn inline" onClick={() => setReplying(true)}>
                    Reply
                  </button>
                  <button className="link-btn inline" disabled={busy} onClick={() => void resolve()}>
                    {root.resolved ? "Unresolve" : "Resolve"}
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TimelineEntry({
  pr,
  item,
  viewer,
  onChanged,
  onReplied,
  onEdited,
}: {
  pr: PrRef;
  item: PrTimelineItem;
  viewer: string | null;
  onChanged: () => Promise<void>;
  onReplied: (root: PrInlineComment, reply: ThreadReply) => void;
  onEdited: (commentId: string, body: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const inline = item.inline ?? [];
  const state = item.kind === "review" ? REVIEW_STATE[item.state ?? "COMMENTED"] : null;
  const expandable = inline.length > 0;
  // The whole bar toggles when there is something to open; the time link still opens GitHub.
  if (item.kind === "comment") {
    return (
      <article className="pr-post pr-comment-post">
        <div className="pr-comment">
          {item.authorAvatarUrl ? <img src={item.authorAvatarUrl} alt="" className="pr-avatar" /> : <span className="pr-avatar blank" />}
          <EditableComment
            pr={pr}
            id={item.id}
            kind="issue"
            body={item.body}
            mine={item.author === viewer}
            format={taskLists}
            bodyClass="pr-post-body"
            meta={
              <>
                <span className="pr-comment-author">{item.author}</span>{" "}
                <a href={item.url} target="_blank" rel="noreferrer" title={new Date(item.createdAt).toLocaleString()}>
                  {commentTime(item.createdAt)}
                </a>
              </>
            }
            onSaved={(body) => onEdited(item.id, body)}
            onDeleted={() => void onChanged()}
          />
        </div>
      </article>
    );
  }
  return (
    <article className={`pr-post ${state ? `pr-review-post ${state.cls}` : ""}`}>
      <header
        className={`pr-post-head ${expandable ? "clickable" : ""}`}
        role={expandable ? "button" : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={expandable ? () => setOpen((o) => !o) : undefined}
        onKeyDown={
          expandable
            ? (e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpen((o) => !o);
                }
              }
            : undefined
        }
      >
        {item.authorAvatarUrl ? <img src={item.authorAvatarUrl} alt="" className="pr-avatar" /> : <span className="pr-avatar blank" />}
        <span className="pr-comment-author">{item.author}</span>
        {state && <span className={`pr-badge ${state.cls}`}>{state.label}</span>}
        {expandable && (
          <span className="pr-badge">
            {inline.length} inline comment{inline.length === 1 ? "" : "s"}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <a href={item.url} target="_blank" rel="noreferrer" className="hint" title={new Date(item.createdAt).toLocaleString()} onClick={(e) => e.stopPropagation()}>
          {commentTime(item.createdAt)}
        </a>
        {expandable && <span className={`pr-chevron ${open ? "open" : ""}`} aria-hidden="true" />}
      </header>
      {item.body.trim() && (
        <div className="pr-post-body">
          <Markdown text={taskLists(item.body)} />
        </div>
      )}
      {open && inline.length > 0 && (
        <div className="pr-inline-list">
          {groupThreads(inline).map((t) => (
            <InlineThreadView key={t.root.id} pr={pr} thread={t} viewer={viewer} onChanged={onChanged} onReplied={(reply) => onReplied(t.root, reply)} onEdited={onEdited} />
          ))}
        </div>
      )}
    </article>
  );
}

function ReviewersSection({ pr, data, onChanged }: { pr: PrRef; data: PrOverview; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const approvals = data.reviewers.filter((r) => r.state === "APPROVED").length;
  const detail = data.pr;

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const request = (r: PrReviewer) => run(r.login, () => (r.isTeam ? prApi.requestReviewers(pr, [], [r.login.split("/")[1]]) : prApi.requestReviewers(pr, [r.login])));
  const remove = (r: PrReviewer) => run(r.login, () => (r.isTeam ? prApi.removeReviewers(pr, [], [r.login.split("/")[1]]) : prApi.removeReviewers(pr, [r.login])));

  return (
    <section>
      <h3>Reviewers</h3>
      {data.reviewers.length === 0 && <div className="hint">No reviews requested.</div>}
      {data.reviewers.map((r) => (
        <div key={r.login} className="pr-side-person" title={REVIEWER_DOT[r.state].title}>
          {r.avatarUrl ? <img src={r.avatarUrl} alt="" className="pr-avatar small" /> : <span className="pr-avatar small blank" />}
          <span className="pr-side-name">{r.isTeam ? `team ${r.login}` : r.login}</span>
          <span className="pr-side-tools">
            {r.state === "PENDING" ? (
              <button className="link-btn inline" disabled={busy === r.login} title="Withdraw the review request" onClick={() => void remove(r)}>
                remove
              </button>
            ) : (
              <button className="link-btn inline" disabled={busy === r.login} title="Ask for another look" onClick={() => void request(r)}>
                re-request
              </button>
            )}
          </span>
          <span className={`pr-ci ${REVIEWER_DOT[r.state].cls}`}>
            <i />
          </span>
        </div>
      ))}
      <AddReviewer
        pr={pr}
        exclude={[detail.author, data.viewer ?? "", ...data.reviewers.map((r) => r.login)]}
        busy={busy === "add"}
        onAdd={(login) => run("add", () => prApi.requestReviewers(pr, [login]))}
      />
      {error && <div className="pr-error">{error}</div>}
      <div className="hint pr-side-note">
        {detail.reviewDecision === "APPROVED"
          ? `Approved${approvals ? ` by ${approvals}` : ""}.`
          : detail.reviewDecision === "CHANGES_REQUESTED"
            ? "Changes were requested."
            : "At least one approving review is required to merge."}
      </div>
    </section>
  );
}

function AddReviewer({ pr, exclude, busy, onAdd }: { pr: PrRef; exclude: string[]; busy: boolean; onAdd: (login: string) => void }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const repo = `${pr.owner}/${pr.repo}`;
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      prApi
        .people(text, [repo])
        .then((r) => setPeople(r.people))
        .catch(() => setPeople([]));
    }, 150);
    return () => clearTimeout(t);
  }, [text, open, repo]);
  const options = useMemo(() => people.filter((p) => !exclude.includes(p.login)).slice(0, 8), [people, exclude]);
  const add = (login: string) => {
    setText("");
    setOpen(false);
    onAdd(login);
  };
  return (
    <div className="pr-add-reviewer">
      <input
        value={text}
        placeholder={busy ? "Requesting…" : "Request a reviewer…"}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && options[0]) add(options[0].login);
          if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && options.length > 0 && (
        <div className="pr-menu pr-add-reviewer-menu">
          {options.map((p) => (
            <button key={p.login} className="pr-menu-item" onMouseDown={() => add(p.login)}>
              {p.avatarUrl ? <img src={p.avatarUrl} alt="" /> : <span className="pr-avatar-blank" />}
              <span>{p.name ?? p.login}</span>
              {p.name && <span className="pr-menu-hint">{p.login}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function PrOverviewTab({ pr }: { pr: PrRef }) {
  const [data, setData] = useState<PrOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const key = `${pr.owner}/${pr.repo}/${pr.number}`;

  const load = () =>
    prApi
      .overview(pr)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    setData(null);
    setError(null);
    load();
  }, [key]);

  const addReply = (itemId: string, root: PrInlineComment, reply: ThreadReply) =>
    setData((d) => {
      if (!d) return d;
      const comment: PrInlineComment = {
        ...reply,
        path: root.path,
        line: root.line,
        diffHunk: null,
        inReplyTo: root.id,
        threadId: null,
        resolved: false,
      };
      return {
        ...d,
        timeline: d.timeline.map((item) => {
          if (item.id !== itemId || !item.inline) return item;
          const inline = [...item.inline];
          const members = new Set([root.id]);
          let last = -1;
          inline.forEach((c, i) => {
            if (c.id === root.id || (c.inReplyTo && members.has(c.inReplyTo))) {
              members.add(c.id);
              last = i;
            }
          });
          inline.splice(last + 1, 0, comment);
          return { ...item, inline, inlineComments: inline.length };
        }),
      };
    });

  const editComment = (commentId: string, body: string) =>
    setData((d) =>
      d
        ? {
            ...d,
            timeline: d.timeline.map((item) =>
              item.id === commentId ? { ...item, body } : item.inline ? { ...item, inline: item.inline.map((c) => (c.id === commentId ? { ...c, body } : c)) } : item,
            ),
          }
        : d,
    );

  if (error) return <div className="pr-error">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;

  const { pr: detail, timeline, checks } = data;
  const failing = checks.filter((c) => c.status === "failure").length;
  const pending = checks.filter((c) => c.status === "pending").length;

  return (
    <div className="pr-overview">
      <div className="pr-overview-main">
        <div className="pr-timeline">
          <article className="pr-post pr-description">
            <header className="pr-post-head">
              {detail.authorAvatarUrl && <img src={detail.authorAvatarUrl} alt="" className="pr-avatar" />}
              <span className="pr-comment-author">{detail.author}</span>
              <span className="hint">
                opened{" "}
                <span title={new Date(detail.createdAt).toLocaleString()}>{commentTime(detail.createdAt)}</span>
                {" · "}
                wants to merge{" "}
                <a href={prHash(pr, "/commits")} className="link-btn inline">
                  {data.commits} commit{data.commits === 1 ? "" : "s"}
                </a>{" "}
                into <span className="chip">{detail.baseRefName}</span> from <span className="chip">{detail.headRefName}</span>
              </span>
            </header>
            <div className="pr-post-body">{detail.body.trim() ? <Markdown text={taskLists(detail.body)} /> : <span className="hint">No description.</span>}</div>
          </article>

          {timeline.map((item) => (
            <TimelineEntry
              key={item.id}
              pr={pr}
              item={item}
              viewer={data.viewer}
              onChanged={load}
              onReplied={(root, reply) => addReply(item.id, root, reply)}
              onEdited={editComment}
            />
          ))}

          {composing ? (
            <CommentEditor
              submitLabel="Comment"
              placeholder="Leave a comment on the pull request"
              onCancel={() => setComposing(false)}
              onSubmit={async (body) => {
                await prApi.comment(pr, body);
                setComposing(false);
                await load();
              }}
            />
          ) : (
            <button className="pr-reply-btn" onClick={() => setComposing(true)}>
              Leave a comment…
            </button>
          )}
        </div>
      </div>

      <aside className="pr-overview-side">
        <ReviewersSection pr={pr} data={data} onChanged={load} />
        <section>
          <h3>Assignees</h3>
          {data.assignees.length === 0 && <div className="hint">No one.</div>}
          {data.assignees.map((a) => (
            <div key={a.login} className="pr-side-person">
              <img src={a.avatarUrl} alt="" className="pr-avatar small" />
              <span className="pr-side-name">{a.login}</span>
            </div>
          ))}
        </section>
        <section>
          <h3>Labels</h3>
          {detail.labels.length === 0 && <div className="hint">None yet.</div>}
          <div className="pr-row-labels pr-side-labels">
            {detail.labels.map((l) => (
              <span key={l.name} className="pr-label" style={{ borderColor: `#${l.color}99`, color: `#${l.color}` }}>
                {l.name}
              </span>
            ))}
          </div>
        </section>
        <section>
          <h3>Milestone</h3>
          <div className={data.milestone ? "" : "hint"}>{data.milestone ?? "No milestone."}</div>
        </section>
        <section>
          <h3>
            Checks
            {checks.length > 0 && (
              <span className="hint">
                {" "}
                · {failing ? `${failing} failing` : pending ? `${pending} running` : "all passing"}
              </span>
            )}
          </h3>
          {checks.length === 0 && <div className="hint">No checks reported.</div>}
          {checks.map((c) => (
            <div key={c.name} className="pr-side-check" title={c.detail ?? c.name}>
              <span className={`pr-ci ${CHECK_DOT[c.status]}`}>
                <i />
              </span>
              {c.url ? (
                <a href={c.url} target="_blank" rel="noreferrer" className="pr-side-check-name">
                  {c.name}
                </a>
              ) : (
                <span className="pr-side-check-name">{c.name}</span>
              )}
            </div>
          ))}
        </section>
        <section>
          <h3>Merge</h3>
          <div className={data.mergeable === "CONFLICTING" ? "pr-error" : "hint"}>
            {data.mergeable === "MERGEABLE" ? "No conflicts with the base branch." : data.mergeable === "CONFLICTING" ? "Conflicts with the base branch." : "GitHub is still computing mergeability."}
          </div>
        </section>
      </aside>
    </div>
  );
}
