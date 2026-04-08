#!/usr/bin/env python3
"""Cost Tagger — SessionStart hook that tags sessions with cost centers.

Part of the Token Management System (Innovation #8: Cost Attribution).

How it works:
  Fires on SessionStart.
  Auto-detects project from $PWD and maps to a cost tag.
  Writes tag to session state for pickup by budget-guard and monthly report.

Mappings:
  ~/Projects/X      → work/X
  ~/.claude          → infra/claude
  ~/atlas-betting    → work/atlas
  default            → personal

Config: ~/.claude/hooks/token-guard-config.json → "cost_attribution" section
"""

import json
import os
import sys
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent
INFRA_DIR = THIS_DIR.parent / "infrastructure"
for candidate in (THIS_DIR, INFRA_DIR):
    candidate_str = str(candidate)
    if candidate.is_dir() and candidate_str not in sys.path:
        sys.path.insert(0, candidate_str)

try:
    from runtime_paths import hooks_dir, runtime_dir, session_state_dir
except Exception:
    def runtime_dir() -> Path:
        return Path.home() / ".claude"

    def hooks_dir() -> Path:
        return runtime_dir() / "hooks"

    def session_state_dir() -> Path:
        return hooks_dir() / "session-state"

CONFIG_PATH = os.environ.get(
    "TOKEN_GUARD_CONFIG_PATH",
    str(hooks_dir() / "token-guard-config.json"),
)
STATE_DIR = str(session_state_dir())


def load_config() -> dict:
    """Load cost_attribution section from config."""
    defaults = {
        "enabled": True,
        "default_tag": "personal",
        "auto_detect": True,
        "custom_mappings": {},
    }
    try:
        with open(CONFIG_PATH) as f:
            raw = json.load(f)
        section = raw.get("cost_attribution")
        if isinstance(section, dict):
            defaults.update(section)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return defaults


def detect_tag(cwd: str, config: dict) -> str:
    """Auto-detect cost tag from current working directory."""
    home = str(Path.home())
    cwd_expanded = os.path.realpath(cwd)

    # Check custom mappings first
    custom = config.get("custom_mappings", {})
    for pattern, tag in custom.items():
        expanded_pattern = os.path.expanduser(pattern)
        if cwd_expanded.startswith(os.path.realpath(expanded_pattern)):
            return tag

    # Auto-detect rules
    projects_dir = os.path.join(home, "Projects")
    claude_dir = os.path.realpath(str(runtime_dir()))

    if cwd_expanded.startswith(projects_dir):
        # Extract project name: ~/Projects/X → work/X
        remainder = cwd_expanded[len(projects_dir):].strip("/")
        project = remainder.split("/")[0] if remainder else "misc"
        return f"work/{project}"

    if cwd_expanded.startswith(claude_dir):
        return "infra/claude"

    # Known project dirs at home level
    known_projects = {
        "atlas-betting": "work/atlas",
        "greekpay": "work/greekpay",
        "therapist-app": "work/therapist-app",
        "twitter_growth_engine": "work/twitter-growth",
        "soccer_passes_framework": "work/soccer",
    }
    for dirname, tag in known_projects.items():
        if cwd_expanded.startswith(os.path.join(home, dirname)):
            return tag

    return config.get("default_tag", "personal")


def main():
    try:
        input_data = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    if not isinstance(input_data, dict):
        sys.exit(0)

    config = load_config()
    if not config.get("enabled", True):
        sys.exit(0)

    session_id = input_data.get("session_id", "unknown")
    cwd = os.environ.get("PWD", os.getcwd())

    tag = detect_tag(cwd, config) if config.get("auto_detect", True) else config.get("default_tag", "personal")

    # Write tag to session state
    os.makedirs(STATE_DIR, exist_ok=True)
    safe_session = "".join(c for c in session_id if c.isalnum() or c in "-_")[:64]
    state_path = os.path.join(STATE_DIR, f"{safe_session}-cost-tag.json")

    state = {
        "session_id": session_id,
        "cost_tag": tag,
        "cwd": cwd,
        "auto_detected": config.get("auto_detect", True),
    }

    try:
        with open(state_path, "w") as f:
            json.dump(state, f, indent=2)
    except OSError:
        pass

    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        try:
            from hook_utils import record_hook_outcome
            code = e.code if isinstance(e.code, int) else 0
            record_hook_outcome("cost-tagger", "success" if code == 0 else "error")
        except Exception:
            pass
        raise
    except Exception:
        try:
            from hook_utils import record_hook_outcome
            record_hook_outcome("cost-tagger", "fail_open")
        except Exception:
            pass
        sys.exit(0)
