#!/usr/bin/env bash
# lean-ralph-stop.sh
# Stock-parity Ralph loop stop hook with compact implementation.

set -euo pipefail

HOOK_INPUT=$(cat)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEAN_RALPH_ROOT="${LEAN_RALPH_ROOT:-}"
if [[ -n "$LEAN_RALPH_ROOT" ]]; then
  CONTROL_SCRIPT="$LEAN_RALPH_ROOT/lean-ralph-control.sh"
  POLICY_FILE="$LEAN_RALPH_ROOT/routing-policy.json"
else
  CONTROL_SCRIPT="$SCRIPT_DIR/lean-ralph-control.sh"
  POLICY_FILE="$SCRIPT_DIR/routing-policy.json"
fi
CONTEXT_FILE=".claude/lean-ralph-context.local.txt"

estimate_tokens() {
  local text="$1"
  local chars="${#text}"
  printf '%s' $(( (chars + 3) / 4 ))
}

emit_telemetry() {
  local mode="$1"
  local tokens_in="$2"
  local tokens_out="$3"
  local cache_tokens="$4"
  local completed="$5"
  local quality_pass="$6"
  local failure_category="$7"
  local token_source="$8"

  if [[ -f "$CONTROL_SCRIPT" ]]; then
    bash "$CONTROL_SCRIPT" telemetry-log \
      --project-dir "$(pwd)" \
      --run-id "$RUN_ID" \
      --task-id "$TASK_ID" \
      --mode "$mode" \
      --tokens-in "$tokens_in" \
      --tokens-out "$tokens_out" \
      --cache-tokens "$cache_tokens" \
      --completed "$completed" \
      --quality-pass "$quality_pass" \
      --fallback-count "$FALLBACK_COUNT" \
      --failure-category "$failure_category" \
      --token-source "$token_source" >/dev/null 2>&1 || true
  fi
}

read_strict_stock_parity() {
  local raw="${LEAN_RALPH_STRICT_PARITY:-}"

  if [[ -z "$raw" ]] && [[ -f "$POLICY_FILE" ]]; then
    raw="$(jq -r '.strict_stock_parity_mode // empty' "$POLICY_FILE" 2>/dev/null || true)"
  fi

  case "$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on)
      printf '%s' "true"
      ;;
    0|false|no|off)
      printf '%s' "false"
      ;;
    *)
      printf '%s' "true"
      ;;
  esac
}

STRICT_STOCK_PARITY="$(read_strict_stock_parity)"

is_number() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

hook_usage_input_tokens() {
  echo "$HOOK_INPUT" | jq -r '
    .usage.input_tokens
    // .usage.inputTokens
    // .input_tokens
    // .inputTokens
    // empty
  ' 2>/dev/null || true
}

resolve_input_tokens() {
  local fallback_text="$1"
  if is_number "$HOOK_INPUT_INPUT_TOKENS"; then
    printf '%s' "$HOOK_INPUT_INPUT_TOKENS"
  else
    estimate_tokens "$fallback_text"
  fi
}

resolve_token_source() {
  if is_number "$HOOK_INPUT_INPUT_TOKENS"; then
    printf '%s' "hook_input_usage+estimated_output"
  else
    printf '%s' "estimated_chars4"
  fi
}

HOOK_INPUT_INPUT_TOKENS="$(hook_usage_input_tokens)"
TOKEN_SOURCE="$(resolve_token_source)"

STATE_FILE=".claude/ralph-loop.local.md"
if [[ ! -f "$STATE_FILE" ]]; then
  exit 0
fi

