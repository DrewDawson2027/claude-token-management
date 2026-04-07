#!/bin/bash
# PreToolUse inbox check — surfaces messages from lead/other terminals
# Runs before EVERY tool call. If inbox has messages, prints them so the model sees them.
umask 077

# NOTE: No top-of-hook early-exit guard here by design.
# Permission enforcement (readOnly/planOnly/planRequired) must always run for
# every tool call — it reads tool_name from stdin to block restricted modes.
# A guard before stdin is read would bypass all permission checks.
# The inbox drain section (below) already skips when the inbox file is empty.

# Load portable utilities
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/portable.sh
# shellcheck disable=SC1091
source "$HOOK_DIR/lib/portable.sh"
require_jq

INPUT=$(cat)
IFS=$'\t' read -r RAW_SESSION_ID TOOL_NAME <<EOF
$(printf '%s' "$INPUT" | jq -r '[(.session_id // ""), (.tool_name // "unknown")] | @tsv' 2>/dev/null)
EOF
if ! [[ "$RAW_SESSION_ID" =~ ^[A-Za-z0-9_-]{8,64}$ ]]; then
  echo "WARN: Non-standard session_id format, normalizing: ${RAW_SESSION_ID:0:32}" >&2
fi
SESSION_ID="${RAW_SESSION_ID:0:8}"

# ─── PERMISSION MODE ENFORCEMENT (physically blocks tools per worker mode) ───
# Matches Claude's agent type tool restrictions: readOnly, editOnly, planOnly, acceptEdits
WORKER_TASK_ID="${CLAUDE_WORKER_TASK_ID:-}"
WORKER_NAME="${CLAUDE_WORKER_NAME:-}"
PERMISSION_MODE="${CLAUDE_WORKER_PERMISSION_MODE:-acceptEdits}"

# readOnly mode: blocks Edit/Write/Bash entirely (research/exploration workers)
if [ "$PERMISSION_MODE" = "readOnly" ]; then
  case "$TOOL_NAME" in
    Edit|Write|Bash)
      echo "BLOCKED: This worker is in readOnly mode. Only Read/Grep/Glob/WebSearch allowed."
      exit 2
      ;;
  esac
fi

# editOnly mode: blocks Bash (safe editing, no command execution)
if [ "$PERMISSION_MODE" = "editOnly" ]; then
  case "$TOOL_NAME" in
    Bash)
      echo "BLOCKED: This worker is in editOnly mode. Bash commands not allowed. Use Read/Edit/Write."
      exit 2
      ;;
  esac
fi

# planOnly mode: blocks Edit/Write/Bash until plan approved (enforced plan-first)
if [ "$PERMISSION_MODE" = "planOnly" ] || { [ -n "$WORKER_TASK_ID" ] && [ "$PERMISSION_MODE" = "acceptEdits" ]; }; then
  if [ -n "$WORKER_TASK_ID" ]; then
    META_FILE=~/.claude/terminals/results/${WORKER_TASK_ID}.meta.json
    if [ -f "$META_FILE" ]; then
      REQUIRE_PLAN=$(jq -r '.require_plan // false' "$META_FILE" 2>/dev/null)
      IS_PLAN_MODE="false"
      [ "$PERMISSION_MODE" = "planOnly" ] && IS_PLAN_MODE="true"
      [ "$REQUIRE_PLAN" = "true" ] && IS_PLAN_MODE="true"
      if [ "$IS_PLAN_MODE" = "true" ]; then
        case "$TOOL_NAME" in
          Edit|Write|Bash)
            APPROVAL_FILE=~/.claude/terminals/results/${WORKER_TASK_ID}.approval
            if [ ! -f "$APPROVAL_FILE" ]; then
              echo "BLOCKED: Plan approval required before editing. Write your plan to results/${WORKER_TASK_ID}.plan.md, then notify lead and wait for '[APPROVED]' in your inbox."
              exit 2
            fi
            APPROVAL_STATUS=$(jq -r '.status // ""' "$APPROVAL_FILE" 2>/dev/null)
            if [ "$APPROVAL_STATUS" != "approved" ]; then
              echo "BLOCKED: Plan not yet approved (status: ${APPROVAL_STATUS}). Wait for lead approval before making edits."
              exit 2
            fi
            ;;
        esac
      fi
    fi
  fi
