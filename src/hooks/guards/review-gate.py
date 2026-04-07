#!/usr/bin/env python3
"""Review Gate — PreToolUse hook that blocks Write/Edit until commit review is dispatched.

When auto-review-dispatch.py creates a review-pending flag after a git commit,
this hook blocks all file-modifying tools (Write, Edit, MultiEdit) until:
  1. The flag is cleared (by build-chain-dispatcher on quick-reviewer completion), OR
  2. The flag expires (15 min timeout — prevents permanent blocks)

This is the ENFORCEMENT companion to the advisory CLAUDE.md instruction.
Without this hook, the commit→quick-reviewer chain is advisory only (C+ grade).

Exit codes: 0 = allow, 2 = block.
"""

import calendar
import json
import os
import sys
import time

FLAG_PATH = os.path.expanduser("~/.claude/hooks/session-state/review-pending")
FLAG_TTL_SECONDS = 900  # 15 minutes


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    tool_name = data.get("tool_name", "")
    if tool_name not in ("Write", "Edit", "MultiEdit"):
        sys.exit(0)

    if not os.path.isfile(FLAG_PATH):
        sys.exit(0)

    # Check flag expiry
    try:
        with open(FLAG_PATH) as f:
            flag = json.load(f)
        created_at = flag.get("created_at", "")
        if created_at:
            created_epoch = calendar.timegm(
                time.strptime(created_at, "%Y-%m-%dT%H:%M:%SZ")
            )
            if time.time() - created_epoch > FLAG_TTL_SECONDS:
                # Expired — clean up and allow
                os.unlink(FLAG_PATH)
                sys.exit(0)
    except (json.JSONDecodeError, OSError, ValueError):
        # Corrupt flag — remove and allow
        try:
            os.unlink(FLAG_PATH)
        except OSError:
            pass
        sys.exit(0)

    # Flag is valid and not expired — block the edit
    print(
        "BLOCKED: A git commit was just made and the mandatory quick-reviewer "
        "has not been dispatched yet. Spawn `quick-reviewer` (model: haiku) on "
        "the committed files FIRST, then continue editing.\n"
        "To unblock: dispatch the quick-reviewer agent on the committed files.\n"
        "Emergency escape: rm ~/.claude/hooks/session-state/review-pending"
    )
    sys.exit(2)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        # Fail-open: never block permanently due to bugs
        sys.exit(0)