FRONTMATTER=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$STATE_FILE")
ITERATION=$(echo "$FRONTMATTER" | grep '^iteration:' | sed 's/iteration: *//' || true)
MAX_ITERATIONS=$(echo "$FRONTMATTER" | grep '^max_iterations:' | sed 's/max_iterations: *//' || true)
COMPLETION_PROMISE=$(echo "$FRONTMATTER" | grep '^completion_promise:' | sed 's/completion_promise: *//' | sed 's/^"\(.*\)"$/\1/' || true)
ACTIVE=$(echo "$FRONTMATTER" | grep '^active:' | sed 's/active: *//' || true)
STATE_SESSION=$(echo "$FRONTMATTER" | grep '^session_id:' | sed 's/session_id: *//' | sed 's/^"\(.*\)"$/\1/' || true)
REASON_BUDGET=$(echo "$FRONTMATTER" | grep '^reason_budget_chars:' | sed 's/reason_budget_chars: *//' || true)
CONTEXT_BUDGET=$(echo "$FRONTMATTER" | grep '^context_budget_chars:' | sed 's/context_budget_chars: *//' || true)
ROUTING_MODE=$(echo "$FRONTMATTER" | grep '^routing_mode:' | sed 's/routing_mode: *//' | sed 's/^"\(.*\)"$/\1/' || true)
RUN_ID=$(echo "$FRONTMATTER" | grep '^run_id:' | sed 's/run_id: *//' | sed 's/^"\(.*\)"$/\1/' || true)
TASK_ID=$(echo "$FRONTMATTER" | grep '^task_id:' | sed 's/task_id: *//' | sed 's/^"\(.*\)"$/\1/' || true)
FALLBACK_COUNT=$(echo "$FRONTMATTER" | grep '^fallback_count:' | sed 's/fallback_count: *//' || true)
HARD_TOKEN_BUDGET=$(echo "$FRONTMATTER" | grep '^hard_token_budget:' | sed 's/hard_token_budget: *//' || true)
HOOK_SESSION=$(echo "$HOOK_INPUT" | jq -r '.session_id // ""')

if [[ ! "$REASON_BUDGET" =~ ^[0-9]+$ ]]; then
  REASON_BUDGET=6000
fi
if [[ ! "$CONTEXT_BUDGET" =~ ^[0-9]+$ ]]; then
  CONTEXT_BUDGET=480
fi
if [[ "$ROUTING_MODE" != "lean" ]] && [[ "$ROUTING_MODE" != "full" ]]; then
  ROUTING_MODE="lean"
fi
if [[ ! "$FALLBACK_COUNT" =~ ^[0-9]+$ ]]; then
  FALLBACK_COUNT=0
fi
if [[ ! "$HARD_TOKEN_BUDGET" =~ ^[0-9]+$ ]]; then
  HARD_TOKEN_BUDGET=2400
fi
if [[ -z "$RUN_ID" ]]; then
  RUN_ID="run-unknown"
fi
if [[ -z "$TASK_ID" ]]; then
  TASK_ID="task-unknown"
fi

# Lean legacy state uses active:true. If explicitly inactive, allow stop.
if [[ -n "$ACTIVE" ]] && [[ "$ACTIVE" != "true" ]]; then
  exit 0
fi

if [[ -n "$STATE_SESSION" ]] && [[ -n "$HOOK_SESSION" ]] && [[ "$STATE_SESSION" != "$HOOK_SESSION" ]]; then
  exit 0
fi

if [[ ! "$ITERATION" =~ ^[0-9]+$ ]]; then
  echo "⚠️  Ralph loop: State file corrupted" >&2
  echo "   File: $STATE_FILE" >&2
  echo "   Problem: 'iteration' field is not a valid number (got: '$ITERATION')" >&2
  echo "" >&2
  echo "   This usually means the state file was manually edited or corrupted." >&2
  echo "   Ralph loop is stopping. Run /ralph-loop again to start fresh." >&2
  emit_telemetry "$ROUTING_MODE" 0 0 0 false false "invalid_iteration" "$TOKEN_SOURCE"
  rm -f "$STATE_FILE"
  exit 0
fi

if [[ ! "$MAX_ITERATIONS" =~ ^[0-9]+$ ]]; then
  echo "⚠️  Ralph loop: State file corrupted" >&2
  echo "   File: $STATE_FILE" >&2
  echo "   Problem: 'max_iterations' field is not a valid number (got: '$MAX_ITERATIONS')" >&2
  echo "" >&2
  echo "   This usually means the state file was manually edited or corrupted." >&2
  echo "   Ralph loop is stopping. Run /ralph-loop again to start fresh." >&2
  emit_telemetry "$ROUTING_MODE" 0 0 0 false false "invalid_max_iterations" "$TOKEN_SOURCE"
  rm -f "$STATE_FILE"
  exit 0
