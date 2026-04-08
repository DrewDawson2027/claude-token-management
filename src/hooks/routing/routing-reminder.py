#!/usr/bin/env python3
"""
routing-reminder.py — UserPromptSubmit hook

Fires on EVERY message. Emits a short routing preamble so the model
actively thinks about what the user is trying to do and picks the right
model/agent/skill — without needing specific trigger words.

Every 25 messages also emits a full routing refresh to counteract
long-session drift where the model forgets its rules.

Output to stdout → injected as <system-reminder> before model sees prompt.
Exit 0 always (advisory only, never blocks).
"""

import json
import sys
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent
INFRA_DIR = THIS_DIR.parent / "infrastructure"
for candidate in (THIS_DIR, INFRA_DIR):
    candidate_str = str(candidate)
    if candidate.is_dir() and candidate_str not in sys.path:
        sys.path.insert(0, candidate_str)

try:
    from runtime_paths import logs_dir
except Exception:
    def logs_dir() -> Path:
        return Path.home() / ".claude" / "logs"


COUNTER_DIR = logs_dir()
COUNTER_DIR.mkdir(parents=True, exist_ok=True)

# Fires on EVERY message — makes the model think about routing before acting
ROUTING_PREAMBLE = """⚡ AUTONOMOUS ROUTING — do this silently before every response:

1. What is the user actually trying to accomplish? (ignore exact wording)
2. Match to your routing rules in CLAUDE.md and pick the right action:
   - Commit / push / PR → Haiku + `/commit` or `/commit-push-pr`
   - Debug / fix / broken → Sonnet + `/debug-issue`
   - Build / implement / add feature → Sonnet (auto-chain: code-simplifier → verify-app after)
   - Review PR / check code → `/review`
   - Research / investigate / analyze / audit / explore codebase → GATE FIRST: (1) Is the content already in the context window or a recently read file? (2) Can Grep answer in ≤3 searches? If yes to either → use it directly, no agent. Only if both fail → dispatch Explore (Haiku) + deep-researcher (Sonnet) in parallel, backgrounded
   - Architecture / system design / how to structure → Sonnet + `code-architect`
   - File lookup / does X exist / find → scout (Haiku) or Grep directly
   - Security audit → `/security-review`
3. Act. Do not ask which command or model to use. Do not wait for permission.
   The user should never have to remember a command name or specific word.
4. If dispatching any agent: (a) run_in_background=true for heavy work, (b) prompt ≤15 lines — output format only, (c) never re-read files already in main context — paste content directly, (d) dispatch + scope check in same parallel message."""

# Long-session refresh every 25 messages
FULL_ROUTING_REFRESH = """⚡ ROUTING REFRESH (long session — re-anchoring):
• Haiku  → commits, scouts, quick-reviewer, fp-checker
• Sonnet → DEFAULT: coding, debug, review, build, verify-app, architecture, security
• Research/analysis → GATE FIRST: already in context window? Grep answers in ≤3 searches? If yes → use it, no agent. Only if both fail → Explore (Haiku) + deep-researcher (Sonnet) backgrounded in parallel. External dispatch ONLY when user explicitly asks.

Auto-chains (fire without being asked):
  git commit → quick-reviewer → fp-checker
  build done → code-simplifier → verify-app
  review done → fp-checker

Agent dispatch hard rules (ALWAYS):
  • run_in_background=true for any agent doing 5+ tool calls
  • Prompt ≤15 lines — task + output format only, no checklists
  • Never re-read files already in main context — paste content inline
  • Scope check + dispatch in the same parallel message — never sequential

Never ask which model/agent/skill. Pattern-match and act."""


def get_count(session_id: str) -> int:
    if not session_id:
        return 0
    try:
        return int(
            (COUNTER_DIR / f".routing-counter-{session_id[:12]}").read_text().strip()
        )
    except Exception:
        return 0


def increment(session_id: str) -> int:
    if not session_id:
        return 0
    f = COUNTER_DIR / f".routing-counter-{session_id[:12]}"
    count = get_count(session_id) + 1
    try:
        f.write_text(str(count))
    except Exception:
        pass
    return count


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    prompt = data.get("prompt", "")
    session_id = data.get("session_id", "")

    if not prompt:
        sys.exit(0)

    msg_count = increment(session_id)
    reminders = [ROUTING_PREAMBLE]

    # Long-session routing refresh every 25 messages
    if msg_count > 0 and msg_count % 25 == 0:
        reminders.append(FULL_ROUTING_REFRESH)

    print("\n\n".join(reminders))
    sys.exit(0)


if __name__ == "__main__":
    main()
