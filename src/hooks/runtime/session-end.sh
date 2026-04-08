#!/bin/bash
# Session End — marks session as closed with final stats preserved
# Triggered by SessionEnd hook
umask 077

CLAUDE_RUNTIME_DIR="${CLAUDE_RUNTIME_DIR:-$HOME/.claude}"
TERMINALS_DIR="$CLAUDE_RUNTIME_DIR/terminals"
GUARD_STATE_DIR="$CLAUDE_RUNTIME_DIR/hooks/session-state"

# Load portable utilities
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/portable.sh
# shellcheck disable=SC1091
source "$HOOK_DIR/lib/portable.sh"
require_jq

INPUT=$(cat)
RAW_SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
if ! [[ "$RAW_SESSION_ID" =~ ^[A-Za-z0-9_-]{8,64}$ ]]; then
  echo "WARN: Non-standard session_id, normalizing: ${RAW_SESSION_ID:0:32}" >&2
fi
SESSION_ID="${RAW_SESSION_ID:0:8}"

SESSION_FILE="$TERMINALS_DIR/session-${SESSION_ID}.json"
if [ -f "$SESSION_FILE" ]; then
  TMP=$(mktemp)
  # Mark closed but preserve files_touched, tool_counts, recent_ops for lead review
  jq '.status = "closed" | .ended = "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"' "$SESSION_FILE" > "$TMP" && mv "$TMP" "$SESSION_FILE"
fi

# Clean per-session guard state files
rm -f "${GUARD_STATE_DIR}/${SESSION_ID}.json" 2>/dev/null
rm -f "${GUARD_STATE_DIR}/${SESSION_ID}-reads.json" 2>/dev/null
rm -f "${GUARD_STATE_DIR}/${SESSION_ID}.json.lock" 2>/dev/null
rm -f "${GUARD_STATE_DIR}/${SESSION_ID}-reads.json.lock" 2>/dev/null

exit 0
