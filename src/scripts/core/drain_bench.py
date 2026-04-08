#!/usr/bin/env python3
"""Deterministic local benchmarks for token-drain issue classes."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pricing import calculate_cost
from runtime_paths import runtime_dir


def utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _pct_delta(new_value: float, baseline: float) -> float | None:
    if baseline == 0:
        return None
    return round(((new_value - baseline) / baseline) * 100.0, 2)


def _ratio(numerator: float, denominator: float) -> float:
    if denominator <= 0:
        return 0.0
    return numerator / denominator


def _estimate_tokens_from_chars(char_count: int) -> int:
    return max(1, round(char_count / 4.0))


def _render_numbered_text(text: str) -> str:
    lines = text.splitlines() or [text]
    width = max(2, len(str(len(lines))))
    return "\n".join(f"{idx + 1:>{width}} {line}" for idx, line in enumerate(lines))


def _default_scenarios() -> dict[str, Any]:
    return {
        "prompt_cache": [
            {
                "id": "resume-regression",
                "mode": "resume",
                "baseline": {"input_tokens": 120000, "cache_read_tokens": 720000},
                "candidate": {"input_tokens": 248000, "cache_read_tokens": 18000},
                "expected": "regression",
            },
            {
                "id": "continue-healthy",
                "mode": "continue",
                "baseline": {"input_tokens": 120000, "cache_read_tokens": 720000},
                "candidate": {"input_tokens": 126000, "cache_read_tokens": 690000},
                "expected": "healthy",
            },
        ],
        "peak_hour": [
            {
                "id": "peak-burn-critical",
                "hourly_usd": [0.6, 0.8, 1.1, 4.8, 5.2, 5.0],
                "budget_usd": 45.0,
                "expected": "critical",
            },
            {
                "id": "steady-ok",
                "hourly_usd": [0.7, 0.9, 0.8, 0.9, 0.7, 0.8],
                "budget_usd": 45.0,
                "expected": "ok",
            },
        ],
        "line_number_overhead": [
            {
                "id": "python-file-overhead",
                "text": "def alpha():\n    return 1\n\n\ndef beta(value):\n    if value:\n        return value * 2\n    return 0\n",
                "min_overhead_pct": 12.0,
            }
        ],
        "read_batching": [
            {
                "id": "three-file-batch",
                "read_char_counts": [4800, 6200, 9100],
                "per_read_overhead_chars": 180,
                "expected_min_savings_pct": 1.5,
            }
        ],
        "routing": [
            {
                "id": "haiku-cheaper-than-sonnet",
                "usage": {
                    "input_tokens": 180000,
                    "output_tokens": 32000,
                    "cache_read_tokens": 40000,
                    "cache_creation_tokens": 22000,
                },
                "expensive_model": "claude-sonnet-4-5",
                "efficient_model": "claude-haiku-4-5",
                "expected_min_savings_pct": 55.0,
            }
        ],
        "fanout": [
            {
                "id": "fanout-over-budget",
                "workers": 6,
                "avg_input_tokens": 22000,
                "max_agents": 4,
                "budget_tokens": 100000,
                "expected_block": True,
            },
            {
                "id": "fanout-within-budget",
                "workers": 3,
                "avg_input_tokens": 18000,
                "max_agents": 4,
                "budget_tokens": 100000,
                "expected_block": False,
            },
        ],
    }


def load_scenarios(path: str | None = None) -> dict[str, Any]:
    if path:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return data.get("scenarios", data)
    return _default_scenarios()


def bench_prompt_cache(case: dict[str, Any]) -> dict[str, Any]:
    baseline = case["baseline"]
    candidate = case["candidate"]
    baseline_ratio = _ratio(
        float(baseline["cache_read_tokens"]),
        float(baseline["cache_read_tokens"]) + float(baseline["input_tokens"]),
    )
    candidate_ratio = _ratio(
        float(candidate["cache_read_tokens"]),
        float(candidate["cache_read_tokens"]) + float(candidate["input_tokens"]),
    )
    input_delta_pct = _pct_delta(
        float(candidate["input_tokens"]), float(baseline["input_tokens"])
    )
    cache_ratio_drop_pct = _pct_delta(candidate_ratio, baseline_ratio)
    classification = (
        "regression"
        if candidate_ratio < (baseline_ratio * 0.35)
        and (input_delta_pct or 0.0) >= 25.0
        else "healthy"
    )
    ok = classification == case["expected"]
    return {
        "suite": "prompt-cache",
        "case_id": case["id"],
        "title": f"{case['mode']} cache behavior",
        "status": "pass" if ok else "fail",
        "classification": classification,
        "expected": case["expected"],
        "metrics": {
            "baseline_cache_hit_ratio": round(baseline_ratio, 4),
            "candidate_cache_hit_ratio": round(candidate_ratio, 4),
            "input_delta_pct": input_delta_pct,
            "cache_ratio_delta_pct": cache_ratio_drop_pct,
        },
    }


def bench_peak_hour(case: dict[str, Any]) -> dict[str, Any]:
    hours = [float(v) for v in case["hourly_usd"]]
    baseline = sum(hours[:3]) / max(len(hours[:3]), 1)
    recent = sum(hours[-3:]) / max(len(hours[-3:]), 1)
    projected_day = recent * 24.0
    multiplier = recent / baseline if baseline > 0 else 0.0
    budget = float(case["budget_usd"])
    classification = "ok"
    if projected_day >= budget * 1.1 or multiplier >= 2.5:
        classification = "critical"
    elif projected_day >= budget * 0.8 or multiplier >= 1.5:
        classification = "warning"
    ok = classification == case["expected"]
    return {
        "suite": "peak-hour",
        "case_id": case["id"],
        "title": "Peak-hour burn projection",
        "status": "pass" if ok else "fail",
        "classification": classification,
        "expected": case["expected"],
        "metrics": {
            "baseline_hourly_usd": round(baseline, 4),
            "recent_hourly_usd": round(recent, 4),
            "recent_vs_baseline_multiplier": round(multiplier, 2),
            "projected_day_usd": round(projected_day, 2),
            "budget_usd": budget,
        },
    }


def bench_line_number_overhead(case: dict[str, Any]) -> dict[str, Any]:
    raw_text = str(case["text"])
    numbered_text = _render_numbered_text(raw_text)
    raw_tokens = _estimate_tokens_from_chars(len(raw_text))
    numbered_tokens = _estimate_tokens_from_chars(len(numbered_text))
    overhead_pct = _pct_delta(float(numbered_tokens), float(raw_tokens)) or 0.0
    ok = overhead_pct >= float(case["min_overhead_pct"])
    return {
        "suite": "line-number-overhead",
        "case_id": case["id"],
        "title": "Line-number payload overhead",
        "status": "pass" if ok else "fail",
        "classification": "measured" if ok else "under-threshold",
        "expected": f">= {case['min_overhead_pct']}%",
        "metrics": {
            "raw_tokens_est": raw_tokens,
            "numbered_tokens_est": numbered_tokens,
            "overhead_pct": round(overhead_pct, 2),
        },
    }


def bench_read_batching(case: dict[str, Any]) -> dict[str, Any]:
    counts = [int(v) for v in case["read_char_counts"]]
    overhead = int(case["per_read_overhead_chars"])
    repeated = sum(_estimate_tokens_from_chars(count + overhead) for count in counts)
    batched = _estimate_tokens_from_chars(sum(counts) + overhead)
    savings_pct = (
        round(((repeated - batched) / repeated) * 100.0, 2) if repeated else 0.0
    )
    ok = savings_pct >= float(case["expected_min_savings_pct"])
    return {
        "suite": "read-batching",
        "case_id": case["id"],
        "title": "Batched reads vs repeated reads",
        "status": "pass" if ok else "fail",
        "classification": "savings-observed" if ok else "under-threshold",
        "expected": f">= {case['expected_min_savings_pct']}%",
        "metrics": {
            "repeated_tokens_est": repeated,
            "batched_tokens_est": batched,
            "savings_pct": savings_pct,
        },
    }


def bench_routing(case: dict[str, Any]) -> dict[str, Any]:
    usage = case["usage"]
    expensive_cost = calculate_cost(
        case["expensive_model"],
        input_tokens=int(usage["input_tokens"]),
        output_tokens=int(usage["output_tokens"]),
        cache_read_tokens=int(usage["cache_read_tokens"]),
        cache_creation_tokens=int(usage["cache_creation_tokens"]),
    )
    efficient_cost = calculate_cost(
        case["efficient_model"],
        input_tokens=int(usage["input_tokens"]),
        output_tokens=int(usage["output_tokens"]),
        cache_read_tokens=int(usage["cache_read_tokens"]),
        cache_creation_tokens=int(usage["cache_creation_tokens"]),
    )
    savings_pct = (
        round(((expensive_cost - efficient_cost) / expensive_cost) * 100.0, 2)
        if expensive_cost
        else 0.0
    )
    ok = savings_pct >= float(case["expected_min_savings_pct"])
    return {
        "suite": "routing",
        "case_id": case["id"],
        "title": "Cheaper routing delta",
        "status": "pass" if ok else "fail",
        "classification": "savings-observed" if ok else "under-threshold",
        "expected": f">= {case['expected_min_savings_pct']}%",
        "metrics": {
            "expensive_cost_usd": expensive_cost,
            "efficient_cost_usd": efficient_cost,
            "savings_pct": savings_pct,
        },
    }


def bench_fanout(case: dict[str, Any]) -> dict[str, Any]:
    workers = int(case["workers"])
    avg_input_tokens = int(case["avg_input_tokens"])
    total_tokens = workers * avg_input_tokens
    block = workers > int(case["max_agents"]) or total_tokens > int(case["budget_tokens"])
    ok = block == bool(case["expected_block"])
    return {
        "suite": "fanout",
        "case_id": case["id"],
        "title": "Fanout budget gate",
        "status": "pass" if ok else "fail",
        "classification": "block" if block else "allow",
        "expected": "block" if case["expected_block"] else "allow",
        "metrics": {
            "workers": workers,
            "avg_input_tokens": avg_input_tokens,
            "total_input_tokens": total_tokens,
            "max_agents": int(case["max_agents"]),
            "budget_tokens": int(case["budget_tokens"]),
        },
    }


BENCH_HANDLERS = {
    "prompt_cache": bench_prompt_cache,
    "peak_hour": bench_peak_hour,
    "line_number_overhead": bench_line_number_overhead,
    "read_batching": bench_read_batching,
    "routing": bench_routing,
    "fanout": bench_fanout,
}


def build_report(scenarios: dict[str, Any]) -> dict[str, Any]:
    cases = []
    for suite_name, handler in BENCH_HANDLERS.items():
        for case in scenarios.get(suite_name, []):
            cases.append(handler(case))
    total = len(cases)
    passed = sum(1 for case in cases if case["status"] == "pass")
    failed = total - passed
    grouped = []
    for suite_name in BENCH_HANDLERS:
        suite_cases = [case for case in cases if case["suite"] == suite_name.replace("_", "-")]
        grouped.append(
            {
                "suite": suite_name.replace("_", "-"),
                "cases": suite_cases,
                "summary": {
                    "total": len(suite_cases),
                    "passed": sum(1 for case in suite_cases if case["status"] == "pass"),
                    "failed": sum(1 for case in suite_cases if case["status"] == "fail"),
                },
            }
        )
    return {
        "schema_version": 1,
        "generated_at": utc_now(),
        "runtime_dir": str(runtime_dir()),
        "summary": {"total": total, "passed": passed, "failed": failed},
        "suites": grouped,
    }


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Token Drain Benchmark Report",
        "",
        f"- Generated: {report['generated_at']}",
        f"- Runtime: `{report['runtime_dir']}`",
        f"- Cases: {report['summary']['passed']}/{report['summary']['total']} passing",
        "",
    ]
    for suite in report.get("suites", []):
        lines.append(f"## {suite['suite']}")
        lines.append("")
        for case in suite.get("cases", []):
            lines.append(
                f"- `{case['case_id']}`: {case['status']} ({case['classification']}, expected {case['expected']})"
            )
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(prog="drain_bench.py")
    ap.add_argument("--fixture")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--markdown", action="store_true")
    ap.add_argument("--out")
    args = ap.parse_args()

    report = build_report(load_scenarios(args.fixture))
    rendered = (
        render_markdown(report)
        if args.markdown and not args.json
        else json.dumps(report, indent=2) + "\n"
    )
    if args.out:
        Path(args.out).write_text(rendered, encoding="utf-8")
    sysout = rendered
    print(sysout, end="")
    return 0 if report["summary"]["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
