#!/usr/bin/env bash
# Run this checkout next to the installed app, on its own ports and its own data.
#
#   ./scripts/dev-beside.sh           http://localhost:5768, data in ~/.claude-dashboard-dev
#   ./scripts/dev-beside.sh --watch   and restart the daemon when a server file is saved
set -euo pipefail
exec "$(dirname "$0")/dev.sh" --beside "$@"
