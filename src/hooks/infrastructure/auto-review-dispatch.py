#!/usr/bin/env python3
"""Auto-Review Dispatcher — PostToolUse hook.

Fires after Bash tool calls and auto-dispatches review agents:
  - git commit → instructs Claude to spawn quick-reviewer on committed files
  - gh pr create / gh pr view → instructs Claude to run /review

MECHANICAL DISPATCH: Writes to mandatory action queue instead of one-shot
stderr. check-inbox.sh re-delivers the action on every tool call until
Claude completes it (same persistence model as Agent Teams' SendMessage).

Exit 0 always (non-blocking).
"""

import json
import os
import re
import sys
import time
import uuid

QUEUE_DIR = os.path.expanduser("~/.claude/hooks/session-state")
QUEUE_FILE = os.path.join(QUEUE_DIR, "mandatory-actions.jsonl")


def _enqueue_action(action_type: str, instruction: str, context: str = "") -> str:
    """Write a mandatory action to the persistent queue. Returns action_id.

    check-inbox.sh reads this queue on EVERY tool call and injects the
    action into Claude's context until a completion marker is written.
    This is the mechanical equivalent of Agent Teams' SendMessage.
    """
    os.makedirs(QUEUE_DIR, exist_ok=True)
    action_id = f"{action_type}-{int(time.time())}-{uuid.uuid4().hex[:6]}"
    action = {
        "id": action_id,
        "type": action_type,
        "instruction": instruction,
        "context": context,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": "pending",
    }
    with open(QUEUE_FILE, "a") as f:
        f.write(json.dumps(action) + "\n")
    # Also print for immediate delivery (belt and suspenders)
    print(instruction)
    return action_id


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    if data.get("tool_name") != "Bash":
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "").strip()
    tool_output = str(data.get("tool_output", ""))

    # Normalize for matching (handle multi-line commands — check first line)
    first_line = command.split("\n")[0].strip()

    # ── git commit → quick-reviewer ──────────────────────────────────────────
    if _is_git_commit(first_line, command):
        # Positive success detection: look for git commit success pattern [branch hash]
        # instead of suppressing on broad "error:" substring match
        if "nothing to commit" in tool_output:
            sys.exit(0)
        commit_success = re.search(r"\[[\w/.-]+ [a-f0-9]{7,}\]", tool_output)
        if not commit_success:
            sys.exit(0)  # Commit likely failed — don't enqueue review
        action_id = _enqueue_action(
            "review-after-commit",
            "AUTO-REVIEW TRIGGERED: git commit completed successfully.\n"
            "MANDATORY — do this now, without asking:\n"
            "1. Run: git diff HEAD~1 --name-only   (get the list of changed files)\n"
            "2. Spawn the `quick-reviewer` agent (model: haiku) on those files\n"
            "3. Report any blockers found before continuing\n"
            "This is a MECHANICAL dispatch — this message will repeat until acted on.",
            context=command,
        )
        # Write review-pending flag for review-gate.py enforcement
        flag_path = os.path.join(QUEUE_DIR, "review-pending")
        try:
            with open(flag_path, "w") as f:
                json.dump(
                    {
                        "action_id": action_id,
                        "created_at": time.strftime(
                            "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                        ),
                        "commit_command": command[:200],
                    },
                    f,
                )
        except OSError:
            pass
        sys.exit(0)

    # ── gh pr create → /review ───────────────────────────────────────────────
    if _is_pr_create(first_line, command, tool_output):
        # Extract PR number from output if available
        pr_hint = ""
        for line in tool_output.splitlines():
            if "github.com" in line and "/pull/" in line:
                pr_hint = f"\nPR URL detected: {line.strip()}"
                break
        _enqueue_action(
            "review-after-pr",
            f"AUTO-REVIEW TRIGGERED: PR was just created.{pr_hint}\n"
            "MANDATORY — do this now, without asking:\n"
            "Run the /review command on this PR immediately.\n"
            "This is a MECHANICAL dispatch — this message will repeat until acted on.",
            context=command,
        )
        sys.exit(0)


def _is_git_commit(first_line: str, full_command: str) -> bool:
    """Detect git commit commands (direct, with flags/env vars, and via scripts)."""
    # Regex catches: git commit, GIT_DIR=... git commit, git -c ... commit, etc.
    if re.search(r"\bgit\b.*\bcommit\b", full_command):
        return True
    return False


def _is_pr_create(first_line: str, full_command: str, output: str) -> bool:
    """Detect PR creation (command or output signal)."""
    cmd_patterns = [
        "gh pr create" in full_command,
        first_line.startswith("gh pr create"),
    ]
    # Also catch if the output looks like a newly created PR URL
    output_signal = (
        "github.com" in output
        and "/pull/" in output
        and ("Created pull request" in output or "https://github" in output)
    )
    return any(cmd_patterns) or output_signal


if __name__ == "__main__":
    main()
