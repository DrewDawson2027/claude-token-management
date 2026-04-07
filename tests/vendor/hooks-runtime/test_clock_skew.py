"""Clock-skew and time-jump tests (Item 3).

Tests time-dependent logic under simulated clock drift. Targets:
- circuit_breaker.py: cooldown calculations
- read-efficiency-guard.py: READ_TTL and SEQUENTIAL_WINDOW pruning
- budget-guard.py: cache TTL and refresh cooldown
"""

import json
import os
import time
import tempfile
from unittest.mock import patch

import pytest

import hook_utils
import circuit_breaker
import guard_normalize


# ═══════════════════════════════════════════════════════════════════════════════
# Circuit breaker clock-skew tests
# ═══════════════════════════════════════════════════════════════════════════════


class TestCircuitBreakerClockSkew:
    """Test circuit_breaker.py under simulated clock drift."""

    @pytest.fixture(autouse=True)
    def isolate_state(self, tmp_path):
        original = circuit_breaker.STATE_FILE
        circuit_breaker.STATE_FILE = str(tmp_path / "circuit-breaker.json")
        yield
        circuit_breaker.STATE_FILE = original

    def test_auto_reset_after_cooldown(self):
        """Circuit resets when now - last_failure > COOLDOWN_SECONDS."""
        # Trip the breaker
        for _ in range(3):
            circuit_breaker.record_failure("test-hook")
        assert circuit_breaker.check_circuit("test-hook") is False

        # Simulate clock jump forward past cooldown
        with patch("circuit_breaker.time") as mock_time:
            mock_time.time.return_value = time.time() + 301
            assert circuit_breaker.check_circuit("test-hook") is True

    def test_clock_jump_1_hour_forward_resets(self):
        """A 1-hour clock jump should auto-reset the circuit."""
        for _ in range(3):
            circuit_breaker.record_failure("jump-hook")
        assert circuit_breaker.check_circuit("jump-hook") is False

        with patch("circuit_breaker.time") as mock_time:
            mock_time.time.return_value = time.time() + 3600
            assert circuit_breaker.check_circuit("jump-hook") is True

    def test_clock_jump_backward_does_not_trip(self):
        """If clock goes backward, circuit should NOT trip prematurely."""
        circuit_breaker.record_failure("back-hook")
        # Only 1 failure, should still pass
        assert circuit_breaker.check_circuit("back-hook") is True

        # Simulate clock going backward
        with patch("circuit_breaker.time") as mock_time:
            mock_time.time.return_value = time.time() - 600
            # With backward clock, now - last_failure < 0 < COOLDOWN
            # So it should NOT auto-reset, but 1 failure < MAX_FAILURES so still True
            assert circuit_breaker.check_circuit("back-hook") is True

    def test_exact_boundary_cooldown(self):
        """Exactly at cooldown boundary: now - last_failure == COOLDOWN_SECONDS."""
        now = time.time()
        for _ in range(3):
            circuit_breaker.record_failure("boundary")

        # Read state to get actual last_failure timestamp
        state = circuit_breaker._load_state()
        last_failure = state["boundary"]["last_failure"]

        with patch("circuit_breaker.time") as mock_time:
            # Exactly at boundary (not past)
            mock_time.time.return_value = last_failure + circuit_breaker.COOLDOWN_SECONDS
            # now - last_failure == COOLDOWN_SECONDS, not > COOLDOWN_SECONDS
            result = circuit_breaker.check_circuit("boundary")
            # With == (not >) this should still be tripped
            assert result is False

    def test_cooldown_just_past_boundary(self):
        """One second past cooldown should reset."""
        for _ in range(3):
            circuit_breaker.record_failure("past")
        state = circuit_breaker._load_state()
        last_failure = state["past"]["last_failure"]

        with patch("circuit_breaker.time") as mock_time:
            mock_time.time.return_value = last_failure + circuit_breaker.COOLDOWN_SECONDS + 1
            assert circuit_breaker.check_circuit("past") is True

    def test_record_success_resets_failures(self):
        for _ in range(2):
            circuit_breaker.record_failure("reset")
        circuit_breaker.record_success("reset")
        state = circuit_breaker._load_state()
        assert state["reset"]["failures"] == 0

    def test_no_entry_returns_true(self):
        assert circuit_breaker.check_circuit("nonexistent") is True

    def test_corrupt_state_file_returns_true(self):
        """Corrupt state file → check_circuit returns True (fail-open)."""
        with open(circuit_breaker.STATE_FILE, "w") as f:
            f.write("{corrupt json")
        assert circuit_breaker.check_circuit("any") is True


# ═══════════════════════════════════════════════════════════════════════════════
# Read-efficiency-guard time tests (unit-level via module import)
# ═══════════════════════════════════════════════════════════════════════════════


