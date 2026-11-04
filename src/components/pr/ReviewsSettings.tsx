import { useEffect, useState, useRef } from "react";
import { prApi, type ReviewAction, type ReviewPermissionMode, type Settings, type SettingsPatch } from "../../api.ts";
import { MODE_HELP, MODE_LABEL, MODES } from "../Conversation.tsx";
import { TrashIcon, GripIcon } from "../Icons.tsx";
import { useSortable } from "../../useSortable.ts";
import { FolderField } from "../FolderPicker.tsx";
import { Select } from "../Select.tsx";
import { usePrWatches } from "./prState.ts";

/**
 * Settings → Reviews: which repositories to search, the actions that start review
 * sessions, the explain model, where PR checkouts live, and which PRs are watched.
 */
const VARS = ["pr_url", "pr_number", "owner", "repo", "title", "head_ref", "base_ref", "head_sha", "base_sha", "author", "body"];
/** The session composer's own list, so an action starts in any mode a session can run in. */
const MODE_OPTIONS = MODES.map((m) => ({ value: m, label: MODE_LABEL[m] ?? m, hint: MODE_HELP[m] }));

const blank = (): ReviewAction => ({
  id: `action-${Date.now().toString(36)}`,
  name: "",
  promptTemplate: "",
  allowedTools: [],
  permissionMode: "default",
  model: "",
  checkout: "head",
  structuredFindings: false,
});

