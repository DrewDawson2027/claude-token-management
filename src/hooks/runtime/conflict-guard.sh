#!/bin/bash
# PreToolUse conflict guard — warns before Edit/Write if another session has touched the same file.
# This is something Agent Teams fundamentally cannot do: pre-edit cross-session conflict detection.
#
# Advisory only: prints a warning but does NOT block the edit (exit 0 always).
# Runs on: Edit, Write
umask 077

# Quick-exit: if only one session exists, nothing can conflict — skip entire hook (~2ms)
SESSION_COUNT=$(find "$HOME/.claude/terminals" -maxdepth 1 -name 'session-*.json' 2>/dev/null | wc -l)
[ "$SESSION_COUNT" -lt 2 ] && exit 0

# Load portable utilities
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/portable.sh
# shellcheck disable=SC1091
source "$HOOK_DIR/lib/portable.sh"
require_jq

INPUT=$(cat)

RAW_SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
if ! [[ "$RAW_SESSION_ID" =~ ^[A-Za-z0-9_-]{8,64}$ ]]; then
  exit 0  # Advisory — don't block on invalid session
fi
SID8="${RAW_SESSION_ID:0:8}"
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
[ -z "$FILE_PATH" ] && exit 0

TERMINALS_DIR=~/.claude/terminals

# Check all other active sessions' files_touched arrays
for sf in "$TERMINALS_DIR"/session-*.json; do
  [ -f "$sf" ] || continue
  OTHER_SID=$(jq -r '.session // ""' "$sf" 2>/dev/null)
  [ "$OTHER_SID" = "$SID8" ] && continue

  OTHER_STATUS=$(jq -r '.status // "unknown"' "$sf" 2>/dev/null)
  [ "$OTHER_STATUS" = "closed" ] && continue

  # Check if this session has touched the same file
  MATCH=$(jq -r --arg fp "$FILE_PATH" '(.files_touched // [])[] | select(. == $fp)' "$sf" 2>/dev/null | head -1)
  if [ -n "$MATCH" ]; then
    OTHER_PROJECT=$(jq -r '.project // "unknown"' "$sf" 2>/dev/null)
    OTHER_TASK=$(jq -r '.current_task // "unknown task"' "$sf" 2>/dev/null)
    echo "WARNING: Session $OTHER_SID ($OTHER_PROJECT) has also touched $(basename "$FILE_PATH") — task: \"$OTHER_TASK\". Coordinate before editing." >&2
    # Advisory only — allow the edit
    exit 0
  fi
done

exit 0
