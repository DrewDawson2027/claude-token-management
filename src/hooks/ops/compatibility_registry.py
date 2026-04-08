#!/usr/bin/env python3
"""Compatibility registry for Claude Code token-drain issue classes."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

THIS_DIR = Path(__file__).resolve().parent
INFRA_DIR = THIS_DIR.parent / "infrastructure"
for candidate in (THIS_DIR, INFRA_DIR):
    candidate_str = str(candidate)
    if candidate.is_dir() and candidate_str not in sys.path:
        sys.path.insert(0, candidate_str)

try:
    from runtime_paths import runtime_path
except Exception:
    def runtime_path(*parts: str) -> Path:
        return Path.home().joinpath(".claude", *parts)


def utc_now() -> str:
    from datetime import datetime, timezone

    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def registry_path() -> Path:
    return runtime_path("cost", "compatibility-registry.json")


DEFAULT_ISSUES: list[dict[str, Any]] = [
    {
        "issue_id": "prompt-cache-resume-continue",
        "title": "Resume/continue cache invalidation",
        "issue_class": "prompt-cache",
        "severity": "critical",
        "ownership": "upstream",
        "status": "mitigated",
        "impact": "Resume and continue flows can burn substantially more input tokens than fresh-session starts.",
        "local_controls": [
            "warn on known expensive resume/continue paths",
            "budget-guard resume source block until explicit acknowledgement",
            "prefer fresh-session fallback when cache hit confidence is low",
        ],
        "detection": [
            "drain_bench:prompt-cache:resume-continue-penalty",
            "compatibility-registry",
        ],
        "benchmarks": ["drain_bench.prompt-cache"],
        "repro_commands": [
            "claude-token-guard bench --suite drain --json",
        ],
        "last_verified_at": "2026-04-07",
        "unresolved_reason": "Actual cache behavior is controlled by Anthropic-side Claude Code internals.",
    },
    {
        "issue_id": "peak-hour-throttling",
        "title": "Peak-hour rate-limit compression",
        "issue_class": "throttling",
        "severity": "high",
        "ownership": "hybrid",
        "status": "mitigated",
        "impact": "The same workload can exhaust usable session budget faster during peak periods.",
        "local_controls": [
            "hourly headroom warnings",
            "admission control via budget-guard",
            "prefer cheaper routing during peak burn",
        ],
        "detection": [
            "budget-guard hourly utilization",
            "drain_bench:peak-hour",
        ],
        "benchmarks": ["drain_bench.peak-hour"],
        "repro_commands": [
            "claude-token-guard bench --suite drain --json",
            "claude-token-guard ops today --json",
        ],
        "last_verified_at": "2026-04-07",
        "unresolved_reason": "Peak-hour platform throttling remains upstream behavior even when local routing is optimized.",
    },
    {
        "issue_id": "context-window-bloat",
        "title": "Oversized context accumulation",
        "issue_class": "context-window",
        "severity": "high",
        "ownership": "local",
        "status": "mitigated",
        "impact": "Repeated large reads and oversized tool output inflate prompt size and session burn rate.",
        "local_controls": [
            "read-efficiency-guard",
            "result-compressor warnings",
            "pre-compact-save state preservation",
        ],
        "detection": [
            "hook audit trail",
            "context growth tracking",
        ],
        "benchmarks": ["drain_bench.read-batching"],
        "repro_commands": [
            "claude-token-guard bench --suite drain --json",
        ],
        "last_verified_at": "2026-04-07",
    },
    {
        "issue_id": "line-number-overhead",
        "title": "Line-number formatting overhead",
        "issue_class": "read-overhead",
        "severity": "medium",
        "ownership": "upstream",
        "status": "benchmarked",
        "impact": "Line-number-heavy read flows add measurable token overhead even when the user only needs targeted content.",
        "local_controls": [
            "batch read guidance",
            "duplicate read suppression",
        ],
        "detection": [
            "drain_bench:line-number-overhead",
        ],
        "benchmarks": ["drain_bench.line-number-overhead"],
        "repro_commands": [
            "claude-token-guard bench --suite drain --json",
        ],
        "last_verified_at": "2026-04-07",
        "unresolved_reason": "The upstream read formatter determines the baseline token overhead.",
    },
    {
        "issue_id": "redundant-reads",
        "title": "Repeated and overlapping file reads",
        "issue_class": "read-overhead",
        "severity": "high",
        "ownership": "local",
        "status": "mitigated",
        "impact": "Re-reading the same file region wastes input tokens and compounds long-session drain.",
        "local_controls": [
            "read-efficiency-guard",
            "read-cache",
            "batch-read benchmark coverage",
        ],
        "detection": [
            "session-state read counters",
            "drain_bench:read-batching",
        ],
        "benchmarks": ["drain_bench.read-batching"],
        "repro_commands": [
            "claude-token-guard bench --suite drain --json",
        ],
        "last_verified_at": "2026-04-07",
    },
    {
        "issue_id": "agent-fanout-overrun",
        "title": "Subagent fanout budget overrun",
        "issue_class": "fanout",
        "severity": "critical",
        "ownership": "local",
        "status": "mitigated",
        "impact": "Too many concurrent workers can consume the session budget faster than the lead agent can recover value.",
        "local_controls": [
            "token-guard max_agents enforcement",
            "fanout benchmark gate",
            "budget-guard hourly headroom enforcement",
        ],
        "detection": [
            "token-guard audit events",
            "drain_bench:fanout",
        ],
        "benchmarks": ["drain_bench.fanout"],
        "repro_commands": [
            "claude-token-guard bench --suite drain --json",
        ],
        "last_verified_at": "2026-04-07",
    },
    {
        "issue_id": "model-misrouting",
        "title": "Unnecessarily expensive model selection",
        "issue_class": "routing",
        "severity": "high",
        "ownership": "local",
        "status": "mitigated",
        "impact": "Sending lookup and lightweight work to expensive models burns tokens without increasing outcome quality.",
        "local_controls": [
            "model-router hard blocks",
            "routing-reminder",
            "routing benchmark delta checks",
        ],
        "detection": [
            "model-router audit blocks",
            "drain_bench:routing",
        ],
        "benchmarks": ["drain_bench.routing"],
        "repro_commands": [
            "claude-token-guard bench --suite drain --json",
        ],
        "last_verified_at": "2026-04-07",
    },
    {
        "issue_id": "visibility-gaps",
        "title": "Low-visibility session burn and alerting gaps",
        "issue_class": "observability",
        "severity": "medium",
        "ownership": "local",
        "status": "mitigated",
        "impact": "Without near-real-time burn visibility, users discover token drain after the damage is already done.",
        "local_controls": [
            "ops today snapshot",
            "proactive alerts",
            "statusline cache",
            "session recap",
        ],
        "detection": [
            "ops today",
            "ops alerts status",
            "health-check",
        ],
        "benchmarks": [],
        "repro_commands": [
            "claude-token-guard ops today --json",
            "claude-token-guard ops alerts status --json",
        ],
        "last_verified_at": "2026-04-07",
    },
    {
        "issue_id": "upstream-regression-intake",
        "title": "New upstream token-drain regressions",
        "issue_class": "compatibility",
        "severity": "high",
        "ownership": "upstream",
        "status": "active",
        "impact": "New Claude Code regressions can invalidate local assumptions and silently degrade burn efficiency.",
        "local_controls": [
            "compatibility registry with upsert path",
            "drain benchmark reruns",
            "operator compatibility report",
        ],
        "detection": [
            "ops compatibility report",
            "manual issue intake via CLI",
        ],
        "benchmarks": ["drain_bench.prompt-cache", "drain_bench.peak-hour"],
        "repro_commands": [
            "claude-token-guard ops compatibility --json",
            "claude-token-guard ops compatibility intake --issue-id new-upstream-regression --title '...' --issue-class compatibility --severity high --ownership upstream --status active --impact '...'",
        ],
        "last_verified_at": "2026-04-07",
        "unresolved_reason": "New regressions require active intake and re-benchmarking; they cannot be prevented purely by static configuration.",
    },
]


def default_registry() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "registry_version": "2026-04-07",
        "issues": list(DEFAULT_ISSUES),
    }


def ensure_registry() -> Path:
    path = registry_path()
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(default_registry(), indent=2) + "\n", encoding="utf-8")
    return path


def load_registry() -> dict[str, Any]:
    path = ensure_registry()
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        registry = default_registry()
        path.write_text(json.dumps(registry, indent=2) + "\n", encoding="utf-8")
        return registry


def save_registry(doc: dict[str, Any]) -> Path:
    path = registry_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    return path


def upsert_issue(
    *,
    issue_id: str,
    title: str,
    issue_class: str,
    severity: str,
    ownership: str,
    status: str,
    impact: str,
    local_controls: list[str] | None = None,
    detection: list[str] | None = None,
    benchmarks: list[str] | None = None,
    repro_commands: list[str] | None = None,
    unresolved_reason: str | None = None,
) -> dict[str, Any]:
    registry = load_registry()
    issues = list(registry.get("issues") or [])
    replacement = {
        "issue_id": issue_id,
        "title": title,
        "issue_class": issue_class,
        "severity": severity,
        "ownership": ownership,
        "status": status,
        "impact": impact,
        "local_controls": local_controls or [],
        "detection": detection or [],
        "benchmarks": benchmarks or [],
        "repro_commands": repro_commands or [],
        "last_verified_at": utc_now()[:10],
    }
    if unresolved_reason:
        replacement["unresolved_reason"] = unresolved_reason

    updated = False
    for idx, issue in enumerate(issues):
        if issue.get("issue_id") == issue_id:
            merged = dict(issue)
            merged.update(replacement)
            issues[idx] = merged
            updated = True
            break
    if not updated:
        issues.append(replacement)

    registry["issues"] = sorted(issues, key=lambda item: str(item.get("issue_id", "")))
    save_registry(registry)
    return registry


def build_report(registry: dict[str, Any] | None = None) -> dict[str, Any]:
    registry = registry or load_registry()
    issues = list(registry.get("issues") or [])
    by_status: dict[str, int] = {}
    by_ownership: dict[str, int] = {}
    by_severity: dict[str, int] = {}
    unresolved_critical = 0
    benchmarked = 0
    reproducible = 0
    local_controls = 0

    report_issues: list[dict[str, Any]] = []
    for issue in issues:
        status = str(issue.get("status") or "unknown")
        ownership = str(issue.get("ownership") or "unknown")
        severity = str(issue.get("severity") or "unknown")
        by_status[status] = by_status.get(status, 0) + 1
        by_ownership[ownership] = by_ownership.get(ownership, 0) + 1
        by_severity[severity] = by_severity.get(severity, 0) + 1
        if severity == "critical" and ownership != "local" and status != "mitigated":
            unresolved_critical += 1
        if issue.get("benchmarks"):
            benchmarked += 1
        if issue.get("repro_commands"):
            reproducible += 1
        if issue.get("local_controls"):
            local_controls += 1

        report_issues.append(
            {
                "issue_id": issue.get("issue_id"),
                "title": issue.get("title"),
                "issue_class": issue.get("issue_class"),
                "severity": severity,
                "ownership": ownership,
                "status": status,
                "has_benchmark": bool(issue.get("benchmarks")),
                "has_repro": bool(issue.get("repro_commands")),
                "local_control_count": len(issue.get("local_controls") or []),
                "last_verified_at": issue.get("last_verified_at"),
                "unresolved_reason": issue.get("unresolved_reason", ""),
            }
        )

    total = len(issues)
    coverage_pct = round((benchmarked / total) * 100, 1) if total else 0.0
    return {
        "schema_version": 1,
        "generated_at": utc_now(),
        "registry_version": registry.get("registry_version", ""),
        "summary": {
            "total_issues": total,
            "by_status": by_status,
            "by_ownership": by_ownership,
            "by_severity": by_severity,
            "unresolved_critical": unresolved_critical,
            "issues_with_benchmarks": benchmarked,
            "issues_with_repro_commands": reproducible,
            "issues_with_local_controls": local_controls,
            "benchmark_coverage_pct": coverage_pct,
        },
        "issues": report_issues,
    }


def render_report(report: dict[str, Any], *, fmt: str = "text") -> str:
    if fmt == "json":
        return json.dumps(report, indent=2)

    issues = list(report.get("issues") or [])
    summary = report.get("summary") or {}
    if fmt == "markdown":
        lines = [
            "# Compatibility Report",
            "",
            f"- Total issues: {summary.get('total_issues', 0)}",
            f"- Benchmark coverage: {summary.get('benchmark_coverage_pct', 0)}%",
            f"- Unresolved critical upstream/hybrid issues: {summary.get('unresolved_critical', 0)}",
            "",
            "| Issue | Class | Severity | Ownership | Status | Bench | Repro |",
            "|---|---|---|---|---|---|---|",
        ]
        for issue in issues:
            lines.append(
                "| {title} | {issue_class} | {severity} | {ownership} | {status} | {bench} | {repro} |".format(
                    title=issue.get("title", ""),
                    issue_class=issue.get("issue_class", ""),
                    severity=issue.get("severity", ""),
                    ownership=issue.get("ownership", ""),
                    status=issue.get("status", ""),
                    bench="yes" if issue.get("has_benchmark") else "no",
                    repro="yes" if issue.get("has_repro") else "no",
                )
            )
        return "\n".join(lines)

    lines = [
        "Compatibility Report",
        f"Total issues: {summary.get('total_issues', 0)}",
        f"Benchmark coverage: {summary.get('benchmark_coverage_pct', 0)}%",
        f"Unresolved critical upstream/hybrid issues: {summary.get('unresolved_critical', 0)}",
        "",
    ]
    for issue in issues:
        lines.append(
            "- {title} [{severity}/{ownership}/{status}] bench={bench} repro={repro}".format(
                title=issue.get("title", ""),
                severity=issue.get("severity", ""),
                ownership=issue.get("ownership", ""),
                status=issue.get("status", ""),
                bench="yes" if issue.get("has_benchmark") else "no",
                repro="yes" if issue.get("has_repro") else "no",
            )
        )
        unresolved_reason = str(issue.get("unresolved_reason") or "").strip()
        if unresolved_reason:
            lines.append(f"  unresolved: {unresolved_reason}")
    return "\n".join(lines)
