"""Path traversal tests (Item 4).

Tests every hook/module that touches filesystem paths with traversal payloads.
Verifies that path normalization prevents escaping intended directories.
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile

import pytest

import guard_normalize
import hook_utils


HOOKS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture
def isolated_env(tmp_path):
    """Isolated environment for subprocess hook testing."""
    state_dir = tmp_path / "session-state"
    state_dir.mkdir(parents=True)
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"schema_version": 2, "max_agents": 5}))
    (tmp_path / ".claude" / "hooks" / "session-state").mkdir(parents=True)
    (tmp_path / ".claude" / "cost").mkdir(parents=True)
    (tmp_path / ".claude" / "cache" / "read-results").mkdir(parents=True)
    (tmp_path / ".claude" / "projects").mkdir(parents=True)

    env = os.environ.copy()
    env["HOME"] = str(tmp_path)
    env["TOKEN_GUARD_STATE_DIR"] = str(state_dir)
    env["TOKEN_GUARD_CONFIG_PATH"] = str(config_path)
    env["PYTHONPATH"] = HOOKS_DIR + os.pathsep + env.get("PYTHONPATH", "")
    return env, state_dir


def run_hook(hook_file, raw_input, env, timeout=10):
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
# guard_normalize.py — normalize_file_path
# ═══════════════════════════════════════════════════════════════════════════════


class TestNormalizeFilePath:
    """Test normalize_file_path against traversal payloads."""

    def test_simple_traversal(self):
        result = guard_normalize.normalize_file_path("../../etc/passwd")
        assert ".." not in result
        assert os.path.isabs(result)

    def test_deep_traversal(self):
        result = guard_normalize.normalize_file_path("/tmp/../../../etc/shadow")
        assert ".." not in result
        assert os.path.isabs(result)

    def test_null_bytes_in_path(self):
        result = guard_normalize.normalize_file_path("/tmp/test\x00evil")
        # Should strip or handle null bytes
        assert "\x00" not in result

    def test_tilde_expansion(self):
        result = guard_normalize.normalize_file_path("~/test.txt")
        assert "~" not in result
        assert os.path.isabs(result)

    def test_empty_path(self):
        result = guard_normalize.normalize_file_path("")
        assert result == ""

    def test_none_path(self):
        result = guard_normalize.normalize_file_path(None)
        assert result == ""

    def test_integer_path(self):
        result = guard_normalize.normalize_file_path(42)
        assert isinstance(result, str)

    def test_dot_dot_slash_repeated(self):
        evil = "../" * 20 + "etc/passwd"
        result = guard_normalize.normalize_file_path(evil)
        assert ".." not in result

    def test_backslash_traversal(self):
        """On Unix, backslashes are valid filename chars — not path separators."""
        result = guard_normalize.normalize_file_path("..\\..\\Windows\\System32")
        # On Unix, normpath treats \ as literal char, so this becomes an absolute
        # path rooted in cwd. The key assertion is it's always absolute.
        assert os.path.isabs(result)

    def test_url_encoded_traversal(self):
        """URL-encoded ../ should not cause traversal after normalization."""
        result = guard_normalize.normalize_file_path("%2e%2e/%2e%2e/etc/passwd")
        # normalization should handle this as a literal string
        assert os.path.isabs(result)

    def test_very_long_path(self):
        result = guard_normalize.normalize_file_path("/" + "a" * 5000)
        # Should be truncated by normalize_text (max_len=4096)
        assert len(result) < 5100


# ═══════════════════════════════════════════════════════════════════════════════
# guard_normalize.py — normalize_session_key
# ═══════════════════════════════════════════════════════════════════════════════


class TestNormalizeSessionKey:
    """Test normalize_session_key against traversal and injection payloads."""

    def test_simple_traversal(self):
        result = guard_normalize.normalize_session_key("../../etc/passwd")
        assert ".." not in result
        assert "/" not in result

    def test_null_bytes(self):
        result = guard_normalize.normalize_session_key("abc\x00def")
        assert "\x00" not in result
        assert len(result) > 0

    def test_empty_string(self):
        result = guard_normalize.normalize_session_key("")
        assert result == "unknown"

    def test_none_value(self):
        result = guard_normalize.normalize_session_key(None)
        assert result == "unknown"

    def test_shell_metacharacters(self):
        result = guard_normalize.normalize_session_key("test; rm -rf /")
        assert ";" not in result
        assert " " not in result

    def test_all_dots_and_slashes(self):
        """Pure traversal string should fall back to hash."""
        result = guard_normalize.normalize_session_key("../../..")
        assert ".." not in result
        assert len(result) > 0

    def test_unicode_session_key(self):
        result = guard_normalize.normalize_session_key("test-\U0001f680-session")
        assert isinstance(result, str)
        assert len(result) > 0

    def test_control_characters(self):
        result = guard_normalize.normalize_session_key("test\x01\x02\x03key")
        assert all(ord(c) > 31 for c in result)

    def test_hash_fallback_for_unsafe_input(self):
        """All-special-chars input should get hash fallback."""
        result = guard_normalize.normalize_session_key("///\\\\:::")
        assert result.startswith("sid-")

    def test_max_length_respected(self):
        result = guard_normalize.normalize_session_key("a" * 1000)
        assert len(result) <= 12  # default max_len

    def test_custom_max_length(self):
        result = guard_normalize.normalize_session_key("abcdefghijklmnop", max_len=5)
        assert len(result) <= 5


# ═══════════════════════════════════════════════════════════════════════════════
# guard_normalize.py — is_invalid_session_key
# ═══════════════════════════════════════════════════════════════════════════════


class TestIsInvalidSessionKey:
    """Test is_invalid_session_key detection."""

    def test_valid_key(self):
        assert guard_normalize.is_invalid_session_key("abc123") is False

    def test_forward_slash(self):
        assert guard_normalize.is_invalid_session_key("abc/def") is True

    def test_backslash(self):
        assert guard_normalize.is_invalid_session_key("abc\\def") is True

    def test_double_dot(self):
        assert guard_normalize.is_invalid_session_key("abc..def") is True

    def test_control_chars(self):
        assert guard_normalize.is_invalid_session_key("abc\x00def") is True

    def test_empty_string(self):
        assert guard_normalize.is_invalid_session_key("") is True

    def test_none(self):
        assert guard_normalize.is_invalid_session_key(None) is True

    def test_integer(self):
        assert guard_normalize.is_invalid_session_key(42) is True


# ═══════════════════════════════════════════════════════════════════════════════
# hook_utils.py — track_context_growth session key sanitization
# ═══════════════════════════════════════════════════════════════════════════════


class TestTrackContextGrowthSanitization:
    """Test that track_context_growth sanitizes session keys for filenames."""

    def test_traversal_in_session_key(self, tmp_path):
        original_expanduser = os.path.expanduser
        state_dir = str(tmp_path / "state")
        os.makedirs(state_dir, exist_ok=True)

        # Patch the state dir used by track_context_growth
        import unittest.mock
        with unittest.mock.patch.dict(os.environ, {"HOME": str(tmp_path)}):
            # The function creates its own path using expanduser
            result = hook_utils.track_context_growth("../../etc/passwd", "Read", 100)
            # Should not create file in ../../etc/
            for f in os.listdir(str(tmp_path)):
                assert ".." not in f

    def test_null_bytes_in_session_key(self, tmp_path):
        import unittest.mock
        with unittest.mock.patch.dict(os.environ, {"HOME": str(tmp_path)}):
            result = hook_utils.track_context_growth("abc\x00def", "Read", 100)
            assert isinstance(result, dict)


# ═══════════════════════════════════════════════════════════════════════════════
# Subprocess tests: traversal payloads to live hooks
# ═══════════════════════════════════════════════════════════════════════════════


class TestTokenGuardPathTraversal:
    """Test token-guard.py with traversal payloads."""

    def test_traversal_session_id(self, isolated_env):
        env, state_dir = isolated_env
        payload = json.dumps({
            "tool_name": "Task",
            "session_id": "../../etc/passwd",
            "tool_input": {"prompt": "test", "subagent_type": "Explore"},
        })
        code, _, _ = run_hook("token-guard.py", payload, env)
        assert code == 0
        # Verify no file created outside state_dir
        for f in os.listdir(str(state_dir)):
            assert ".." not in f

    def test_null_session_id(self, isolated_env):
        env, _ = isolated_env
        payload = json.dumps({
            "tool_name": "Task",
            "session_id": "test\x00evil",
            "tool_input": {"prompt": "test", "subagent_type": "Explore"},
        })
        code, _, _ = run_hook("token-guard.py", payload, env)
        assert code == 0


class TestReadGuardPathTraversal:
    """Test read-efficiency-guard.py with traversal payloads."""

    def test_traversal_file_path(self, isolated_env):
        env, state_dir = isolated_env
        payload = json.dumps({
            "tool_name": "Read",
            "session_id": "safe123",
            "tool_input": {"file_path": "../../etc/passwd"},
        })
        code, _, _ = run_hook("read-efficiency-guard.py", payload, env)
        assert code == 0

    def test_traversal_session_id(self, isolated_env):
        env, state_dir = isolated_env
        payload = json.dumps({
            "tool_name": "Read",
            "session_id": "../../../etc/shadow",
            "tool_input": {"file_path": "/tmp/test.py"},
        })
        code, _, _ = run_hook("read-efficiency-guard.py", payload, env)
        assert code == 0
        for f in os.listdir(str(state_dir)):
            assert ".." not in f
