#!/bin/bash
# Universal Session Registry — registers EVERY Claude Code session with full metadata
# Triggered by SessionStart hook
# Captures transcript_path so the lead can read other sessions' conversations
umask 077

# Quick-exit: if this session is already registered, skip re-registration (~2ms)
# CLAUDE_SESSION_ID is set as an env var by Claude Code for all hooks.
[ -f "$HOME/.claude/terminals/session-${CLAUDE_SESSION_ID:0:8}.json" ] && exit 0

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
CWD=$(echo "$INPUT" | jq -r '.cwd // "unknown"')
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // "unknown"')
SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"')

mkdir -p ~/.claude/terminals

# Structured debug logging — no raw input (avoids logging sensitive data)
DEBUG_LOG=~/.claude/terminals/debug-session-register.log
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) session=$SESSION_ID cwd=$CWD source=$SOURCE" >> "$DEBUG_LOG"

# Auto-truncate debug log
DEBUG_LINES=$(wc -l < "$DEBUG_LOG" 2>/dev/null || echo 0)
if [ "$DEBUG_LINES" -gt 200 ]; then
  tail -150 "$DEBUG_LOG" > "$DEBUG_LOG.tmp"
  mv "$DEBUG_LOG.tmp" "$DEBUG_LOG"
fi

PROJECT=$(basename "$CWD")
BRANCH=$(cd "$CWD" 2>/dev/null && git branch --show-current 2>/dev/null || echo "none")

# Append to session log
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n \
  --arg ts "$NOW" \
  --arg session "$SESSION_ID" \
  --arg source "$SOURCE" \
  --arg project "$PROJECT" \
  --arg branch "$BRANCH" \
  --arg cwd "$CWD" \
  --arg transcript "$TRANSCRIPT" \
  '{ts:$ts,session:$session,event:"start",source:$source,project:$project,branch:$branch,cwd:$cwd,transcript:$transcript}' \
  >> ~/.claude/terminals/sessions.jsonl

# Capture TTY for reliable tab targeting by coord_wake_session
# Uses portable get_tty which walks the process tree
TTY=$(get_tty)
# Write per-session status file for quick lookup by lead
SESSION_FILE=~/.claude/terminals/session-"${SESSION_ID}".json
jq -n \
  --arg session "$SESSION_ID" \
  --arg claude_session_id "$RAW_SESSION_ID" \
  --arg project "$PROJECT" \
  --arg branch "$BRANCH" \
  --arg cwd "$CWD" \
  --arg transcript "$TRANSCRIPT" \
  --arg started "$NOW" \
  --arg last_active "$NOW" \
  --arg tty "$TTY" \
  '
  {
    session: $session,
    claude_session_id: $claude_session_id,
    status: "active",
    project: $project,
    branch: $branch,
    cwd: $cwd,
    transcript: $transcript,
    started: $started,
    last_active: $last_active
  } |
  (if $tty != "" then .tty = $tty else . end)
  ' > "$SESSION_FILE"

# Auto-truncate sessions log
LINES=$(wc -l < ~/.claude/terminals/sessions.jsonl 2>/dev/null || echo 0)
if [ "$LINES" -gt 200 ]; then
  tail -150 ~/.claude/terminals/sessions.jsonl > ~/.claude/terminals/sessions.tmp
  mv ~/.claude/terminals/sessions.tmp ~/.claude/terminals/sessions.jsonl
fi

# Fix 1: Set terminal tab title to session ID for wake targeting by coord_wake_session
printf '\e]0;claude-%s\a' "$SESSION_ID"

exit 0
