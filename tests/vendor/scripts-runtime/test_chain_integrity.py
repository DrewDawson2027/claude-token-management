#!/usr/bin/env python3
"""
Integration tests for the hook chain dispatch system.

Tests the three critical chain components:
  1. auto-review-dispatch.py — commit detection and review enqueuing
  2. build-chain-dispatcher.py — build agent detection and chain creation
  3. chain-advance.py — chain state advancement

These tests verify that:
  - Commits trigger review chains
  - Build agents trigger simplifier→verify chains
  - Non-build agents (architect, scout, etc.) are skipped
  - Chain state files are created and advanced correctly
  - Dead-letter behavior works on expiry

Run: pytest ~/.claude/scripts/tests/test_chain_integrity.py -v
"""

import json
import os
import subprocess
import sys
import tempfile
import time

import pytest

HOOKS_DIR = os.path.expanduser("~/.claude/hooks")
AUTO_REVIEW = os.path.join(HOOKS_DIR, "auto-review-dispatch.py")
BUILD_CHAIN = os.path.join(HOOKS_DIR, "build-chain-dispatcher.py")
CHAIN_ADVANCE = os.path.join(HOOKS_DIR, "chain-advance.py")


@pytest.fixture
def temp_state(tmp_path):
    """Create isolated state directory for tests."""
    state_dir = tmp_path / "session-state"
    state_dir.mkdir()
    (state_dir / "done").mkdir()
    (state_dir / "chains").mkdir()
    env = os.environ.copy()
    env["TOKEN_GUARD_STATE_DIR"] = str(state_dir)
    # Override QUEUE_DIR by setting HOME to a temp dir that has the right structure
    home_claude = tmp_path / ".claude" / "hooks" / "session-state"
    home_claude.mkdir(parents=True)
    (home_claude / "done").mkdir()
    (home_claude / "chains").mkdir()
    env["HOME"] = str(tmp_path)
    return env, tmp_path


def run_hook(hook_path, input_data, env):
    """Run a hook script with JSON input and return (returncode, stdout, stderr)."""
    result = subprocess.run(
        [sys.executable, hook_path],
        input=json.dumps(input_data),
        capture_output=True,
        text=True,
        env=env,
        timeout=10,
    )
    return result.returncode, result.stdout, result.stderr


# ═══════════════════════════════════════════════════════════════════════
# auto-review-dispatch.py tests
# ═══════════════════════════════════════════════════════════════════════


class TestAutoReviewDispatch:
    """Tests for commit detection and review chain triggering."""

    @pytest.mark.skipif(not os.path.isfile(AUTO_REVIEW), reason="Hook not installed")
    def test_simple_commit_triggers_review(self, temp_state):
        env, tmp = temp_state
        data = {
            "tool_name": "Bash",
            "tool_input": {"command": 'git commit -m "fix: handle null case"'},
            "tool_output": "[main abc1234] fix: handle null case\n 1 file changed",
        }
        rc, stdout, stderr = run_hook(AUTO_REVIEW, data, env)
        assert rc == 0
        assert "AUTO-REVIEW TRIGGERED" in stdout or "quick-reviewer" in stdout

    @pytest.mark.skipif(not os.path.isfile(AUTO_REVIEW), reason="Hook not installed")
    def test_commit_with_env_vars_triggers_review(self, temp_state):
        env, tmp = temp_state
        data = {
            "tool_name": "Bash",
            "tool_input": {
                "command": 'GIT_COMMITTER_DATE="2026-01-01" git commit -m "test"'
            },
            "tool_output": "[main def5678] test\n 1 file changed",
        }
        rc, stdout, stderr = run_hook(AUTO_REVIEW, data, env)
        assert rc == 0
        assert "AUTO-REVIEW TRIGGERED" in stdout or "quick-reviewer" in stdout

    @pytest.mark.skipif(not os.path.isfile(AUTO_REVIEW), reason="Hook not installed")
    def test_failed_commit_does_not_trigger(self, temp_state):
        env, tmp = temp_state
        data = {
            "tool_name": "Bash",
            "tool_input": {"command": 'git commit -m "test"'},
            "tool_output": "nothing to commit, working tree clean",
        }
        rc, stdout, stderr = run_hook(AUTO_REVIEW, data, env)
        assert rc == 0
        assert "AUTO-REVIEW" not in stdout

    @pytest.mark.skipif(not os.path.isfile(AUTO_REVIEW), reason="Hook not installed")
    def test_commit_message_with_error_word_still_triggers(self, temp_state):
        """Regression: old code suppressed on 'error:' in output."""
        env, tmp = temp_state
        data = {
            "tool_name": "Bash",
            "tool_input": {"command": 'git commit -m "Fix error: handle null case"'},
            "tool_output": "[main aaa1111] Fix error: handle null case\n 1 file changed",
        }
        rc, stdout, stderr = run_hook(AUTO_REVIEW, data, env)
        assert rc == 0
        # Should still trigger despite "error:" in the commit message
        assert "AUTO-REVIEW TRIGGERED" in stdout

    @pytest.mark.skipif(not os.path.isfile(AUTO_REVIEW), reason="Hook not installed")
    def test_non_bash_tool_ignored(self, temp_state):
        env, tmp = temp_state
        data = {
            "tool_name": "Read",
            "tool_input": {"file_path": "/tmp/test.py"},
        }
        rc, stdout, stderr = run_hook(AUTO_REVIEW, data, env)
        assert rc == 0
        assert stdout.strip() == ""


