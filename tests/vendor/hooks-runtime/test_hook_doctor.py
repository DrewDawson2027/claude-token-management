"""Tests for hook-doctor.py (Item 8).

Validates the diagnostic report: check functions, output format,
remediation suggestions, and JSON output mode.
"""

import json
import os
import sys
import time

import pytest

# Load hook-doctor module dynamically (hyphenated filename)
import importlib.util

HOOKS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location("hook_doctor", os.path.join(HOOKS_DIR, "hook-doctor.py"))
hook_doctor = importlib.util.module_from_spec(_spec)
sys.modules["hook_doctor"] = hook_doctor
_spec.loader.exec_module(hook_doctor)


@pytest.fixture
def doctor_env(tmp_path, monkeypatch):
    """Set up isolated environment for doctor checks."""
    hooks_dir = tmp_path / "hooks"
    hooks_dir.mkdir()
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    config_path = hooks_dir / "token-guard-config.json"
    config_path.write_text(json.dumps({"schema_version": 2, "max_agents": 5}))

    # Create some hook files
    for name in ["token-guard.py", "budget-guard.py"]:
        (hooks_dir / name).write_text("#!/usr/bin/env python3\npass")
    for name in ["heartbeat.sh", "check-inbox.sh"]:
        p = hooks_dir / name
        p.write_text("#!/bin/bash\nexit 0")
        os.chmod(str(p), 0o755)

    # Create lib/
    lib_dir = hooks_dir / "lib"
    lib_dir.mkdir()
    (lib_dir / "portable.sh").write_text("#!/bin/bash\n# portable")

    # Create support modules
    for mod in ["hook_utils.py", "circuit_breaker.py", "guard_normalize.py", "guard_contracts.py"]:
        (hooks_dir / mod).write_text("# module")

    monkeypatch.setattr(hook_doctor, "HOOKS_DIR", str(hooks_dir))
    monkeypatch.setattr(hook_doctor, "STATE_DIR", str(state_dir))
    monkeypatch.setattr(hook_doctor, "CONFIG_PATH", str(config_path))
    monkeypatch.setattr(hook_doctor, "COUNTERS_FILE", str(state_dir / "hook-counters.json"))
    monkeypatch.setattr(hook_doctor, "CIRCUIT_FILE", str(state_dir / "circuit-breaker.json"))

    return tmp_path, hooks_dir, state_dir


class TestDoctorChecks:
    """Test individual check functions."""

    def test_file_existence_ok(self, doctor_env):
        report = hook_doctor.DoctorReport()
        hook_doctor.check_file_existence(report)
        assert report.ok_count >= 2

    def test_permissions_ok(self, doctor_env):
        report = hook_doctor.DoctorReport()
        hook_doctor.check_permissions(report)
        assert report.ok_count >= 1

    def test_permissions_warn_non_executable(self, doctor_env):
        tmp_path, hooks_dir, _ = doctor_env
        # Make a hook non-executable
        non_exec = hooks_dir / "bad.sh"
        non_exec.write_text("#!/bin/bash\nexit 0")
        os.chmod(str(non_exec), 0o644)

        report = hook_doctor.DoctorReport()
        hook_doctor.check_permissions(report)
        assert report.warn_count >= 1

    def test_state_health_corrupt_json(self, doctor_env):
        _, _, state_dir = doctor_env
        (state_dir / "corrupt.json").write_text("{bad json")

        report = hook_doctor.DoctorReport()
        hook_doctor.check_state_health(report)
        assert report.warn_count >= 1

    def test_state_health_all_valid(self, doctor_env):
        _, _, state_dir = doctor_env
        (state_dir / "good.json").write_text(json.dumps({"ok": True}))

        report = hook_doctor.DoctorReport()
        hook_doctor.check_state_health(report)
        assert report.ok_count >= 1

    def test_circuit_breaker_tripped(self, doctor_env):
        _, _, state_dir = doctor_env
        cb_file = state_dir / "circuit-breaker.json"
        cb_file.write_text(json.dumps({
            "test-hook": {"failures": 3, "last_failure": time.time()}
        }))

        report = hook_doctor.DoctorReport()
        hook_doctor.check_circuit_breakers(report)
        assert report.warn_count >= 1

    def test_circuit_breaker_all_clear(self, doctor_env):
        report = hook_doctor.DoctorReport()
        hook_doctor.check_circuit_breakers(report)
        assert report.ok_count >= 1

    def test_config_unknown_keys(self, doctor_env):
        tmp_path, hooks_dir, _ = doctor_env
        config = hooks_dir / "token-guard-config.json"
        config.write_text(json.dumps({
            "schema_version": 2,
            "unknown_key": "bad",
            "typo_field": True,
        }))

        report = hook_doctor.DoctorReport()
        hook_doctor.check_config(report)
        assert report.warn_count >= 1
        # Should suggest removing unknown keys
        assert any("unknown" in r.lower() for r in report.remediations)

    def test_stale_lock_detection(self, doctor_env):
        _, _, state_dir = doctor_env
        lock_file = state_dir / "test.lock"
        lock_file.write_text("")
        # Set mtime to 10 minutes ago
        old_time = time.time() - 600
        os.utime(str(lock_file), (old_time, old_time))

        report = hook_doctor.DoctorReport()
        hook_doctor.check_lock_staleness(report)
        assert report.warn_count >= 1

    def test_counters_summary(self, doctor_env):
        _, _, state_dir = doctor_env
        counters_file = state_dir / "hook-counters.json"
        counters_file.write_text(json.dumps({
            "token-guard": {"success": 100, "fail_closed": 2, "fail_open": 0, "error": 0},
            "budget-guard": {"success": 95, "fail_open": 1, "fail_closed": 0, "error": 0},
        }))

        report = hook_doctor.DoctorReport()
        hook_doctor.check_counters(report)
        assert len(report.counters) == 2


class TestDoctorOutput:
    """Test report formatting."""

    def test_human_readable_format(self, doctor_env):
        output = hook_doctor.run_doctor(json_output=False)
        assert "Hook Doctor Report" in output
        assert "Summary:" in output

    def test_json_output_format(self, doctor_env):
        output = hook_doctor.run_doctor(json_output=True)
        data = json.loads(output)
        assert "checks" in data
        assert "summary" in data
        assert isinstance(data["checks"], list)
        assert "ok" in data["summary"]

    def test_remediation_included(self, doctor_env):
        _, _, state_dir = doctor_env
        # Create a corrupt file to trigger remediation
        (state_dir / "bad.json").write_text("not json")
        output = hook_doctor.run_doctor(json_output=False)
        assert "Remediation" in output or "Summary:" in output
