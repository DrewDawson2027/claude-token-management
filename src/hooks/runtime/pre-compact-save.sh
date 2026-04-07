#!/bin/bash
# Pre-Compact State Save — preserves session context before context compaction
# Triggered by PreCompact hook
# Ensures agents can recover working state after context window is compacted
INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
TRIGGER=$(echo "$INPUT" | jq -r '.trigger // "unknown"')
CWD=$(echo "$INPUT" | jq -r '.cwd // "unknown"')

STATE_DIR="$HOME/.claude/session-cache"
mkdir -p "$STATE_DIR"

# Save compaction event with session context
STATE_FILE="$STATE_DIR/compaction-state.json"
jq -c -n \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg session "${SESSION_ID:0:8}" \
  --arg trigger "$TRIGGER" \
  --arg cwd "$CWD" \
  '{ts:$ts, session:$session, trigger:$trigger, cwd:$cwd, recovery_hint:"Check session-cache/*.md files for preserved context. Plans and todos in .planning/ survive compaction."}' \
  > "$STATE_FILE"

# Append to compaction log for pattern analysis
COMPACT_LOG="$STATE_DIR/compaction-log.jsonl"
jq -c -n \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg session "${SESSION_ID:0:8}" \
  --arg trigger "$TRIGGER" \
  '{ts:$ts, session:$session, trigger:$trigger}' \
  >> "$COMPACT_LOG"

# Auto-truncate compaction log
if [ -f "$COMPACT_LOG" ]; then
  LINES=$(wc -l < "$COMPACT_LOG" 2>/dev/null | tr -d ' ')
  if [ "$LINES" -gt 100 ]; then
    tail -50 "$COMPACT_LOG" > "$COMPACT_LOG.tmp"
    mv "$COMPACT_LOG.tmp" "$COMPACT_LOG"
  fi
fi

exit 0
