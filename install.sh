#!/usr/bin/env bash
# One-shot setup for claude-dashboard.
#
# Checks every dependency the dashboard actually uses, offers to install the ones
# it can install safely, then sets the dashboard up the way you choose: as a Mac
# app in /Applications, or to run from this folder and use in the browser. Safe to
# re-run: everything already satisfied is left alone, and the app is only replaced
# by a fresh build of itself.
set -euo pipefail
cd "$(dirname "$0")"

# shellcheck source=scripts/preflight.sh
source scripts/preflight.sh

ASSUME_YES=0
DO_BUILD=1
MODE=""
UPDATE=0
APP_PATH="/Applications/Claude Dashboard.app"

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

      --app       Build the Mac app and put it in /Applications (Apple silicon).
      --browser   Set it up to run from this folder and use in the browser.
      --update    Pull the latest version first, then set up as before.
  -y, --yes       Don't ask before installing a missing dependency.
      --no-build  Skip the UI build (start.sh's dev server builds on the fly).
  -h, --help      Show this message.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app)       MODE=app ;;
    --browser)   MODE=browser ;;
    --update)    UPDATE=1 ;;
    -y|--yes)    ASSUME_YES=1 ;;
    --no-build)  DO_BUILD=0 ;;
    -h|--help)   usage; exit 0 ;;
    *) printf "unknown option: %s\n\n" "$1"; usage; exit 1 ;;
  esac
  shift
done

# Ask before doing anything to the user's machine. A non-interactive shell (piped
# input, CI) can't answer, so it declines unless --yes was passed.
confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] || return 1
  local reply
  printf "      %sinstall it now? [y/N]%s " "$BOLD" "$RESET"
  read -r reply
  case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

printf "\n%sclaude-dashboard — setup%s\n" "$BOLD" "$RESET"

can_build_app() { [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ]; }

# ── 0. the latest version ─────────────────────────────────────────────────────
if [ "$UPDATE" = 1 ]; then
  step "Update"
  if [ ! -d .git ]; then
    bad "this folder is not a git checkout, so there is nothing to pull"
    hint "download the new release, or clone the repository and run ./install.sh there"
    exit 1
  fi
  BEFORE="$(git rev-parse --short HEAD)"
  git pull --ff-only
  AFTER="$(git rev-parse --short HEAD)"
  if [ "$BEFORE" = "$AFTER" ]; then ok "already up to date ($AFTER)"; else ok "$BEFORE → $AFTER"; fi
fi

# ── how to use it ─────────────────────────────────────────────────────────────
# Asked first, so the long part can run without anyone watching. Without an
# answer it stays with what is already there: the app when it is installed.
if [ "$MODE" = app ] && ! can_build_app; then
  bad "the Mac app is built on Apple silicon Macs only"
  hint "use ./install.sh --browser instead"
  exit 1
fi
if [ -z "$MODE" ]; then
  DEFAULT=browser
  if [ -d "$APP_PATH" ] && can_build_app; then DEFAULT=app; fi
  if can_build_app && [ -t 0 ] && [ "$UPDATE" = 0 ]; then
    step "How do you want to use it?"
    printf "  %s1%s  Mac app      its own window and Dock icon, in /Applications. Takes a few minutes to build.\n" "$BOLD" "$RESET"
    printf "  %s2%s  Browser      runs from this folder, opens at http://localhost:5758.\n" "$BOLD" "$RESET"
    if [ "$DEFAULT" = app ]; then printf "\n      %s[1]%s " "$BOLD" "$RESET"; else printf "\n      %s[2]%s " "$BOLD" "$RESET"; fi
    read -r reply
    case "$reply" in
      1|a|app) MODE=app ;;
      2|b|browser) MODE=browser ;;
      *) MODE="$DEFAULT" ;;
    esac
  else
    MODE="$DEFAULT"
  fi
fi
if [ "$MODE" = app ] && pgrep -f "$APP_PATH/Contents/MacOS/" >/dev/null 2>&1; then
  bad "Claude Dashboard is running — quit it first (⌘Q), then re-run ./install.sh"
  hint "its sessions keep running; the new app picks them up"
  exit 1
fi

FATAL=0
NOTES=()

# ── 1. bun (required) ─────────────────────────────────────────────────────────
step "Runtime"
if has_bun; then
  ok "bun $(bun --version)"
else
  bad "bun is missing — the daemon, the package install and the build all run on it"
  hint "$BUN_INSTALL_CMD"
  if confirm; then
    curl -fsSL https://bun.sh/install | bash
    ensure_bun_on_path
    if has_bun; then
      ok "bun $(bun --version) installed"
      NOTES+=("bun was added to ~/.bun/bin — open a new terminal, or run: export PATH=\"\$HOME/.bun/bin:\$PATH\"")
    else
      bad "bun still not on PATH after installing"
      hint "open a new terminal and re-run ./install.sh"
      FATAL=1
    fi
  else
    hint "skipped — install it yourself, then re-run ./install.sh"
    FATAL=1
  fi