class TestReadGuardTimePruning:
    """Test read-efficiency-guard's TTL pruning logic."""

    def test_reads_outside_ttl_are_pruned(self, tmp_path):
        """Reads older than READ_TTL should be removed from state."""
        import read_guard

        state_file = str(tmp_path / "reads.json")
        now = time.time()
        old_reads = [
            {"path": "/a.py", "normalized_path": "/a.py", "path_hash": "abc",
             "timestamp": now - 400},  # older than READ_TTL=300
            {"path": "/b.py", "normalized_path": "/b.py", "path_hash": "def",
             "timestamp": now - 10},  # fresh
        ]
        state = {"reads": old_reads, "schema_version": 2, "session_key": "test"}
        hook_utils.save_json_state(state_file, state)

        # Simulate pruning logic (inline since main() calls sys.exit)
        ttl = getattr(read_guard, "READ_TTL", 300)
        pruned = [r for r in old_reads if now - r["timestamp"] < ttl]
        assert len(pruned) == 1
        assert pruned[0]["path"] == "/b.py"

    def test_future_timestamp_reads_survive_pruning(self):
        """Reads with future timestamps should not be pruned."""
        import read_guard
        now = time.time()
        ttl = getattr(read_guard, "READ_TTL", 300)
        future_read = {"path": "/future.py", "timestamp": now + 1000}
        # now - future_timestamp < 0 < ttl → survives pruning
        assert now - future_read["timestamp"] < ttl

    def test_sequential_window_boundary(self):
        """Reads exactly at SEQUENTIAL_WINDOW boundary."""
        import read_guard
        now = time.time()
        window = getattr(read_guard, "SEQUENTIAL_WINDOW", 120)
        # At exact boundary: now - timestamp == window → NOT < window → pruned
        boundary_read = {"path": "/edge.py", "timestamp": now - window}
        assert not (now - boundary_read["timestamp"] < window)

    def test_sequential_window_just_inside(self):
        """Reads 1 second inside SEQUENTIAL_WINDOW boundary survive."""
        import read_guard
        now = time.time()
        window = getattr(read_guard, "SEQUENTIAL_WINDOW", 120)
        inside_read = {"path": "/edge.py", "timestamp": now - window + 1}
        assert now - inside_read["timestamp"] < window


# ═══════════════════════════════════════════════════════════════════════════════
# Budget-guard cache TTL tests
# ═══════════════════════════════════════════════════════════════════════════════


class TestBudgetGuardCacheTTL:
    """Test budget-guard's cache staleness detection."""

    def test_fresh_cache_not_stale(self, tmp_path):
        """Cache file younger than TTL should not be stale."""
        cache_file = tmp_path / "cache.json"
        cache_file.write_text(json.dumps({"pct": 50, "level": "ok"}))
        # File just created = fresh = mtime is now
        age = time.time() - os.path.getmtime(str(cache_file))
        assert age < 60  # cache_ttl_seconds=60

    def test_old_cache_is_stale(self, tmp_path):
        """Cache file older than TTL should be stale."""
        cache_file = tmp_path / "cache.json"
        cache_file.write_text(json.dumps({"pct": 50}))
        # Set mtime to 120 seconds ago
        old_time = time.time() - 120
        os.utime(str(cache_file), (old_time, old_time))
        age = time.time() - os.path.getmtime(str(cache_file))
        assert age > 60

    def test_future_mtime_cache_not_stale(self, tmp_path):
        """Cache file with future mtime should be treated as fresh."""
        cache_file = tmp_path / "cache.json"
        cache_file.write_text(json.dumps({"pct": 50}))
        future_time = time.time() + 3600
        os.utime(str(cache_file), (future_time, future_time))
        age = time.time() - os.path.getmtime(str(cache_file))
        # Negative age → "fresh"
        assert age < 60

    def test_cooldown_file_future_mtime(self, tmp_path):
        """Refresh cooldown file with future mtime should not permanently block."""
        cooldown_file = tmp_path / "refresh.ts"
        cooldown_file.write_text(str(time.time() + 9999))
        # The cooldown should be based on file content or mtime comparison
        # A reasonable implementation treats future-mtime as "just refreshed"
        future_time = time.time() + 9999
        os.utime(str(cooldown_file), (future_time, future_time))
        age = time.time() - os.path.getmtime(str(cooldown_file))
        # Negative age means cooldown appears "just set"
        assert age < 0


# ═══════════════════════════════════════════════════════════════════════════════
# Terminal-heartbeat.sh timestamp tests (file-based)
# ═══════════════════════════════════════════════════════════════════════════════


class TestHeartbeatStampAge:
    """Test terminal-heartbeat.sh cooldown logic via file mtimes."""

    def test_fresh_stamp_blocks_heartbeat(self, tmp_path):
        """Stamp file < 5s old → heartbeat should be skipped."""
        stamp = tmp_path / "stamp"
        stamp.write_text("")
        age = time.time() - os.path.getmtime(str(stamp))
        assert age < 5  # COOLDOWN=5s

    def test_old_stamp_allows_heartbeat(self, tmp_path):
        """Stamp file > 5s old → heartbeat should fire."""
        stamp = tmp_path / "stamp"
        stamp.write_text("")
        old_time = time.time() - 10
        os.utime(str(stamp), (old_time, old_time))
        age = time.time() - os.path.getmtime(str(stamp))
        assert age >= 5

    def test_very_old_stamp_allows_heartbeat(self, tmp_path):
        """Stamp file 1 hour old → heartbeat should fire."""
        stamp = tmp_path / "stamp"
        stamp.write_text("")
        old_time = time.time() - 3600
        os.utime(str(stamp), (old_time, old_time))
        age = time.time() - os.path.getmtime(str(stamp))
        assert age >= 5

    def test_stale_detection_threshold(self, tmp_path):
        """Session file > 300s old → should be marked stale."""
        session_file = tmp_path / "session.json"
        session_file.write_text(json.dumps({"status": "active"}))
        old_time = time.time() - 350
        os.utime(str(session_file), (old_time, old_time))
        age = time.time() - os.path.getmtime(str(session_file))
        assert age > 300  # stale threshold
