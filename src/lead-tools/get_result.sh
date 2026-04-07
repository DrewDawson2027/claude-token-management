#!/bin/bash
# Check worker output and completion status via the installed coordinator runtime.
# Usage: get_result.sh <task_id> [tail_lines]

set -euo pipefail

TASK_ID="${1:?Usage: get_result.sh <task_id> [tail_lines]}"
TAIL_LINES="${2:-100}"

CLI="$HOME/.claude/mcp-coordinator/scripts/worker-cli.mjs"
if [ ! -f "$CLI" ]; then
  echo "Coordinator worker CLI not found: $CLI" >&2
  exit 1
fi

exec node "$CLI" get-result "$TASK_ID" "$TAIL_LINES"
