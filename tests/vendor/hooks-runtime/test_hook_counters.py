"""Tests for hook observability counters (Item 7).

Validates record_hook_outcome() in hook_utils.py: incrementing, concurrent
writes, corrupt file recovery, and counter invariants.
"""

import json
import os
import tempfile
import concurrent.futures

import pytest

import hook_utils


@pytest.fixture
def counters_dir(tmp_path):
    """Provide a temp dir and patch COUNTERS_FILE."""
    counters_file = str(tmp_path / "hook-counters.json")
    original = hook_utils.COUNTERS_FILE
    hook_utils.COUNTERS_FILE = counters_file
    yield tmp_path, counters_file
    hook_utils.COUNTERS_FILE = original


class TestRecordHookOutcome:
    """Core counter recording tests."""

    def test_creates_fresh_file(self, counters_dir):
        _, counters_file = counters_dir
        assert not os.path.exists(counters_file)
        hook_utils.record_hook_outcome("test-hook", "success")
        assert os.path.exists(counters_file)
        state = json.loads(open(counters_file).read())
        assert state["test-hook"]["success"] == 1

    def test_increments_correctly(self, counters_dir):
        _, counters_file = counters_dir
        hook_utils.record_hook_outcome("my-hook", "success")
        hook_utils.record_hook_outcome("my-hook", "success")
        hook_utils.record_hook_outcome("my-hook", "fail_open")
        state = json.loads(open(counters_file).read())
        assert state["my-hook"]["success"] == 2
        assert state["my-hook"]["fail_open"] == 1

    def test_fail_closed_counter(self, counters_dir):
        _, counters_file = counters_dir
        hook_utils.record_hook_outcome("guard", "fail_closed")
        hook_utils.record_hook_outcome("guard", "fail_closed")
        state = json.loads(open(counters_file).read())
        assert state["guard"]["fail_closed"] == 2

    def test_error_counter(self, counters_dir):
        _, counters_file = counters_dir
        hook_utils.record_hook_outcome("guard", "error")
        state = json.loads(open(counters_file).read())
        assert state["guard"]["error"] == 1

    def test_multiple_hooks_independent(self, counters_dir):
        _, counters_file = counters_dir
        hook_utils.record_hook_outcome("hook-a", "success")
        hook_utils.record_hook_outcome("hook-b", "fail_open")
        hook_utils.record_hook_outcome("hook-a", "success")
        state = json.loads(open(counters_file).read())
        assert state["hook-a"]["success"] == 2
        assert state["hook-b"]["fail_open"] == 1
        assert "hook-a" in state and "hook-b" in state

    def test_last_updated_field(self, counters_dir):
        _, counters_file = counters_dir
        hook_utils.record_hook_outcome("ts-hook", "success")
        state = json.loads(open(counters_file).read())
        assert "last_updated" in state["ts-hook"]
        assert len(state["ts-hook"]["last_updated"]) > 0

    def test_corrupt_file_resets_gracefully(self, counters_dir):
        _, counters_file = counters_dir
        with open(counters_file, "w") as f:
            f.write("NOT VALID JSON{{{")
        # Should not crash, should recover
        hook_utils.record_hook_outcome("recovered", "success")
        state = json.loads(open(counters_file).read())
        assert state["recovered"]["success"] == 1

    def test_counters_non_negative(self, counters_dir):
        _, counters_file = counters_dir
        for outcome in ("success", "fail_open", "fail_closed", "error"):
            hook_utils.record_hook_outcome("check", outcome)
        state = json.loads(open(counters_file).read())
        for key in ("success", "fail_open", "fail_closed", "error"):
            assert state["check"][key] >= 0

    def test_unknown_outcome_key(self, counters_dir):
        """Unknown outcome creates the key (non-fatal)."""
        _, counters_file = counters_dir
        hook_utils.record_hook_outcome("odd", "unknown_thing")
        state = json.loads(open(counters_file).read())
        assert state["odd"]["unknown_thing"] == 1

    def test_never_crashes_on_readonly_dir(self, tmp_path):
        """record_hook_outcome should silently fail if dir is unwritable."""
        readonly_file = str(tmp_path / "nowrite" / "counters.json")
        original = hook_utils.COUNTERS_FILE
        hook_utils.COUNTERS_FILE = readonly_file
        # Don't create the parent dir — record should fail silently
        os.makedirs(os.path.dirname(readonly_file), exist_ok=True)
        os.chmod(os.path.dirname(readonly_file), 0o444)
        try:
            # Should not raise
            hook_utils.record_hook_outcome("broken", "success")
        finally:
            os.chmod(os.path.dirname(readonly_file), 0o755)
            hook_utils.COUNTERS_FILE = original


class TestConcurrentCounters:
    """Concurrent write safety tests."""

    def test_concurrent_increments_no_corruption(self, counters_dir):
        _, counters_file = counters_dir
        n_workers = 10

        def record_one(_):
            hook_utils.record_hook_outcome("concurrent", "success")

        with concurrent.futures.ThreadPoolExecutor(max_workers=n_workers) as ex:
            list(ex.map(record_one, range(n_workers)))

        state = json.loads(open(counters_file).read())
        # May lose some under race, but file must be valid JSON
        assert state["concurrent"]["success"] >= 1
        assert state["concurrent"]["success"] <= n_workers

    def test_concurrent_mixed_outcomes(self, counters_dir):
        _, counters_file = counters_dir
        outcomes = ["success"] * 5 + ["fail_open"] * 3 + ["fail_closed"] * 2

        def record_one(outcome):
            hook_utils.record_hook_outcome("mixed", outcome)

        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
            list(ex.map(record_one, outcomes))

        state = json.loads(open(counters_file).read())
        total = sum(state["mixed"].get(k, 0) for k in ("success", "fail_open", "fail_closed"))
        assert total >= 1  # At least some recorded
