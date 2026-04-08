#!/bin/bash
# worker-status-push.sh — PostToolUse hook
# Auto-pushes active worker status after every tool call.
# Only emits output (exit 2) when workers are running — zero noise otherwise.

CLAUDE_RUNTIME_DIR="${CLAUDE_RUNTIME_DIR:-$HOME/.claude}"
TERMINALS_DIR="$CLAUDE_RUNTIME_DIR/terminals"
RESULTS_DIR="$TERMINALS_DIR/results"
[ -d "$RESULTS_DIR" ] || exit 0

# Only fire in lead sessions (check for lead marker)
[ -f "$TERMINALS_DIR/.lead-session" ] || exit 0

# Rate limit: max once per 10 seconds to avoid spamming on rapid tool calls
MARKER="$RESULTS_DIR/.status-push-ts"
NOW=$(date +%s)
if [ -f "$MARKER" ]; then
  LAST=$(cat "$MARKER" 2>/dev/null || echo 0)
  [ $((NOW - LAST)) -lt 10 ] && exit 0
fi
echo "$NOW" > "$MARKER"

# Quick-exit: if no .pid files exist, no workers are running — skip the loop (~2ms)
find "$RESULTS_DIR" -maxdepth 1 -name '*.pid' -print -quit 2>/dev/null | grep -q . || exit 0

# Collect running workers (one compact line each)
STATUS=""
for meta in "$RESULTS_DIR"/*.meta.json; do
  [ -f "$meta" ] || continue
  [ -f "${meta}.done" ] && continue
  TASK_ID=$(basename "$meta" .meta.json)
  PID_FILE="$RESULTS_DIR/$TASK_ID.pid"
  [ -f "$PID_FILE" ] || continue
  PID=$(cat "$PID_FILE" 2>/dev/null)
  [ -n "$PID" ] || continue
  kill -0 "$PID" 2>/dev/null || continue
  NAME=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('worker_name',sys.argv[2]))" "$meta" "$TASK_ID" 2>/dev/null || echo "$TASK_ID")
  RESULT_FILE="$RESULTS_DIR/$TASK_ID.txt"
  LAST_LINE=""
  if [ -f "$RESULT_FILE" ]; then
    LAST_LINE=$(tail -1 "$RESULT_FILE" 2>/dev/null | cut -c1-80)
  fi
  STATUS="${STATUS}[running] ${NAME}: ${LAST_LINE}\n"
done

[ -z "$STATUS" ] && exit 0

printf -- "--- Active Workers ---\n%b---\n" "$STATUS"
exit 0
