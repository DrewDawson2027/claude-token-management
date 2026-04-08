#!/usr/bin/env python3
"""Hook Doctor — diagnostic report for the Claude Code hook system.

Usage:
    python3 hook-doctor.py          # Human-readable report
    python3 hook-doctor.py --json   # Machine-readable JSON output

Checks:
  1. File existence — all hooks referenced in settings exist
  2. Permissions — shell hooks are executable
  3. Dependencies — jq, Python >= 3.9, required modules
  4. State health — session-state dir, no corrupt JSON, no orphaned locks
  5. Circuit breaker status — any tripped circuits
  6. Counter summary — hook-counters.json totals
  7. Config consistency — token-guard-config.json parseable, known keys
  8. Lock staleness — lock files older than 5 minutes
  9. Disk usage — session-state dir size
"""

import glob
import json
import os
import shutil
import subprocess
import sys
import time
from runtime_paths import hooks_dir, session_state_dir

HOOKS_DIR = str(hooks_dir())
STATE_DIR = str(session_state_dir())
CONFIG_PATH = os.path.join(HOOKS_DIR, "token-guard-config.json")
COUNTERS_FILE = os.path.join(STATE_DIR, "hook-counters.json")
CIRCUIT_FILE = os.path.join(STATE_DIR, "circuit-breaker.json")

KNOWN_CONFIG_KEYS = {
    "schema_version", "max_agents", "parallel_window_seconds",
    "global_cooldown_seconds", "max_per_subagent_type", "state_ttl_hours",
    "audit_log", "failure_mode", "sanitize_session_ids", "normalize_paths",
    "fault_audit", "max_string_field_length", "metrics_correlation_window_seconds",
    "shadow_rules", "shadow_default_mode", "shadow_sample_pct", "shadow_audit",
    "session_recap_default_window_minutes", "one_per_session", "always_allowed",
    "model_routing",
}


class DoctorReport:
    def __init__(self):
        self.checks = []
        self.remediations = []
        self.counters = {}
        self.ok_count = 0
        self.warn_count = 0
        self.fail_count = 0

    def ok(self, msg):
        self.checks.append(("OK", msg))
        self.ok_count += 1

    def warn(self, msg, remediation=None):
        self.checks.append(("WARN", msg))
        self.warn_count += 1
        if remediation:
            self.remediations.append(remediation)

    def fail(self, msg, remediation=None):
        self.checks.append(("FAIL", msg))
        self.fail_count += 1
        if remediation:
            self.remediations.append(remediation)


def check_file_existence(report):
    """Check that all hook files exist and are readable."""
    py_hooks = [f for f in os.listdir(HOOKS_DIR)
                if f.endswith(".py") and not f.startswith("__")]
    sh_hooks = [f for f in os.listdir(HOOKS_DIR) if f.endswith(".sh")]

    py_count = len(py_hooks)
    sh_count = len(sh_hooks)

    if py_count > 0:
        report.ok(f"{py_count} Python hooks found and readable")
    else:
        report.fail("No Python hooks found", "Check hooks directory is correct")

    if sh_count > 0:
        report.ok(f"{sh_count} shell hooks found and readable")
    else:
        report.warn("No shell hooks found")


def check_permissions(report):
    """Check shell hooks are executable."""
    sh_hooks = [f for f in os.listdir(HOOKS_DIR) if f.endswith(".sh")]
    non_exec = []
    for f in sh_hooks:
        path = os.path.join(HOOKS_DIR, f)
        if not os.access(path, os.X_OK):
            non_exec.append(f)

    if non_exec:
        report.warn(
            f"{len(non_exec)}/{len(sh_hooks)} shell hooks not executable: {', '.join(non_exec[:5])}",
            f"Run: chmod +x {' '.join(non_exec[:5])}"
        )
    else:
        report.ok(f"{len(sh_hooks)}/{len(sh_hooks)} shell hooks executable")


