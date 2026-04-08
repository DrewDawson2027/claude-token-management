#!/usr/bin/env python3
"""Session Token Tracker — real-time per-session token consumption.

PostToolUse hook that incrementally reads new lines from the session's JSONL
file, sums token usage, and updates a hot-layer JSON file for instant queries.

Uses file offset tracking to only read new data (<20ms per invocation).
Fail-open: if anything goes wrong, silently exits without blocking.
"""

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

THIS_DIR = Path(__file__).resolve().parent
INFRA_DIR = THIS_DIR.parent / "infrastructure"
for candidate in (THIS_DIR, INFRA_DIR):
    candidate_str = str(candidate)
    if candidate.is_dir() and candidate_str not in sys.path:
        sys.path.insert(0, candidate_str)

try:
    from runtime_paths import projects_dir, scripts_dir, session_state_dir
except Exception:
    def scripts_dir() -> Path:
        return Path.home() / ".claude" / "scripts"

    def projects_dir() -> Path:
        return Path.home() / ".claude" / "projects"

    def session_state_dir() -> Path:
        return Path.home() / ".claude" / "hooks" / "session-state"


SCRIPTS_DIR = scripts_dir()
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

try:
    from pricing import calculate_cost_from_usage, normalize_model_name
except ImportError:

    def calculate_cost_from_usage(model, usage):
        return 0.0

    def normalize_model_name(m):
        return m

PROJECTS_DIR = projects_dir()
STATE_DIR = session_state_dir()


def find_session_jsonl(session_id: str) -> Optional[Path]:
    """Find the JSONL file for a session across all project directories."""
    if not session_id or not PROJECTS_DIR.exists():
        return None
    for proj_dir in PROJECTS_DIR.iterdir():
        if not proj_dir.is_dir():
            continue
        candidate = proj_dir / f"{session_id}.jsonl"
        if candidate.is_file():
            return candidate
    return None


def load_state(state_path: Path) -> dict:
    """Load existing session tracking state."""
    try:
        return json.loads(state_path.read_text())
    except (OSError, json.JSONDecodeError, ValueError):
        return {}


