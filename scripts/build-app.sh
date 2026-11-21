#!/usr/bin/env bash
# Build "Claude Dashboard.app" (macOS, Apple silicon) into build/app/.
#
#   bun run app:mac             build it
#   bun run app:mac --install   build it and put it in /Applications
#
# The bundle carries everything the dashboard runs on: the built UI, the daemon's
# source with its dependencies, and a bun to run it. Nothing in it is personal;
# the dashboard keeps its data in ~/.claude-dashboard.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=scripts/preflight.sh
source scripts/preflight.sh

APP_NAME="Claude Dashboard"
OUT="build/app"
SRC="build/app-src"
DAEMON="build/app-daemon"
RES="build/app-resources"
# SIGN_ID names a code-signing identity in the keychain. The default, "-", signs
# ad hoc: fine to run, but macOS asks for Calendar access again after each build.
SIGN_ID="${SIGN_ID:--}"
INSTALL=0

for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) bad "unknown option: $arg"; exit 1 ;;
  esac
done

[ "$(uname -s)" = Darwin ] || { bad "the app is built on macOS only"; exit 1; }
[ "$(uname -m)" = arm64 ] || { bad "the app is built for Apple silicon only"; exit 1; }
ensure_bun_on_path
has_bun || { bad "bun is required to build the app"; exit 1; }
[ -d node_modules/electron/dist ] || { bad "electron is not installed"; hint "bun install && node node_modules/electron/install.js"; exit 1; }

VERSION="$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' package.json | head -1)"
BUILD="$VERSION-$(date +%Y%m%dT%H%M%S)"

step "Building UI"
bun run build

step "App icon"
mkdir -p "$RES"
if [ ! -f "$RES/icon.icns" ] || [ scripts/make-icons.py -nt "$RES/icon.icns" ]; then
  python3 scripts/make-icons.py --app-icon "$RES/icon-1024.png" >/dev/null
  rm -rf "$RES/icon.iconset"
  mkdir -p "$RES/icon.iconset"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$RES/icon-1024.png" --out "$RES/icon.iconset/icon_${size}x${size}.png" >/dev/null
    sips -z "$((size * 2))" "$((size * 2))" "$RES/icon-1024.png" --out "$RES/icon.iconset/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns -o "$RES/icon.icns" "$RES/icon.iconset"
  ok "rendered"
else
  ok "up to date"
fi

step "Daemon"
rm -rf "$DAEMON"
mkdir -p "$DAEMON"
cp -R server shared dist "$DAEMON/"
mkdir -p "$DAEMON/excalidraw-assets"
cp -R node_modules/@excalidraw/excalidraw/dist/prod/fonts "$DAEMON/excalidraw-assets/"
SDK_VERSION="$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' node_modules/@anthropic-ai/claude-agent-sdk/package.json | head -1)"
ZOD_VERSION="$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' node_modules/zod/package.json | head -1)"
cat > "$DAEMON/package.json" <<JSON
{
  "name": "claude-dashboard-daemon",
  "private": true,
  "version": "$VERSION",
  "build": "$BUILD",
  "type": "module",
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "$SDK_VERSION",
    "zod": "$ZOD_VERSION"
  }
}
JSON
(cd "$DAEMON" && bun install --production --silent)
BUN_BIN="$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$(command -v bun)")"
cp "$BUN_BIN" build/app-bun
ok "$BUILD, with bun $(bun --version)"

step "Shell"
rm -rf "$SRC"
mkdir -p "$SRC"
bun build ./electron/main.ts --target=node --format=esm -e electron --outfile="$SRC/main.mjs" >/dev/null
cp electron/preload.cjs "$SRC/preload.cjs"
cat > "$SRC/package.json" <<JSON
{
  "name": "claude-dashboard",
  "productName": "$APP_NAME",
  "private": true,
  "version": "$VERSION",
  "type": "module",
  "main": "main.mjs"
}
JSON
ok "bundled"

step "Packaging"
rm -rf "$OUT"
node_modules/.bin/electron-builder --mac dir --arm64 --config electron-builder.yml >/dev/null
APP="$OUT/mac-arm64/$APP_NAME.app"
[ -d "$APP" ] || { bad "electron-builder left no app at $APP"; exit 1; }
rm -rf "$APP/Contents/Resources/app/node_modules"
ditto "$DAEMON" "$APP/Contents/Resources/daemon"
ditto build/app-bun "$APP/Contents/Resources/bun"
ok "$APP"

step "Signing ($SIGN_ID)"
if [ "$SIGN_ID" != - ] && ! security find-identity -p codesigning | grep -q "\"$SIGN_ID\""; then
  bad "signing identity \"$SIGN_ID\" is not in the keychain"
  exit 1
fi
sign() { codesign --force --sign "$SIGN_ID" --entitlements scripts/entitlements.plist --timestamp=none "$@" 2>/dev/null; }
# Inside out, and never --deep: Claude Code and bun keep their makers' signatures,
# which is what their Keychain access and their notarisation hang on.
while IFS= read -r f; do
  case "$f" in
    */claude-agent-sdk-darwin-arm64/claude|*/Contents/Resources/bun) continue ;;
  esac
  if file -b "$f" | grep -q "Mach-O"; then sign "$f"; fi
done < <(find "$APP" -type f)
while IFS= read -r b; do sign "$b"; done < <(find "$APP" \( -name "*.framework" -o -name "*.app" \) | awk '{print gsub("/","/"), $0}' | sort -rn | cut -d' ' -f2-)
codesign --verify --strict "$APP"
ok "verified"

if [ "$INSTALL" = 1 ]; then
  step "Installing"
  DEST="/Applications/$APP_NAME.app"
  if pgrep -f "$DEST/Contents/MacOS/" >/dev/null 2>&1; then
    bad "$APP_NAME is running; quit it first (its daemon can stay up)"
    exit 1
  fi
  rm -rf "$DEST"
  ditto "$APP" "$DEST"
  ok "$DEST"
fi

printf "\n%sBuilt%s %s (%s)\n\n" "$BOLD" "$RESET" "$APP" "$(du -sh "$APP" | awk '{print $1}')"