export function ReviewsSettings({ settings, save, models }: { settings: Settings; save: (p: SettingsPatch) => void; models: { value: string; label: string }[] }) {
  const r = settings.reviews;
  const [status, setStatus] = useState<{ ok: boolean; login: string | null; error?: string } | null>(null);
  const [repoDraft, setRepoDraft] = useState("");
  const [selected, setSelected] = useState<string | null>(r.actions[0]?.id ?? null);
  const [draft, setDraft] = useState<ReviewAction | null>(null);
  const [tools, setTools] = useState("");
  const { watches } = usePrWatches();

  useEffect(() => {
    prApi.status().then(setStatus).catch(() => setStatus({ ok: false, login: null }));
  }, []);

  useEffect(() => {
    const a = selected === "new" ? blank() : (r.actions.find((x) => x.id === selected) ?? null);
    setDraft(a);
    setTools(a?.allowedTools.join("\n") ?? "");
  }, [selected, r.actions]);

  const saveActions = (actions: ReviewAction[]) => save({ reviews: { actions } });
  const actionsRef = useRef<HTMLUListElement>(null);
  const drag = useSortable({
    count: r.actions.length,
    listRef: actionsRef,
    itemSelector: ".pr-actions-item",
    onMove: (from, to) => {
      const next = [...r.actions];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      saveActions(next);
    },
  });

  const commit = () => {
    if (!draft || !draft.name.trim() || !draft.promptTemplate.trim()) return;
    const clean: ReviewAction = { ...draft, name: draft.name.trim(), allowedTools: tools.split("\n").map((t) => t.trim()).filter(Boolean), model: draft.model.trim() };
    const exists = r.actions.some((a) => a.id === clean.id);
    saveActions(exists ? r.actions.map((a) => (a.id === clean.id ? clean : a)) : [...r.actions, clean]);
    setSelected(clean.id);
  };

  return (
    <>
      <div className="panel">
        <h2>GitHub</h2>
        <p className="hint">
          The daemon uses the token the <code>gh</code> CLI holds. Nothing else is stored.
          {status === null ? " Checking…" : status.ok ? ` Signed in as ${status.login}.` : ` Not signed in: ${status.error ?? "run gh auth login"}.`}
        </p>
        {status && !status.ok && (
          <button className="icon-btn tiny" onClick={() => prApi.reset().then(() => prApi.status().then(setStatus))}>
            Check again
          </button>
        )}
        <h3 className="set-h">Repositories</h3>
        <p className="set-help">Searched by every view that names no repository of its own, as owner/name.</p>
        <div className="chip-row" style={{ marginBottom: 10 }}>
          {r.repos.map((repo) => (
            <span key={repo} className="chip">
              {repo}{" "}
              <button className="pr-chip-x" onClick={() => save({ reviews: { repos: r.repos.filter((x) => x !== repo) } })} aria-label={`Remove ${repo}`}>
                ✕
              </button>
            </span>
          ))}
          {r.repos.length === 0 && <span className="set-help">None yet.</span>}
        </div>
        <div className="inline-add-row">
          <label className="field">
            <span>Add a repository</span>
            <input
              className="search"
              spellCheck={false}
              placeholder="owner/name"
              value={repoDraft}
              onChange={(e) => setRepoDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const v = repoDraft.trim();
                if (/^[\w.-]+\/[\w.-]+$/.test(v) && !r.repos.includes(v)) {
                  save({ reviews: { repos: [...r.repos, v] } });
                  setRepoDraft("");
                }
              }}
            />
          </label>
          <div className="field inline-add-btn">
            <span aria-hidden="true">&nbsp;</span>
            <button
              className="icon-btn"
              disabled={!/^[\w.-]+\/[\w.-]+$/.test(repoDraft.trim()) || r.repos.includes(repoDraft.trim())}
              onClick={() => {
                save({ reviews: { repos: [...r.repos, repoDraft.trim()] } });
                setRepoDraft("");
              }}
            >
              Add
            </button>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Actions</h2>
        <p className="hint">Each action is a button on a PR that starts a session in a checkout of it with this prompt.</p>
        <div className="pr-actions-edit">
          <ul className="pr-actions-list" ref={actionsRef}>
            {r.actions.map((a, i) => (
              <li
                key={a.id}
                className={`pr-actions-item ${selected === a.id ? "on" : ""} ${drag.active === i ? "dragging" : ""}`}
                style={drag.itemStyle(i)}
              >
                <button className="sort-grip" data-sort-handle aria-label={`Drag to reorder ${a.name}`} {...drag.handleProps(i)}>
                  <GripIcon />
                </button>
                <button className="pr-actions-name" onClick={() => setSelected(a.id)}>
                  {a.name}
                </button>
              </li>
            ))}
            <li>
              <button className={`icon-btn tiny wide ${selected === "new" ? "on" : ""}`} onClick={() => setSelected("new")}>
                + New action
              </button>
            </li>
          </ul>
          {draft ? (
            <div className="pr-action-form">
              <div className="set-grid">
                <label className="field">
                  <span>Name</span>
                  <input className="search" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </label>
                <label className="field">
                  <span>Checkout</span>
                  <Select
                    value={draft.checkout}
                    onChange={(v) => setDraft({ ...draft, checkout: v as ReviewAction["checkout"] })}
                    options={[
                      { value: "head", label: "PR head", hint: "A worktree of the PR's head commit" },
                      { value: "none", label: "None", hint: "An empty scratch directory" },
                    ]}
                  />
                </label>
              </div>
              <label className="field">
                <span>Prompt</span>
                <textarea className="search pr-mono" rows={8} value={draft.promptTemplate} onChange={(e) => setDraft({ ...draft, promptTemplate: e.target.value })} />
              </label>
              <div className="chip-row" style={{ marginBottom: 12 }}>
                {VARS.map((v) => (
                  <button key={v} type="button" className="chip-btn" onClick={() => setDraft({ ...draft, promptTemplate: `${draft.promptTemplate}{{${v}}}` })}>
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>
              <label className="field">
                <span>Tools allowed without asking (one per line)</span>
                <textarea className="search pr-mono" rows={6} value={tools} onChange={(e) => setTools(e.target.value)} spellCheck={false} />
              </label>
              <div className="set-grid">
                <label className="field">
                  <span>Permission mode</span>
                  <Select value={draft.permissionMode} onChange={(v) => setDraft({ ...draft, permissionMode: v as ReviewPermissionMode })} options={MODE_OPTIONS} />
                </label>
                <label className="field">
                  <span>Model</span>
                  <Select
                    value={draft.model || "default"}
                    onChange={(v) => setDraft({ ...draft, model: v === "default" ? "" : v })}
                    options={[{ value: "default", label: "Dashboard default" }, ...models]}
                  />
                </label>
              </div>
              <label className="set-row">
                <input type="checkbox" checked={draft.structuredFindings} onChange={(e) => setDraft({ ...draft, structuredFindings: e.target.checked })} />
                <span className="set-text">
                  <span className="set-label">Structured findings</span>
                  <span className="set-help">The session answers with a checklist of findings (severity, file, line) instead of prose. Follow-ups update the list.</span>
                </span>
              </label>
              <div className="set-actions">
                <button className="icon-btn primary" disabled={!draft.name.trim() || !draft.promptTemplate.trim()} onClick={commit}>
                  {r.actions.some((a) => a.id === draft.id) ? "Save" : "Create"}
                </button>
                {r.actions.some((a) => a.id === draft.id) && (
                  <button
                    className="icon-btn danger"
                    onClick={() => {
                      if (window.confirm(`Delete “${draft.name}”?`)) {
                        saveActions(r.actions.filter((a) => a.id !== draft.id));
                        setSelected(null);
                      }
                    }}
                  >
                    <TrashIcon /> Delete
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="set-help">Select an action to edit.</div>
          )}
        </div>
      </div>

      <div className="panel">
        <h2>Explain</h2>
        <p className="hint">Highlight code in a PR diff and press ⌘⇧E. Each explanation is a session in a checkout of that commit, with read-only tools.</p>
        <div className="set-grid" style={{ maxWidth: 760 }}>
          <label className="field">
            <span>Permission mode</span>
            <Select
              value={r.explainPermissionMode ?? "default"}
              onChange={(v) => save({ reviews: { explainPermissionMode: v as ReviewPermissionMode } })}
              options={MODE_OPTIONS}
            />
          </label>
          <label className="field">
            <span>Model</span>
            <Select
              value={r.explainModel || "default"}
              onChange={(v) => save({ reviews: { explainModel: v === "default" ? "" : v } })}
              options={[{ value: "default", label: "Dashboard default" }, ...models]}
            />
          </label>
        </div>
        <h2 style={{ marginTop: 22 }}>Checkouts</h2>
        <p className="hint">Disposable clones for review sessions. Your own checkouts are never touched.</p>
        <div className="set-grid">
          <FolderField
            label="Checkout directory"
            value={r.checkoutRoot}
            placeholder="~/.claude-dashboard/pr"
            onChange={(v) => save({ reviews: { checkoutRoot: v } })}
            pickerTitle="Pick the review checkouts folder"
            pickerHint="Disposable clones for review sessions live here and are pruned automatically."
          />
          <label className="field">
            <span>Checkouts to keep</span>
            <input
              className="search"
              type="number"
              min={0}
              max={50}
              defaultValue={r.keepCheckouts}
              onBlur={(e) => {
                const v = Math.max(0, Number(e.target.value) || 0);
                if (v !== r.keepCheckouts) save({ reviews: { keepCheckouts: v } });
              }}
            />
            <span className="set-help">Older checkouts no session is using are removed when a new one is made.</span>
          </label>
        </div>
      </div>

      <div className="panel">
        <h2>Watching</h2>
        <p className="hint">
          The daemon polls each watched PR and tells you about new commits, reviews, comments, CI verdicts, conflicts, merges and closes. The switch
          for the alert itself is under Notifications.
        </p>
        <div className="set-grid">
          <label className="field">
            <span>Poll every (minutes)</span>
            <input
              className="search"
              type="number"
              min={1}
              max={60}
              defaultValue={r.watchIntervalMinutes}
              onBlur={(e) => {
                const v = Math.max(1, Math.round(Number(e.target.value) || 0));
                e.target.value = String(v);
                if (v !== r.watchIntervalMinutes) save({ reviews: { watchIntervalMinutes: v } });
              }}
            />
            <span className="set-help">One GitHub call per watched PR per poll. A minute is the floor.</span>
          </label>
          <label className="field">
            <span>Unwatch merged or closed after (days)</span>
            <input
              className="search"
              type="number"
              min={0}
              max={365}
              defaultValue={r.watchUnwatchAfterDays}
              onBlur={(e) => {
                const v = Math.max(0, Math.round(Number(e.target.value) || 0));
                e.target.value = String(v);
                if (v !== r.watchUnwatchAfterDays) save({ reviews: { watchUnwatchAfterDays: v } });
              }}
            />
            <span className="set-help">Keeps the list from filling with finished work. Zero keeps them until you unwatch.</span>
          </label>
        </div>
        <h3 className="set-h">Watched pull requests</h3>
        {watches.length === 0 ? (
          <p className="set-help">None yet. Press the bell on a PR row or page, or w with a row selected.</p>
        ) : (
          <ul className="pr-watch-list">
            {watches.map((w) => (
              <li key={`${w.owner}/${w.repo}#${w.number}`} className="pr-watch-item">
                <a className="pr-watch-ref" href={`#/pr/${w.owner}/${w.repo}/${w.number}`}>
                  {w.repo}#{w.number}
                </a>
                <span className="pr-watch-title" title={w.title}>
                  {w.title}
                </span>
                {w.state !== "OPEN" && <span className={`pr-badge ${w.state === "MERGED" ? "accent" : "bad"}`}>{w.state.toLowerCase()}</span>}
                {w.unseen.length > 0 && <span className="pr-badge pending">{w.unseen.length} unseen</span>}
                {w.error && (
                  <span className="pr-badge bad" title={w.error}>
                    poll failed
                  </span>
                )}
                <span className="pr-watch-since">since {new Date(w.since).toLocaleDateString()}</span>
                <button className="icon-btn tiny" onClick={() => void prApi.unwatch(w).catch(() => {})}>
                  <TrashIcon /> Unwatch
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