fi

if [[ "$MAX_ITERATIONS" -gt 0 ]] && [[ "$ITERATION" -ge "$MAX_ITERATIONS" ]]; then
  echo "🛑 Ralph loop: Max iterations ($MAX_ITERATIONS) reached."
  emit_telemetry "$ROUTING_MODE" 0 0 0 false true "max_iterations_reached" "$TOKEN_SOURCE"
  rm -f "$STATE_FILE"
  exit 0
fi

TRANSCRIPT_PATH=$(echo "$HOOK_INPUT" | jq -r '.transcript_path // ""')
if [[ ! -f "$TRANSCRIPT_PATH" ]]; then
  echo "⚠️  Ralph loop: Transcript file not found" >&2
  echo "   Expected: $TRANSCRIPT_PATH" >&2
  echo "   This is unusual and may indicate a Claude Code internal issue." >&2
  echo "   Ralph loop is stopping." >&2
  emit_telemetry "$ROUTING_MODE" 0 0 0 false false "transcript_missing" "$TOKEN_SOURCE"
  rm -f "$STATE_FILE"
  exit 0
fi

set +e
TRANSCRIPT_PARSE_JSON=$(jq -rs '
  def assistant_role:
    (.role? // .message.role? // "");
  def extract_text:
    if (.message.content? | type) == "array" then
      [ .message.content[]? | select(.type == "text") | .text ] | join("\n")
    elif (.content? | type) == "array" then
      [ .content[]? | select(.type == "text") | .text ] | join("\n")
    elif (.content? | type) == "string" then
      .content
    else
      ""
    end;
  [ .[] | select(assistant_role == "assistant") | extract_text ] as $messages
  | {
      has_assistant: (($messages | length) > 0),
      last_output: ($messages | last // "")
    }
' "$TRANSCRIPT_PATH" 2>&1)
JQ_EXIT=$?
set -e

if [[ "$JQ_EXIT" -ne 0 ]]; then
  echo "⚠️  Ralph loop: Failed to parse assistant message JSON" >&2
  echo "   Error: $TRANSCRIPT_PARSE_JSON" >&2
  echo "   This may indicate a transcript format issue." >&2
  echo "   Ralph loop is stopping." >&2
  emit_telemetry "$ROUTING_MODE" 0 0 0 false false "transcript_parse_error" "$TOKEN_SOURCE"
  rm -f "$STATE_FILE"
  exit 0
fi

HAS_ASSISTANT=$(printf '%s' "$TRANSCRIPT_PARSE_JSON" | jq -r '.has_assistant // false' 2>/dev/null || echo false)
LAST_OUTPUT=$(printf '%s' "$TRANSCRIPT_PARSE_JSON" | jq -r '.last_output // ""' 2>/dev/null || echo "")

if [[ "$HAS_ASSISTANT" != "true" ]]; then
  echo "⚠️  Ralph loop: No assistant messages found in transcript" >&2
  echo "   Transcript: $TRANSCRIPT_PATH" >&2
  echo "   This is unusual and may indicate a transcript format issue" >&2
  echo "   Ralph loop is stopping." >&2
  emit_telemetry "$ROUTING_MODE" 0 0 0 false false "no_assistant_messages" "$TOKEN_SOURCE"
  rm -f "$STATE_FILE"
  exit 0
fi

RISK_ESCALATE=false
if [[ "$STRICT_STOCK_PARITY" != "true" ]] && [[ -f "$CONTROL_SCRIPT" ]]; then
  RISK_RESULT=$(bash "$CONTROL_SCRIPT" assess-risk --project-dir "$(pwd)" --mode "$ROUTING_MODE" --text "$LAST_OUTPUT" 2>/dev/null || echo '{}')
  RISK_ESCALATE=$(echo "$RISK_RESULT" | jq -r '.escalate // false')
fi

if [[ "$STRICT_STOCK_PARITY" != "true" ]] && [[ "$ROUTING_MODE" == "lean" ]] && [[ "$RISK_ESCALATE" == "true" ]]; then
  ROUTING_MODE="full"
  FALLBACK_COUNT=$((FALLBACK_COUNT + 1))
  if [[ -f "$CONTROL_SCRIPT" ]]; then
    bash "$CONTROL_SCRIPT" set-field --file "$STATE_FILE" --field "routing_mode" --value '"full"' >/dev/null 2>&1 || true
    bash "$CONTROL_SCRIPT" set-field --file "$STATE_FILE" --field "fallback_count" --value "$FALLBACK_COUNT" >/dev/null 2>&1 || true
  fi
fi

if [[ "$COMPLETION_PROMISE" != "null" ]] && [[ -n "$COMPLETION_PROMISE" ]]; then
  PROMISE_TEXT=$(echo "$LAST_OUTPUT" | perl -0777 -pe 's/.*?<promise>(.*?)<\/promise>.*/$1/s; s/^\s+|\s+$//g; s/\s+/ /g' 2>/dev/null || echo "")
  if [[ -n "$PROMISE_TEXT" ]] && [[ "$PROMISE_TEXT" = "$COMPLETION_PROMISE" ]]; then
    VERIFY_ALLOWED=true
    if [[ "$STRICT_STOCK_PARITY" != "true" ]] && [[ -f "$CONTROL_SCRIPT" ]]; then
      VERIFY_RESULT=$(bash "$CONTROL_SCRIPT" verify-completion --project-dir "$(pwd)" --state-file "$STATE_FILE" --completion "$COMPLETION_PROMISE" --text "$LAST_OUTPUT" 2>/dev/null || echo '{"allowed":false}')
      VERIFY_ALLOWED=$(echo "$VERIFY_RESULT" | jq -r '.allowed // false')
    fi
    if [[ "$VERIFY_ALLOWED" == "true" ]]; then
      echo "✅ Ralph loop: Detected <promise>$COMPLETION_PROMISE</promise>"
      emit_telemetry "$ROUTING_MODE" "$(resolve_input_tokens "$LAST_OUTPUT")" 0 0 true true "none" "$TOKEN_SOURCE"
      rm -f "$STATE_FILE"
      exit 0
    fi
  fi
fi

NEXT_ITERATION=$((ITERATION + 1))
PROMPT_TEXT=$(awk '/^---$/{i++; next} i>=2' "$STATE_FILE")
if [[ -z "$PROMPT_TEXT" ]]; then
  echo "⚠️  Ralph loop: State file corrupted or incomplete" >&2
  echo "   File: $STATE_FILE" >&2
  echo "   Problem: No prompt text found" >&2
  echo "" >&2
  echo "   This usually means:" >&2
  echo "     • State file was manually edited" >&2
  echo "     • File was corrupted during writing" >&2
  echo "" >&2
  echo "   Ralph loop is stopping. Run /ralph-loop again to start fresh." >&2
  emit_telemetry "$ROUTING_MODE" "$(resolve_input_tokens "$LAST_OUTPUT")" 0 0 false false "missing_prompt_text" "$TOKEN_SOURCE"
  rm -f "$STATE_FILE"
  exit 0
fi

CONTEXT_META='{}'
if [[ "$STRICT_STOCK_PARITY" != "true" ]] && [[ -f "$CONTROL_SCRIPT" ]]; then
  CONTEXT_META=$(bash "$CONTROL_SCRIPT" pack-context --project-dir "$(pwd)" --max-chars "$CONTEXT_BUDGET" --max-lines 80 --json 2>/dev/null || echo '{}')
fi

CONTEXT_DELTA=""
if [[ "$STRICT_STOCK_PARITY" != "true" ]] && [[ -f "$CONTEXT_FILE" ]]; then
  CONTEXT_DELTA=$(head -c "$CONTEXT_BUDGET" "$CONTEXT_FILE" || true)
fi

REINJECT_REASON="$PROMPT_TEXT"
if [[ -n "$CONTEXT_DELTA" ]]; then
  REINJECT_REASON="$PROMPT_TEXT

Current bounded context (delta only):
$CONTEXT_DELTA"
fi

EFFECTIVE_REASON_BUDGET="$REASON_BUDGET"
if [[ "$STRICT_STOCK_PARITY" != "true" ]] && [[ "$ROUTING_MODE" == "lean" ]] && [[ "$EFFECTIVE_REASON_BUDGET" -gt 450 ]]; then
  EFFECTIVE_REASON_BUDGET=450
fi

if [[ "$EFFECTIVE_REASON_BUDGET" -gt 0 ]]; then
  REINJECT_REASON=$(printf '%s' "$REINJECT_REASON" | head -c "$EFFECTIVE_REASON_BUDGET")
fi

TEMP_FILE="${STATE_FILE}.tmp.$$"
sed "s/^iteration: .*/iteration: $NEXT_ITERATION/" "$STATE_FILE" > "$TEMP_FILE"
mv "$TEMP_FILE" "$STATE_FILE"

if [[ "$COMPLETION_PROMISE" != "null" ]] && [[ -n "$COMPLETION_PROMISE" ]]; then
  if [[ "$STRICT_STOCK_PARITY" == "true" ]]; then
    SYSTEM_MSG="🔄 Ralph iteration $NEXT_ITERATION | To stop: output <promise>$COMPLETION_PROMISE</promise> (ONLY when statement is TRUE - do not lie to exit!)"
  else
    if [[ "$ROUTING_MODE" == "full" ]]; then
      SYSTEM_MSG="🔄 Ralph iteration $NEXT_ITERATION | Full-route fallback active. To stop: output <promise>$COMPLETION_PROMISE</promise> (ONLY when statement is TRUE - do not lie to exit!)"
    else
      SYSTEM_MSG="🔄 Ralph iteration $NEXT_ITERATION | To stop: output <promise>$COMPLETION_PROMISE</promise> (ONLY when statement is TRUE - do not lie to exit!)"
    fi
  fi
else
  if [[ "$STRICT_STOCK_PARITY" == "true" ]]; then
    SYSTEM_MSG="🔄 Ralph iteration $NEXT_ITERATION | No completion promise set - loop runs infinitely"
  else
    if [[ "$ROUTING_MODE" == "full" ]]; then
      SYSTEM_MSG="🔄 Ralph iteration $NEXT_ITERATION | Full-route fallback active | No completion promise set - loop runs infinitely"
    else
      SYSTEM_MSG="🔄 Ralph iteration $NEXT_ITERATION | No completion promise set - loop runs infinitely"
    fi
  fi
fi

REASON_TOKENS=$(estimate_tokens "$REINJECT_REASON")
SYSTEM_TOKENS=$(estimate_tokens "$SYSTEM_MSG")
TOTAL_OUT_TOKENS=$((REASON_TOKENS + SYSTEM_TOKENS))
if [[ "$STRICT_STOCK_PARITY" != "true" ]] && [[ "$HARD_TOKEN_BUDGET" -gt 0 ]] && [[ "$TOTAL_OUT_TOKENS" -gt "$HARD_TOKEN_BUDGET" ]]; then
  ALLOWED_REASON_TOKENS=$((HARD_TOKEN_BUDGET - SYSTEM_TOKENS))
  if [[ "$ALLOWED_REASON_TOKENS" -lt 1 ]]; then
    ALLOWED_REASON_TOKENS=1
  fi
  ALLOWED_REASON_CHARS=$((ALLOWED_REASON_TOKENS * 4))
  REINJECT_REASON=$(printf '%s' "$REINJECT_REASON" | head -c "$ALLOWED_REASON_CHARS")
  REASON_TOKENS=$(estimate_tokens "$REINJECT_REASON")
  TOTAL_OUT_TOKENS=$((REASON_TOKENS + SYSTEM_TOKENS))
fi

CACHE_TOKENS=$(echo "$CONTEXT_META" | jq -r '.cache_tokens // 0' 2>/dev/null || echo 0)
INPUT_TOKENS=$(resolve_input_tokens "$LAST_OUTPUT")
emit_telemetry "$ROUTING_MODE" "$INPUT_TOKENS" "$TOTAL_OUT_TOKENS" "$CACHE_TOKENS" false true "none" "$TOKEN_SOURCE"

jq -n \
  --arg prompt "$REINJECT_REASON" \
  --arg msg "$SYSTEM_MSG" \
  '{
    "decision": "block",
    "reason": $prompt,
    "systemMessage": $msg
  }'

exit 0