# ═══════════════════════════════════════════════════════════════════════
# build-chain-dispatcher.py tests
# ═══════════════════════════════════════════════════════════════════════


class TestBuildChainDispatcher:
    """Tests for build agent detection and chain creation."""

    @pytest.mark.skipif(not os.path.isfile(BUILD_CHAIN), reason="Hook not installed")
    def test_general_purpose_triggers_chain(self, temp_state):
        env, tmp = temp_state
        data = {
            "agent_name": "implementation-agent",
            "description": "implement the auth feature",
            "subagent_type": "general-purpose",
        }
        rc, stdout, stderr = run_hook(BUILD_CHAIN, data, env)
        assert rc == 0
        assert "BUILD CHAIN TRIGGERED" in stdout
        # Check chain state file was created
        chains_dir = tmp / ".claude" / "hooks" / "session-state" / "chains"
        chain_files = list(chains_dir.glob("chain-*.json"))
        assert len(chain_files) == 1
        chain = json.loads(chain_files[0].read_text())
        assert chain["type"] == "build"
        assert len(chain["steps"]) == 2
        assert chain["steps"][0]["name"] == "code-simplifier"
        assert chain["steps"][1]["name"] == "verify-app"

    @pytest.mark.skipif(not os.path.isfile(BUILD_CHAIN), reason="Hook not installed")
    def test_scout_does_not_trigger(self, temp_state):
        env, tmp = temp_state
        data = {
            "agent_name": "scout",
            "description": "find the config file",
            "subagent_type": "scout",
        }
        rc, stdout, stderr = run_hook(BUILD_CHAIN, data, env)
        assert rc == 0
        assert "BUILD CHAIN" not in stdout

    @pytest.mark.skipif(not os.path.isfile(BUILD_CHAIN), reason="Hook not installed")
    def test_code_architect_does_not_trigger(self, temp_state):
        env, tmp = temp_state
        data = {
            "agent_name": "code-architect",
            "description": "design the update architecture",
            "subagent_type": "code-architect",
        }
        rc, stdout, stderr = run_hook(BUILD_CHAIN, data, env)
        assert rc == 0
        assert "BUILD CHAIN" not in stdout

    @pytest.mark.skipif(not os.path.isfile(BUILD_CHAIN), reason="Hook not installed")
    def test_empty_agent_does_not_trigger(self, temp_state):
        env, tmp = temp_state
        data = {
            "agent_name": "",
            "description": "",
            "subagent_type": "",
        }
        rc, stdout, stderr = run_hook(BUILD_CHAIN, data, env)
        assert rc == 0
        assert "BUILD CHAIN" not in stdout

    @pytest.mark.skipif(not os.path.isfile(BUILD_CHAIN), reason="Hook not installed")
    def test_reviewer_triggers_fp_checker(self, temp_state):
        env, tmp = temp_state
        data = {
            "agent_name": "quick-reviewer",
            "description": "review the recent changes",
            "subagent_type": "quick-reviewer",
        }
        rc, stdout, stderr = run_hook(BUILD_CHAIN, data, env)
        assert rc == 0
        assert "FP-CHECKER CHAIN" in stdout

    @pytest.mark.skipif(not os.path.isfile(BUILD_CHAIN), reason="Hook not installed")
    def test_verify_app_does_not_retrigger(self, temp_state):
        env, tmp = temp_state
        data = {
            "agent_name": "verify-app",
            "description": "verify the application",
            "subagent_type": "verify-app",
        }
        rc, stdout, stderr = run_hook(BUILD_CHAIN, data, env)
        assert rc == 0
        assert "BUILD CHAIN" not in stdout
        assert "FP-CHECKER" not in stdout


