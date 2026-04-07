#!/usr/bin/env python3
"""Sub-agent usage assessment — reads agent-metrics.jsonl and produces
a summary table of token usage, cost, and dispatch frequency by agent type.

Usage:
    python3 ~/.claude/scripts/subagent-usage.py              # today's summary
    python3 ~/.claude/scripts/subagent-usage.py --window 7   # last 7 days
    python3 ~/.claude/scripts/subagent-usage.py --json        # machine-readable
"""

import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone, timedelta

METRICS_FILE = os.path.expanduser("~/.claude/hooks/session-state/agent-metrics.jsonl")


def load_metrics(window_days=1):
    if not os.path.isfile(METRICS_FILE):
        return []
    cutoff = datetime.now(timezone.utc) - timedelta(days=window_days)
    records = []
    with open(METRICS_FILE) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if d.get("record_type") != "usage":
                continue
            ts = d.get("ts", "")
            try:
                record_time = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                if record_time < cutoff:
                    continue
            except (ValueError, TypeError):
                pass
            records.append(d)
    return records


def aggregate(records):
    by_type = defaultdict(
        lambda: {
            "count": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_creation_tokens": 0,
            "total_cost_usd": 0.0,
            "api_calls": 0,
        }
    )
    for r in records:
        agent_type = r.get("agent_type", "unknown")
        agg = by_type[agent_type]
        agg["count"] += 1
        agg["input_tokens"] += r.get("input_tokens", 0) or 0
        agg["output_tokens"] += r.get("output_tokens", 0) or 0
        agg["cache_read_tokens"] += r.get("cache_read_tokens", 0) or 0
        agg["cache_creation_tokens"] += r.get("cache_creation_tokens", 0) or 0
        agg["total_cost_usd"] += r.get("cost_usd", 0) or 0
        agg["api_calls"] += r.get("api_calls", 0) or 0
    return dict(by_type)


def format_tokens(n):
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n/1_000:.1f}K"
    return str(n)


def print_table(aggregated, window_days):
    if not aggregated:
        print(f"No sub-agent usage in the last {window_days} day(s).")
        return

    total_cost = sum(v["total_cost_usd"] for v in aggregated.values())
    total_dispatches = sum(v["count"] for v in aggregated.values())
    total_api_calls = sum(v["api_calls"] for v in aggregated.values())

    print(f"Sub-Agent Usage Assessment ({window_days}d window)")
    print(f"{'='*65}")
    print(f"{'Agent Type':<25} {'Runs':>5} {'API':>5} {'In':>8} {'Out':>8} {'Cost':>8}")
    print(f"{'-'*25} {'-'*5} {'-'*5} {'-'*8} {'-'*8} {'-'*8}")

    sorted_types = sorted(
        aggregated.items(), key=lambda x: x[1]["total_cost_usd"], reverse=True
    )
    for agent_type, data in sorted_types:
        print(
            f"{agent_type:<25} {data['count']:>5} {data['api_calls']:>5} "
            f"{format_tokens(data['input_tokens']):>8} "
            f"{format_tokens(data['output_tokens']):>8} "
            f"${data['total_cost_usd']:>7.4f}"
        )

    print(f"{'-'*25} {'-'*5} {'-'*5} {'-'*8} {'-'*8} {'-'*8}")
    print(
        f"{'TOTAL':<25} {total_dispatches:>5} {total_api_calls:>5} "
        f"{'':>8} {'':>8} ${total_cost:>7.4f}"
    )

    if total_dispatches > 0:
        avg_cost = total_cost / total_dispatches
        print(f"\nAvg cost/dispatch: ${avg_cost:.4f}")

    # Flag expensive agents
    for agent_type, data in sorted_types:
        if data["total_cost_usd"] > 0.50:
            print(
                f"  WARNING: {agent_type} spent ${data['total_cost_usd']:.2f} "
                f"({data['count']} dispatches)"
            )


def main():
    window = 1
    as_json = False
    for arg in sys.argv[1:]:
        if arg == "--json":
            as_json = True
        elif arg.startswith("--window"):
            if "=" in arg:
                window = int(arg.split("=")[1])
        elif arg.isdigit():
            window = int(arg)

    records = load_metrics(window)
    aggregated = aggregate(records)

    if as_json:
        total_cost = sum(v["total_cost_usd"] for v in aggregated.values())
        print(
            json.dumps(
                {
                    "window_days": window,
                    "total_dispatches": sum(v["count"] for v in aggregated.values()),
                    "total_cost_usd": round(total_cost, 4),
                    "by_agent_type": aggregated,
                },
                indent=2,
            )
        )
    else:
        print_table(aggregated, window)


if __name__ == "__main__":
    main()
