#!/usr/bin/env bash
# Brief token/cost summary at end of each Claude Code session.
# Receives Stop hook JSON on stdin; pipes to ccusage statusline.
# Output prints to stderr so it appears in the terminal without affecting responses.

CCUSAGE="$(which ccusage 2>/dev/null || echo '/opt/homebrew/bin/ccusage')"

if [[ ! -x "$CCUSAGE" ]]; then
  exit 0
fi

# Capture stdin (the Stop hook payload) for statusline
INPUT=$(cat)

# --- statusline: compact session summary (reads hook JSON) ---
STATUS=$( echo "$INPUT" | "$CCUSAGE" statusline --visual-burn-rate emoji-text --offline 2>/dev/null )
if [[ -n "$STATUS" ]]; then
  echo "💰 $STATUS" >&2
fi

# --- today's daily spend (one-line summary) ---
DAILY=$( "$CCUSAGE" daily 2>/dev/null | grep -E "^\s*│\s*[0-9]{4}-[0-9]{2}-[0-9]{2}" | tail -1 )
if [[ -n "$DAILY" ]]; then
  # Extract just the date and cost columns
  DATE=$(echo "$DAILY" | awk -F'│' '{gsub(/[[:space:]]/,"",$2); print $2}')
  COST=$(echo "$DAILY" | awk -F'│' '{gsub(/[[:space:]]/,"",$(NF-1)); print $(NF-1)}')
  echo "📅 Today $DATE — $COST" >&2
fi

exit 0
