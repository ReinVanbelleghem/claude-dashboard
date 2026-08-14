#!/usr/bin/env bash
# One-shot setup for claude-dashboard.
#
# Checks every dependency the dashboard actually uses, offers to install the ones
# it can install safely, then fetches packages and builds the UI. Safe to re-run:
# nothing here is destructive, and everything already satisfied is left alone.
set -euo pipefail
cd "$(dirname "$0")"

# shellcheck source=scripts/preflight.sh
source scripts/preflight.sh

ASSUME_YES=0
DO_BUILD=1

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

  -y, --yes       Don't ask before installing a missing dependency.
      --no-build  Skip the UI build (start.sh's dev server builds on the fly).
  -h, --help      Show this message.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
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

# ── 5. ports ──────────────────────────────────────────────────────────────────
step "Ports"
for p in 5757 5758; do
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

# ── 6. packages + build ───────────────────────────────────────────────────────
step "Dependencies"
bun install
ok "packages installed"

if [ "$DO_BUILD" = 1 ]; then
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
cat <<EOF
${BOLD}Start it:${RESET}
  ./start.sh          dev mode  — daemon on :5757, UI on http://localhost:5758
  bun run start       single    — everything on http://localhost:5757

The daemon binds 127.0.0.1 only. It can start Claude sessions with real file
access, so do not expose it to your network.
EOF
printf "\n"