fi
INBOX_DIR=~/.claude/terminals/inbox
INBOX="${INBOX_DIR}/${SESSION_ID}.jsonl"
RESULTS_DIR=~/.claude/terminals/results
INTERRUPT_ON_NOTICES="${CLAUDE_LEAD_INTERRUPT_ON_NOTICES:-0}"

mkdir -p "$INBOX_DIR"

ROUTE_SCAN_STAMP="$RESULTS_DIR/.route-scan.stamp"
ROUTE_SCAN_COOLDOWN="${CLAUDE_LEAD_ROUTE_SCAN_COOLDOWN:-10}"
ROUTE_SCAN_MAX_PER_PASS="${CLAUDE_LEAD_ROUTE_SCAN_MAX_PER_PASS:-8}"
DO_ROUTE_SCAN=false
if [ -z "$WORKER_TASK_ID" ] && [ -z "$WORKER_NAME" ]; then
  DO_ROUTE_SCAN=true
  if [ -e "$ROUTE_SCAN_STAMP" ]; then
    ROUTE_SCAN_AGE=$(( $(date +%s) - $(get_file_mtime_epoch "$ROUTE_SCAN_STAMP") ))
    if [ "$ROUTE_SCAN_AGE" -ge 0 ] && [ "$ROUTE_SCAN_AGE" -lt "$ROUTE_SCAN_COOLDOWN" ]; then
      DO_ROUTE_SCAN=false
    fi
  fi
