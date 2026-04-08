"""
Shared infrastructure for Claude Code hooks.

Provides portable file locking, atomic state management, and audit logging
used by both token-guard.py and read-efficiency-guard.py.

This module exists to eliminate DRY violations — bug fixes here propagate
automatically to all hooks that import it.
"""

import json
import os
import sys
import tempfile
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, IO, List, Optional

try:
    from guard_normalize import normalize_session_key, normalize_text
except Exception:
    normalize_session_key = None
    normalize_text = None
try:
    from runtime_paths import session_state_dir
except Exception:
    session_state_dir = None

# Portable file locking — fcntl on Unix, msvcrt on Windows
if sys.platform == "win32":
    import msvcrt

    def lock(f: IO) -> None:
        """Acquire an exclusive lock on the file."""
        msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)

    def unlock(f: IO) -> None:
        """Release the lock on the file."""
        msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
else:
    import fcntl

    def lock(f: IO) -> None:
        """Acquire an exclusive lock on the file."""
        fcntl.flock(f, fcntl.LOCK_EX)

    def unlock(f: IO) -> None:
        """Release the lock on the file."""
        fcntl.flock(f, fcntl.LOCK_UN)


def load_json_state(
    path: str, default_factory: Optional[Callable[[], Dict]] = None
) -> Dict:
    """Load JSON state from file, returning default on any error.

    Args:
        path: Path to the JSON state file.
        default_factory: Callable returning the default state dict.
                         If None, returns an empty dict.
    """
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (
        FileNotFoundError,
        json.JSONDecodeError,
        OSError,
        UnicodeDecodeError,
        ValueError,
    ):
        return default_factory() if default_factory else {}


def save_json_state(path: str, state: Dict) -> bool:
    """Atomically persist state — write to temp file, then rename.

    Uses os.replace() which is atomic on both POSIX and Windows.
    If the process crashes mid-write, the original file is untouched.

    Returns True on success, False on failure (non-fatal).
    """
    dir_name = os.path.dirname(path)
    try:
        fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(state, f, indent=2)
            os.replace(tmp_path, path)
            return True
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            return False
    except OSError:
        return False


def locked_append(path: str, line: str) -> bool:
    """Append a line to a file with exclusive file locking.

    Prevents interleaved writes from concurrent hook processes.
    Non-fatal — returns False on any error.
    """
    lock_path = path + ".lock"
    try:
        with open(lock_path, "w") as lf:
            lock(lf)
            try:
                with open(path, "a") as f:
                    f.write(line)
                return True
            finally:
                unlock(lf)
    except OSError:
        return False


def read_jsonl_fault_tolerant(path: str) -> List[Dict]:
    """Read a JSONL file, skipping corrupt lines instead of failing.

    Returns a list of successfully parsed entries.
    One bad line does NOT discard all valid entries.
    """
    entries = []
    try:
        with open(path, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except (FileNotFoundError, OSError):
        pass
    return entries


STATE_DIR = os.environ.get(
    "TOKEN_GUARD_STATE_DIR",
    str(session_state_dir() if session_state_dir is not None else os.path.expanduser("~/.claude/hooks/session-state")),
)
COUNTERS_FILE = os.path.join(STATE_DIR, "hook-counters.json")


def _utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    )


def _sanitize_session_key(value: Any) -> str:
    if normalize_session_key is not None:
        return normalize_session_key(value)
    text = str(value or "").replace("\x00", "")
    cleaned = "".join(ch for ch in text if ch.isalnum() or ch in {"_", "-"})
    return cleaned[:64] or "unknown"


def _sanitize_tool_name(value: Any) -> str:
    raw = str(value or "").replace("\x00", "")
    cleaned = "".join(ch for ch in raw if ch.isalnum() or ch in {"_", "-"})
    if normalize_text is not None:
        cleaned = normalize_text(cleaned, max_len=64)
    return cleaned[:64] or "unknown"


