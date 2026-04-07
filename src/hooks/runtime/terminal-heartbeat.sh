#!/bin/bash
# Universal Terminal Heartbeat v2.2 — rate-limited, self-healing, versioned, injection-safe
# Triggered by PostToolUse on Edit|Write|Bash|Read
# Tracks: activity log, session liveness, files touched, tool counts, recent ops
#
# RATE LIMIT: Max 1 full heartbeat per 5 seconds per session.
# Between beats, only the activity log is appended (cheap).
#
# All jq calls use --arg for safe value passing (no string interpolation in filters).
# All date/stat calls use portable.sh for cross-platform compatibility.
umask 077

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
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
if [ "$TOOL_NAME" = "Bash" ]; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.command // "unknown"' | head -1 | cut -c1-80)
else
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // "unknown"')
fi
CWD=$(echo "$INPUT" | jq -r '.cwd // "unknown"')
PROJECT=$(basename "$CWD")
SID8="${RAW_SESSION_ID:0:8}"
FILE_BASE=$(basename "$FILE_PATH")

mkdir -p ~/.claude/terminals
INBOX_DIR=~/.claude/terminals/inbox
mkdir -p "$INBOX_DIR"

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

MAX_TURNS_MESSAGE=""

# ─── ACTIVITY LOG (always fires before cooldown — intentional by design) ───
# The rate-limit check is AFTER this block. Activity log gets every event;
# the full session-file update is rate-limited to 1/5s. This is correct behavior.
ACTIVITY_FILE=~/.claude/terminals/activity.jsonl
JSON_LINE=$(jq -n --arg ts "$NOW" --arg session "$SID8" --arg tool "$TOOL_NAME" \
      --arg file "$FILE_BASE" --arg path "$FILE_PATH" --arg project "$PROJECT" \
      '{ts:$ts,session:$session,tool:$tool,file:$file,path:$path,project:$project}')
portable_flock_append "${ACTIVITY_FILE}.lock" "echo '$JSON_LINE' >> '$ACTIVITY_FILE'"

# ─── RATE LIMIT CHECK (portable locking) ───
LOCK_FILE="/tmp/claude-heartbeat-${SID8}.lock"
COOLDOWN=5  # seconds
LOCK_PREEXISTED=false
[ -e "$LOCK_FILE" ] && LOCK_PREEXISTED=true

if ! portable_flock_try "$LOCK_FILE"; then
  exit 0  # Another heartbeat is running, activity log already written
fi
# Check lock file age (mtime) for cooldown
LOCK_AGE=$(( $(date +%s) - $(get_file_mtime_epoch "$LOCK_FILE") ))
if $LOCK_PREEXISTED && [ "$LOCK_AGE" -lt "$COOLDOWN" ] && [ "$LOCK_AGE" -ge 0 ]; then
  portable_flock_release "$LOCK_FILE"
  exit 0  # Skip full heartbeat, activity log already written
fi
touch "$LOCK_FILE"

# ─── FULL HEARTBEAT (rate-limited to 1 per 5s) ───

# Capture TTY (portable, walks process tree)
CURR_TTY=$(get_tty)
TRACK_CURRENT_FILE="no"
if { [ "$TOOL_NAME" = "Read" ] || [ "$TOOL_NAME" = "Edit" ] || [ "$TOOL_NAME" = "Write" ]; } && [ "$FILE_PATH" != "unknown" ]; then
  TRACK_CURRENT_FILE="yes"
fi

SESSION_FILE=~/.claude/terminals/session-${SID8}.json
SCHEMA_VERSION=2  # Increment when adding new fields