fi
if $DO_ROUTE_SCAN; then
  touch "$ROUTE_SCAN_STAMP"
  ROUTED_THIS_PASS=0
  for donefile in "$RESULTS_DIR"/*.meta.json.done; do
    [ -f "$donefile" ] || continue
    if [ "$ROUTED_THIS_PASS" -ge "$ROUTE_SCAN_MAX_PER_PASS" ]; then
      break
    fi
    TASK_ID=$(basename "$donefile" .meta.json.done)
    REPORTED="$RESULTS_DIR/${TASK_ID}.reported"
    [ -f "$REPORTED" ] && continue
    ROUTE_LOCK="$RESULTS_DIR/${TASK_ID}.route.lock"
    if ! mkdir "$ROUTE_LOCK" 2>/dev/null; then
      continue
    fi

    META_FILE="$RESULTS_DIR/${TASK_ID}.meta.json"
    TARGET_SESSION=""
    if [ -f "$META_FILE" ]; then
      TARGET_SESSION=$(jq -r '.notify_session_id // .requested_by // empty' "$META_FILE" 2>/dev/null || true)
    fi

    ROUTED=false
    if [[ "$TARGET_SESSION" =~ ^[A-Za-z0-9_-]{8}$ ]]; then
      TARGET_INBOX="${INBOX_DIR}/${TARGET_SESSION}.jsonl"
      if [ -L "$TARGET_INBOX" ]; then
        rmdir "$ROUTE_LOCK" 2>/dev/null || true
        continue
      fi
      DONE_SUMMARY=$(tr -d '\000-\010\013\014\016-\037\177\200-\237' < "$donefile" | head -c 4000)
      RESULT_TAIL=$(tail -20 "$RESULTS_DIR/${TASK_ID}.txt" 2>/dev/null | tr -d '\000-\010\013\014\016-\037\177\200-\237' | head -c 12000)
      if jq -n \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg task "$TASK_ID" \
        --arg done_summary "$DONE_SUMMARY" \
        --arg tail "$RESULT_TAIL" \
        '
        {
          ts: $ts,
          from: "coordinator",
          priority: "normal",
          content: (
            "[WORKER COMPLETED] " + $task + "\n" + $done_summary +
            (if $tail != "" then "\n\n" + $tail else "" end)
          )
        }
        ' >> "$TARGET_INBOX"; then
        ROUTED=true
      fi
    fi

    if [ "$ROUTED" = true ]; then
      ROUTED_THIS_PASS=$((ROUTED_THIS_PASS + 1))
      touch "$REPORTED"
    fi
    rmdir "$ROUTE_LOCK" 2>/dev/null || true
  done
fi

# ─── Plan Approval Check ───
# If this worker has a pending approval file, check and deliver it
RESULTS_DIR_CHECK=~/.claude/terminals/results
if [ -n "$WORKER_TASK_ID" ]; then
  approval_file="$RESULTS_DIR_CHECK/${WORKER_TASK_ID}.approval"
  APPROVAL_REPORTED="$RESULTS_DIR_CHECK/${WORKER_TASK_ID}.approval.reported"
  if [ -f "$approval_file" ] && [ ! -f "$APPROVAL_REPORTED" ]; then
    META_CHECK="$RESULTS_DIR_CHECK/${WORKER_TASK_ID}.meta.json"
    NOTIFY_SID=""
    if [ -f "$META_CHECK" ]; then
      NOTIFY_SID=$(jq -r '.notify_session_id // empty' "$META_CHECK" 2>/dev/null || true)
    fi
    if [ "$NOTIFY_SID" = "$SESSION_ID" ] || [ -z "$NOTIFY_SID" ]; then
      APPROVAL_STATUS=$(jq -r '.status // "unknown"' "$approval_file" 2>/dev/null || echo "unknown")
      APPROVAL_MSG=$(jq -r '.message // .feedback // ""' "$approval_file" 2>/dev/null || true)
      echo "--- PLAN APPROVAL UPDATE ---"
      echo "Task: $WORKER_TASK_ID"
      echo "Status: $APPROVAL_STATUS"
      [ -n "$APPROVAL_MSG" ] && echo "Message: $APPROVAL_MSG"
      echo "--- END APPROVAL ---"
      touch "$APPROVAL_REPORTED"
    fi
  fi
fi

# ─── Task Board Suggestions (for interactive workers) ───
# Check for unassigned, unblocked pending tasks and suggest them
TASKS_DIR=~/.claude/terminals/tasks
if [ "${CLAUDE_LEAD_SHOW_TASK_SUGGESTIONS:-0}" = "1" ] && [ -d "$TASKS_DIR" ]; then
  PENDING_TASKS=""
  for tf in "$TASKS_DIR"/*.json; do
    [ -f "$tf" ] || continue
    T_STATUS=$(jq -r '.status // ""' "$tf" 2>/dev/null)
    T_ASSIGNEE=$(jq -r '.assignee // ""' "$tf" 2>/dev/null)
    [ "$T_STATUS" != "pending" ] && continue
    [ -n "$T_ASSIGNEE" ] && continue
    # Check not blocked
    T_BLOCKERS=$(jq -r '.blocked_by // [] | length' "$tf" 2>/dev/null || echo "0")
    [ "$T_BLOCKERS" -gt 0 ] && continue
    T_ID=$(jq -r '.task_id // ""' "$tf" 2>/dev/null)
    T_SUBJECT=$(jq -r '.subject // ""' "$tf" 2>/dev/null)
    PENDING_TASKS="${PENDING_TASKS}  - ${T_ID}: ${T_SUBJECT}\n"
  done
  if [ -n "$PENDING_TASKS" ]; then
    echo "--- AVAILABLE TASKS (unassigned, unblocked) ---"
    printf "%b" "$PENDING_TASKS"
    echo "Claim with: coord_update_task task_id=<ID> assignee=<your_name> status=in_progress"
    echo "--- END AVAILABLE TASKS ---"
  fi
fi

# --- MANDATORY ACTION QUEUE (mechanical dispatch = Agent Teams SendMessage) ---
MANDATORY_QUEUE="$HOME/.claude/hooks/session-state/mandatory-actions.jsonl"
DONE_DIR="$HOME/.claude/hooks/session-state/done"
DEAD_LETTER="$HOME/.claude/hooks/session-state/dead-letter.jsonl"
CHAINS_DIR="$HOME/.claude/hooks/session-state/chains"
if [ "${CLAUDE_LEAD_ENABLE_MANDATORY_ACTIONS:-1}" = "1" ] && [ -f "$MANDATORY_QUEUE" ] && [ -s "$MANDATORY_QUEUE" ]; then
  mkdir -p "$DONE_DIR" "$CHAINS_DIR"
  NOW_EPOCH=$(date +%s)
  REMAINING=""
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    AID=$(echo "$line" | jq -r '.id // ""' 2>/dev/null)
    ASTATUS=$(echo "$line" | jq -r '.status // "pending"' 2>/dev/null)
    ATYPE=$(echo "$line" | jq -r '.type // ""' 2>/dev/null)
    AINST=$(echo "$line" | jq -r '.instruction // ""' 2>/dev/null)
    DCOUNT=$(echo "$line" | jq -r '.delivery_count // 0' 2>/dev/null)
    CREATED=$(echo "$line" | jq -r '.created_at // ""' 2>/dev/null)
    CHAIN_ID=$(echo "$line" | jq -r '.chain_id // ""' 2>/dev/null)
    [ "$ASTATUS" = "completed" ] && continue

    if [ -n "$AID" ] && [ -f "$DONE_DIR/$AID" ]; then
      if [ -n "$CHAIN_ID" ] && [ -f "$CHAINS_DIR/$CHAIN_ID.json" ]; then
        NEXT=$(python3 "$HOME/.claude/hooks/chain-advance.py" "$CHAINS_DIR/$CHAIN_ID.json" 2>/dev/null)
        [ -n "$NEXT" ] && echo "$NEXT" >> "$MANDATORY_QUEUE"
      fi
      continue
    fi

    TTL=1800
    if [ "$ATYPE" = "review-after-commit" ] || [ "$ATYPE" = "review-after-pr" ]; then
      TTL=3600
    fi
    if [ -n "$CREATED" ]; then
      CE=$(python3 - "$CREATED" <<'PY'
import sys
from datetime import datetime, timezone
raw = sys.argv[1]
try:
    dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    print(int(dt.timestamp()))
except Exception:
    print(0)
PY
)
      if [ "$CE" -gt 0 ] && [ $((NOW_EPOCH - CE)) -gt "$TTL" ]; then
        EXPIRED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        echo "$line" | jq -c ". + {expired_reason: \"ttl\", expired_at: \"$EXPIRED_AT\"}" >> "$DEAD_LETTER" 2>/dev/null
        continue
      fi
    fi

    LAST_DEL=$(echo "$line" | jq -r '.last_delivery_epoch // 0' 2>/dev/null)
    if [ "$DCOUNT" -gt 0 ] && [ "$LAST_DEL" -gt 0 ]; then
      BACKOFF=$((60 * (1 << (DCOUNT - 1))))
      [ "$BACKOFF" -gt 960 ] && BACKOFF=960
      if [ $((NOW_EPOCH - LAST_DEL)) -lt "$BACKOFF" ]; then
        REMAINING="${REMAINING}${line}
"
        continue
      fi
    fi

    NC=$((DCOUNT + 1))
    UL=$(echo "$line" | jq -c ".delivery_count = $NC | .last_delivery_epoch = $NOW_EPOCH" 2>/dev/null)
    REMAINING="${REMAINING}${UL}
"
    printf '\n\n!!! MANDATORY ACTION REQUIRED — ACT NOW BEFORE ANY OTHER WORK !!!\n[MANDATORY ACTION %s — delivery #%d]\n%s\n[To complete this action: touch ~/.claude/hooks/session-state/done/%s]\n!!! THIS MESSAGE REPEATS UNTIL DONE MARKER EXISTS — ACT IMMEDIATELY !!!\n\n' \
      "$ATYPE" "$NC" "$AINST" "$AID"
  done < "$MANDATORY_QUEUE"
  if [ -n "$REMAINING" ]; then
    printf '%s' "$REMAINING" > "$MANDATORY_QUEUE.tmp"
    mv "$MANDATORY_QUEUE.tmp" "$MANDATORY_QUEUE"
  else
    rm -f "$MANDATORY_QUEUE"
  fi
fi

# Crash-safe drain: copy inbox to temp, display, then delete original.
# If hook crashes after copy but before delete, messages are still in the original file
# and will be re-delivered next time (idempotent delivery > lost messages).
if [ -f "$INBOX" ] && [ -s "$INBOX" ]; then
  TMP_INBOX=$(mktemp)
  cp "$INBOX" "$TMP_INBOX"
  # Check for shutdown requests — surface them as a distinct block
  if grep -q "SHUTDOWN_REQUEST" "$TMP_INBOX" 2>/dev/null; then
    echo "--- SHUTDOWN REQUEST ---"
    echo "The project lead has requested you shut down gracefully."
    echo "If you have unsaved work, finish it now."
    echo "To approve shutdown, notify the lead that you are done."
    echo "To reject, continue working and notify the lead why."
    echo "--- END SHUTDOWN REQUEST ---"
  fi
  echo "--- INCOMING MESSAGES FROM COORDINATOR ---"
  tr -d '\000-\010\013\014\016-\037\177\200-\237' < "$TMP_INBOX"
  echo "--- END MESSAGES ---"
  # Only delete after successful display
  rm -f "$INBOX" "$TMP_INBOX"
fi

# ─── Focused Worker Auto-Stream ───
# When a worker is focused (via coord_focus_worker or coord_focus_next),
# show their latest output on each tool call. Emulates native Agent Teams'
# in-process output display.
FOCUS_STATE="$HOME/.claude/terminals/.focus-state"
FOCUS_DISPLAY_STAMP="$HOME/.claude/terminals/.focus-display.stamp"
FOCUS_DISPLAY_COOLDOWN="${CLAUDE_LEAD_FOCUS_COOLDOWN:-8}"
FOCUS_SHOWN=false

if [ -f "$FOCUS_STATE" ] && [ -z "$WORKER_TASK_ID" ]; then
  FOCUSED_NAME=$(cat "$FOCUS_STATE" 2>/dev/null)
  if [ -n "$FOCUSED_NAME" ]; then
    DO_FOCUS_DISPLAY=true

    # Cooldown check
    if [ -e "$FOCUS_DISPLAY_STAMP" ]; then
      FOCUS_AGE=$(( $(date +%s) - $(get_file_mtime_epoch "$FOCUS_DISPLAY_STAMP") ))
      if [ "$FOCUS_AGE" -ge 0 ] && [ "$FOCUS_AGE" -lt "$FOCUS_DISPLAY_COOLDOWN" ]; then
        DO_FOCUS_DISPLAY=false
      fi
    fi

    if $DO_FOCUS_DISPLAY; then
      touch "$FOCUS_DISPLAY_STAMP"
      # Find the focused worker's result file
      FOCUS_TASK_ID=""
      for meta in "$RESULTS_DIR"/*.meta.json; do
        [ -f "$meta" ] || continue
        WN=$(jq -r '.worker_name // ""' "$meta" 2>/dev/null)
        if [ "$WN" = "$FOCUSED_NAME" ]; then
          FOCUS_TASK_ID=$(basename "$meta" .meta.json)
          break
        fi
      done

      if [ -n "$FOCUS_TASK_ID" ]; then
        FOCUS_RESULT="$RESULTS_DIR/${FOCUS_TASK_ID}.txt"
        FOCUS_PID="$RESULTS_DIR/${FOCUS_TASK_ID}.pid"
        FOCUS_STATUS="idle"
        if [ -f "$FOCUS_PID" ] && kill -0 "$(cat "$FOCUS_PID" 2>/dev/null)" 2>/dev/null; then
          FOCUS_STATUS="running"
        fi
        if [ -f "$RESULTS_DIR/${FOCUS_TASK_ID}.meta.json.done" ]; then
          FOCUS_STATUS="done"
        fi

        if [ -f "$FOCUS_RESULT" ]; then
          echo "─── ${FOCUSED_NAME} [${FOCUS_STATUS}] ───"
          tail -8 "$FOCUS_RESULT" | tr -d '\000-\010\013\014\016-\037\177\200-\237' | head -c 2000
          echo ""
          echo "─── /cycle next | /unfocus to stop ───"
          FOCUS_SHOWN=true
        fi

        # Auto-unfocus if worker is done
        if [ "$FOCUS_STATUS" = "done" ]; then
          rm -f "$FOCUS_STATE"
        fi
      fi
    fi
  fi
fi

# ─── Worker Completion Notices ───
# Surfaces recently completed workers without requiring coord_watch_output
COMPLETIONS_FOUND=false
for donefile in "$RESULTS_DIR"/*.meta.json.done; do
  [ -f "$donefile" ] || continue
  FILE_AGE=$(( $(date +%s) - $(get_file_mtime_epoch "$donefile") ))
  [ "$FILE_AGE" -gt 60 ] && continue
  TASK_ID=$(basename "$donefile" .meta.json.done)
  ANNOUNCED=~/.claude/terminals/.announced-"${TASK_ID}"
  [ -f "$ANNOUNCED" ] && continue
  META_FILE="$RESULTS_DIR/${TASK_ID}.meta.json"
  WORKER_NAME="unknown"
  [ -f "$META_FILE" ] && WORKER_NAME=$(jq -r '.worker_name // "unknown"' "$META_FILE" 2>/dev/null || echo "unknown")
  echo "Worker '${WORKER_NAME}' completed task ${TASK_ID}"
  touch "$ANNOUNCED"
  COMPLETIONS_FOUND=true
done
# Advisory notices should not veto tool calls. Keep optional legacy interrupt
# behavior behind an explicit opt-in env flag.
if [ "$COMPLETIONS_FOUND" = true ] || [ "$FOCUS_SHOWN" = true ]; then
  if [ "$INTERRUPT_ON_NOTICES" = "1" ]; then
    exit 2
  fi
fi
exit 0