fi

# ── 2. git (required) ─────────────────────────────────────────────────────────
step "Version control"
if has_git; then
  ok "git $(git --version | awk '{print $3}')"
else
  bad "git is missing — the diff viewer, branch switcher and review panel shell out to it"
  hint "$(git_install_hint)"
  FATAL=1
fi

# ── 3. Claude Code (required to start sessions) ───────────────────────────────
step "Claude Code"
if has_claude; then
  ok "claude CLI found ($(command -v claude))"
  hint "the dashboard drives your existing install, settings and login"
else
  warn "claude CLI not found"
  hint "the dashboard can still index and search past sessions,"
  hint "but '+ New session' needs the CLI installed and logged in:"
  hint "$(claude_install_hint)"
  NOTES+=("install the Claude Code CLI and run 'claude' once to log in before starting sessions")
fi

if has_claude_home; then
  ok "~/.claude found — there is history to index"
else
  warn "~/.claude does not exist yet"
  hint "run Claude Code once; the dashboard reads its transcripts from there"
fi

# ── 4. notifications (optional, macOS) ────────────────────────────────────────
if [ "$OS" = macos ]; then
  step "Notifications (optional)"
  if has_notifier; then
    ok "terminal-notifier — clickable banners"
  else
    warn "terminal-notifier not installed"
    hint "without it, notifications fall back to osascript (not clickable)"
    if have brew; then
      hint "brew install terminal-notifier"
      if confirm; then
        brew install terminal-notifier && ok "terminal-notifier installed"
      fi
    else
      hint "install Homebrew first, then: brew install terminal-notifier"
    fi
  fi
fi

# ── 5. services page (optional) ───────────────────────────────────────────────
# Everything here is optional: without it the Services page simply says what is
# missing, and the rest of the dashboard is unaffected.
step "Services page (optional)"
if has_tmux; then
  ok "tmux $(tmux -V | awk '{print $2}') — runs the local dev stack"
else
  warn "tmux not installed — the Services page cannot start or attach to anything"
  hint "$(tmux_install_hint)"
  if [ "$OS" = macos ] && have brew && confirm; then
    brew install tmux && ok "tmux installed"
  fi
fi
if has_python3; then
  ok "python3 $(python3 --version 2>&1 | awk '{print $2}') — brokers the browser terminal"
else
  warn "python3 not found — the in-browser terminal (attach, logs, shell) needs it"
  hint "it only uses the standard library; any python3 on PATH will do"
fi
if has_docker; then
  ok "docker compose $(docker compose version --short 2>/dev/null || echo found) — lists and drives containers"
else
  warn "docker compose not available — the containers section stays empty"
  hint "$(docker_install_hint)"
fi

# ── 6. ports ──────────────────────────────────────────────────────────────────
step "Ports"
PORTS="5757 5758"
if [ "$MODE" = app ]; then PORTS="5757"; fi
for p in $PORTS; do
  if port_busy "$p"; then
    warn "port $p is in use — is the dashboard already running?"
    hint "free it with: kill \$(lsof -ti tcp:$p)"
  else
    ok "port $p free"
  fi
done

if [ "$FATAL" = 1 ]; then
  printf "\n%s✗ setup incomplete%s — resolve the items above and re-run ./install.sh\n\n" "$RED" "$RESET"
  exit 1
fi

# ── 7. packages + build ───────────────────────────────────────────────────────
step "Dependencies"
bun install
ok "packages installed"

if [ "$MODE" = app ]; then
  if [ ! -d node_modules/electron/dist ]; then
    step "Electron"
    bun node_modules/electron/install.js
    ok "downloaded"
  fi
  ./scripts/build-app.sh --install
elif [ "$DO_BUILD" = 1 ]; then
  step "Building UI"
  bun run build
  ok "built to dist/ — 'bun run start' now serves everything on one port"
fi

# ── done ──────────────────────────────────────────────────────────────────────
printf "\n%s✓ ready%s\n\n" "$GREEN" "$RESET"
if [ ${#NOTES[@]} -gt 0 ]; then
  printf "%sBefore you start:%s\n" "$BOLD" "$RESET"
  for n in "${NOTES[@]}"; do printf "  • %s\n" "$n"; done
  printf "\n"
fi
if [ "$MODE" = app ]; then
  cat <<EOF
${BOLD}Start it:${RESET}
  open "$APP_PATH"

The app was built on this Mac, so macOS opens it without a warning.
Update later with:  ./install.sh --update

The daemon binds 127.0.0.1 only. It can start Claude sessions with real file
access, so do not expose it to your network.
EOF
else
  cat <<EOF
${BOLD}Start it:${RESET}
  ./start.sh          dev mode  — daemon on :5757, UI on http://localhost:5758
  bun run start       single    — everything on http://localhost:5757

Update later with:  ./install.sh --update
Want the Mac app instead?  ./install.sh --app

The daemon binds 127.0.0.1 only. It can start Claude sessions with real file
access, so do not expose it to your network.
EOF
fi
printf "\n"