def save_state(state_path: Path, state: dict):
    """Atomically save session tracking state."""
    tmp = state_path.with_suffix(".tmp")
    try:
        tmp.write_text(json.dumps(state, indent=2) + "\n")
        tmp.replace(state_path)
    except OSError:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def main():
    try:
        input_data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    if not isinstance(input_data, dict):
        sys.exit(0)

    session_id = input_data.get("session_id", "")
    if not session_id:
        sys.exit(0)

    hook_event = input_data.get("hook_event_name", "")

    # ── SubagentStop handler: increment agentsCompleted counter ──
    if hook_event == "SubagentStop":
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        safe_key = "".join(c for c in session_id if c.isalnum() or c in "-_")[:64]
        state_path = STATE_DIR / f"{safe_key}-tokens.json"
        state = load_state(state_path)
        if state.get("sessionId"):
            state["agentsCompleted"] = state.get("agentsCompleted", 0) + 1
            state["lastUpdatedAt"] = datetime.now(timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%SZ"
            )
            save_state(state_path, state)
        sys.exit(0)

    # Tool name is "Task" in Claude Code payloads (defensive: also check "Agent")
    tool_name = input_data.get("tool_name", "")

    # Find session JSONL
    jsonl_path = find_session_jsonl(session_id)
    if not jsonl_path:
        sys.exit(0)

    # State file
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    safe_key = "".join(c for c in session_id if c.isalnum() or c in "-_")[:64]
    state_path = STATE_DIR / f"{safe_key}-tokens.json"

    state = load_state(state_path)
    last_offset = state.get("lastOffset", 0)

    # Get current file size
    try:
        file_size = jsonl_path.stat().st_size
    except OSError:
        sys.exit(0)

    # Nothing new to read
    if file_size <= last_offset:
        # Still update tool counts and agent spawns
        dirty = False
        if tool_name:
            tc = state.get("toolCounts", {})
            tc[tool_name] = tc.get(tool_name, 0) + 1
            state["toolCounts"] = tc
            dirty = True
        if tool_name in ("Task", "Agent"):
            state["agentsSpawned"] = state.get("agentsSpawned", 0) + 1
            dirty = True
        if dirty:
            state["lastUpdatedAt"] = datetime.now(timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%SZ"
            )
            save_state(state_path, state)
        sys.exit(0)

    # Initialize state if new
    if not state.get("sessionId"):
        state = {
            "sessionId": session_id,
            "startedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "lastUpdatedAt": "",
            "lastOffset": 0,
            "totals": {
                "inputTokens": 0,
                "outputTokens": 0,
                "cacheCreationTokens": 0,
                "cacheReadTokens": 0,
                "costUSD": 0.0,
                "apiCalls": 0,
            },
            "models": {},
            "agentsSpawned": 0,
            "agentsCompleted": 0,
            "agentsBlocked": 0,
            "toolCounts": {},
        }
        last_offset = 0

    # Read new lines from offset
    new_input = 0
    new_output = 0
    new_cache_create = 0
    new_cache_read = 0
    new_cost = 0.0
    new_api_calls = 0
    new_models: dict[str, dict] = {}

    try:
        with jsonl_path.open("r", encoding="utf-8", errors="ignore") as f:
            f.seek(last_offset)
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if entry.get("type") != "assistant":
                    continue
                msg = entry.get("message", {})
                if not isinstance(msg, dict):
                    continue
                usage = msg.get("usage")
                if not usage or not isinstance(usage, dict):
                    continue

                model_raw = msg.get("model", "unknown")
                cost = calculate_cost_from_usage(model_raw, usage)

                inp = int(usage.get("input_tokens", 0) or 0)
                out = int(usage.get("output_tokens", 0) or 0)
                cc = int(usage.get("cache_creation_input_tokens", 0) or 0)
                cr = int(usage.get("cache_read_input_tokens", 0) or 0)

                new_input += inp
                new_output += out
                new_cache_create += cc
                new_cache_read += cr
                new_cost += cost
                new_api_calls += 1

                mk = normalize_model_name(model_raw) or model_raw
                m = new_models.setdefault(mk, {"messages": 0, "costUSD": 0.0})
                m["messages"] += 1
                m["costUSD"] += cost

            new_offset = f.tell()
    except (OSError, PermissionError):
        sys.exit(0)

    # Update state totals
    totals = state.get("totals", {})
    totals["inputTokens"] = totals.get("inputTokens", 0) + new_input
    totals["outputTokens"] = totals.get("outputTokens", 0) + new_output
    totals["cacheCreationTokens"] = (
        totals.get("cacheCreationTokens", 0) + new_cache_create
    )
    totals["cacheReadTokens"] = totals.get("cacheReadTokens", 0) + new_cache_read
    totals["costUSD"] = round(totals.get("costUSD", 0.0) + new_cost, 4)
    totals["apiCalls"] = totals.get("apiCalls", 0) + new_api_calls
    state["totals"] = totals

    # Update model breakdown
    existing_models = state.get("models", {})
    for mk, mv in new_models.items():
        em = existing_models.setdefault(mk, {"messages": 0, "costUSD": 0.0})
        em["messages"] += mv["messages"]
        em["costUSD"] = round(em["costUSD"] + mv["costUSD"], 4)
    state["models"] = existing_models

    # Update tool counts
    if tool_name:
        tc = state.get("toolCounts", {})
        tc[tool_name] = tc.get(tool_name, 0) + 1
        state["toolCounts"] = tc

    # Track agent spawns — increment when Task/Agent tool is used
    if tool_name in ("Task", "Agent"):
        state["agentsSpawned"] = state.get("agentsSpawned", 0) + 1

    state["lastOffset"] = new_offset
    state["lastUpdatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    save_state(state_path, state)


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        try:
            from hook_utils import record_hook_outcome

            code = e.code if isinstance(e.code, int) else 0
            outcome = "success" if code == 0 else "error"
            record_hook_outcome("session-tracker", outcome)
        except Exception:
            pass
        raise
    except Exception:
        try:
            from hook_utils import record_hook_outcome

            record_hook_outcome("session-tracker", "fail_open")
        except Exception:
            pass
        # Fail-open: never block the tool call
        sys.exit(0)