def record_hook_outcome(hook_name: str, outcome: str) -> None:
    """Record one hook invocation outcome in hook-counters.json.

    This is intentionally best-effort and never raises. Unknown outcome keys are
    preserved instead of being rejected so newer hooks can add outcome classes
    without breaking older helper code.
    """

    dir_name = os.path.dirname(COUNTERS_FILE)
    try:
        os.makedirs(dir_name, exist_ok=True)
    except OSError:
        return

    lock_path = COUNTERS_FILE + ".lock"
    try:
        with open(lock_path, "a+") as lf:
            lock(lf)
            try:
                state = load_json_state(COUNTERS_FILE, default_factory=dict)
                if not isinstance(state, dict):
                    state = {}
                hook_state = state.setdefault(str(hook_name), {})
                if not isinstance(hook_state, dict):
                    hook_state = {}
                    state[str(hook_name)] = hook_state
                for key in ("success", "fail_open", "fail_closed", "error"):
                    try:
                        hook_state[key] = max(0, int(hook_state.get(key, 0) or 0))
                    except Exception:
                        hook_state[key] = 0
                hook_state[outcome] = max(0, int(hook_state.get(outcome, 0) or 0)) + 1
                hook_state["last_updated"] = _utc_now_iso()
                save_json_state(COUNTERS_FILE, state)
            finally:
                unlock(lf)
    except OSError:
        return


def track_context_growth(session_id: Any, tool_name: Any, result_size: Any) -> Dict:
    """Persist per-session context growth for result-compressor and reporting."""

    session_key = _sanitize_session_key(session_id)
    tool_key = _sanitize_tool_name(tool_name)
    try:
        size = max(0, int(result_size or 0))
    except Exception:
        size = 0

    try:
        os.makedirs(STATE_DIR, exist_ok=True)
    except OSError:
        return {
            "session_key": session_key,
            "total_chars": size,
            "total_results": 1,
            "large_results": 1 if size > 5000 else 0,
            "tool_counts": {tool_key: 1},
        }

    path = os.path.join(STATE_DIR, f"{session_key}-context.json")
    lock_path = path + ".lock"
    default_state = {
        "schema_version": 1,
        "session_key": session_key,
        "created_at": _utc_now_iso(),
        "updated_at": _utc_now_iso(),
        "total_chars": 0,
        "total_results": 0,
        "large_results": 0,
        "tool_counts": {},
        "recent_results": [],
    }
    try:
        with open(lock_path, "a+") as lf:
            lock(lf)
            try:
                state = load_json_state(path, default_factory=lambda: dict(default_state))
                if not isinstance(state, dict):
                    state = dict(default_state)
                state["session_key"] = session_key
                state["schema_version"] = 1
                state["updated_at"] = _utc_now_iso()
                state["total_chars"] = max(0, int(state.get("total_chars", 0) or 0)) + size
                state["total_results"] = max(0, int(state.get("total_results", 0) or 0)) + 1
                state["large_results"] = max(0, int(state.get("large_results", 0) or 0))
                if size > 5000:
                    state["large_results"] += 1
                tool_counts = state.get("tool_counts")
                if not isinstance(tool_counts, dict):
                    tool_counts = {}
                tool_counts[tool_key] = max(0, int(tool_counts.get(tool_key, 0) or 0)) + 1
                state["tool_counts"] = tool_counts
                recent_results = state.get("recent_results")
                if not isinstance(recent_results, list):
                    recent_results = []
                recent_results.append(
                    {
                        "ts": _utc_now_iso(),
                        "tool": tool_key,
                        "chars": size,
                    }
                )
                state["recent_results"] = recent_results[-50:]
                save_json_state(path, state)
                return state
            finally:
                unlock(lf)
    except OSError:
        return {
            "session_key": session_key,
            "total_chars": size,
            "total_results": 1,
            "large_results": 1 if size > 5000 else 0,
            "tool_counts": {tool_key: 1},
            "updated_at": _utc_now_iso(),
        }


# Single source of truth for default config — used by token-guard.py and self-heal.py.
# Both import from here to prevent config drift.
DEFAULT_CONFIG = {
    "schema_version": 2,
    "max_agents": 5,
    "parallel_window_seconds": 30,
    "global_cooldown_seconds": 5,
    "max_per_subagent_type": 1,
    "state_ttl_hours": 24,
    "audit_log": True,
    "failure_mode": "fail_open",
    "sanitize_session_ids": True,
    "normalize_paths": True,
    "fault_audit": True,
    "max_string_field_length": 512,
    "metrics_correlation_window_seconds": 15,
    "shadow_rules": {},
    "shadow_default_mode": "enforce",
    "shadow_sample_pct": 100,
    "shadow_audit": True,
    "session_recap_default_window_minutes": 180,
    "one_per_session": [
        "Explore",
        "master-coder",
        "master-researcher",
        "master-architect",
        "master-workflow",
        "Plan",
    ],
    "always_allowed": [
        "claude-code-guide",
        "statusline-setup",
        "haiku",
    ],
}