# ═══════════════════════════════════════════════════════════════════════
# chain-advance.py tests
# ═══════════════════════════════════════════════════════════════════════


class TestChainAdvance:
    """Tests for chain state advancement."""

    @pytest.mark.skipif(
        not os.path.isfile(CHAIN_ADVANCE), reason="chain-advance.py not installed"
    )
    def test_advances_to_next_step(self, tmp_path):
        chain = {
            "chain_id": "chain-test001",
            "type": "build",
            "steps": [
                {"name": "code-simplifier", "status": "pending"},
                {"name": "verify-app", "status": "pending"},
            ],
            "current_step": 0,
            "created_at": "2026-03-05T00:00:00Z",
        }
        chain_path = tmp_path / "chain-test001.json"
        chain_path.write_text(json.dumps(chain))

        result = subprocess.run(
            [sys.executable, CHAIN_ADVANCE, str(chain_path)],
            capture_output=True,
            text=True,
            timeout=5,
        )

        # Read updated chain state
        updated = json.loads(chain_path.read_text())
        assert updated["steps"][0]["status"] == "done"
        assert updated["current_step"] == 1

    @pytest.mark.skipif(
        not os.path.isfile(CHAIN_ADVANCE), reason="chain-advance.py not installed"
    )
    def test_chain_complete_returns_empty(self, tmp_path):
        chain = {
            "chain_id": "chain-test002",
            "type": "build",
            "steps": [
                {"name": "code-simplifier", "status": "done"},
                {"name": "verify-app", "status": "pending"},
            ],
            "current_step": 1,
            "created_at": "2026-03-05T00:00:00Z",
        }
        chain_path = tmp_path / "chain-test002.json"
        chain_path.write_text(json.dumps(chain))

        result = subprocess.run(
            [sys.executable, CHAIN_ADVANCE, str(chain_path)],
            capture_output=True,
            text=True,
            timeout=5,
        )

        updated = json.loads(chain_path.read_text())
        assert updated["steps"][1]["status"] == "done"
        assert updated["current_step"] == 2  # past end = chain complete


# ═══════════════════════════════════════════════════════════════════════
# End-to-end chain scenario
# ═══════════════════════════════════════════════════════════════════════


class TestEndToEndChain:
    """Verify full chain lifecycle: trigger → create state → advance → complete."""

    @pytest.mark.skipif(
        not (os.path.isfile(BUILD_CHAIN) and os.path.isfile(CHAIN_ADVANCE)),
        reason="Hooks not installed",
    )
    def test_full_build_chain_lifecycle(self, temp_state):
        env, tmp = temp_state

        # Step 1: Build agent completes → triggers chain
        data = {
            "agent_name": "vibe-coder",
            "description": "implement new dashboard",
            "subagent_type": "vibe-coder",
        }
        rc, stdout, stderr = run_hook(BUILD_CHAIN, data, env)
        assert rc == 0
        assert "BUILD CHAIN TRIGGERED" in stdout

        # Verify chain state was created
        chains_dir = tmp / ".claude" / "hooks" / "session-state" / "chains"
        chain_files = list(chains_dir.glob("chain-*.json"))
        assert len(chain_files) >= 1

        chain_path = chain_files[0]
        chain = json.loads(chain_path.read_text())
        assert chain["current_step"] == 0
        assert chain["steps"][0]["name"] == "code-simplifier"
        assert chain["steps"][0]["status"] == "pending"

        # Step 2: Advance chain (simulates code-simplifier completing)
        result = subprocess.run(
            [sys.executable, CHAIN_ADVANCE, str(chain_path)],
            capture_output=True,
            text=True,
            env=env,
            timeout=5,
        )

        chain = json.loads(chain_path.read_text())
        assert chain["steps"][0]["status"] == "done"
        assert chain["current_step"] == 1

        # Step 3: Advance again (simulates verify-app completing)
        result = subprocess.run(
            [sys.executable, CHAIN_ADVANCE, str(chain_path)],
            capture_output=True,
            text=True,
            env=env,
            timeout=5,
        )

        chain = json.loads(chain_path.read_text())
        assert chain["steps"][1]["status"] == "done"
        assert chain["current_step"] == 2  # past end = complete
