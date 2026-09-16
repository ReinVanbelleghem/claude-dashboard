import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { gitApi, type ProvisionMode, type ProvisionPlan, type ProvisionRule } from "../api.ts";
import { TrashIcon } from "./Icons.tsx";

/**
 * What this repository carries into a new checkout, editable here.
 *
 * Per repository because one global list cannot be right for all of them, and being
 * wrong is silent: a JS repo wants `node_modules`, a Python monorepo wants a venv per
 * project, and a checkout provisioned by the wrong list looks fine until a session tries
 * to run something in it and finds no interpreter. The list belongs next to the
 * repository's checkouts for the same reason the create button does — this is the screen
 * where you are already deciding things about that repository.
 *
 * Three things are shown that the raw setting cannot tell you, and each is why this is a
 * UI rather than a documented JSON key:
 *
 *  - **What a pattern resolves to.** `projects/*&#8203;/venv` is either nine venvs or a typo,
 *    and the difference is one number on screen.
 *  - **What git says.** A path git does not ignore is refused by provisioning — carrying
 *    it would leave untracked work in the new checkout and make it undeletable — so a
 *    rule that will never fire is marked as one before you create anything.
 *  - **What is here that the rules miss.** The scan is the answer to the failure that
 *    prompted all this: nobody knew nine venvs needed listing.
 *
 * The list itself opens in a dialog rather than unfolding into the card. A rule is a short
 * path and three controls, so its natural measure is a column — inlined under a card as
 * wide as the display it read as a half-empty panel, and it pushed the checkouts it sits
 * under off the screen. What stays on the card is the one line worth seeing without
 * asking: how much this repository carries, and whether anything is being left behind.
 */
