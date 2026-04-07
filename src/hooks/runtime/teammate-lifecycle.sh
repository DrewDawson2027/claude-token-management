#!/bin/bash
# Teammate lifecycle telemetry hook.
# Tracks native Agent Teams lifecycle events in activity.jsonl + session metadata.
umask 077

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/portable.sh
# shellcheck disable=SC1091
source "$HOOK_DIR/lib/portable.sh"
require_jq

EVENT_NAME="${1:-unknown}"
INPUT=$(cat)

RAW_SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // .session // ""')
SESSION_ID=""
if [[ "$RAW_SESSION_ID" =~ ^[A-Za-z0-9_-]{8,64}$ ]]; then
  SESSION_ID="${RAW_SESSION_ID:0:8}"
fi

CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
PROJECT=$(basename "${CWD:-unknown}")
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

TEAMMATE_ID=$(echo "$INPUT" | jq -r '.teammate_session_id // .teammate_id // .teammate // ""')
TASK_ID=$(echo "$INPUT" | jq -r '.task_id // .task.id // ""')
DETAIL=$(echo "$INPUT" | jq -c '{reason: (.reason // ""), status: (.status // ""), summary: (.summary // "")}')

ACTIVITY_FILE=~/.claude/terminals/activity.jsonl
mkdir -p ~/.claude/terminals

EVENT_JSON=$(jq -c -n \
  --arg ts "$NOW" \
  --arg session "${SESSION_ID:-unknown}" \
  --arg tool "$EVENT_NAME" \
  --arg teammate "$TEAMMATE_ID" \
  --arg task "$TASK_ID" \
  --arg project "$PROJECT" \
  --arg detail "$DETAIL" \
  '{
    ts: $ts,
    session: $session,
    tool: $tool,
    teammate: $teammate,
    task_id: $task,
    project: $project,
    detail: ($detail | fromjson?)
  }')

TMP_EVENT=$(mktemp)
printf "%s\n" "$EVENT_JSON" > "$TMP_EVENT"
portable_flock_append "${ACTIVITY_FILE}.lock" "cat '$TMP_EVENT' >> '$ACTIVITY_FILE'"
rm -f "$TMP_EVENT"

# Best-effort session enrichment (never blocks the parent tool flow).
if [ -n "$SESSION_ID" ]; then
  SESSION_FILE=~/.claude/terminals/session-${SESSION_ID}.json
  if [ -f "$SESSION_FILE" ]; then
    TMP=$(mktemp)
    jq --arg now "$NOW" \
       --arg event "$EVENT_NAME" \
       --arg task "$TASK_ID" \
       --arg teammate "$TEAMMATE_ID" \
       '
       .teammate_events = ((.teammate_events // 0) + 1) |
       .last_teammate_event = {
         t: $now,
         event: $event,
         task_id: $task,
         teammate: $teammate
       }
       ' "$SESSION_FILE" > "$TMP" 2>/dev/null && mv "$TMP" "$SESSION_FILE"
  fi
fi

# Quality gate check — only for TaskCompleted events
if [[ "$EVENT_NAME" == "TaskCompleted" ]]; then
  GATE_SCRIPT=""
  if [[ -n "$CLAUDE_LEAD_QUALITY_GATE" && -x "$CLAUDE_LEAD_QUALITY_GATE" ]]; then
    GATE_SCRIPT="$CLAUDE_LEAD_QUALITY_GATE"
  elif [[ -x "${CWD}/.quality-gate.sh" ]]; then
    GATE_SCRIPT="${CWD}/.quality-gate.sh"
  fi

  if [[ -n "$GATE_SCRIPT" ]]; then
    GATE_OUTPUT=$(echo "$INPUT" | "$GATE_SCRIPT" "$EVENT_NAME" 2>&1)
    GATE_EXIT=$?
    if [[ "$GATE_EXIT" -eq 2 ]]; then
      printf "Quality gate FAILED for task %s:\n%s\n" "$TASK_ID" "$GATE_OUTPUT" >&2
      exit 2
    fi
  fi
fi

exit 0
