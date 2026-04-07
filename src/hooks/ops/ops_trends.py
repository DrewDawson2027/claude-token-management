#!/usr/bin/env python3
"""Trend analysis for Claude token/cost usage with rolling windows."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List

from ops_sources import CLAUDE_DIR, COST_DIR, utc_now_iso, read_json

PROJECTS_DIR = CLAUDE_DIR / "projects"

COST_PER_1K_INPUT = 0.003
COST_PER_1K_OUTPUT = 0.015
COST_PER_1K_CACHE_READ = 0.0003


def _safe_int(v: Any) -> int:
    try:
        return int(v or 0)
    except Exception:
        return 0


def _safe_float(v: Any) -> float | None:
    try:
        if v is None:
            return None
        return float(v)
    except Exception:
        return None


def _record_cost(usage: dict[str, Any]) -> float:
    explicit = _safe_float(
        usage.get("costUSD") or usage.get("cost_usd") or usage.get("total_cost_usd")
    )
    if explicit is not None:
        return max(0.0, explicit)
    input_tokens = _safe_int(usage.get("input_tokens"))
    output_tokens = _safe_int(usage.get("output_tokens"))
    cache_read = _safe_int(usage.get("cache_read_input_tokens"))
    fresh_input = max(0, input_tokens - cache_read)
    cost = (
        (fresh_input / 1000.0) * COST_PER_1K_INPUT
        + (output_tokens / 1000.0) * COST_PER_1K_OUTPUT
        + (cache_read / 1000.0) * COST_PER_1K_CACHE_READ
    )
    return round(cost, 6)


def _parse_ts(raw: Any) -> datetime | None:
    if isinstance(raw, (int, float)):
        try:
            val = float(raw)
            if val > 10_000_000_000:
                val /= 1000.0
            return datetime.fromtimestamp(val, tz=timezone.utc)
        except Exception:
            return None
    if not isinstance(raw, str):
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def collect_daily_series(window_days: int = 30) -> List[Dict[str, Any]]:
    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=max(0, window_days - 1))
    buckets: dict[date, dict[str, Any]] = defaultdict(
        lambda: {
            "messages": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cost_usd": 0.0,
        }
    )

    if PROJECTS_DIR.exists():
        for fp in PROJECTS_DIR.rglob("*.jsonl"):
            try:
                mtime = datetime.fromtimestamp(
                    fp.stat().st_mtime, tz=timezone.utc
                ).date()
                if mtime < start - timedelta(days=1):
                    continue
            except Exception:
                pass
            try:
                with fp.open("r", encoding="utf-8", errors="ignore") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            row = json.loads(line)
                        except Exception:
                            continue
                        msg = row.get("message") or {}
                        usage = msg.get("usage") if isinstance(msg, dict) else None
                        if not isinstance(usage, dict):
                            continue
                        ts = _parse_ts(row.get("timestamp") or row.get("createdAt"))
                        if ts is None:
                            continue
                        d = ts.date()
                        if d < start or d > end:
                            continue
                        b = buckets[d]
                        b["messages"] += 1
                        b["input_tokens"] += _safe_int(usage.get("input_tokens"))
                        b["output_tokens"] += _safe_int(usage.get("output_tokens"))
                        b["cache_read_tokens"] += _safe_int(
                            usage.get("cache_read_input_tokens")
                        )
                        b["cost_usd"] += _record_cost(usage)
            except Exception:
                continue

    series: List[Dict[str, Any]] = []
    prev_cost = None
    for i in range(window_days):
        d = start + timedelta(days=i)
        b = buckets[d]
        total_tokens = int(b["input_tokens"] + b["output_tokens"])
        item = {
            "date": d.isoformat(),
            "messages": int(b["messages"]),
            "input_tokens": int(b["input_tokens"]),
            "output_tokens": int(b["output_tokens"]),
            "cache_read_tokens": int(b["cache_read_tokens"]),
            "total_tokens": total_tokens,
            "cost_usd": round(float(b["cost_usd"]), 4),
        }
        if prev_cost is not None:
            item["day_over_day_cost_delta_usd"] = round(item["cost_usd"] - prev_cost, 4)
        prev_cost = item["cost_usd"]
        series.append(item)

    # add rolling average
    for idx, item in enumerate(series):
        start_idx = max(0, idx - 6)
        window = series[start_idx : idx + 1]
        item["rolling_7d_avg_cost_usd"] = round(
            sum(x["cost_usd"] for x in window) / len(window), 4
        )

    return series


def _legacy_summary_fields(series: List[Dict[str, Any]]) -> Dict[str, Any]:
    def summarize_window(n: int) -> Dict[str, Any]:
        tail = series[-n:]
        return {
            "costUSD": round(sum(x["cost_usd"] for x in tail), 4),
            "messages": sum(int(x["messages"]) for x in tail),
            "inputTokens": sum(int(x["input_tokens"]) for x in tail),
            "outputTokens": sum(int(x["output_tokens"]) for x in tail),
        }

    today = summarize_window(1)
    week = summarize_window(min(7, len(series)))
    month = summarize_window(min(30, len(series)))
    legacy_series = [
        {
            "window": "today",
            **today,
            "dailyAvgCostUSD": today["costUSD"],
            "dailyAvgMessages": float(today["messages"]),
        },
        {
            "window": "week",
            **week,
            "dailyAvgCostUSD": round(week["costUSD"] / max(1, min(7, len(series))), 2),
            "dailyAvgMessages": round(
                week["messages"] / max(1, min(7, len(series))), 1
            ),
        },
        {
            "window": "month",
            **month,
            "dailyAvgCostUSD": round(
                month["costUSD"] / max(1, min(30, len(series))), 2
            ),
            "dailyAvgMessages": round(
                month["messages"] / max(1, min(30, len(series))), 1
            ),
        },
    ]
    week_avg = legacy_series[1]["dailyAvgCostUSD"] if len(legacy_series) > 1 else 0
    wow = None
    if week_avg:
        wow = round(((legacy_series[0]["costUSD"] - week_avg) / week_avg) * 100, 1)
    return {"legacy_series": legacy_series, "weekOverWeekChangePct": wow}


def build_trends(window_days: int = 7, include_legacy: bool = True) -> Dict[str, Any]:
    series = collect_daily_series(max(30, window_days))
    view = series[-window_days:]
    total_cost = round(sum(x["cost_usd"] for x in view), 4)
    dod = view[-1].get("day_over_day_cost_delta_usd") if view else None
    wow = None
    if len(series) >= 8:
        today_cost = series[-1]["cost_usd"]
        prior = series[-8]["cost_usd"]
        wow = round(today_cost - prior, 4)
    budgets = read_json(COST_DIR / "budgets.json", {}) or {}
    out: Dict[str, Any] = {
        "schema_version": 1,
        "generated_at": utc_now_iso(),
        "window_days": window_days,
        "series": view,
        "summary": {
            "total_cost_usd": total_cost,
            "total_messages": sum(int(x["messages"]) for x in view),
            "total_tokens": sum(int(x["total_tokens"]) for x in view),
            "day_over_day_delta_usd": dod,
            "week_over_week_delta_usd": wow,
            "moving_average_7d_cost_usd": view[-1].get("rolling_7d_avg_cost_usd")
            if view
            else 0,
        },
        "budget_thresholds": (budgets.get("thresholds") or {}),
    }
    if include_legacy:
        out.update(_legacy_summary_fields(series))
    return out


def render_ascii_graph(series: List[Dict[str, Any]]) -> str:
    if not series:
        return "No data"
    max_cost = max(float(x.get("cost_usd") or 0) for x in series) or 1.0
    lines = ["Date        Cost     Graph"]
    for x in series:
        cost = float(x.get("cost_usd") or 0)
        width = int(round((cost / max_cost) * 20))
        lines.append(f"{x['date']}  ${cost:>6.2f}  {'#' * width}")
    return "\n".join(lines)


def render_text(doc: Dict[str, Any]) -> str:
    lines = [
        f"Cost Trends ({doc.get('window_days')}d)",
        f"Generated: {doc.get('generated_at')}",
        f"Total: ${doc.get('summary', {}).get('total_cost_usd', 0):.2f}",
        f"DoD delta: {doc.get('summary', {}).get('day_over_day_delta_usd')}",
        "",
        render_ascii_graph(doc.get("series") or []),
    ]
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="Token management trend analysis")
    ap.add_argument("--window", type=int, default=7, choices=[7, 14, 30])
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--markdown", action="store_true")
    args = ap.parse_args()
    doc = build_trends(window_days=args.window)
    if args.json:
        print(json.dumps(doc, indent=2))
        return 0
    if args.markdown:
        print("```\n" + render_text(doc) + "\n```")
        return 0
    print(render_text(doc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
