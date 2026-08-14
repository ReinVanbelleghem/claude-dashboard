#!/usr/bin/env bash
# Build a distributable zip of claude-dashboard.
#
# Ships source + a prebuilt dist/ so the recipient can run it without a build,
# and deliberately omits node_modules (bloat), the git history, and any local
# state. The dashboard keeps all of its own data in ~/.claude-dashboard, which is
# outside this directory — so nothing personal is in scope to begin with.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=scripts/preflight.sh
source scripts/preflight.sh

NAME="claude-dashboard"
OUT_DIR="build"

usage() {
  cat <<'EOF'
Usage: bun run package [options]

  --bump patch|minor|major   Raise the version in package.json before building.
  --version X.Y.Z            Set an exact version before building.
  -f, --force                Overwrite an existing zip for this version.
  -h, --help                 Show this message.

Examples:
  bun run package                    # repackage the current version
  bun run package --bump patch       # 1.0.0 → 1.0.1, then package
  bun run package --bump minor       # 1.0.0 → 1.1.0, then package
  bun run package --version 2.0.0    # set exactly, then package
EOF
}

BUMP=""
SET_VERSION=""
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --bump)          BUMP="${2:-}"; shift ;;
    --bump=*)        BUMP="${1#*=}" ;;
    patch|minor|major) BUMP="$1" ;;          # bare form: bun run package patch
    --version)       SET_VERSION="${2:-}"; shift ;;
    --version=*)     SET_VERSION="${1#*=}" ;;
    -f|--force)      FORCE=1 ;;
    -h|--help)       usage; exit 0 ;;
    *) printf "unknown option: %s\n\n" "$1"; usage; exit 1 ;;
  esac
  shift
done

ensure_bun_on_path
has_bun || { bad "bun is required to build the distributable"; exit 1; }

# ── version ───────────────────────────────────────────────────────────────────
read_version() {
  sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' package.json | head -1
}

# Rewrite via a temp file rather than `sed -i`, whose syntax differs between BSD
# (macOS) and GNU sed. Only the version string is touched, so formatting survives.
write_version() {
  local v="$1" tmp
  tmp="$(mktemp)"
  sed -E 's/("version"[[:space:]]*:[[:space:]]*)"[^"]*"/\1"'"$v"'"/' package.json > "$tmp"
  mv "$tmp" package.json
}

# Callers use this in a $(...) capture, so it must print NOTHING but the version:
# anything else would be swallowed into the version string. Validation therefore
# happens before the call, not in here.
bump_version() {
  local v="$1" kind="$2" major minor patch
  IFS=. read -r major minor patch <<<"$v"
  major="${major:-0}"; minor="${minor:-0}"; patch="${patch:-0}"
  case "$kind" in
    major) major=$((major + 1)); minor=0; patch=0 ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    patch) patch=$((patch + 1)) ;;
  esac
  printf "%s.%s.%s" "$major" "$minor" "$patch"
}

CURRENT="$(read_version)"
[ -n "$CURRENT" ] || { bad "no \"version\" field in package.json"; exit 1; }

if [ -n "$SET_VERSION" ] && [ -n "$BUMP" ]; then
  bad "--version and --bump are mutually exclusive"
  exit 1
fi

VERSION="$CURRENT"
if [ -n "$SET_VERSION" ]; then
  case "$SET_VERSION" in
    [0-9]*.[0-9]*.[0-9]*) VERSION="$SET_VERSION" ;;
    *) bad "version must look like X.Y.Z (got '$SET_VERSION')"; exit 1 ;;
  esac
elif [ -n "$BUMP" ]; then
  case "$BUMP" in
    patch|minor|major) ;;
    *) bad "unknown bump '$BUMP' — use patch, minor or major"; exit 1 ;;
  esac
  VERSION="$(bump_version "$CURRENT" "$BUMP")"
fi

ZIP="$OUT_DIR/$NAME-v$VERSION.zip"
STAGE="$OUT_DIR/$NAME"

# Catch the "shipped two different zips under one version" mistake before doing
# any work, rather than silently replacing what a colleague may already have.
if [ -e "$ZIP" ] && [ "$FORCE" = 0 ]; then
  step "Version"
  bad "$ZIP already exists"
  hint "bump it:      bun run package --bump patch"
  hint "or overwrite: bun run package --force"
  printf "\n"
  exit 1
fi

step "Version"
if [ "$VERSION" != "$CURRENT" ]; then
  write_version "$VERSION"
  ok "$CURRENT → $VERSION (written to package.json)"
else
  ok "$VERSION"
fi

# ── build ─────────────────────────────────────────────────────────────────────
step "Building UI"
bun run build

step "Staging"
rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE"

# An explicit allowlist, so a stray file in the working tree can never ride along.
COPY=(
  README.md
  install.sh
  start.sh
  package.json
  bun.lock
  tsconfig.json
  vite.config.ts
  index.html
  src
  server
  public
  dist
  scripts
)
for item in "${COPY[@]}"; do
  [ -e "$item" ] || { warn "skipping missing $item"; continue; }
  cp -R "$item" "$STAGE/"
done

# Finder metadata and stray local state never belong in a shared archive.
find "$STAGE" -name '.DS_Store' -delete
find "$STAGE" -name '*.log' -delete
rm -rf "$STAGE/node_modules" "$STAGE/build"
chmod +x "$STAGE/install.sh" "$STAGE/start.sh" "$STAGE/scripts/"*.sh

# ── belt and braces: refuse to ship anything that smells like a secret ─────────
step "Secret scan"
PATTERN='sk-ant-[A-Za-z0-9_-]{10,}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]+|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|chat\.googleapis\.com/v1/spaces/[A-Za-z0-9_-]+/messages\?key='
if grep -rEIl "$PATTERN" "$STAGE" >/dev/null 2>&1; then
  bad "possible secret found in the staged tree — refusing to package:"
  grep -rEIln "$PATTERN" "$STAGE" | sed 's/^/      /'
  exit 1
fi
ok "no credentials, keys or webhook URLs in the staged tree"

if find "$STAGE" -name '.env*' -o -name '*.pem' -o -name '*.key' | grep -q .; then
  bad "an env or key file made it into the staging tree — refusing to package"
  exit 1
fi
ok "no .env / .pem / .key files"

# ── zip ───────────────────────────────────────────────────────────────────────
step "Packaging"
( cd "$OUT_DIR" && zip -qr "$(basename "$ZIP")" "$NAME" -x '*/.DS_Store' )
rm -rf "$STAGE"

SIZE="$(du -h "$ZIP" | awk '{print $1}')"
printf "\n%s✓ %s%s  (%s)\n\n" "$GREEN" "$ZIP" "$RESET" "$SIZE"
cat <<EOF
Send that file. The recipient runs:

  unzip $(basename "$ZIP")
  cd $NAME
  ./install.sh
  ./start.sh
EOF
printf "\n"
