#!/usr/bin/env python3
"""
Hook Health Analyzer — aggregates per-hook metrics for the SLO dashboard.

Reads two data sources:
  1. hook-counters.json — success/fail_open/fail_closed/error counts per hook
  2. audit.jsonl — per-decision records with latency_ms and timestamps

Outputs a health summary suitable for session-slo-check.py or CLI display.

Usage:
    python3 hook_health.py              # JSON summary
    python3 hook_health.py --human      # human-readable table
"""

import json
import os
import sys
import statistics
from collections import defaultdict
from typing import Dict, List

STATE_DIR = os.environ.get(
    "TOKEN_GUARD_STATE_DIR",
    os.path.expanduser("~/.claude/hooks/session-state"),
)
COUNTERS_FILE = os.path.join(STATE_DIR, "hook-counters.json")
AUDIT_FILE = os.path.join(STATE_DIR, "audit.jsonl")

# Thresholds for health grading
ERROR_RATE_WARN = 0.05  # 5% errors = warning
ERROR_RATE_CRIT = 0.15  # 15% errors = critical
LATENCY_P95_WARN_MS = 500  # 500ms p95 = warning
LATENCY_P95_CRIT_MS = 2000  # 2s p95 = critical
BLOCK_RATE_INFO = 0.10  # 10% blocks = informational


def load_counters() -> Dict:
    try:
        with open(COUNTERS_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def load_recent_audit(max_lines: int = 500) -> List[Dict]:
    """Load the most recent audit entries (tail of file)."""
    entries = []
    try:
        with open(AUDIT_FILE) as f:
            lines = f.readlines()
        for line in lines[-max_lines:]:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    except (FileNotFoundError, OSError):
        pass
    return entries


def compute_health() -> Dict:
    """Compute per-hook health metrics."""
    counters = load_counters()
    audit = load_recent_audit()

    # Aggregate latencies from audit trail
    latencies: Dict[str, List[float]] = defaultdict(list)
    decisions: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))

    for entry in audit:
        hook = entry.get("hook", "unknown")
        decision = entry.get("decision", "unknown")
        lat = entry.get("latency_ms")
        decisions[hook][decision] += 1
        if lat is not None and isinstance(lat, (int, float)):
            latencies[hook].append(lat)

    # Build per-hook health report
    hooks = {}
    all_hook_names = set(counters.keys()) | set(decisions.keys())

    for name in sorted(all_hook_names):
        counter = counters.get(name, {})
        total_counter = sum(
            counter.get(k, 0) for k in ("success", "fail_open", "fail_closed", "error")
        )
        errors_counter = counter.get("error", 0) + counter.get("fail_open", 0)
        blocks_counter = counter.get("fail_closed", 0)

        dec = decisions.get(name, {})

        lats = latencies.get(name, [])
        lat_stats = {}
        if lats:
            lats_sorted = sorted(lats)
            lat_stats = {
                "p50_ms": round(statistics.median(lats_sorted), 1),
                "p95_ms": round(
                    (
                        lats_sorted[int(len(lats_sorted) * 0.95)]
                        if len(lats_sorted) >= 2
                        else lats_sorted[-1]
                    ),
                    1,
                ),
                "max_ms": round(max(lats_sorted), 1),
                "samples": len(lats_sorted),
            }

        # Grade
        error_rate = (errors_counter / total_counter) if total_counter > 0 else 0
        p95 = lat_stats.get("p95_ms", 0)

        if error_rate >= ERROR_RATE_CRIT or p95 >= LATENCY_P95_CRIT_MS:
            grade = "RED"
        elif error_rate >= ERROR_RATE_WARN or p95 >= LATENCY_P95_WARN_MS:
            grade = "WARN"
        else:
            grade = "GREEN"

        hooks[name] = {
            "grade": grade,
            "total_invocations": total_counter,
            "errors": errors_counter,
            "blocks": blocks_counter,
            "error_rate": round(error_rate, 3),
            "latency": lat_stats,
            "audit_decisions": dict(dec) if dec else {},
        }

    # Overall grade
    grades = [h["grade"] for h in hooks.values()]
    if "RED" in grades:
        overall = "RED"
    elif "WARN" in grades:
        overall = "WARN"
    else:
        overall = "GREEN"

    return {
        "overall": overall,
        "hook_count": len(hooks),
        "hooks": hooks,
    }


def format_human(health: Dict) -> str:
    """Format health report as a human-readable table."""
    lines = [
        f"Hook Health: {health['overall']} ({health['hook_count']} hooks)",
        "",
        f"{'Hook':<28} {'Grade':<6} {'Total':>7} {'Errs':>5} {'Blks':>5} {'p50':>7} {'p95':>7}",
        "-" * 75,
    ]
    for name, h in health["hooks"].items():
        lat = h.get("latency", {})
        p50 = f"{lat.get('p50_ms', '-'):>5}ms" if lat else "    -  "
        p95 = f"{lat.get('p95_ms', '-'):>5}ms" if lat else "    -  "
        lines.append(
            f"{name:<28} {h['grade']:<6} {h['total_invocations']:>7} "
            f"{h['errors']:>5} {h['blocks']:>5} {p50} {p95}"
        )

    # Flag issues
    issues = []
    for name, h in health["hooks"].items():
        if h["grade"] == "RED":
            issues.append(f"  CRITICAL: {name} — error rate {h['error_rate']*100:.1f}%")
        elif h["grade"] == "WARN":
            lat = h.get("latency", {})
            if lat.get("p95_ms", 0) >= LATENCY_P95_WARN_MS:
                issues.append(f"  SLOW: {name} — p95 latency {lat['p95_ms']}ms")
            if h["error_rate"] >= ERROR_RATE_WARN:
                issues.append(
                    f"  ERRORS: {name} — error rate {h['error_rate']*100:.1f}%"
                )

    if issues:
        lines.extend(["", "Issues:"] + issues)

    return "\n".join(lines)


def main():
    health = compute_health()

    if "--human" in sys.argv:
        print(format_human(health))
    else:
        print(json.dumps(health, indent=2))


if __name__ == "__main__":
    main()
