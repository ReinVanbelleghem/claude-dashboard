# Claude Dashboard

A local dashboard for Claude Code sessions: watch the ones running in your terminals,
**start and drive your own from the browser**, search everything you have ever asked,
review the resulting diff, and get told when something needs you.

It runs entirely on your machine. Nothing is uploaded, and the only network calls are
the ones Claude Code itself makes.

---

## Quick start

```bash
./install.sh        # checks dependencies, installs what's missing, builds the UI
./start.sh          # or: bun run dev
```

Then open **http://localhost:5758**.

`install.sh` is safe to re-run. It verifies bun, git, the Claude Code CLI and
`~/.claude`, offers to install anything missing (asking first — pass `--yes` to
skip the prompts), then runs `bun install` and builds. If you already have
everything, `bun install && ./start.sh` does the same job.

`start.sh` runs two processes:

| process | port | what it is |
| --- | --- | --- |
| daemon | 5757 | Bun HTTP API, the transcript indexer, and the parent of every session you start here |
| UI | 5758 | Vite dev server, proxying `/api` to the daemon |

For a single-process setup, build the UI once and let the daemon serve it:

```bash
bun run build
bun run start       # everything on http://localhost:5757
```

The daemon binds **127.0.0.1 only**. It can start Claude sessions with real file
access, so it must not be reachable from your network.

### Requirements

`./install.sh` checks all of these for you.

