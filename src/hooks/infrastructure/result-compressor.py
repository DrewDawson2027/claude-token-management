#!/usr/bin/env python3
"""Result Compressor — PostToolUse hook that detects oversized tool results.

Part of the Token Management System (Innovation #5: Tool Result Compression).

How it works:
  Fires after Bash, Grep, Read tool results.
  If result > 5000 chars, logs a context-bloat warning to stderr.
  Tracks cumulative context growth per session.
  Advisory only (non-blocking) — prints recommendation to stderr.

Config: ~/.claude/hooks/token-guard-config.json (no dedicated section needed)
"""

import json
import os
import sys

# Threshold for "large result" warning (characters)
LARGE_RESULT_THRESHOLD = 5000

# Estimated tokens-per-char ratio (conservative)
CHARS_PER_TOKEN = 4

# Tools we monitor for bloat
MONITORED_TOOLS = {"Bash", "Grep", "Read"}


def main():
    # If read-efficiency-guard already warned this session, skip duplicate bloat warning.
    # The guard sets this env var when it emits a CONTEXT BLOAT or BLOCKED warning.
    if os.environ.get("READ_EFFICIENCY_GUARD_WARNED"):
        sys.exit(0)

    try:
        input_data = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    if not isinstance(input_data, dict):
        sys.exit(0)

    tool_name = input_data.get("tool_name", "")
    if tool_name not in MONITORED_TOOLS:
        sys.exit(0)

    # Get result size from tool_output
    tool_output = input_data.get("tool_output", "")
    if isinstance(tool_output, dict):
        tool_output = json.dumps(tool_output)
    result_size = len(str(tool_output))

    session_id = input_data.get("session_id", "unknown")

    # Track context growth (import here to avoid import errors if hook_utils missing)
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from hook_utils import track_context_growth

        state = track_context_growth(session_id, tool_name, result_size)
        total_chars = state.get("total_chars", 0)
        total_results = state.get("total_results", 0)
        large_count = state.get("large_results", 0)
    except ImportError:
        total_chars = result_size
        total_results = 1
        large_count = 1 if result_size > LARGE_RESULT_THRESHOLD else 0

    # Advisory for large individual results
    if result_size > LARGE_RESULT_THRESHOLD:
        est_tokens = result_size // CHARS_PER_TOKEN
        print(
            f"CONTEXT BLOAT: Large {tool_name} result ({result_size:,} chars, ~{est_tokens:,} tokens). "
            f"Consider using head_limit, limit param, or more specific patterns.",
            file=sys.stderr,
        )

    # Advisory for cumulative context growth
    est_total_tokens = total_chars // CHARS_PER_TOKEN
    if est_total_tokens > 200000:
        print(
            f"CONTEXT WARNING: Session context ~{est_total_tokens:,} tokens across {total_results} results "
            f"({large_count} large). Context window pressure is high.",
            file=sys.stderr,
        )

    sys.exit(0)  # Always non-blocking


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        try:
            from hook_utils import record_hook_outcome

            code = e.code if isinstance(e.code, int) else 0
            record_hook_outcome(
                "result-compressor", "success" if code == 0 else "error"
            )
        except Exception:
            pass
        raise
    except Exception:
        try:
            from hook_utils import record_hook_outcome

            record_hook_outcome("result-compressor", "fail_open")
        except Exception:
            pass
        sys.exit(0)
