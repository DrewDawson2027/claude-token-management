#!/usr/bin/env python3
"""Savings Calculator — estimates tokens/cost saved by token-guard blocks.

Correlates agent-metrics.jsonl (actual costs per agent type) with
audit.jsonl (block events) to estimate what would have been spent
without the guard system.

Works retroactively — no modification to token-guard.py needed.
"""

from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from pathlib import Path
from statistics import median

CORE_DIR = Path(__file__).resolve().parents[1] / "core"
if str(CORE_DIR) not in sys.path:
    sys.path.insert(0, str(CORE_DIR))

from runtime_paths import runtime_dir

HOOKS_DIR = runtime_dir() / "hooks"
if str(HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(HOOKS_DIR))

from hook_utils import read_jsonl_fault_tolerant

AGENT_METRICS_FILE = HOOKS_DIR / "session-state" / "agent-metrics.jsonl"
AUDIT_FILE = HOOKS_DIR / "session-state" / "audit.jsonl"

# Fallback median costs per agent type when no real data exists (conservative)
FALLBACK_MEDIANS = {
    "Explore": {"tokens": 60000, "cost_usd": 0.50},
    "master-coder": {"tokens": 200000, "cost_usd": 3.00},
    "master-researcher": {"tokens": 150000, "cost_usd": 2.25},
    "master-architect": {"tokens": 120000, "cost_usd": 1.80},
    "master-workflow": {"tokens": 180000, "cost_usd": 2.70},
    "Plan": {"tokens": 40000, "cost_usd": 0.30},
    "default": {"tokens": 80000, "cost_usd": 1.00},
}


def compute_agent_medians() -> dict[str, dict]:
    """Compute median tokens and cost per agent type from actual metrics."""
    entries = read_jsonl_fault_tolerant(str(AGENT_METRICS_FILE))
    by_type: dict[str, list[dict]] = defaultdict(list)

    for e in entries:
        if e.get("event") != "agent_completed":
            continue
        atype = e.get("agent_type", "") or "unknown"
        total_tokens = int(e.get("input_tokens", 0)) + int(e.get("output_tokens", 0))
        cost = float(e.get("cost_usd", 0) or 0)
        # Skip zero-token entries (broken transcript discovery era)
        if total_tokens > 0:
            by_type[atype].append({"tokens": total_tokens, "cost": cost})

    result = {}
    for atype, entries_list in by_type.items():
        if not entries_list:
            continue
        token_values = [e["tokens"] for e in entries_list]
        cost_values = [e["cost"] for e in entries_list]
        result[atype] = {
            "median_tokens": int(median(token_values)),
            "median_cost": round(median(cost_values), 4),
            "sample_size": len(entries_list),
        }
    return result


def compute_savings(date_filter: str | None = None) -> dict:
    """Compute total savings from token-guard blocks.

    Args:
        date_filter: Optional YYYY-MM-DD prefix to filter audit entries by date.

    Returns dict with total savings, per-rule breakdown, and per-type breakdown.
    """
    medians = compute_agent_medians()
    audit_entries = read_jsonl_fault_tolerant(str(AUDIT_FILE))

    total_blocks = 0
    total_tokens_saved = 0
    total_cost_saved = 0.0
    by_rule: dict[str, dict] = defaultdict(lambda: {"blocks": 0, "tokens": 0, "cost": 0.0})
    by_type: dict[str, dict] = defaultdict(lambda: {"blocks": 0, "tokens": 0, "cost": 0.0})

    for e in audit_entries:
        if e.get("event") != "block":
            continue

        # Date filter
        if date_filter:
            ts = e.get("ts", "")
            if not ts.startswith(date_filter):
                continue

        total_blocks += 1
        atype = e.get("type", "") or e.get("subagent_type", "") or "unknown"
        reason = e.get("reason", "unknown")

        # Use real data if available, otherwise fallback
        if atype in medians:
            est_tokens = medians[atype]["median_tokens"]
            est_cost = medians[atype]["median_cost"]
        else:
            fb = FALLBACK_MEDIANS.get(atype, FALLBACK_MEDIANS["default"])
            est_tokens = fb["tokens"]
            est_cost = fb["cost_usd"]

        # If audit entry already has savings (from future enhanced token-guard)
        if e.get("estimated_tokens_saved"):
            est_tokens = int(e["estimated_tokens_saved"])
        if e.get("estimated_cost_saved"):
            est_cost = float(e["estimated_cost_saved"])

        total_tokens_saved += est_tokens
        total_cost_saved += est_cost

        by_rule[reason]["blocks"] += 1
        by_rule[reason]["tokens"] += est_tokens
        by_rule[reason]["cost"] += est_cost

        by_type[atype]["blocks"] += 1
        by_type[atype]["tokens"] += est_tokens
        by_type[atype]["cost"] += est_cost

    # Also count allows for context
    total_allows = sum(1 for e in audit_entries if e.get("event") == "allow")

    return {
        "totalBlocks": total_blocks,
        "totalAllows": total_allows,
        "totalTokensSaved": total_tokens_saved,
        "totalCostSaved": round(total_cost_saved, 2),
        "blockRate": round(total_blocks / (total_blocks + total_allows) * 100, 1)
            if (total_blocks + total_allows) > 0 else 0,
        "byRule": {k: {**v, "cost": round(v["cost"], 2)} for k, v in by_rule.items()},
        "byType": {k: {**v, "cost": round(v["cost"], 2)} for k, v in by_type.items()},
        "mediansUsed": {k: v for k, v in medians.items()},
    }


def format_tokens(n: int) -> str:
    """Format token count for display."""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def print_savings(date_filter: str | None = None):
    """Print formatted savings report."""
    savings = compute_savings(date_filter)

    title = "Token Guard Savings"
    if date_filter:
        title += f" ({date_filter})"
    else:
        title += " (all time)"

    print(f"\n  {title}")
    print(f"  {'=' * 50}")
    print(f"  Total decisions:  {savings['totalAllows'] + savings['totalBlocks']}")
    print(f"  Allows:           {savings['totalAllows']}")
    print(f"  Blocks:           {savings['totalBlocks']}")
    print(f"  Block rate:       {savings['blockRate']}%")
    print(f"  Est. tokens saved: {format_tokens(savings['totalTokensSaved'])}")
    print(f"  Est. cost saved:   ${savings['totalCostSaved']:.2f}")

    if savings["byRule"]:
        print(f"\n  By Rule:")
        for rule, data in sorted(
            savings["byRule"].items(), key=lambda x: x[1]["cost"], reverse=True
        ):
            print(f"    {rule}: {data['blocks']} blocks -> ${data['cost']:.2f}")

    if savings["byType"]:
        print(f"\n  By Agent Type:")
        for atype, data in sorted(
            savings["byType"].items(), key=lambda x: x[1]["cost"], reverse=True
        ):
            print(f"    {atype}: {data['blocks']} blocks -> "
                  f"{format_tokens(data['tokens'])} tokens, ${data['cost']:.2f}")

    if savings["mediansUsed"]:
        print(f"\n  Median Costs (from real data):")
        for atype, med in sorted(savings["mediansUsed"].items()):
            print(f"    {atype}: {format_tokens(med['median_tokens'])} tokens, "
                  f"${med['median_cost']:.4f} ({med['sample_size']} samples)")

    print()


if __name__ == "__main__":
    date = sys.argv[1] if len(sys.argv) > 1 else None
    print_savings(date)
