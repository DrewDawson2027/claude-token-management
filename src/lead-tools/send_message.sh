#!/bin/bash
# Send message to another Claude Code session via inbox
# Usage: send_message.sh <from> <to_session_id> <content> [priority]

FROM="${1:?Usage: send_message.sh <from> <to> <content> [priority]}"
TO="${2:?Missing target session ID}"
CONTENT="${3:?Missing message content}"
PRIORITY="${4:-normal}"

INBOX_DIR="$HOME/.claude/terminals/inbox"
INBOX_FILE="$INBOX_DIR/${TO}.jsonl"
SESSION_FILE="$HOME/.claude/terminals/session-${TO}.json"

mkdir -p "$INBOX_DIR"

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -cn \
  --arg ts "$TS" \
  --arg from "$FROM" \
  --arg priority "$PRIORITY" \
  --arg content "$CONTENT" \
  '{ts:$ts,from:$from,priority:$priority,content:$content}' >> "$INBOX_FILE"

# Mark session as having messages
if [ -f "$SESSION_FILE" ]; then
  python3 -c "
import json
with open('$SESSION_FILE') as f: d = json.load(f)
d['has_messages'] = True
with open('$SESSION_FILE', 'w') as f: json.dump(d, f, indent=2)
" 2>/dev/null
fi

echo "Message sent to $TO"
echo "Content: \"$CONTENT\""
echo "Priority: $PRIORITY"
echo "0 API tokens used."