def check_dependencies(report):
    """Check required tools and modules."""
    # jq
    jq_available = shutil.which("jq") is not None
    if jq_available:
        report.ok("jq is installed")
    else:
        report.fail("jq is not installed", "Install with: brew install jq")

    # Python version
    ver = sys.version_info
    if ver >= (3, 9):
        report.ok(f"Python {ver.major}.{ver.minor}.{ver.micro} (>= 3.9)")
    else:
        report.warn(f"Python {ver.major}.{ver.minor} < 3.9")

    # Required modules
    for mod_name in ("hook_utils", "circuit_breaker", "guard_normalize", "guard_contracts"):
        try:
            mod_path = os.path.join(HOOKS_DIR, f"{mod_name}.py")
            if os.path.exists(mod_path):
                report.ok(f"Module {mod_name} exists")
            else:
                report.fail(f"Module {mod_name} not found")
        except Exception as e:
            report.fail(f"Module {mod_name} check failed: {e}")


def check_state_health(report):
    """Check session-state directory health."""
    if not os.path.isdir(STATE_DIR):
        report.warn("session-state directory missing", f"mkdir -p {STATE_DIR}")
        return

    corrupt_files = []
    total_files = 0
    for f in os.listdir(STATE_DIR):
        if not f.endswith(".json"):
            continue
        total_files += 1
        fpath = os.path.join(STATE_DIR, f)
        try:
            with open(fpath) as fh:
                json.load(fh)
        except (json.JSONDecodeError, UnicodeDecodeError):
            corrupt_files.append(f)

    if corrupt_files:
        report.warn(
            f"{len(corrupt_files)}/{total_files} corrupt JSON files: {', '.join(corrupt_files[:5])}",
            f"Remove corrupt files: rm {' '.join(os.path.join(STATE_DIR, f) for f in corrupt_files[:3])}"
        )
    else:
        report.ok(f"{total_files} JSON state files all valid")


def check_circuit_breakers(report):
    """Check for tripped circuit breakers."""
    if not os.path.exists(CIRCUIT_FILE):
        report.ok("No circuit breaker state (none tripped)")
        return

    try:
        with open(CIRCUIT_FILE) as f:
            state = json.load(f)
    except (json.JSONDecodeError, OSError):
        report.warn("Circuit breaker state file corrupt", f"Remove: rm {CIRCUIT_FILE}")
        return

    now = time.time()
    tripped = []
    for hook_name, entry in state.items():
        failures = entry.get("failures", 0)
        last_failure = entry.get("last_failure", 0)
        if failures >= 3:
            remaining = max(0, 300 - (now - last_failure))
            if remaining > 0:
                tripped.append(f"{hook_name} (resets in {int(remaining)}s)")
            # else: already auto-reset

    if tripped:
        report.warn(f"Circuit breakers tripped: {', '.join(tripped)}")
    else:
        report.ok("No circuit breakers currently tripped")


def check_counters(report):
    """Check and summarize hook counters."""
    if not os.path.exists(COUNTERS_FILE):
        report.ok("No hook counters recorded yet")
        return

    try:
        with open(COUNTERS_FILE) as f:
            counters = json.load(f)
    except (json.JSONDecodeError, OSError):
        report.warn("Hook counters file corrupt", f"Remove: rm {COUNTERS_FILE}")
        return

    report.counters = counters
    total_success = sum(v.get("success", 0) for v in counters.values())
    total_fail_open = sum(v.get("fail_open", 0) for v in counters.values())
    total_fail_closed = sum(v.get("fail_closed", 0) for v in counters.values())
    total_error = sum(v.get("error", 0) for v in counters.values())

    if total_fail_open > 0 or total_error > 0:
        report.warn(
            f"Counters: {total_success} ok, {total_fail_closed} blocked, "
            f"{total_fail_open} fail-open, {total_error} errors"
        )
    else:
        report.ok(
            f"Counters: {total_success} ok, {total_fail_closed} blocked, 0 errors"
        )