| | why |
| --- | --- |
| [Bun](https://bun.sh) | the daemon, the package install and the build all run on it |
| git | the diff viewer, branch switcher and review panel shell out to it |
| Claude Code, logged in | the dashboard drives your existing install and settings. Without it you can still index and search past sessions, but not start new ones |
| `terminal-notifier` *(optional, macOS)* | clickable notification banners; without it, notifications fall back to `osascript` |

---

## Sharing it

```bash
bun run package                  # → build/claude-dashboard-v1.0.0.zip
bun run package --bump patch     # 1.0.0 → 1.0.1, then package
bun run package --bump minor     # 1.0.0 → 1.1.0, then package
bun run package --version 2.0.0  # set exactly, then package
```

`scripts/package.sh` is a plain bash script — `./scripts/package.sh --bump patch`
works just as well if you'd rather not go through `bun run`.

Produces a ~300KB zip: source plus a prebuilt `dist/`, with `node_modules`, git
history and Finder metadata left out. Before zipping it scans the staged tree for
credentials, keys and webhook URLs and refuses to package if it finds any.

`--bump` rewrites the version in `package.json`, so each iteration you send a
colleague gets its own filename. Packaging a version whose zip already exists is
refused — otherwise two different builds end up sharing one version number, and
neither of you can tell which one they have. Pass `--force` when you really do
mean to replace it.

Nothing personal is in scope to begin with — all dashboard state (your settings,
the Google Chat webhook, favourites, and the SQLite index of your transcripts)
lives in `~/.claude-dashboard`, deliberately outside this directory. Never share
*that* folder.

The recipient runs:

```bash
unzip claude-dashboard-v1.0.0.zip
cd claude-dashboard
./install.sh
./start.sh
```

They see their own `~/.claude` sessions, not yours.

---

## What it does

### Live

Two kinds of session, listed separately because only one of them is interactive.

Paste an image into the composer (⌘V, or drag one in) and it goes to the session as a
real image block; the message shows an `[Image #1]` marker like the terminal does, with
a thumbnail chip above the box. Up to 8 images, 5MB each.

- **Your sessions** — started from the dashboard with `+ New session`. The daemon is
  their parent process, so it holds their stdin: you can chat, answer permission
  prompts, switch model or permission mode, interrupt a turn, and queue a message
  while one is running. They load your real `~/.claude` settings, `CLAUDE.md`, skills
  and MCP servers, exactly like a terminal session.
- **Running externally** — read from the session registry Claude Code keeps in
  `~/.claude/sessions`. Read-only: their input belongs to the terminal that launched
  them. Once one finishes, **Continue here** resumes it under the dashboard.

Each card shows its git branch and, for your own sessions, live status. A session that
has ended stays listed until you remove it, then moves to **Resumable** — see
[Ending, removing, forgetting](#ending-removing-forgetting).

### Session view

Open a session in the side drawer or the full page (`↗` on any card, or set
Settings → Sessions to always open the page). The full page adds the git panel and a
metadata sidebar.

- **Transcript** with markdown rendering, syntax-highlighted code blocks, collapsible
  tool calls, and a `Hide tools` toggle for reading just the conversation
- **Subagent tabs** when a session spawns agents via the Task tool, each with a live
  activity line, token and tool counts, and its final report. Finished ones collapse
  behind a toggle
- **Permission prompts** as Allow once / Allow always / Deny, so a session started here
  never blocks on a decision you cannot see
- **Slash commands** — type `/` for the commands that session actually supports
  (skills, plugins, prompt-level built-ins). TUI-only ones like `/skills` do not exist
  outside a terminal
- **`↵` sends, `⇧↵` newlines.** A message sent mid-turn is queued and marked as such

### Research sessions

The **Research** tile in the new-session dialog starts a session that cannot reach this
machine at all. It runs in an empty scratch folder (`~/.claude-dashboard/scratch`) with
no project CLAUDE.md, no skills, and no Bash, Read, Write, Glob or Grep — so there is no
route to a codebase, and a general question cannot quietly become about whatever happens
to be checked out here.

**MCP connectors and web search still work**, which is the point: no local context, full
research tools. Those connectors are account-side rather than configured locally, so
keeping them means keeping the `user` setting source — and your global
`~/.claude/CLAUDE.md` rides on that same source. It is the one thing that cannot be
dropped without taking Slack, Notion and Gmail with it. It still *names* directories,
but nothing in the session can open one.

### Git and review

Git for the session's repository. Reading is unrestricted. Writing is deliberately
narrow: switch branch, stage, commit, push, pull, fetch, edit or discard a named file,
and add or remove a worktree. Anything that can lose work wholesale or leave a
conflicted tree — merge, rebase, reset, force-push — stays in a terminal.

The two halves are split by what they are for. **Git** in the sidebar is what you act
on — branch, pull, push, commit — and stays put while the page grows. The panel below
the conversation is what you read: the file lists and the diffs. Both are the same
repository state, so a commit made in one empties the file list in the other.

- **Stage and unstage** per file, or all at once, from the **Uncommitted** file list.
  Staged and not-staged are separate groups, and a partially staged file appears in
  both, because part of it is going into the next commit and part of it isn't. Both
  halves of a rename move together
- **Edit a file in place** from the pencil on its header, in both the **Uncommitted**
  and **Whole branch** views. It edits the file on disk rather than the patch, which is
  why a fix made while reading the branch diff turns up as an uncommitted change: there
  is one file, and both views are reading it. Saving carries the hash of what was
  loaded, so an edit that a session overwrote in the meantime is refused instead of
  clobbering it. `⌘S` saves, `Esc` closes, `Tab` indents
- **Open a file** from the button above the diff, for a file nothing has changed yet —
  the diff only knows about files that are already in it. The picker browses the
  repository or searches it by name; searching goes through git, so it finds tracked
  and untracked files and skips everything `.gitignore` excludes, which is most of a
  working checkout. It is scoped to the repo, like every other file operation here
- Syntax highlighting, line numbers, and a gutter mark beside the lines the diff shows
  as changed. It is a real textarea with the colour painted on a layer underneath, so
  every editing behaviour the OS gives you still works. The change marks are dropped
  while an edit changes the line count — the diff's numbers no longer point at the same
  code — and come back when you save and the diff is re-read
- **Open in VS Code** from any file header in a diff, in every scope — uncommitted,
  whole branch, and a commit in the History tab. It is a `vscode://` link, so the OS
  hands it to the editor; nothing is shelled out on the daemon's side
- **Discard** a file's uncommitted changes from its header in the **Uncommitted** diff.
  It asks first, because an unstaged edit exists in no git object and nothing brings it
  back: a tracked file goes back to HEAD (index and worktree together), an untracked
  one is deleted from disk and the button says so. Named files only — there is no
  discard-everything, and the daemon refuses any path the status didn't list, which is
  what rules out a directory taking its contents with it
- **Commit** the staged files with the message box in the sidebar (`⌘↵`). It is only
  ever the staged files — never `-a`, since the staging area is the review step. Hooks
  run, under a timeout so one waiting for input can't wedge the repo. Unresolved
  conflicts are refused before git can write the markers into history
- **Push** publishes the branch's commits, and sets an upstream on the first push of a
  new branch. Never forced, and never with a refspec the browser chose — the
  destination comes from the branch's own config. A branch known to be behind is
  refused with "pull first" rather than being rejected by the remote
- **Pull** in the header fast-forwards the current branch onto its upstream. It is a
  fetch plus `merge --ff-only`, never `git pull`, so no repo config can turn the click
  into a rebase or a merge commit: if the histories have diverged it refuses and says
  by how much. It also declines to overwrite a file you have edited, while unrelated
  dirty files are no reason to block it
- **Switch branch** from the header. Type to filter, type a new name to create it off
  the current branch. Checking out a remote-only branch sets up tracking. The filter
  runs on the server because a long-lived repo has thousands of remote branches, and
  the popover says what it is not showing you rather than stopping silently at sixty
- Uncommitted work is carried across when git can and the switch is refused when it
  can't — the refusal is shown verbatim, with a note on which kind of stash moves the
  files it names. A name that already exists on a remote is refused rather than
  created, since a local branch sharing that name would share none of its commits
- **Uncommitted** (what is different right now) and **Whole branch** (what this branch
  adds over its base, i.e. what a PR would contain)
- Unified or split diffs, per-file collapsing, ignore-whitespace, and a **History** tab
  with per-commit diffs
- **Review comments** on any line or file. Resolve to hide one and drop it from the
  prompt; **Draft for Claude** composes the open comments into a prompt and puts it in
  the session's composer — grouped by file with each commented line quoted — where you
  can edit it before sending. Nothing is sent on your behalf, and comments are marked
  as seen only when the message actually goes
- Comments are keyed by repository, so they survive branch switches, but they are
  **read back scoped to the repository _and_ the branch you are on**: one written
  against another branch's code points at lines that aren't in this tree, so showing it
  in this diff would pin it to whatever now sits on that line number. Off-branch
  comments are counted as *N hidden* and listed under **review those**, which is also
  the only place they can be deleted from. Comments written with no branch recorded
  show on every branch, so nothing written before branch tracking becomes unreachable.
  The prompt and **Clear resolved** use the same scope as the list, so neither can act
  on a comment you were not shown. A comment whose line has since changed is flagged as
  adrift rather than silently re-pointed

### Worktrees

One session per branch, without the sessions fighting over one checkout. A git worktree
is a second working directory for the same repository — its own branch, its own index,
one shared object store — so a session can work `feat/login` while another stays on
`main` and neither moves the files under the other.

- **New worktree** from the Worktrees panel, or straight from **+ New session** with
  *Work in a new worktree*, which is the flow this exists for: name a branch and the
  session starts in a checkout of its own. Created beside the repository as
  `<repo>-<branch>` — `~/src/app` on `feat/login` becomes `~/src/app-feat-login` — with
  the branch name slugified, since a `/` in a path would nest the directory somewhere
  nothing looks. Settings → Git can point them elsewhere
- **A fresh checkout holds only what git tracks**, which is not enough to run anything:
  no `node_modules`, no `.env`. So a declared set of paths is carried over —
  `node_modules` symlinked because copying one is slow and doubles the disk, `.env` and
  friends copied because a symlink would mean editing one checkout's secrets edits every
  other one's. **Only paths git ignores are carried**: anything else would arrive as
  untracked work, turn up in the diff and in *stage all*, and — since a dirty worktree is
  refused — leave the new worktree impossible to remove. It is checked twice, once against
  the source and again against what actually landed, because whether git ignores something
  depends on what it *is*: the conventional `node_modules/` pattern matches a directory and
  not a symlink to one. A path that fails the second check is taken back out and named in
  the result. The list is `ui.worktreeProvision` in `settings.json`
- **That `node_modules/` trailing slash is worth knowing about**, since it is what most
  repos have and it is why a symlink would otherwise be left behind. Settings → Git
  can allow provisioning to add the bare path to `.git/info/exclude` — the local ignore
  file git never commits, which matches a symlink as well as a directory, and which
  changes nothing in your main checkout where `node_modules` is a real directory already
  ignored. Off by default: it writes inside your repository's git directory
- **A branch can only be checked out once.** The branch popover knows which worktree
  holds which branch, so a branch open elsewhere offers **open that checkout** instead of
  a switch that git would refuse. The refusal is still handled if a worktree appears
  between the list being drawn and the click landing
- **Remove** deletes the directory and nothing else: the branch and every commit on it
  survive, which is why it needs no confirmation beyond the one it asks for. Uncommitted
  work does not survive and exists in no git object, so **a dirty worktree is refused** —
  `--force` is never passed, and the refusal counts the files. A worktree with a live
  session in it is refused too, since git would happily delete the directory out from
  under a running process. The main checkout is never removable, nor is a locked one
- **Review comments follow the branch, not the directory.** They are keyed by the shared
  `.git`, so a comment written against `feat/login` in one checkout is there when you look
  at `feat/login` in another. Comments written before this shipped keep working against
  the checkout they were made in
- **The Worktrees tab is the same panel for every repository at once.** Cleaning up is
  the one worktree job you cannot do from a session, because a checkout you are finished
  with is one you have no session open in. The repository list folds session history and
  the configured worktree directory onto the shared `.git`, so a checkout nothing has run
  in yet shows up too, and each group creates, opens and removes exactly as the
  in-session panel does
- **Sessions group by repository.** Transcripts are keyed by working directory, so every
  worktree used to file as a separate project — and so did every subdirectory a session
  happened to run in. History and Usage now roll those up under the repository, with each
  real checkout listed underneath

Writes are serialised in two tiers, because worktrees share a ref store but not an index:
per checkout for staging, committing and switching, and per repository for fetching and
for worktree add/remove.

### History and Usage

Full-text search over every prompt you have typed, across every project, **paginated**
— 20 rows a page by default, with 10/50/100 as alternatives, remembered per browser.
The pager reports where you are in the whole result set (`21–40 of 1,179`) rather than
just the page, because a range alone cannot tell you whether there are thirty sessions
behind it or three thousand. Usage shows
**fresh tokens** — uncached input + cache writes + output — against local budgets.
Cache reads are reported separately: they are typically ~97% of raw token volume at a
tenth of the input rate, so including them makes every gauge read as maxed out. Costs
are pay-as-you-go list-price equivalents, not what a subscription charges.

### Settings

Four sections behind a left rail — Appearance, Notifications, Sessions, Git — one
panel at a time, with the section you last used remembered. Everything saves as you
change it; there is no save button.

### Appearance

Settings → Appearance: dark or light; a **palette** — nine of them (Default, Slate, Terminal, Ocean, Grape, Solar, Sepia, Mono,
Ember) — that moves the surfaces, borders and text steps; an accent hue (seven); and the tab icon —
six glyphs in any of the same hues, generated as data URLs and applied live. Every
palette column clears 4.5:1 for primary and secondary text (3:1 for muted) against its
own three surface steps, and every accent clears 4.5:1 against every palette. The
accent and palette only drive chrome; chart colours are left alone, so recolouring the
dashboard can never make two data series collide.

The tab icon also **badges itself** when a session is waiting on you — an amber dot on
the tile plus a `(n)` count in the title, so a tab squeezed down to its favicon still
tells you something needs answering.

Installed as an app — Safari's **Add to Dock**, or any browser's install — the same
count becomes a **badge on the Dock icon**, which is the one place it stays readable
with the window hidden behind an editor. It needs notification permission granted,
since that is what the platforms gate badging on. The window's title bar follows the
palette too, via `theme-color`, so a Dock app is not left framing Ocean in default grey.

The Dock **icon** itself cannot follow the picker: it is baked in when the app is
installed, and nothing a running page does reaches it. Appearance → Dock icon →
**Download as PNG** renders the current glyph and hue at 1024px so you can set it in
the web app's own settings (File → Settings → General), which is the supported way to
change it. Removing the app from the Dock and re-adding it picks up the current icon too.

The choice is written to `settings.json` **and** mirrored in `localStorage`. The
server copy is what another browser picks up; the local copy is what makes the first
paint correct instead of flashing the default theme. The static icons in `public/` are
the pre-paint fallback and the answer to bare `/favicon.ico` requests; regenerate them
with `bun run icons` after editing `public/favicon.svg`.

### Command palette

**⌘K** (Ctrl-K) from anywhere: jump to a live session, search past ones by prompt text,
go to a tab, start a session, or switch theme and accent. What the dashboard already
holds in memory filters on every keystroke; past sessions come from the daemon's
full-text index and are debounced, so typing never waits on the network.

### Notifications

Told when something wants you, so you can leave the dashboard closed. Configure in
Settings: which events (terminal session needs input, permission request, reply
finished, session error), which channels (macOS banner, browser, Google Chat webhook),
a delay before notifying, a per-session cooldown, quiet hours, and whether to stay
quiet about the session already on your screen.

---

## Configuration

Everything lives in `~/.claude-dashboard/`:

| file | what |
| --- | --- |
| `index.db` | SQLite index of every transcript. Derived — safe to delete, it rebuilds |
| `config.json` | Token budgets and model pricing |
| `settings.json` | Notification and UI preferences (written by the Settings tab) |
| `comments.json` | Your review comments |
| `favourites.json` | Saved working directories |
| `sessions.json` | Sessions that can be resumed |
| `models.json` | Model list, cached from the last session that ran |

**Budgets are local guesses.** Your real subscription quota is not published in a form
this can read, so `config.json` ships with calibrated estimates (35M fresh tokens per
5 hours, 700M per week). Tune them until the gauges agree with `/usage`. The daemon
prints what it loaded on startup:

```
[claude-dashboard] budgets: 35M per 5h, 700M per week, $250/day (fresh tokens; edit config.json to tune)
```

### Environment variables

| variable | default | purpose |
| --- | --- | --- |
| `PORT` | `5757` | Daemon port |
| `DASHBOARD_HOME` | `~/.claude-dashboard` | Where the dashboard keeps its own state |
| `CLAUDE_HOME` | `~/.claude` | Claude Code's state. **Only ever read** |
| `DASHBOARD_WATCH` | unset | `1` restarts the daemon on server file changes — see below |

---

## Sessions are children of the daemon

A session you start here is a child process of the daemon, which is what makes it
interactive. The consequence: **restarting the daemon ends its sessions.** There is no
idle timeout — they live as long as the daemon does.

This is why `start.sh` does *not* use `--watch` by default. Set `DASHBOARD_WATCH=1`
when working on server code, and accept that saving a file in `server/` ends any
session you had running.

Nothing is lost when that happens: transcripts persist, and the session reappears
under **Resumable**, where `Resume` starts a fresh process on the same conversation
with its history intact.

Config is read once at startup, so an edit to `config.json` needs a daemon restart.

### Ending, removing, forgetting

Three levels, none of which delete a conversation:

- **End** — stops the process. The session becomes read-only, stays listed under
  *Finished here*, and its transcript is untouched
- **Remove** — clears it off the live list. It then appears under *Resumable*
- **Forget** — stops offering to resume it. Still searchable in History

The only way to delete a conversation is to delete its `.jsonl` under
`~/.claude/projects`, which the dashboard never does.

---

## Scripts

| command | what |
| --- | --- |
| `./start.sh` | Daemon + UI dev server together (the normal way to run it) |
| `bun run start` | Daemon only, serving the built UI from `dist/` |
| `bun run server` | Daemon only, with `--watch` |
| `bun run ui` | Vite dev server only |
| `bun run build` | Build the UI into `dist/` |
| `bun run reindex` | Re-read every transcript from scratch |
| `bun run icons` | Regenerate the static fallback icons in `public/` |

`reindex` is for after changing what the indexer extracts. The indexer is incremental —
it records how far into each transcript it has parsed — so a newly handled record type
is invisible to lines already consumed. Rows are rebuilt, not duplicated.

---

## How it fits together

```
~/.claude/projects/**.jsonl ──► indexer ──► index.db ──► History, Usage, transcripts
~/.claude/sessions/*.json   ──► registry ─────────────► Live (external sessions)
Agent SDK child processes   ──► agents.ts ────────────► Live (your sessions), chat
git                         ──► git.ts ───────────────► branches, diffs, history, switch, worktrees
```

The UI holds **one SSE connection** (`/api/events`) that carries live session state,
usage rollups, index ticks, agent timelines, streaming tokens, and notifications.

### Server

| file | responsibility |
| --- | --- |
| `index.ts` | HTTP routes, SSE fan-out, notification tick |
| `indexer.ts` | Incremental transcript parsing |
| `db.ts` | SQLite schema and migrations |
| `agents.ts` | Sessions the dashboard owns: spawn, stream, permissions, subagents |
| `registry.ts` | Reads Claude Code's own session registry |
| `git.ts` | Git: never a shell, always `--no-optional-locks`; writes are limited to switch/create/fetch and worktree add/remove, ref names validated by git itself, and serialised in two tiers — per checkout for the index, per repository for the shared ref store |
| `provision.ts` | What a new worktree carries over so it can actually run |
| `repoKeys.ts` | Which repository each indexed session belongs to, so worktrees group |
| `comments.ts` | Review comments and the prompt they compose into |
| `notify.ts` | Whether, when and where to interrupt you |
| `settings.ts`, `config.ts`, `dirs.ts`, `usage.ts`, `paths.ts` | Preferences, pricing, folder picking, rollups, paths |

### Frontend

React, and nothing else — the markdown renderer, syntax highlighter, diff renderer,
charts and icons are all hand-written, so the bundle is ~72KB gzipped and works
offline. (The daemon's one dependency is the Claude Agent SDK.) Deliberate side effect: model output is
rendered as React elements, never `innerHTML`, so a transcript cannot inject markup.

---

## Known limitations

- **Terminal sessions cannot be typed into.** Their stdin is a tty. The only channel
  into a live external session is Claude Code's undocumented peer socket, which this
  deliberately does not build on
- **Plan mode is unverified end to end**, and `onUserDialog` / `onElicitation` are not
  wired — a non-permission dialog (an MCP elicitation, say) would park a turn with
  nothing in the UI to answer it
- **Bypass permissions must be chosen when a session starts.** The CLI refuses to
  enable it later; switching to it mid-session fails with a message saying so
- **Auto mode is model-dependent.** Models that do not offer it fall back to *Ask me*,
  and the UI reports the mode actually in force
- **Search covers your prompts, not replies.** The FTS index holds typed prompts only
- **Subagent transcripts are not indexed.** They exist under
  `~/.claude/projects/<dir>/<sessionId>/subagents/` but the indexer reads only
  top-level files, so subagent work is missing from History and usage totals
- **A worktree's own directory name is what the OS shows**, so two checkouts of one
  repository are told apart in the dashboard by the `repo ▸ branch` badge rather than by
  their window titles
