#!/usr/bin/env bash
# session-end-auto-commit.sh
# Fires on every Claude session Stop. Auto-commits uncommitted changes on
# feature branches so work is never lost when a session ends mid-task.
# Never touches main, master, or develop. Logs every auto-commit.

LOG_FILE="$HOME/.claude/hooks/session-state/auto-commits.log"
mkdir -p "$(dirname "$LOG_FILE")"

# Find the git repo for the current working directory
GIT_DIR=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$GIT_DIR" ]; then
  exit 0  # Not in a git repo — nothing to do
fi

# Get current branch
BRANCH=$(git -C "$GIT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  exit 0  # Detached HEAD or error — skip
fi

# Never auto-commit to main, master, or develop
case "$BRANCH" in
  main|master|develop)
    exit 0
    ;;
esac

# Check for uncommitted changes (staged or unstaged, including untracked)
DIRTY=$(git -C "$GIT_DIR" status --porcelain 2>/dev/null)
if [ -z "$DIRTY" ]; then
  exit 0  # Clean — nothing to do
fi

# Count changed files for the log message
FILE_COUNT=$(echo "$DIRTY" | wc -l | tr -d ' ')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SHORT_HASH=$(git -C "$GIT_DIR" rev-parse --short HEAD 2>/dev/null)

# Stage everything and commit
git -C "$GIT_DIR" add -A 2>/dev/null
git -C "$GIT_DIR" commit \
  --no-verify \
  -m "wip: auto-commit on session end [$BRANCH] $TIMESTAMP" \
  2>/dev/null

EXIT_CODE=$?
NEW_HASH=$(git -C "$GIT_DIR" rev-parse --short HEAD 2>/dev/null)

if [ $EXIT_CODE -eq 0 ]; then
  echo "[$TIMESTAMP] AUTO-COMMIT: $GIT_DIR | branch=$BRANCH | files=$FILE_COUNT | $SHORT_HASH → $NEW_HASH" >> "$LOG_FILE"
else
  echo "[$TIMESTAMP] AUTO-COMMIT FAILED: $GIT_DIR | branch=$BRANCH | exit=$EXIT_CODE" >> "$LOG_FILE"
fi

exit 0  # Never block session end
