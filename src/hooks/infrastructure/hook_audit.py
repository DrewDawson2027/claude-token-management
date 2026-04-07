"""
Shared audit trail for all Claude Code hooks.

Every hook should call log_decision() to record its allow/block/warn decisions.
Writes to session-state/audit.jsonl with a standardized schema.

Usage in any hook:
    from hook_audit import log_decision
    log_decision("model-router", "Task", "block", "prompt exceeds 15 lines", latency_ms=12)

Schema per entry:
    ts           — ISO timestamp
    hook         — hook name (e.g. "model-router", "credential-guard")
    tool         — tool that triggered the hook (e.g. "Task", "Bash", "Read")
    decision     — "allow" | "block" | "warn" | "skip" | "error"
    reason       — human-readable reason string
    latency_ms   — hook execution time in milliseconds (optional)
    session_id   — truncated session ID (optional)
    extra        — dict of additional context (optional)
"""

import json
import os
import sys
import time
from typing import Optional

# Import shared locking from hook_utils (self-contained fallback if unavailable)
try:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from hook_utils import locked_append
except (ImportError, SyntaxError):

    def locked_append(path: str, line: str) -> bool:
        try:
            with open(path, "a") as f:
                f.write(line)
            return True
        except OSError:
            return False


AUDIT_PATH = os.path.join(
    os.environ.get(
        "TOKEN_GUARD_STATE_DIR",
        os.path.expanduser("~/.claude/hooks/session-state"),
    ),
    "audit.jsonl",
)


def log_decision(
    hook: str,
    tool: str,
    decision: str,
    reason: str = "",
    latency_ms: Optional[float] = None,
    session_id: str = "",
    extra: Optional[dict] = None,
) -> None:
    """Record a hook decision to the shared audit trail.

    Non-fatal — any error is silently ignored. This function MUST never
    crash the calling hook or affect its exit code.
    """
    try:
        os.makedirs(os.path.dirname(AUDIT_PATH), exist_ok=True)
        entry = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "schema_version": 2,
            "hook": hook,
            "tool": tool,
            "decision": decision,
            "reason": reason,
        }
        if latency_ms is not None:
            entry["latency_ms"] = round(latency_ms, 1)
        if session_id:
            entry["session_id"] = session_id[:8]
        if extra:
            entry["extra"] = extra
        locked_append(AUDIT_PATH, json.dumps(entry, separators=(",", ":")) + "\n")
    except Exception:
        pass


class HookTimer:
    """Context manager for timing hook execution and auto-logging the decision.

    Usage:
        with HookTimer("model-router", "Task") as timer:
            # ... hook logic ...
            timer.decision = "block"
            timer.reason = "prompt exceeds 15 lines"
        # auto-logs on exit
    """

    def __init__(self, hook: str, tool: str, session_id: str = ""):
        self.hook = hook
        self.tool = tool
        self.session_id = session_id
        self.decision = "allow"
        self.reason = ""
        self.extra: Optional[dict] = None
        self._start = 0.0

    def __enter__(self):
        self._start = time.monotonic()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        elapsed = (time.monotonic() - self._start) * 1000
        if exc_type is not None and self.decision == "allow":
            self.decision = "error"
            self.reason = f"{exc_type.__name__}: {exc_val}"
        log_decision(
            self.hook,
            self.tool,
            self.decision,
            self.reason,
            latency_ms=elapsed,
            session_id=self.session_id,
            extra=self.extra,
        )
        return False  # don't suppress exceptions
