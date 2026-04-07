#!/usr/bin/env python3
"""Build Chain Dispatcher — SubagentStop hook.

When a build/implementation subagent finishes, dispatches the mandatory
post-build chain: code-simplifier → verify-app.

MECHANICAL DISPATCH: Writes to mandatory action queue (same file as
auto-review-dispatch). check-inbox.sh re-delivers on every tool call
until completion. Same persistence model as Agent Teams' SendMessage.

Detection logic:
  - Agent type whitelist only (general-purpose, vibe-coder, master-coder)
  - Keyword fallback REMOVED — caused false-positive chain triggers
  - Unknown/empty agents → skip (don't assume build)
  - Reviewers/researchers/scouts/architects → skip silently
"""

import json
import os
import sys
import time
import uuid

QUEUE_DIR = os.path.expanduser("~/.claude/hooks/session-state")
QUEUE_FILE = os.path.join(QUEUE_DIR, "mandatory-actions.jsonl")
CHAINS_DIR = os.path.join(QUEUE_DIR, "chains")

# Agent types that genuinely build code (whitelist approach)
BUILD_AGENTS = frozenset(
    {
        "master-coder",
        "vibe-coder",
        "general-purpose",
    }
)

# Review agents trigger the fp-checker chain instead of build chain.
# Uses exact agent type names only — "review" substring removed to prevent
# false matches from custom agents like "code-review-summarizer".
REVIEW_KEYWORDS = frozenset(
    {
        "quick-reviewer",
        "reviewer",
    }
)

SKIP_KEYWORDS = frozenset(
    {
        "verify",
        "verify-app",
        "simplify",
        "code-simplifier",
        "scout",
        "explore",
        "research",
        "architect",
        "code-architect",
        "plan",
        "audit",
        "lint",
        "fp-checker",
        "false-positive",
    }
)


def _enqueue_action(action_type: str, instruction: str, context: str = "") -> str:
    """Write a mandatory action to the persistent queue. Returns action_id."""
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
    # Also print for immediate delivery
    print(instruction)
    return action_id


def _patch_last_action_chain_id(chain_id: str):
    """Add chain_id to the last action in the queue file."""
    if not os.path.isfile(QUEUE_FILE):
        return
    lines = []
    with open(QUEUE_FILE) as f:
        lines = f.readlines()
    if not lines:
        return
    try:
        last = json.loads(lines[-1])
        last["chain_id"] = chain_id
        lines[-1] = json.dumps(last) + "\n"
        with open(QUEUE_FILE, "w") as f:
            f.writelines(lines)
    except (json.JSONDecodeError, IndexError):
        pass


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    agent_name = str(data.get("agent_name", "")).lower()
    agent_desc = str(data.get("description", "")).lower()
    agent_type = str(data.get("subagent_type", "")).lower()
    agent_text = f"{agent_name} {agent_desc}".strip()

    # Empty/unnamed agents → skip (don't assume build)
    if not agent_text.strip():
        sys.exit(0)

    # Explicit skip: post-chain agents (avoid infinite loops)
    if any(kw in agent_text for kw in SKIP_KEYWORDS):
        sys.exit(0)

    # ── REVIEW chain: quick-reviewer/reviewer → fp-checker ───────────────────
    is_review_agent = any(kw in agent_text for kw in REVIEW_KEYWORDS)

    if is_review_agent:
        # Clear review-pending flag — the review was dispatched and completed
        review_flag = os.path.join(QUEUE_DIR, "review-pending")
        try:
            os.unlink(review_flag)
        except FileNotFoundError:
            pass

        _enqueue_action(
            "fp-checker-after-review",
            "FP-CHECKER CHAIN TRIGGERED: review agent completed.\n"
            "MANDATORY — run now without asking:\n"
            "  1. Collect ALL findings from the review that just completed\n"
            "  2. Spawn `fp-checker` agent (model: haiku) with those findings as input\n"
            "  3. Only surface CONFIRMED findings to the user — drop REFUTED ones\n"
            "  4. For UNCERTAIN findings: include with a note that human judgment is needed\n"
            "Do NOT show the raw review output. Show only fp-checker's filtered results.\n"
            "This is a MECHANICAL dispatch — this message will repeat until acted on.",
            context=agent_text,
        )
        sys.exit(0)

    # ── BUILD chain: build agent → code-simplifier → verify-app ─────────────
    # Agent type whitelist (sole signal — keywords removed to avoid false positives)
    is_build_agent_type = agent_type in BUILD_AGENTS

    if is_build_agent_type:
        # Create persistent chain state file
        chain_id = f"chain-{uuid.uuid4().hex[:8]}"
        os.makedirs(CHAINS_DIR, exist_ok=True)
        chain_state = {
            "chain_id": chain_id,
            "type": "build",
            "steps": [
                {"name": "code-simplifier", "status": "pending"},
                {"name": "verify-app", "status": "pending"},
            ],
            "current_step": 0,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "trigger_agent": agent_text,
        }
        chain_path = os.path.join(CHAINS_DIR, f"{chain_id}.json")
        with open(chain_path, "w") as f:
            json.dump(chain_state, f, indent=2)

        # Enqueue only the FIRST step (chain-advance.py handles subsequent steps)
        action_id = _enqueue_action(
            "chain-step",
            "BUILD CHAIN TRIGGERED: implementation agent completed.\n"
            "MANDATORY — Spawn `code-simplifier` agent (model: sonnet) now.\n"
            "This is step 1/2 of the build chain. After it completes,\n"
            "the chain will automatically advance to `verify-app`.\n"
            "Do NOT skip. Do NOT ask the user. Just run it.",
            context=agent_text,
        )
        # Patch the last enqueued action with chain_id
        _patch_last_action_chain_id(chain_id)

        # Write action_id back into chain state for correlation
        chain_state["steps"][0]["action_id"] = action_id
        with open(chain_path, "w") as f:
            json.dump(chain_state, f, indent=2)


if __name__ == "__main__":
    main()
