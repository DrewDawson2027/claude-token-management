"""Malformed hook payload tests (Item 2).

Tests ALL Python hooks with malformed stdin payloads to verify they
never crash or hang. Fail-closed hooks must fail-open on bad input.
Fail-open hooks must always exit 0.

Expected behavior: ALL hooks exit 0 on malformed input, because even
fail-closed hooks (token-guard, read-efficiency-guard) explicitly
handle parse failures with exit(0) to avoid blocking on bad data.
"""

import json
import os
import subprocess
import sys
import tempfile

import pytest

HOOKS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Hook definitions: (filename, is_fail_closed, needs_state_dir)
HOOKS = [
    ("token-guard.py", True, True),
    ("budget-guard.py", False, True),
    ("model-router.py", False, True),
    ("read-efficiency-guard.py", True, True),
    ("read-cache.py", False, False),
    ("session-tracker.py", False, False),
    ("agent-metrics.py", False, False),
    ("cost-tagger.py", False, True),
    ("result-compressor.py", False, False),
]


@pytest.fixture
def isolated_env(tmp_path):
    """Provide an isolated environment for hook subprocess execution."""
    state_dir = tmp_path / "session-state"
    state_dir.mkdir(parents=True)
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"schema_version": 2, "max_agents": 5}))

    # Create dirs hooks might look for
    (tmp_path / ".claude" / "hooks" / "session-state").mkdir(parents=True)
    (tmp_path / ".claude" / "cost").mkdir(parents=True)
    (tmp_path / ".claude" / "cache" / "read-results").mkdir(parents=True)
    (tmp_path / ".claude" / "projects").mkdir(parents=True)

    env = os.environ.copy()
    env["HOME"] = str(tmp_path)
    env["TOKEN_GUARD_STATE_DIR"] = str(state_dir)
    env["TOKEN_GUARD_CONFIG_PATH"] = str(config_path)
    # Ensure hooks dir is on PYTHONPATH for imports
    env["PYTHONPATH"] = HOOKS_DIR + os.pathsep + env.get("PYTHONPATH", "")
    return env


def run_hook(hook_file, raw_input, env, timeout=10):
    """Run a hook as subprocess with raw stdin. Returns (exit_code, stdout, stderr)."""
    script = os.path.join(HOOKS_DIR, hook_file)
    result = subprocess.run(
        [sys.executable, script],
        input=raw_input,
        capture_output=True,
        text=True,
        env=env,
        timeout=timeout,
    )
    return result.returncode, result.stdout, result.stderr


# ═══════════════════════════════════════════════════════════════════════════════
# Payload generators
# ═══════════════════════════════════════════════════════════════════════════════

EMPTY_STDIN = ""
NON_JSON_GARBAGE = "not{json at all ["
JUST_A_NUMBER = "42"
JUST_AN_ARRAY = "[1, 2, 3]"
JUST_NULL = "null"
JUST_TRUE = "true"
JUST_STRING = '"hello"'
EMPTY_OBJECT = "{}"
MISSING_TOOL_NAME = json.dumps({"session_id": "test123"})
MISSING_SESSION = json.dumps({"tool_name": "Read"})
HUGE_PAYLOAD = json.dumps({"tool_name": "Task", "session_id": "x" * 100_000})
NULL_BYTES = json.dumps({"tool_name": "Task", "session_id": "abc\x00def"})
UNICODE_EMOJI = json.dumps({"tool_name": "Task", "session_id": "test-\U0001f680-session"})
NEGATIVE_NUMBERS = json.dumps({"tool_name": "Task", "tool_input": {"max_turns": -999}})
BOOL_WHERE_STRING = json.dumps({"tool_name": True, "session_id": False})
NESTED_DEEP = json.dumps({"a": {"b": {"c": {"d": {"e": "deep"}}}}})

