"""Lock contention stress tests (Item 5).

Tests concurrent hook invocations to verify:
- No data loss under parallel writes
- No file corruption from concurrent state modifications
- Consistent behavior under race conditions
"""

import json
import os
import time
import concurrent.futures
import subprocess
import sys

import pytest

import hook_utils
import circuit_breaker


HOOKS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ═══════════════════════════════════════════════════════════════════════════════
# hook_utils.locked_append — parallel writes
# ═══════════════════════════════════════════════════════════════════════════════


class TestLockedAppendContention:
    """Test locked_append under concurrent writers."""

    def test_10_parallel_appends_no_data_loss(self, tmp_path):
        """All 10 lines should appear in the file."""
        target = str(tmp_path / "test.jsonl")
        n_workers = 10

        def append_one(i):
            line = json.dumps({"worker": i, "ts": time.time()}) + "\n"
            return hook_utils.locked_append(target, line)

        with concurrent.futures.ThreadPoolExecutor(max_workers=n_workers) as ex:
            results = list(ex.map(append_one, range(n_workers)))

        assert all(results), "All appends should succeed"
        with open(target) as f:
            lines = [l.strip() for l in f if l.strip()]
        assert len(lines) == n_workers, f"Expected {n_workers} lines, got {len(lines)}"

    def test_no_interleaved_partial_lines(self, tmp_path):
        """Each line should be valid JSON — no interleaving."""
        target = str(tmp_path / "jsonl.log")
        n_workers = 20

        def append_one(i):
            line = json.dumps({"w": i, "data": "x" * 100}) + "\n"
            return hook_utils.locked_append(target, line)

        with concurrent.futures.ThreadPoolExecutor(max_workers=n_workers) as ex:
            list(ex.map(append_one, range(n_workers)))

        with open(target) as f:
            for line_num, raw in enumerate(f, 1):
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    json.loads(raw)
                except json.JSONDecodeError:
                    pytest.fail(f"Line {line_num} is not valid JSON: {raw[:100]}")

    def test_process_level_concurrent_appends(self, tmp_path):
        """Use actual subprocess processes for stronger contention testing."""
        target = str(tmp_path / "proc.jsonl")
        n_procs = 5
        script = f"""
import sys
sys.path.insert(0, "{HOOKS_DIR}")
import json, hook_utils
for i in range(10):
    hook_utils.locked_append("{target}", json.dumps({{"pid": __import__("os").getpid(), "i": i}}) + "\\n")
"""
        procs = []
        for _ in range(n_procs):
            p = subprocess.Popen(
                [sys.executable, "-c", script],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            procs.append(p)

        for p in procs:
            p.wait(timeout=30)

        with open(target) as f:
            lines = [l.strip() for l in f if l.strip()]
        # Each process writes 10 lines, 5 processes = 50 total
        assert len(lines) == n_procs * 10, f"Expected {n_procs * 10}, got {len(lines)}"


# ═══════════════════════════════════════════════════════════════════════════════
# hook_utils.save_json_state — parallel writes
# ═══════════════════════════════════════════════════════════════════════════════


class TestSaveJsonStateContention:
    """Test save_json_state under concurrent writers."""

    def test_5_parallel_writes_valid_json(self, tmp_path):
        """Final file should always be valid JSON."""
        target = str(tmp_path / "state.json")
        n_workers = 5

        def write_one(i):
            state = {"worker": i, "data": list(range(i * 10))}
            return hook_utils.save_json_state(target, state)

        with concurrent.futures.ThreadPoolExecutor(max_workers=n_workers) as ex:
            results = list(ex.map(write_one, range(n_workers)))

        # File should be valid JSON (whichever write won last)
        with open(target) as f:
            state = json.load(f)
        assert "worker" in state
        assert isinstance(state["data"], list)

    def test_no_corrupt_partial_writes(self, tmp_path):
        """Atomic replace means no partial writes should ever be visible."""
        target = str(tmp_path / "atomic.json")
        n_rounds = 20

        for i in range(n_rounds):
            hook_utils.save_json_state(target, {"round": i, "big": "x" * 1000})
            # Read immediately after write — should always be valid
            with open(target) as f:
                state = json.load(f)
            assert state["round"] == i


# ═══════════════════════════════════════════════════════════════════════════════
# circuit_breaker.py — concurrent failure recording
# ═══════════════════════════════════════════════════════════════════════════════


class TestCircuitBreakerContention:

    @pytest.fixture(autouse=True)
    def isolate_state(self, tmp_path):
        original = circuit_breaker.STATE_FILE
        circuit_breaker.STATE_FILE = str(tmp_path / "cb.json")
        yield
        circuit_breaker.STATE_FILE = original

    def test_concurrent_record_failure_no_corruption(self):
        """5 concurrent record_failure calls should not corrupt the state file."""
        n_workers = 5

        def record_one(_):
            circuit_breaker.record_failure("contention-hook")

        with concurrent.futures.ThreadPoolExecutor(max_workers=n_workers) as ex:
            list(ex.map(record_one, range(n_workers)))

        state = circuit_breaker._load_state()
        entry = state.get("contention-hook", {})
        # Failures may be approximate under races but file must be valid
        assert entry.get("failures", 0) >= 1
        assert entry.get("failures", 0) <= n_workers

    def test_concurrent_check_and_record(self):
        """Mix of check_circuit and record_failure calls."""
        def mixed_ops(i):
            if i % 2 == 0:
                circuit_breaker.record_failure("mixed")
            else:
                circuit_breaker.check_circuit("mixed")

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
            list(ex.map(mixed_ops, range(16)))

        # File should still be valid
        state = circuit_breaker._load_state()
        assert isinstance(state, dict)


# ═══════════════════════════════════════════════════════════════════════════════
# Token-guard state file — concurrent subprocess spawns
# ═══════════════════════════════════════════════════════════════════════════════


class TestTokenGuardConcurrentSpawns:
    """Simulate concurrent Task spawn attempts hitting token-guard."""

    def test_3_concurrent_spawns_no_crash(self, tmp_path):
        """3 parallel token-guard invocations should not corrupt state."""
        state_dir = tmp_path / "state"
        state_dir.mkdir()
        config_path = tmp_path / "config.json"
        config_path.write_text(json.dumps({
            "schema_version": 2, "max_agents": 10,
            "parallel_window_seconds": 30,
        }))

        env = os.environ.copy()
        env["TOKEN_GUARD_STATE_DIR"] = str(state_dir)
        env["TOKEN_GUARD_CONFIG_PATH"] = str(config_path)
        env["PYTHONPATH"] = HOOKS_DIR + os.pathsep + env.get("PYTHONPATH", "")

        payload = json.dumps({
            "tool_name": "Task",
            "session_id": "concurrent-test",
            "tool_input": {"prompt": "test", "subagent_type": "Explore"},
        })

        def spawn_one(_):
            return subprocess.run(
                [sys.executable, os.path.join(HOOKS_DIR, "token-guard.py")],
                input=payload,
                capture_output=True,
                text=True,
                env=env,
                timeout=10,
            ).returncode

        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
            codes = list(ex.map(spawn_one, range(3)))

        # All should complete (0 = allow, 2 = block, both valid)
        for code in codes:
            assert code in (0, 2), f"Unexpected exit code: {code}"

        # State file should be valid JSON
        state_files = list(state_dir.glob("*.json"))
        for sf in state_files:
            with open(sf) as f:
                json.load(f)  # Should not raise
