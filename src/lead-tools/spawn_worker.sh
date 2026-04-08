#!/bin/bash
# Spawn a worker via the installed coordinator runtime.
# Usage: spawn_worker.sh <directory> <prompt> [model] [task_id] [layout]

set -euo pipefail

DIR="${1:?Usage: spawn_worker.sh <directory> <prompt> [model] [task_id] [layout]}"
PROMPT="${2:?Missing prompt}"
MODEL="${3:-sonnet}"
TASK_ID="${4:-W$(date +%s)}"
LAYOUT="${5:-split}"
CLAUDE_RUNTIME_DIR="${CLAUDE_RUNTIME_DIR:-$HOME/.claude}"

CLI="$CLAUDE_RUNTIME_DIR/mcp-coordinator/scripts/worker-cli.mjs"
if [ ! -f "$CLI" ]; then
  echo "Coordinator worker CLI not found: $CLI" >&2
  exit 1
fi

exec node "$CLI" spawn "$DIR" "$PROMPT" "$MODEL" "$TASK_ID" "$LAYOUT"