PAYLOADS = {
    "empty_stdin": EMPTY_STDIN,
    "non_json_garbage": NON_JSON_GARBAGE,
    "just_number": JUST_A_NUMBER,
    "just_array": JUST_AN_ARRAY,
    "just_null": JUST_NULL,
    "just_true": JUST_TRUE,
    "just_string": JUST_STRING,
    "empty_object": EMPTY_OBJECT,
    "missing_tool_name": MISSING_TOOL_NAME,
    "missing_session": MISSING_SESSION,
    "huge_payload": HUGE_PAYLOAD,
    "null_bytes": NULL_BYTES,
    "unicode_emoji": UNICODE_EMOJI,
    "negative_numbers": NEGATIVE_NUMBERS,
    "bool_where_string": BOOL_WHERE_STRING,
    "nested_deep": NESTED_DEEP,
}


# ═══════════════════════════════════════════════════════════════════════════════
# Parametrized tests: each hook × each payload
# ═══════════════════════════════════════════════════════════════════════════════

HOOK_NAMES = [h[0] for h in HOOKS]
PAYLOAD_NAMES = list(PAYLOADS.keys())


@pytest.mark.parametrize("hook_file", HOOK_NAMES, ids=HOOK_NAMES)
@pytest.mark.parametrize("payload_name", PAYLOAD_NAMES, ids=PAYLOAD_NAMES)
def test_malformed_payload_exits_zero(hook_file, payload_name, isolated_env):
    """Every hook must exit 0 on malformed input — never crash, never hang."""
    raw_input = PAYLOADS[payload_name]
    exit_code, stdout, stderr = run_hook(hook_file, raw_input, isolated_env)
    assert exit_code == 0, (
        f"{hook_file} with {payload_name} payload exited {exit_code}.\n"
        f"stderr: {stderr[:500]}"
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Extra targeted tests for fail-closed hooks
# ═══════════════════════════════════════════════════════════════════════════════


class TestTokenGuardMalformed:
    """Extra tests for token-guard.py which is fail-closed on valid input."""

    def test_empty_stdin_does_not_block(self, isolated_env):
        code, _, stderr = run_hook("token-guard.py", "", isolated_env)
        assert code == 0, f"Empty stdin should fail-open, got exit {code}: {stderr}"

    def test_non_task_tool_passes_through(self, isolated_env):
        """token-guard only cares about Task tool calls."""
        payload = json.dumps({"tool_name": "Read", "session_id": "s123"})
        code, _, _ = run_hook("token-guard.py", payload, isolated_env)
        assert code == 0

    def test_array_stdin_does_not_block(self, isolated_env):
        code, _, _ = run_hook("token-guard.py", "[1,2,3]", isolated_env)
        assert code == 0


class TestReadGuardMalformed:
    """Extra tests for read-efficiency-guard.py which is fail-closed on valid input."""

    def test_empty_stdin_does_not_block(self, isolated_env):
        code, _, stderr = run_hook("read-efficiency-guard.py", "", isolated_env)
        assert code == 0, f"Empty stdin should fail-open, got exit {code}: {stderr}"

    def test_non_read_tool_exits_zero(self, isolated_env):
        """read-efficiency-guard only cares about Read tool calls."""
        payload = json.dumps({"tool_name": "Bash", "session_id": "s123"})
        code, _, _ = run_hook("read-efficiency-guard.py", payload, isolated_env)
        assert code == 0

    def test_null_file_path(self, isolated_env):
        payload = json.dumps({
            "tool_name": "Read",
            "session_id": "s123",
            "tool_input": {"file_path": None},
        })
        code, _, _ = run_hook("read-efficiency-guard.py", payload, isolated_env)
        assert code == 0


class TestResultCompressorMalformed:
    """result-compressor reads stdin specially (tool result, not hook JSON)."""

    def test_binary_garbage(self, isolated_env):
        code, _, _ = run_hook("result-compressor.py", "\x00\x01\x02\xff", isolated_env)
        assert code == 0

    def test_very_long_output(self, isolated_env):
        code, _, _ = run_hook("result-compressor.py", "x" * 200_000, isolated_env)
        assert code == 0