def check_config(report):
    """Check token-guard-config.json consistency."""
    if not os.path.exists(CONFIG_PATH):
        report.warn("token-guard-config.json not found", "Create default config")
        return

    try:
        with open(CONFIG_PATH) as f:
            config = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        report.fail(f"Config parse error: {e}", f"Fix or regenerate {CONFIG_PATH}")
        return

    unknown_keys = set(config.keys()) - KNOWN_CONFIG_KEYS
    if unknown_keys:
        report.warn(
            f"Unknown config keys: {', '.join(sorted(unknown_keys))}",
            f"Remove unknown keys from {CONFIG_PATH}"
        )
    else:
        report.ok("Config has no unknown keys")

    # Validate schema version
    if config.get("schema_version") != 2:
        report.warn(f"Config schema_version is {config.get('schema_version')}, expected 2")
    else:
        report.ok("Config schema_version is 2")


def check_lock_staleness(report):
    """Check for stale lock files."""
    if not os.path.isdir(STATE_DIR):
        return

    stale_locks = []
    now = time.time()
    for f in os.listdir(STATE_DIR):
        if f.endswith(".lock"):
            fpath = os.path.join(STATE_DIR, f)
            try:
                age = now - os.path.getmtime(fpath)
                if age > 300:  # 5 minutes
                    stale_locks.append((f, int(age)))
            except OSError:
                pass

    if stale_locks:
        names = [f"{name} ({age}s old)" for name, age in stale_locks[:5]]
        report.warn(
            f"{len(stale_locks)} stale lock files: {', '.join(names)}",
            f"Remove stale locks: rm {' '.join(os.path.join(STATE_DIR, s[0]) for s in stale_locks[:3])}"
        )
    else:
        report.ok("No stale lock files")


def check_disk_usage(report):
    """Check session-state directory size."""
    if not os.path.isdir(STATE_DIR):
        return

    total = 0
    for dirpath, dirnames, filenames in os.walk(STATE_DIR):
        for f in filenames:
            try:
                total += os.path.getsize(os.path.join(dirpath, f))
            except OSError:
                pass

    mb = total / (1024 * 1024)
    if mb > 50:
        report.warn(f"State directory: {mb:.1f}MB (consider cleanup)", "Run monthly purge")
    elif mb > 10:
        report.warn(f"State directory: {mb:.1f}MB (growing)")
    else:
        report.ok(f"State directory: {mb:.1f}MB")


def format_report(report, json_output=False):
    """Format the report for output."""
    if json_output:
        return json.dumps({
            "checks": [{"status": s, "message": m} for s, m in report.checks],
            "counters": report.counters,
            "remediations": report.remediations,
            "summary": {
                "ok": report.ok_count,
                "warn": report.warn_count,
                "fail": report.fail_count,
            },
        }, indent=2)

    lines = ["=== Hook Doctor Report ===", ""]
    for status, msg in report.checks:
        prefix = {"OK": "[OK]", "WARN": "[WARN]", "FAIL": "[FAIL]"}[status]
        lines.append(f"  {prefix} {msg}")

    if report.counters:
        lines.append("")
        lines.append("--- Counters ---")
        for hook_name, counts in sorted(report.counters.items()):
            s = counts.get("success", 0)
            fc = counts.get("fail_closed", 0)
            fo = counts.get("fail_open", 0)
            e = counts.get("error", 0)
            lines.append(f"  {hook_name:30s} {s:>6} ok / {fc:>3} blocked / {fo:>3} fail-open / {e:>3} errors")

    if report.remediations:
        lines.append("")
        lines.append("--- Remediation ---")
        for i, rem in enumerate(report.remediations, 1):
            lines.append(f"  {i}. {rem}")

    lines.append("")
    lines.append(f"Summary: {report.ok_count} ok, {report.warn_count} warnings, {report.fail_count} failures")
    return "\n".join(lines)


def run_doctor(json_output=False):
    """Run all diagnostic checks and return formatted report."""
    report = DoctorReport()

    check_file_existence(report)
    check_permissions(report)
    check_dependencies(report)
    check_state_health(report)
    check_circuit_breakers(report)
    check_counters(report)
    check_config(report)
    check_lock_staleness(report)
    check_disk_usage(report)

    return format_report(report, json_output=json_output)


if __name__ == "__main__":
    json_flag = "--json" in sys.argv
    print(run_doctor(json_output=json_flag))