export function ProvisionEditor({ cwd }: { cwd: string }) {
  const [plan, setPlan] = useState<ProvisionPlan | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<ProvisionRule[] | null>(null);
  const [draft, setDraft] = useState({ path: "", mode: "symlink" as ProvisionMode });

  const load = useCallback(() => {
    gitApi
      .provision(cwd)
      .then(setPlan)
      .catch((e: Error) => setError(e.message));
  }, [cwd]);

  useEffect(load, [load]);

  // A dialog closes on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  /** Every write goes through the same call, and every call returns the new plan. */
  const save = async (rules: ProvisionRule[]) => {
    setBusy(true);
    setError(null);
    try {
      const r = await gitApi.provisionSave(cwd, rules);
      setPlan(r.plan);
      // The suggestions were computed against the old rules; some of them are now in it.
      setSuggestions(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const scan = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await gitApi.provisionScan(cwd);
      setSuggestions(r.suggestions);
      if (!r.ok) setError(r.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!plan) return null;
  if (!plan.ok && !plan.repoKey) return null;

  const rows = ruleRows(plan);
  const carried = plan.paths.filter((p) => p.ignored);
  const stranded = plan.paths.filter((p) => !p.ignored);

  /**
   * A repository's stored list holds only what differs from the global one, so every edit
   * is expressed as "here is the whole repo list again" — computed from the rows rather
   * than accumulated, which is what keeps a mode set back to its global value from
   * leaving a redundant override behind.
   */
  const commit = (next: RuleRow[]) =>
    save(
      next
        .filter((r) => r.origin === "repo" || r.mode !== r.globalMode)
        .map((r) => ({ path: r.path, mode: r.mode })),
    );

  const setMode = (path: string, mode: ProvisionMode) =>
    commit(rows.map((r) => (r.path === path ? { ...r, mode } : r)));

  const drop = (path: string) => commit(rows.filter((r) => r.path !== path));

  const add = (rule: ProvisionRule) => {
    const rest = rows.filter((r) => r.path !== rule.path.trim());
    commit([
      ...rest,
      { path: rule.path.trim(), mode: rule.mode, origin: "repo", globalMode: null, matches: 0 },
    ]);
  };

  const submitDraft = () => {
    if (!draft.path.trim()) return;
    add(draft);
    setDraft({ path: "", mode: draft.mode });
  };

  /**
   * Grouped by where the rule comes from, which is what turns a per-row "global" /
   * "this repo" tag on every line into two headings. The scope of a rule is the one
   * thing about it that is the same for its whole run.
   */
  const globals = rows.filter((r) => r.origin === "global");
  const locals = rows.filter((r) => r.origin === "repo");

  return (
    <div className="pv">
      <button className="pv-head" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <span className="pv-head-label">Provisioning</span>
        <span className="pv-counts">
          <span className="pv-count">
            {carried.length === 0 ? "nothing carried over" : `${carried.length} carried over`}
          </span>
          {stranded.length > 0 && (
            <span className="pv-count warn">{stranded.length} left behind</span>
          )}
        </span>
        <span className="pv-open">Edit</span>
      </button>

      {open &&
        // Portalled to <body>: this is always rendered inside WorktreesPanel's own
        // `.panel`, which now always carries a `backdrop-filter`, and that creates a
        // containing block for `.modal`'s `position: fixed` — the modal would center
        // on that panel instead of the viewport. Same bug and fix as ThemeStudio.
        createPortal(
        <>
          <div className="scrim" onClick={() => setOpen(false)} />
          <div
            className="modal wide scroll pv-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Provisioning for ${plan.name ?? "this repository"}`}
          >
            <div className="modal-head">
              <div>
                <h3>Provisioning{plan.name && <small>{plan.name}</small>}</h3>
                <p className="hint">
                  Untracked paths every new checkout of this repository is given, on top of
                  the global list. Patterns may use <code>*</code> and <code>**</code>.
                </p>
              </div>
            </div>

            <div className="pv-body">
              <dl className="pv-legend">
                <div>
                  <dt data-mode="symlink">symlink</dt>
                  <dd>one shared copy — right for dependencies, wrong for anything written to</dd>
                </div>
                <div>
                  <dt data-mode="copy">copy</dt>
                  <dd>the checkout gets its own — right for env files</dd>
                </div>
                <div>
                  <dt data-mode="off">off here</dt>
                  <dd>listed globally, not carried into this repository</dd>
                </div>
              </dl>

              <div className="pv-rules">
                {globals.length > 0 && (
                  <RuleGroup
                    title="From the global list"
                    note="shared by every repository"
                    rows={globals}
                    busy={busy}
                    onMode={setMode}
                  />
                )}
                {locals.length > 0 && (
                  <RuleGroup
                    title="Added for this repository"
                    note={plan.name ?? undefined}
                    rows={locals}
                    busy={busy}
                    onMode={setMode}
                    onDrop={drop}
                  />
                )}
              </div>

              <div className="pv-add">
                <input
                  className="search pv-add-path"
                  spellCheck={false}
                  placeholder="add a path or pattern, e.g. projects/*/venv"
                  value={draft.path}
                  disabled={busy}
                  onChange={(e) => setDraft({ ...draft, path: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitDraft();
                  }}
                />
                <ModeSelect
                  mode={draft.mode}
                  busy={busy}
                  onChange={(mode) => setDraft({ ...draft, mode })}
                />
                <button
                  className="icon-btn tiny primary"
                  disabled={busy || !draft.path.trim()}
                  onClick={submitDraft}
                >
                  Add
                </button>
                <button className="icon-btn tiny pv-scan" disabled={busy} onClick={() => void scan()}>
                  {busy ? "Scanning…" : "Scan repository"}
                </button>
              </div>

              {suggestions !== null && (
                <div className="pv-sugg">
                  {suggestions.length === 0 ? (
                    <p className="pv-note">
                      Nothing found that the rules above would miss. Everything ignored and worth
                      carrying is already covered.
                    </p>
                  ) : (
                    <>
                      <p className="pv-note">
                        Ignored by git in {plan.name}, not covered above — click to add:
                      </p>
                      <div className="pv-chips">
                        {suggestions.map((s) => (
                          <button
                            className="pv-chip"
                            key={`${s.path} ${s.mode}`}
                            disabled={busy}
                            onClick={() => add(s)}
                            title={`Add as ${s.mode}`}
                          >
                            <code>{s.path}</code>
                            <small data-mode={s.mode}>{s.mode}</small>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}

              {/*
                The one warning worth making loud — but loud is a marked block with the paths
                as a scannable list, not a paragraph of fourteen comma-separated paths.
                Provisioning refuses a path git does not ignore, because carrying it over would
                put untracked work in the new checkout — visible in the diff, caught by "stage
                all", and enough to make the worktree undeletable. A rule in that state never
                fires, and nothing else on screen would tell you.
              */}
              {stranded.length > 0 && (
                <details className="pv-stranded">
                  <summary>
                    <span className="pv-stranded-count">{stranded.length}</span>
                    {stranded.length === 1 ? " path is" : " paths are"} left behind — git tracks{" "}
                    {stranded.length === 1 ? "it" : "them"}
                  </summary>
                  <p className="pv-note">
                    Copying tracked files into a new checkout would show up there as uncommitted
                    work, so provisioning skips {stranded.length === 1 ? "it" : "them"}.
                  </p>
                  <ul className="pv-path-list">
                    {stranded.map((p) => (
                      <li key={p.path}>
                        <code>{p.path}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {carried.length > 0 && (
                <details className="pv-resolved">
                  <summary>
                    What a new checkout gets — <b>{carried.length}</b> path
                    {carried.length === 1 ? "" : "s"}
                  </summary>
                  <ul className="pv-path-list">
                    {carried.map((p) => (
                      <li key={p.path}>
                        <code>{p.path}</code> <small data-mode={p.mode}>{p.mode}</small>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {error && <p className="pv-error">{error}</p>}
            </div>

            <div className="modal-actions">
              <button className="icon-btn" onClick={() => setOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

/** One run of rules with the same scope, under the heading that states that scope. */
function RuleGroup({
  title,
  note,
  rows,
  busy,
  onMode,
  onDrop,
}: {
  title: string;
  note?: string;
  rows: RuleRow[];
  busy: boolean;
  onMode: (path: string, mode: ProvisionMode) => void;
  onDrop?: (path: string) => void;
}) {
  return (
    <section className="pv-group">
      <h4 className="pv-group-head">
        {title}
        {note && <small>{note}</small>}
      </h4>
      <div className="pv-list">
        {rows.map((r) => (
          <div className="pv-rule" data-mode={r.mode} key={r.path}>
            <code className="pv-path" title={r.path}>
              {r.path}
            </code>
            <span className="pv-flag">
              {r.origin === "global" && r.mode !== r.globalMode && (
                <span className="pv-tag">overridden</span>
              )}
            </span>
            {/* A pattern's whole value is what it resolves to, so say so — kept next to
                the mode, the other thing you look at when judging a rule. */}
            <span className="pv-hits">{r.matches !== null && `${r.matches}×`}</span>
            <ModeSelect mode={r.mode} busy={busy} onChange={(mode) => onMode(r.path, mode)} />
            {onDrop ? (
              <button
                className="pv-drop"
                title="Remove this rule"
                aria-label={`Remove ${r.path}`}
                disabled={busy}
                onClick={() => onDrop(r.path)}
              >
                <TrashIcon />
              </button>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The mode, colour-coded by what it does. Ten native selects reading "symlink" in
 * identical grey is a list you have to read; the same ten tinted by mode is one you can
 * scan.
 */
function ModeSelect({
  mode,
  busy,
  onChange,
}: {
  mode: ProvisionMode;
  busy: boolean;
  onChange: (mode: ProvisionMode) => void;
}) {
  return (
    <span className="pv-mode" data-mode={mode}>
      <select
        value={mode}
        disabled={busy}
        aria-label="Mode"
        onChange={(e) => onChange(e.target.value as ProvisionMode)}
      >
        <option value="symlink">symlink</option>
        <option value="copy">copy</option>
        <option value="off">off here</option>
      </select>
    </span>
  );
}

type RuleRow = {
  path: string;
  mode: ProvisionMode;
  origin: "global" | "repo";
  /** What the global list says, so an override can be recognised and undone. */
  globalMode: ProvisionMode | null;
  /** How many literal paths this rule resolves to here, or null when it is not a pattern. */
  matches: number | null;
};

/**
 * The two lists as one editable list.
 *
 * Global rules come first and always appear, even when this repository has switched one
 * off — a rule you cannot see is a rule you cannot turn back on. The repository's own
 * additions follow in the order they were saved.
 */
function ruleRows(plan: ProvisionPlan): RuleRow[] {
  const repoMode = new Map(plan.repo.map((r) => [r.path.trim(), r.mode]));
  const globalMode = new Map(plan.global.map((r) => [r.path.trim(), r.mode]));

  const hits = (rule: string): number | null => {
    if (!/[*?]/.test(rule)) return null;
    return plan.paths.filter((p) => p.rule === rule).length;
  };

  const rows: RuleRow[] = plan.global.map((g) => {
    const path = g.path.trim();
    return {
      path,
      mode: repoMode.get(path) ?? g.mode,
      origin: "global",
      globalMode: g.mode,
      matches: hits(path),
    };
  });

  for (const r of plan.repo) {
    const path = r.path.trim();
    if (globalMode.has(path)) continue;
    rows.push({ path, mode: r.mode, origin: "repo", globalMode: null, matches: hits(path) });
  }

  return rows;
}
