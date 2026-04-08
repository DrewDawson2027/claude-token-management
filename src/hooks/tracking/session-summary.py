#!/usr/bin/env python3
"""Session Summary — Stop hook that writes final session analytics.

On session end:
1. Reads the session's hot-layer token file
2. Writes a session summary line to daily sessions JSONL
3. Cleans up the hot-layer file

Fail-open: never blocks session termination.
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent
INFRA_DIR = THIS_DIR.parent / "infrastructure"
for candidate in (THIS_DIR, INFRA_DIR):
    candidate_str = str(candidate)
    if candidate.is_dir() and candidate_str not in sys.path:
        sys.path.insert(0, candidate_str)

try:
    from runtime_paths import hooks_dir, session_state_dir, token_analytics_dir
except Exception:
    def hooks_dir() -> Path:
        return Path.home() / ".claude" / "hooks"

    def session_state_dir() -> Path:
        return hooks_dir() / "session-state"

    def token_analytics_dir() -> Path:
        return Path.home() / ".claude" / "token-analytics"


from hook_utils import locked_append

STATE_DIR = session_state_dir()
SESSIONS_DIR = token_analytics_dir() / "sessions"


def main():
    try:
        input_data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    session_id = input_data.get("session_id", "")
    if not session_id:
        sys.exit(0)

    # Find the hot-layer token file
    safe_key = "".join(c for c in session_id if c.isalnum() or c in "-_")[:64]
    token_path = STATE_DIR / f"{safe_key}-tokens.json"

    if not token_path.exists():
        sys.exit(0)

    try:
        state = json.loads(token_path.read_text())
    except (OSError, json.JSONDecodeError):
        sys.exit(0)

    totals = state.get("totals", {})
    # Skip empty sessions
    if totals.get("apiCalls", 0) == 0:
        # Clean up the file anyway
        try:
            token_path.unlink(missing_ok=True)
        except OSError:
            pass
        sys.exit(0)

    # Build session summary
    summary = {
        "sessionId": session_id,
        "startedAt": state.get("startedAt", ""),
        "endedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "totals": totals,
        "models": state.get("models", {}),
        "agentsSpawned": state.get("agentsSpawned", 0),
        "agentsBlocked": state.get("agentsBlocked", 0),
        "toolCounts": state.get("toolCounts", {}),
    }

    # Calculate duration
    try:
        start = datetime.fromisoformat(summary["startedAt"].replace("Z", "+00:00"))
        end = datetime.fromisoformat(summary["endedAt"].replace("Z", "+00:00"))
        summary["durationSeconds"] = int((end - start).total_seconds())
    except (ValueError, TypeError):
        summary["durationSeconds"] = 0

    # Write to daily sessions JSONL
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    sessions_file = SESSIONS_DIR / f"{today}.jsonl"
    locked_append(str(sessions_file), json.dumps(summary) + "\n")

    # Clean up hot-layer file
    try:
        token_path.unlink(missing_ok=True)
    except OSError:
        pass

    # Brief summary to stderr (visible but doesn't interfere)
    cost = totals.get("costUSD", 0)
    calls = totals.get("apiCalls", 0)
    duration = summary.get("durationSeconds", 0)
    dur_str = f"{duration // 3600}h {(duration % 3600) // 60}m" if duration > 0 else "unknown"
    print(
        f"Session {session_id[:8]}: {calls} API calls, ${cost:.2f} equiv. ({dur_str})",
        file=sys.stderr,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(0)
