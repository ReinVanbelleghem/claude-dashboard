#!/usr/bin/env bash
# Run the dashboard from this checkout: the daemon and the UI dev server together.
#
#   ./scripts/dev.sh                    on the usual ports, with the usual data
#   ./scripts/dev.sh --beside           next to the installed app: own ports, own data
#   ./scripts/dev.sh --watch            restart the daemon when a server file is saved
#   ./scripts/dev.sh --beside --watch   both
#
# Without --beside the installed app has to be quit first, since both want port 5757.
# --watch ends every session the daemon started each time it restarts.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=scripts/preflight.sh
source scripts/preflight.sh

for arg in "$@"; do
  case "$arg" in
    --beside) export DASHBOARD_BESIDE=1 ;;
    --watch) export DASHBOARD_WATCH=1 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) bad "unknown option: $arg"; exit 1 ;;
  esac
done

exec ./start.sh
