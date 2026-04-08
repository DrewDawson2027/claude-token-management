#!/usr/bin/env python3
"""
Worktree Router — PreToolUse hook (matcher: "Task").

Before spawning a sub-agent, checks:
  1. How many git worktrees are currently active (slot availability)
  2. Whether the Task prompt asks for isolated work that should run on its own branch
  3. Warns (non-blocking) when all worktree slots are occupied, so you can decide
     whether to wait or proceed anyway.

Max worktree slots default: 3 (configurable in token-guard-config.json → "worktree_router")

This hook is ADVISORY, not blocking (exit 0 always). It injects a warning into
stderr that surfaces in the Claude Code UI so you can make an informed call.

Fail-open: any error → silent exit(0).
"""

import json
import os
import subprocess
import sys
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent
INFRA_DIR = THIS_DIR.parent / "infrastructure"
for candidate in (THIS_DIR, INFRA_DIR):
    candidate_str = str(candidate)
    if candidate.is_dir() and candidate_str not in sys.path:
        sys.path.insert(0, candidate_str)

try:
    from runtime_paths import hooks_dir, worktrees_dir
except Exception:
    def hooks_dir() -> Path:
        return Path.home() / ".claude" / "hooks"

    def worktrees_dir() -> Path:
        return Path.home() / ".claude" / "worktrees"


HOME = Path.home()
CONFIG_PATH = hooks_dir() / "token-guard-config.json"
WORKTREE_STATE = worktrees_dir() / "slots.json"

DEFAULT_MAX_SLOTS = 3


def load_config() -> dict:
    try:
        raw = json.loads(CONFIG_PATH.read_text())
        return raw.get("worktree_router", {})
    except Exception:
        return {}


def get_active_worktrees() -> list[dict]:
    """Run git worktree list --porcelain and parse output."""
    try:
        result = subprocess.run(
            ["git", "worktree", "list", "--porcelain"],
            capture_output=True, text=True, timeout=5,
            cwd=str(HOME)
        )
        worktrees = []
        current: dict = {}
        for line in result.stdout.splitlines():
            if line.startswith("worktree "):
                if current:
                    worktrees.append(current)
                current = {"path": line[9:].strip()}
            elif line.startswith("branch "):
                current["branch"] = line[7:].strip()
            elif line.startswith("HEAD "):
                current["head"] = line[5:].strip()
        if current:
            worktrees.append(current)
        return worktrees
    except Exception:
        return []


def parse_task_input() -> dict:
    """Read STDIN for the Task tool input."""
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return {}
        return json.loads(raw)
    except Exception:
        return {}


def suggests_isolation(prompt: str) -> bool:
    """Heuristic: does this Task prompt suggest it needs branch isolation?"""
    keywords = [
        "branch", "worktree", "isolat", "parallel", "concurrent",
        "separate", "independent", "draft", "experiment", "spike"
    ]
    lower = prompt.lower()
    return any(k in lower for k in keywords)


def main() -> None:
    config = load_config()
    max_slots = int(config.get("max_slots", DEFAULT_MAX_SLOTS))
    enabled = config.get("enabled", True)

    if not enabled:
        sys.exit(0)

    task_input = parse_task_input()
    prompt = task_input.get("prompt", task_input.get("description", ""))

    worktrees = get_active_worktrees()
    # Main worktree + checked-out branches = slot usage
    # Slot 0 is always main working tree — additional worktrees = extra slots
    active_extra = max(0, len(worktrees) - 1)
    available = max_slots - active_extra

    if available <= 0:
        print(
            f"WORKTREE ROUTER: All {max_slots} worktree slots occupied "
            f"({active_extra} extra worktrees active). "
            f"Sub-agent will share the main working tree. "
            f"Consider: `git worktree remove <path>` to free a slot first.",
            file=sys.stderr
        )
    elif suggests_isolation(prompt) and active_extra == 0:
        # Suggest using a worktree for isolated work
        print(
            f"WORKTREE ROUTER: Task appears to need branch isolation "
            f"({available}/{max_slots} slots free). "
            f"Tip: add 'use a new git worktree at /tmp/wt-<name>' to the Task "
            f"prompt for full isolation.",
            file=sys.stderr
        )
    # else: plenty of room, silent pass

    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(0)  # always fail-open
