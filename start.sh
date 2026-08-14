#!/usr/bin/env bash
# Starts the indexer daemon and the UI dev server together, and shuts both down
# on Ctrl-C. The daemon is the only process that reads ~/.claude.
set -euo pipefail
cd "$(dirname "$0")"

# Fails with a pointer at ./install.sh when bun or git is missing, instead of the
# "command not found" a first-time runner would otherwise get.
# shellcheck source=scripts/preflight.sh
source scripts/preflight.sh
require_deps_or_die

API_PORT="${PORT:-5757}"
UI_PORT=5758

if [ ! -d node_modules ]; then
  echo "→ installing dependencies…"
  bun install
fi

# A stale process holding the API port would leave the UI proxying into the void.
if lsof -ti tcp:"$API_PORT" >/dev/null 2>&1; then
  echo "!  port $API_PORT is already in use — is the dashboard already running?"
  echo "   free it with: kill \$(lsof -ti tcp:$API_PORT)"
  exit 1
fi

pids=()
cleanup() {
  trap - INT TERM EXIT
  for pid in "${pids[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
}
trap cleanup INT TERM EXIT

echo "→ daemon   http://localhost:$API_PORT"
# NOT --watch by default: the daemon is the parent process of every session you
# start from the dashboard, so reloading it on a file save kills those sessions
# mid-conversation. Opt in with DASHBOARD_WATCH=1 when working on the server.
if [ "${DASHBOARD_WATCH:-0}" = "1" ]; then
  echo "   (watch mode — saving a server file restarts the daemon and ends its sessions)"
  bun run --watch server/index.ts &
else
  bun run server/index.ts &
fi
pids+=($!)

# Give the daemon a moment to finish its backfill so the first page load has data.
sleep 2

echo "→ dashboard http://localhost:$UI_PORT"
bunx vite --port "$UI_PORT" &
pids+=($!)

wait
