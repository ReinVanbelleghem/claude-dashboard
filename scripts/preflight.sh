#!/usr/bin/env bash
# Shared dependency detection for claude-dashboard.
#
# Sourced by install.sh (which offers to fix what is missing) and by start.sh
# (which only fails fast with a pointer at install.sh). Not meant to be run
# directly — it defines helpers and sets variables, it does not install anything.

# ── output ────────────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi

ok()    { printf "  %s✓%s %s\n" "$GREEN"  "$RESET" "$*"; }
warn()  { printf "  %s!%s %s\n" "$YELLOW" "$RESET" "$*"; }
bad()   { printf "  %s✗%s %s\n" "$RED"    "$RESET" "$*"; }
hint()  { printf "      %s%s%s\n" "$DIM" "$*" "$RESET"; }
step()  { printf "\n%s%s%s\n" "$BOLD" "$*" "$RESET"; }

have() { command -v "$1" >/dev/null 2>&1; }

# ── platform ──────────────────────────────────────────────────────────────────
case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux)  OS=linux ;;
  *)      OS=other ;;
esac

# ── bun ───────────────────────────────────────────────────────────────────────
# bun installs to ~/.bun/bin. A shell that has not been restarted since the
# install will not have it on PATH yet, so we add it ourselves before looking.
BUN_BIN_DIR="${BUN_INSTALL:-$HOME/.bun}/bin"
ensure_bun_on_path() {
  case ":$PATH:" in
    *":$BUN_BIN_DIR:"*) ;;
    *) [ -d "$BUN_BIN_DIR" ] && export PATH="$BUN_BIN_DIR:$PATH" ;;
  esac
}

# ── required / optional dependency probes ─────────────────────────────────────
# Each returns 0 when satisfied. They print nothing, so callers decide the tone.
has_bun()    { ensure_bun_on_path; have bun; }
has_git()    { have git; }
has_claude() { have claude; }
has_notifier() { have terminal-notifier; }
has_claude_home() { [ -d "${CLAUDE_HOME:-$HOME/.claude}" ]; }

port_busy() {
  have lsof || return 1   # no lsof: assume free rather than block the install
  lsof -ti tcp:"$1" >/dev/null 2>&1
}

# ── install commands, per platform ────────────────────────────────────────────
BUN_INSTALL_CMD='curl -fsSL https://bun.sh/install | bash'

git_install_hint() {
  case "$OS" in
    macos) echo "xcode-select --install    # or: brew install git" ;;
    linux) echo "sudo apt install git      # or your distro's package manager" ;;
    *)     echo "https://git-scm.com/downloads" ;;
  esac
}

claude_install_hint() {
  echo "npm install -g @anthropic-ai/claude-code    # then run: claude"
}

# ── the fast path used by start.sh ────────────────────────────────────────────
# Fails with a pointer at install.sh rather than trying to repair anything.
require_deps_or_die() {
  local missing=0
  if ! has_bun; then
    bad "bun is not installed — the daemon and the build both run on it"
    missing=1
  fi
  if ! has_git; then
    bad "git is not installed — the diff and branch panels shell out to it"
    missing=1
  fi
  if [ "$missing" = 1 ]; then
    printf "\n  Run %s./install.sh%s to set this up.\n\n" "$BOLD" "$RESET"
    exit 1
  fi
}