if [ -f "$SESSION_FILE" ]; then
  TMP=$(mktemp)

  # Use jq --arg for all dynamic values (safe against special chars in filenames)
  # Worker identity env vars (set by coord_spawn_worker for interactive workers)
  WORKER_NAME="${CLAUDE_WORKER_NAME:-}"
  WORKER_TASK_ID="${CLAUDE_WORKER_TASK_ID:-}"
  WORKER_MAX_TURNS="${CLAUDE_WORKER_MAX_TURNS:-}"

  jq --arg now "$NOW" \
     --arg tool "$TOOL_NAME" \
     --arg file_base "$FILE_BASE" \
     --arg file_path "$FILE_PATH" \
     --arg tty "$CURR_TTY" \
     --arg raw_session_id "$RAW_SESSION_ID" \
     --argjson schema "$SCHEMA_VERSION" \
     --arg is_write_edit "$([ "$TOOL_NAME" = "Write" ] || [ "$TOOL_NAME" = "Edit" ] && echo "yes" || echo "no")" \
     --arg track_current "$TRACK_CURRENT_FILE" \
     --arg worker_name "$WORKER_NAME" \
     --arg worker_task "$WORKER_TASK_ID" \
     '
     .last_active = $now |
     .last_tool = $tool |
     .last_file = $file_base |
     .claude_session_id = $raw_session_id |
     .schema_version = $schema |
     (if $tty != "" then .tty = $tty else . end) |
     (if $worker_name != "" then .worker_name = $worker_name else . end) |
     (if $worker_task != "" then .current_task = $worker_task else . end) |
     .tool_counts = ((.tool_counts // {}) | .[$tool] = ((.[$tool] // 0) + 1)) |
     .turn_count = ((.turn_count // 0) + 1) |
     (if $is_write_edit == "yes" then
       .files_touched = (((.files_touched // []) | map(select(. != $file_path))) + [$file_path])[-30:]
     else . end) |
     (if $track_current == "yes" then .current_files = [$file_path] else . end) |
     .recent_ops = (((.recent_ops // []) + [{"t": $now, "tool": $tool, "file": $file_base}])[-10:])
     ' "$SESSION_FILE" > "$TMP" 2>/dev/null && mv "$TMP" "$SESSION_FILE"

  # ─── MAX TURNS ENFORCEMENT ───
  if [ -n "$WORKER_MAX_TURNS" ] && [ -n "$WORKER_TASK_ID" ]; then
    CURRENT_TURNS=$(jq -r '.turn_count // 0' "$SESSION_FILE" 2>/dev/null || echo "0")
    if [ "$CURRENT_TURNS" -ge "$WORKER_MAX_TURNS" ]; then
      MAX_TURNS_MESSAGE="[MAX_TURNS_REACHED] Task ${WORKER_TASK_ID} hit limit of ${WORKER_MAX_TURNS} turns. Terminating."
      jq -n --arg ts "$NOW" --arg content "$MAX_TURNS_MESSAGE" \
        '{ts:$ts,from:"coordinator",priority:"urgent",content:$content}' \
        >> "${INBOX_DIR}/${SID8}.jsonl" 2>/dev/null
      META_FILE=~/.claude/terminals/results/${WORKER_TASK_ID}.meta.json
      if [ -f "$META_FILE" ]; then
        LEAD_SID=$(jq -r '.notify_session_id // empty' "$META_FILE" 2>/dev/null || true)
        if [ -n "$LEAD_SID" ]; then
          jq -n --arg ts "$NOW" --arg task "$WORKER_TASK_ID" --argjson max "$WORKER_MAX_TURNS" \
            '{ts:$ts,from:"coordinator",priority:"urgent",content:("[MAX_TURNS_REACHED] Worker " + $task + " hit " + ($max|tostring) + " turns. Auto-terminated.")}' \
            >> "${INBOX_DIR}/${LEAD_SID}.jsonl" 2>/dev/null
        fi
        PID_FILE=~/.claude/terminals/results/${WORKER_TASK_ID}.pid
        if [ -f "$PID_FILE" ]; then
          WORKER_PID=$(cat "$PID_FILE" 2>/dev/null)
          if [[ "$WORKER_PID" =~ ^[0-9]+$ ]]; then
            kill -TERM "$WORKER_PID" 2>/dev/null || true
          fi
        fi
      fi
    fi
  fi
else
  # Fallback: create session file from PostToolUse context using jq (safe JSON construction)
  BRANCH=$(cd "$CWD" 2>/dev/null && git branch --show-current 2>/dev/null || echo "none")

  WORKER_NAME="${CLAUDE_WORKER_NAME:-}"
  WORKER_TASK_ID="${CLAUDE_WORKER_TASK_ID:-}"

  jq -n \
    --arg session "$SID8" \
    --arg claude_session_id "$RAW_SESSION_ID" \
    --arg project "$PROJECT" \
    --arg branch "$BRANCH" \
    --arg cwd "$CWD" \
    --arg now "$NOW" \
    --arg tool "$TOOL_NAME" \
    --arg file_base "$FILE_BASE" \
    --arg file_path "$FILE_PATH" \
    --arg tty "$CURR_TTY" \
    --argjson schema "$SCHEMA_VERSION" \
    --arg track_current "$TRACK_CURRENT_FILE" \
    --arg worker_name "$WORKER_NAME" \
    --arg worker_task "$WORKER_TASK_ID" \
    '
    {
      session: $session,
      claude_session_id: $claude_session_id,
      status: "active",
      project: $project,
      branch: $branch,
      cwd: $cwd,
      started: $now,
      last_active: $now,
      last_tool: $tool,
      last_file: $file_base,
      source: "heartbeat-fallback",
      schema_version: $schema,
      tool_counts: {($tool): 1},
      turn_count: 1,
      files_touched: [],
      recent_ops: [{"t": $now, "tool": $tool, "file": $file_base}]
    } |
    (if $track_current == "yes" then .current_files = [$file_path] else . end) |
    (if $tty != "" then .tty = $tty else . end) |
    (if $worker_name != "" then .worker_name = $worker_name else . end) |
    (if $worker_task != "" then .current_task = $worker_task else . end)
    ' > "$SESSION_FILE"
fi

# Track plan file writes (using --arg for safe path handling)
case "$FILE_PATH" in
  */.claude/plans/*.md)
    if [ -f "$SESSION_FILE" ]; then
      TMP=$(mktemp)
      jq --arg plan "$FILE_PATH" '.plan_file = $plan' "$SESSION_FILE" > "$TMP" && mv "$TMP" "$SESSION_FILE"
    fi
    ;;
esac

# ─── AUTO-STALE: Mark other sessions stale if inactive >30s ───
# Only check every 60s (not every heartbeat) by using a separate lock
STALE_LOCK="/tmp/claude-stale-check.lock"
STALE_COOLDOWN=60
STALE_LOCK_PREEXISTED=false
[ -e "$STALE_LOCK" ] && STALE_LOCK_PREEXISTED=true

DO_STALE=false
if portable_flock_try "$STALE_LOCK"; then
  STALE_AGE=$(( $(date +%s) - $(get_file_mtime_epoch "$STALE_LOCK") ))
  if { ! $STALE_LOCK_PREEXISTED; } || [ "$STALE_AGE" -gt "$STALE_COOLDOWN" ] || [ "$STALE_AGE" -lt 0 ]; then
    DO_STALE=true
    touch "$STALE_LOCK"
  fi
  portable_flock_release "$STALE_LOCK"
fi

if $DO_STALE; then
  NOW_EPOCH=$(date +%s)
  for sf in ~/.claude/terminals/session-*.json; do
    [ -f "$sf" ] || continue
    [ "$sf" = "$SESSION_FILE" ] && continue

    SF_STATUS=$(jq -r '.status // "unknown"' "$sf" 2>/dev/null)
    [ "$SF_STATUS" != "active" ] && continue

    SF_LAST=$(jq -r '.last_active // "1970-01-01T00:00:00Z"' "$sf" 2>/dev/null)
    SF_EPOCH=$(parse_iso_to_epoch "$SF_LAST")
    SF_SID=$(jq -r '.session // ""' "$sf" 2>/dev/null)
    SF_TASK=$(jq -r '.current_task // empty' "$sf" 2>/dev/null)

    AGE=$(( NOW_EPOCH - SF_EPOCH ))

    # Mark stale after 30s (matches native Agent Teams idle detection)
    if [ "$AGE" -gt 30 ]; then
      TMP=$(mktemp)
      jq '.status = "stale"' "$sf" > "$TMP" 2>/dev/null && mv "$TMP" "$sf"

      # Notify lead only for the matching worker task (avoid cross-worker false alerts)
      [ -z "$SF_TASK" ] && continue
      for mf in ~/.claude/terminals/results/*.meta.json; do
        [ -f "$mf" ] || continue
        TASK_ID=$(jq -r '.task_id // empty' "$mf" 2>/dev/null || true)
        [ -z "$TASK_ID" ] && continue
        [ "$TASK_ID" != "$SF_TASK" ] && continue
        LEAD_SID=$(jq -r '.notify_session_id // empty' "$mf" 2>/dev/null || true)
        WORKER_MODE=$(jq -r '.mode // "pipe"' "$mf" 2>/dev/null || true)
        [ -z "$LEAD_SID" ] && continue
        [ "$WORKER_MODE" != "interactive" ] && continue
        # Notify lead that this interactive worker went stale
        IDLE_REPORTED=~/.claude/terminals/results/"$(basename "$mf" .meta.json)".${SF_SID}.idle-notified
        [ -f "$IDLE_REPORTED" ] && continue
        jq -n --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg sid "$SF_SID" \
          '{ts:$ts,from:"coordinator",priority:"normal",content:("[WORKER IDLE] Session " + $sid + " — inactive for >30s, marked stale.")}' \
          >> "${INBOX_DIR}/${LEAD_SID}.jsonl" 2>/dev/null
        touch "$IDLE_REPORTED"
      done
    fi
  done
fi

# Auto-truncate activity log (portable lock to avoid concurrent truncation)
# shellcheck disable=SC2016
portable_flock_append "${ACTIVITY_FILE}.lock" '
  LINES=$(wc -l < "'"$ACTIVITY_FILE"'" 2>/dev/null || echo 0)
  if [ "$LINES" -gt 600 ]; then
    tail -500 "'"$ACTIVITY_FILE"'" > "'"${ACTIVITY_FILE}"'.tmp" && mv "'"${ACTIVITY_FILE}"'.tmp" "'"$ACTIVITY_FILE"'"
  fi
'

if [ -n "$MAX_TURNS_MESSAGE" ]; then
  echo "$MAX_TURNS_MESSAGE"
fi

exit 0
