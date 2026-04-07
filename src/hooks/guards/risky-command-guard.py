#!/usr/bin/env python3
"""Risky Command Guard — PreToolUse hook.

Intercepts dangerous Bash commands. Two tiers:
  BLOCKED (exit 2): catastrophic, near-irreversible operations
  WARNING (exit 0): risky but potentially intentional — injects elevated safety evaluation guidance

Boris pattern: route permission approvals through elevated safety judgment.
The "warning" tier doesn't stop execution — it injects a safety-check
prompt into Claude's context so Claude evaluates the command with care
before proceeding.
"""

import json
import re
import sys


# ── TIER 1: BLOCKED outright (exit 2) ────────────────────────────────────────
# Commands so catastrophic they should never run without explicit user override.
BLOCKED_PATTERNS = [
    (r"rm\s+-[rRf]{2,}\s+/(?!\w)", "Recursive delete at filesystem root"),
    (r"git\s+push\s+[^\n]*(?:main|master)[^\n]*--force(?!-with-lease)", "Force push to main/master branch"),
    (r"DROP\s+DATABASE\s+\w+", "DROP DATABASE (irreversible data destruction)"),
    (r"git\s+push\s+--force\s+.*(?:main|master)", "Force push to protected branch"),
]

# ── TIER 2: WARNING — inject elevated safety evaluation guidance ─────────────
# Risky but possibly intentional. Claude gets context to evaluate carefully.
RISKY_PATTERNS = [
    (r"\brm\s+-[rRf]{2,}", "Recursive/force delete"),
    (r"\bgit\s+push\s+[^\n]*--force(?!-with-lease)", "Force push (use --force-with-lease instead)"),
    (r"\bgit\s+reset\s+--hard", "Hard reset (discards uncommitted changes permanently)"),
    (r"\bgit\s+checkout\s+--\s+\.", "git checkout -- . (discards all working directory changes)"),
    (r"\bDROP\s+TABLE\b", "DROP TABLE (data destruction)"),
    (r"\bTRUNCATE\s+TABLE\b", "TRUNCATE TABLE (data destruction)"),
    (r"\bkill\s+-9\b", "SIGKILL (force-terminate, no cleanup)"),
    (r"\bchmod\s+777\b", "chmod 777 (world-writable permissions — security risk)"),
    (r">\s*/dev/(?!null)", "Redirect to device file (potential data loss)"),
    (r"\bdd\s+if=", "dd command (can overwrite disks/partitions)"),
    (r"git\s+push\s+.*--delete", "Delete remote branch"),
    (r"git\s+branch\s+-D\b", "Force-delete local branch (unmerged changes lost)"),
]


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    if data.get("tool_name") != "Bash":
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")

    # ── Check BLOCKED tier ────────────────────────────────────────────────────
    for pattern, reason in BLOCKED_PATTERNS:
        if re.search(pattern, command, re.IGNORECASE):
            print(
                json.dumps({
                    "decision": "block",
                    "reason": (
                        f"BLOCKED: {reason}.\n"
                        f"Command: {command[:120]}\n"
                        "This operation is catastrophic and irreversible. "
                        "If you truly need to run this, the user must explicitly confirm it. "
                        "For force pushes: use --force-with-lease. "
                        "For deletes: verify the exact path first."
                    )
                })
            )
            sys.exit(2)

    # ── Check RISKY tier ─────────────────────────────────────────────────────
    matched = []
    for pattern, desc in RISKY_PATTERNS:
        if re.search(pattern, command, re.IGNORECASE):
            matched.append(desc)

    if matched:
        risks = " | ".join(matched)
        print(
            f"⚠️  RISKY COMMAND — ELEVATED SAFETY EVALUATION REQUIRED\n"
            f"Risk(s): {risks}\n"
            f"Command: {command[:150]}\n"
            "Before executing, verify ALL of the following:\n"
            "  1. Is this truly necessary for the current task?\n"
            "  2. Is this reversible? If not — has the user explicitly confirmed it?\n"
            "  3. Is the scope correct? (exact paths, branch names, table names)\n"
            "  4. Is there a safer alternative? (--force-with-lease, soft delete, backup first)\n"
            "Proceed only if all checks pass. When in doubt, ask the user."
        )
        # Exit 0 — warning injected, Claude decides
        sys.exit(0)


if __name__ == "__main__":
    main()
