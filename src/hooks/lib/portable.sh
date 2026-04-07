#!/bin/bash
# Portable utility functions for cross-platform hook scripts.
# Source this file in any hook: source "$(dirname "$0")/lib/portable.sh"
#
# Provides:
#   get_file_mtime_epoch <file>       — file modification time as epoch seconds
#   parse_iso_to_epoch <timestamp>    — ISO 8601 timestamp to epoch seconds
#   get_tty                           — detect controlling TTY (best-effort)
#   require_jq                        — fail-fast if jq is not available

# Get file modification time as Unix epoch seconds.
# Tries macOS stat, GNU stat, date -r fallback.
get_file_mtime_epoch() {
  local file="$1"
  local out=""
  # GNU stat may accept `-f` and print filesystem info (non-epoch). Only accept numeric output.
  out=$(stat -f %m "$file" 2>/dev/null || true)
  if [[ "$out" =~ ^[0-9]+$ ]]; then
    echo "$out"
    return
  fi
  out=$(stat -c %Y "$file" 2>/dev/null || true)
  if [[ "$out" =~ ^[0-9]+$ ]]; then
    echo "$out"
    return
  fi
  if [ -f "$file" ]; then                                # busybox/fallback
    date -r "$file" +%s 2>/dev/null || echo 0
  else
    echo 0
  fi
}

# Parse ISO 8601 timestamp to Unix epoch seconds.
# Tries macOS date -jf, GNU date -d, falls back to 0.
parse_iso_to_epoch() {
  local ts="$1"
  # macOS
  if date -jf "%Y-%m-%dT%H:%M:%SZ" "$ts" +%s 2>/dev/null; then return; fi
  # GNU/Linux
  if date -d "$ts" +%s 2>/dev/null; then return; fi
  # Fallback: epoch 0 (will be treated as very old, not incorrectly fresh)
  echo 0
}

# Detect controlling TTY using multiple fallback methods.
# Returns the TTY path (e.g., /dev/ttys003) or empty string.
get_tty() {
  local t pid

  # Method 1: Direct tty command (works in interactive terminals)
  t=$(tty 2>/dev/null || true)
  if [ -n "$t" ] && [ "$t" != "not a tty" ]; then echo "$t"; return; fi

  # Method 2: Parent process TTY
  t=$(ps -o tty= -p "$PPID" 2>/dev/null | sed 's/ //g' || true)
  if [ -n "$t" ] && [ "$t" != "??" ]; then echo "/dev/$t"; return; fi

  # Method 3: Walk up process tree (up to 3 levels)
  pid=$PPID
  for _ in 1 2 3; do
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    [ -z "$pid" ] && break
    t=$(ps -o tty= -p "$pid" 2>/dev/null | sed 's/ //g' || true)
    if [ -n "$t" ] && [ "$t" != "??" ]; then echo "/dev/$t"; return; fi
  done

  echo ""  # No TTY found
}

# Portable flock replacement. Uses flock if available, falls back to mkdir-based lock.
# Usage: portable_flock_try <fd_or_lockfile>
#   Returns 0 if lock acquired, 1 if already locked.
# For the "exec N>file; flock -n N" pattern, use: portable_flock_try /path/to/lockfile
# Caller must call portable_flock_release <lockfile> when done.
_PORTABLE_FLOCK_DIRS=()
portable_flock_try() {
  local lockpath="$1"
  if command -v flock >/dev/null 2>&1; then
    # Real flock available (Linux, Homebrew on macOS)
    # Open for append (not truncate) so lock file mtime remains meaningful for cooldown/stale logic.
    exec 9>>"$lockpath"
    flock -n 9 2>/dev/null && return 0
    exec 9>&-
    return 1
  else
    # Fallback: mkdir is atomic on all POSIX filesystems
    local dlock="${lockpath}.d"
    if mkdir "$dlock" 2>/dev/null; then
      _PORTABLE_FLOCK_DIRS+=("$dlock")
      return 0
    fi
    # Check for stale lock (older than 60s)
    if [ -d "$dlock" ]; then
      local lock_age
      lock_age=$(( $(date +%s) - $(get_file_mtime_epoch "$dlock") ))
      if [ "$lock_age" -gt 60 ]; then
        rmdir "$dlock" 2>/dev/null
        mkdir "$dlock" 2>/dev/null && { _PORTABLE_FLOCK_DIRS+=("$dlock"); return 0; }
      fi
    fi
    return 1
  fi
}

portable_flock_release() {
  local lockpath="$1"
  if command -v flock >/dev/null 2>&1; then
    exec 9>&- 2>/dev/null
  else
    rmdir "${lockpath}.d" 2>/dev/null || true
  fi
}

# Portable flock wrapper for protecting file appends.
# Usage: portable_flock_append <lockfile> <command>
# Example: portable_flock_append "/path/to/file.lock" "echo data >> /path/to/file"
portable_flock_append() {
  local lockfile="$1"
  shift
  local cmd="${1-}"
  if command -v flock >/dev/null 2>&1; then
    # Intentional shell-string API for callers like: portable_flock_append lock "echo x >> file"
    eval "( flock 200; $cmd )" 200>"$lockfile"
  else
    # mkdir-based lock with cleanup trap
    local dlock="${lockfile}.d"
    while ! mkdir "$dlock" 2>/dev/null; do
      local age
      age=$(( $(date +%s) - $(get_file_mtime_epoch "$dlock") ))
      if [ "$age" -gt 30 ]; then rmdir "$dlock" 2>/dev/null; fi
      sleep 0.1 2>/dev/null || sleep 1
    done
    # Intentional shell-string API (see comment above).
    eval "$cmd"
    rmdir "$dlock" 2>/dev/null || true
  fi
}

# Fail-fast if jq is not installed.
require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq is required but not installed. Install with: brew install jq (macOS) or apt install jq (Linux)" >&2
    exit 2
  fi
}
