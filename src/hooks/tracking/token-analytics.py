#!/usr/bin/env python3
"""Token Analytics — unified CLI for token usage tracking and analysis.

Commands:
  status    Current session token consumption
  today     Today's usage summary
  week      This week with daily trend
  range     Historical date range analysis
  agents    Per-agent-type breakdown
  recommend Pattern-based recommendations
  savings   Token-guard savings report
  report    Full combined report
  export    Export to CSV

Usage:
  python3 ~/.claude/hooks/token-analytics.py status
  python3 ~/.claude/hooks/token-analytics.py today
  python3 ~/.claude/hooks/token-analytics.py week
  python3 ~/.claude/hooks/token-analytics.py range --from 2026-02-01 --to 2026-02-25
  python3 ~/.claude/hooks/token-analytics.py agents
  python3 ~/.claude/hooks/token-analytics.py recommend
  python3 ~/.claude/hooks/token-analytics.py savings
  python3 ~/.claude/hooks/token-analytics.py report
  python3 ~/.claude/hooks/token-analytics.py export --format csv --out ~/report.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import median

THIS_DIR = Path(__file__).resolve().parent
INFRA_DIR = THIS_DIR.parent / "infrastructure"
for candidate in (THIS_DIR, INFRA_DIR):
    candidate_str = str(candidate)
    if candidate.is_dir() and candidate_str not in sys.path:
        sys.path.insert(0, candidate_str)

try:
    from runtime_paths import hooks_dir, scripts_dir, session_state_dir, token_analytics_dir
except Exception:
    def hooks_dir() -> Path:
        return Path.home() / ".claude" / "hooks"

    def scripts_dir() -> Path:
        return Path.home() / ".claude" / "scripts"

    def session_state_dir() -> Path:
        return hooks_dir() / "session-state"

    def token_analytics_dir() -> Path:
        return Path.home() / ".claude" / "token-analytics"


SCRIPTS_DIR = scripts_dir()
HOOKS_DIR = hooks_dir()
for d in (str(SCRIPTS_DIR), str(HOOKS_DIR)):
    if d not in sys.path:
        sys.path.insert(0, d)

from hook_utils import read_jsonl_fault_tolerant

try:
    from savings_calculator import compute_savings, format_tokens, print_savings
except ImportError:
    def compute_savings(date_filter=None):
        return {"totalBlocks": 0, "totalCostSaved": 0}
    def format_tokens(n):
        return str(n)
    def print_savings(date_filter=None):
        print("  Savings calculator not available")

try:
    from token_snapshots import (
        generate_daily_snapshot,
        save_daily_snapshot,
        show_snapshot,
        DAILY_DIR,
        WEEKLY_DIR,
        MONTHLY_DIR,
        aggregate_daily_files,
        ensure_dirs as ensure_snapshot_dirs,
    )
except ImportError:
    DAILY_DIR = Path.home() / ".claude" / "token-analytics" / "daily"
    WEEKLY_DIR = Path.home() / ".claude" / "token-analytics" / "weekly"
    MONTHLY_DIR = Path.home() / ".claude" / "token-analytics" / "monthly"
    def generate_daily_snapshot(d):
        return {}
    def save_daily_snapshot(d, s=None):
        return Path()
    def show_snapshot(d):
        print(f"  No snapshot module available")
    def aggregate_daily_files(paths):
        return {}
    def ensure_snapshot_dirs():
        pass

HOME = Path.home()
CLAUDE_DIR = hooks_dir().parent
STATE_DIR = session_state_dir()
AGENT_METRICS_FILE = STATE_DIR / "agent-metrics.jsonl"
AUDIT_FILE = STATE_DIR / "audit.jsonl"


def fmt_tokens(n: int) -> str:
    """Format token count for display."""
    if n >= 1_000_000_000:
        return f"{n / 1_000_000_000:.1f}B"
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return f"{n:,}"


def fmt_cost(usd: float) -> str:
    """Format USD cost for display."""
    if usd < 0.01:
        return f"${usd:.4f}"
    if usd < 1.0:
        return f"${usd:.2f}"
    return f"${usd:,.2f}"


def fmt_duration(seconds: float) -> str:
    """Format seconds into human-readable duration."""
    if seconds < 60:
        return f"{seconds:.0f}s"
    if seconds < 3600:
        return f"{seconds / 60:.0f}m"
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    return f"{hours}h {minutes}m"


def bar_chart(value: float, max_value: float, width: int = 20) -> str:
    """Generate a simple bar chart string."""
    if max_value <= 0:
        return ""
    filled = int(value / max_value * width)
    half = 1 if (value / max_value * width - filled) >= 0.5 else 0
    return "\u2588" * filled + ("\u258c" if half else "") + " " * (width - filled - half)


# ─── Status Command ──────────────────────────────────────────────────────────

def cmd_status(args):
    """Show current session token consumption."""
    # Find the most recent session token file
    token_files = sorted(
        STATE_DIR.glob("*-tokens.json"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    ) if STATE_DIR.exists() else []

    if not token_files:
        print("\n  No active session tracking data found.")
        print("  Session tracker may not be registered yet.")
        return

    # Show the most recent (or all active)
    for tf in token_files[:3]:
        try:
            state = json.loads(tf.read_text())
        except (OSError, json.JSONDecodeError):
            continue

        sid = state.get("sessionId", "unknown")
        started = state.get("startedAt", "")
        updated = state.get("lastUpdatedAt", "")
        totals = state.get("totals", {})
        models = state.get("models", {})
        tools = state.get("toolCounts", {})

        # Calculate duration
        duration_str = ""
        if started and updated:
            try:
                start_dt = datetime.fromisoformat(started.replace("Z", "+00:00"))
                end_dt = datetime.fromisoformat(updated.replace("Z", "+00:00"))
                duration_str = fmt_duration((end_dt - start_dt).total_seconds())
            except (ValueError, TypeError):
                pass

        cost = totals.get("costUSD", 0)
        api_calls = totals.get("apiCalls", 0)

        print(f"\n  Session {sid[:8]} ({duration_str or 'active'})")
        print(f"  {'=' * 55}")
        print(f"  Tokens:  Input {fmt_tokens(totals.get('inputTokens', 0))} | "
              f"Output {fmt_tokens(totals.get('outputTokens', 0))} | "
              f"Cache Read {fmt_tokens(totals.get('cacheReadTokens', 0))} | "
              f"Cache Write {fmt_tokens(totals.get('cacheCreationTokens', 0))}")
        print(f"  Cost:    {fmt_cost(cost)} (equiv. pay-as-you-go)")
        print(f"  Calls:   {api_calls} API calls")

        if models:
            model_parts = []
            for mk, mv in sorted(models.items(), key=lambda x: x[1].get("costUSD", 0), reverse=True):
                model_parts.append(f"{mk} ({mv['messages']} calls)")
            print(f"  Models:  {' | '.join(model_parts)}")

        agents_spawned = state.get("agentsSpawned", 0)
        agents_blocked = state.get("agentsBlocked", 0)
        if agents_spawned or agents_blocked:
            print(f"  Agents:  {agents_spawned} spawned, {agents_blocked} blocked")

        if tools:
            tool_parts = [f"{k} {v}" for k, v in sorted(tools.items(), key=lambda x: x[1], reverse=True)[:6]]
            print(f"  Tools:   {' | '.join(tool_parts)}")

        # Projection based on rate
        if duration_str and cost > 0:
            try:
                start_dt = datetime.fromisoformat(started.replace("Z", "+00:00"))
                elapsed = (datetime.now(timezone.utc) - start_dt).total_seconds()
                if elapsed > 300:  # Only project after 5 minutes
                    rate_per_hour = cost / (elapsed / 3600)
                    print(f"  Rate:    {fmt_cost(rate_per_hour)}/hr")
            except (ValueError, TypeError):
                pass

    print()


# ─── Today Command ───────────────────────────────────────────────────────────

def cmd_today(args):
    """Show today's usage summary."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    daily_path = DAILY_DIR / f"{today}.json"

    # Generate on-the-fly if missing or stale
    if not daily_path.exists() or _is_stale(daily_path, max_age_minutes=5):
        snapshot = generate_daily_snapshot(today)
        save_daily_snapshot(today, snapshot)
    else:
        snapshot = json.loads(daily_path.read_text())

    t = snapshot.get("totals", {})

    print(f"\n  Today ({today})")
    print(f"  {'=' * 55}")
    print(f"  Sessions:    {t.get('sessions', 0)}")
    print(f"  Messages:    {t.get('messages', 0):,}")
    print(f"  Tokens:      Input {fmt_tokens(t.get('inputTokens', 0))} | "
          f"Output {fmt_tokens(t.get('outputTokens', 0))} | "
          f"Cache Read {fmt_tokens(t.get('cacheReadTokens', 0))} | "
          f"Cache Write {fmt_tokens(t.get('cacheCreationTokens', 0))}")
    print(f"  Cost:        {fmt_cost(t.get('costUSD', 0))} (equiv.)")

    # Model breakdown
    models = snapshot.get("models", {})
    if models:
        print(f"  Models:", end="")
        parts = []
        for mk, mv in sorted(models.items(), key=lambda x: x[1].get("costUSD", 0), reverse=True):
            pct = (mv["costUSD"] / t["costUSD"] * 100) if t.get("costUSD", 0) > 0 else 0
            parts.append(f"{mk} {fmt_cost(mv['costUSD'])} ({pct:.0f}%)")
        print(f"      {' | '.join(parts)}")

    # Agent stats
    ag = snapshot.get("agents", {})
    if ag.get("spawned") or ag.get("blocked"):
        block_rate = (ag["blocked"] / (ag["spawned"] + ag["blocked"]) * 100
                      if (ag["spawned"] + ag["blocked"]) > 0 else 0)
        print(f"  Agents:      {ag['spawned']} spawned, {ag.get('blocked', 0)} blocked "
              f"({block_rate:.0f}% block rate)")

    # Comparison to yesterday
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
    yesterday_path = DAILY_DIR / f"{yesterday}.json"
    if yesterday_path.exists():
        try:
            y_snap = json.loads(yesterday_path.read_text())
            y_cost = y_snap.get("totals", {}).get("costUSD", 0)
            t_cost = t.get("costUSD", 0)
            if y_cost > 0:
                diff = t_cost - y_cost
                pct = (diff / y_cost) * 100
                sign = "+" if diff >= 0 else ""
                print(f"  vs Yesterday: {sign}{fmt_cost(abs(diff))} ({sign}{pct:.0f}%)")
        except (OSError, json.JSONDecodeError):
            pass

    # Top sessions
    ts = snapshot.get("topSessions", [])
    if ts:
        print(f"  Top:         ", end="")
        parts = [f"{s['id']} {fmt_cost(s['costUSD'])}" for s in ts[:3]]
        print(" | ".join(parts))

    print()


# ─── Week Command ────────────────────────────────────────────────────────────

def cmd_week(args):
    """Show this week's usage with daily trend."""
    today = datetime.now(timezone.utc)
    # Get Monday of this week
    monday = today - timedelta(days=today.weekday())

    days = []
    max_cost = 0
    total_cost = 0
    total_msgs = 0

    for i in range(7):
        day = monday + timedelta(days=i)
        day_str = day.strftime("%Y-%m-%d")
        day_name = day.strftime("%a")

        daily_path = DAILY_DIR / f"{day_str}.json"
        if daily_path.exists():
            try:
                snap = json.loads(daily_path.read_text())
                cost = snap.get("totals", {}).get("costUSD", 0)
                msgs = snap.get("totals", {}).get("messages", 0)
                days.append({"name": day_name, "date": day_str, "cost": cost, "msgs": msgs})
                max_cost = max(max_cost, cost)
                total_cost += cost
                total_msgs += msgs
            except (OSError, json.JSONDecodeError):
                days.append({"name": day_name, "date": day_str, "cost": 0, "msgs": 0})
        elif day.date() <= today.date():
            # Try generating on-the-fly for today
            if day_str == today.strftime("%Y-%m-%d"):
                snapshot = generate_daily_snapshot(day_str)
                save_daily_snapshot(day_str, snapshot)
                cost = snapshot.get("totals", {}).get("costUSD", 0)
                msgs = snapshot.get("totals", {}).get("messages", 0)
                days.append({"name": day_name, "date": day_str, "cost": cost, "msgs": msgs})
                max_cost = max(max_cost, cost)
                total_cost += cost
                total_msgs += msgs
            else:
                days.append({"name": day_name, "date": day_str, "cost": 0, "msgs": 0})
        else:
            days.append({"name": day_name, "date": day_str, "cost": 0, "msgs": 0, "future": True})

    start_str = monday.strftime("%b %d")
    end_str = (monday + timedelta(days=6)).strftime("%b %d")

    print(f"\n  This Week ({start_str} - {end_str})")
    print(f"  {'=' * 55}")

    days_with_data = [d for d in days if d["cost"] > 0]
    for d in days:
        if d.get("future"):
            print(f"  {d['name']}  ---")
        elif d["cost"] > 0:
            chart = bar_chart(d["cost"], max_cost, 20)
            print(f"  {d['name']}  {fmt_cost(d['cost']):>8}  {chart}")
        else:
            print(f"  {d['name']}  {'---':>8}")

    print(f"\n  Total:    {fmt_cost(total_cost)}")
    if days_with_data:
        avg = total_cost / len(days_with_data)
        print(f"  Average:  {fmt_cost(avg)}/day")
        projected_monthly = avg * 30
        print(f"  Projected: {fmt_cost(projected_monthly)}/month")

    # Compare to last week
    last_monday = monday - timedelta(weeks=1)
    last_total = 0
    for i in range(7):
        day = last_monday + timedelta(days=i)
        day_str = day.strftime("%Y-%m-%d")
        daily_path = DAILY_DIR / f"{day_str}.json"
        if daily_path.exists():
            try:
                snap = json.loads(daily_path.read_text())
                last_total += snap.get("totals", {}).get("costUSD", 0)
            except (OSError, json.JSONDecodeError):
                pass

    if last_total > 0:
        diff = total_cost - last_total
        pct = (diff / last_total) * 100
        sign = "+" if diff >= 0 else ""
        print(f"  vs Last Week: {sign}{fmt_cost(abs(diff))} ({sign}{pct:.0f}%)")

    print()


# ─── Range Command ───────────────────────────────────────────────────────────

def cmd_range(args):
    """Show usage for a date range."""
    start = args.start
    end = args.end or datetime.now(timezone.utc).strftime("%Y-%m-%d")

    daily_files = []
    current = datetime.strptime(start, "%Y-%m-%d")
    end_dt = datetime.strptime(end, "%Y-%m-%d")

    while current <= end_dt:
        day_str = current.strftime("%Y-%m-%d")
        p = DAILY_DIR / f"{day_str}.json"
        if p.exists():
            daily_files.append(p)
        current += timedelta(days=1)

    if not daily_files:
        print(f"\n  No data for range {start} to {end}")
        print(f"  Run: python3 ~/.claude/scripts/token_snapshots.py backfill --start {start} --end {end}")
        return

    agg = aggregate_daily_files(daily_files)
    t = agg.get("totals", {})

    print(f"\n  Usage: {start} to {end}")
    print(f"  {'=' * 55}")
    print(f"  Days:      {agg.get('daysCount', 0)}")
    print(f"  Sessions:  {t.get('sessions', 0)}")
    print(f"  Messages:  {t.get('messages', 0):,}")
    print(f"  Cost:      {fmt_cost(t.get('costUSD', 0))}")

    models = agg.get("models", {})
    if models:
        print(f"  Models:")
        for mk, mv in sorted(models.items(), key=lambda x: x[1].get("costUSD", 0), reverse=True):
            print(f"    {mk}: {fmt_cost(mv['costUSD'])} ({mv['messages']:,} msgs)")

    # Daily trend
    daily_costs = agg.get("dailyCosts", [])
    if daily_costs and len(daily_costs) > 1:
        max_cost = max(d["costUSD"] for d in daily_costs)
        print(f"\n  Daily Trend:")
        for d in daily_costs[-14:]:  # Last 14 days max
            chart = bar_chart(d["costUSD"], max_cost, 15)
            print(f"    {d['date']}  {fmt_cost(d['costUSD']):>8}  {chart}")

    print()


# ─── Agents Command ──────────────────────────────────────────────────────────

def cmd_agents(args):
    """Show per-agent-type breakdown."""
    entries = read_jsonl_fault_tolerant(str(AGENT_METRICS_FILE))
    audit_entries = read_jsonl_fault_tolerant(str(AUDIT_FILE))

    # Filter to last 7 days
    cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")

    by_type: dict[str, dict] = defaultdict(lambda: {
        "spawns": 0, "tokens": 0, "cost": 0.0, "token_list": []
    })

    for e in entries:
        if e.get("event") != "agent_completed":
            continue
        ts = e.get("ts", "")
        if ts < cutoff:
            continue

        atype = e.get("agent_type", "unknown") or "unknown"
        total_tokens = int(e.get("input_tokens", 0)) + int(e.get("output_tokens", 0))
        cost = float(e.get("cost_usd", 0) or 0)

        by_type[atype]["spawns"] += 1
        by_type[atype]["tokens"] += total_tokens
        by_type[atype]["cost"] += cost
        if total_tokens > 0:
            by_type[atype]["token_list"].append(total_tokens)

    # Count blocks per type
    block_counts: dict[str, int] = defaultdict(int)
    for e in audit_entries:
        if e.get("event") != "block":
            continue
        ts = e.get("ts", "")
        if ts < cutoff:
            continue
        atype = e.get("type", "") or e.get("subagent_type", "") or "unknown"
        block_counts[atype] += 1

    print(f"\n  Agent Usage (Last 7 Days)")
    print(f"  {'=' * 70}")
    print(f"  {'Type':<20} {'Spawns':>7} {'Tokens':>10} {'Cost':>9} {'Avg/Spawn':>11} {'Blocked':>8}")
    print(f"  {'-' * 70}")

    total_spawns = 0
    total_tokens = 0
    total_cost = 0.0
    total_blocked = 0

    rows = sorted(by_type.items(), key=lambda x: x[1]["cost"], reverse=True)
    for atype, data in rows:
        spawns = data["spawns"]
        tokens = data["tokens"]
        cost = data["cost"]
        avg = tokens // spawns if spawns > 0 else 0
        blocked = block_counts.get(atype, 0)
        block_rate_str = f"{blocked}" if blocked else "0"

        print(f"  {atype:<20} {spawns:>7} {fmt_tokens(tokens):>10} "
              f"{fmt_cost(cost):>9} {fmt_tokens(avg):>11} {block_rate_str:>8}")

        total_spawns += spawns
        total_tokens += tokens
        total_cost += cost
        total_blocked += blocked

    # Also show types that were only blocked (never spawned)
    for atype, blocked in block_counts.items():
        if atype not in by_type:
            print(f"  {atype:<20} {'0':>7} {'---':>10} {'---':>9} {'---':>11} {blocked:>8}")
            total_blocked += blocked

    print(f"  {'-' * 70}")
    total_avg = total_tokens // total_spawns if total_spawns > 0 else 0
    print(f"  {'Total':<20} {total_spawns:>7} {fmt_tokens(total_tokens):>10} "
          f"{fmt_cost(total_cost):>9} {fmt_tokens(total_avg):>11} {total_blocked:>8}")
    print()


# ─── Recommend Command ───────────────────────────────────────────────────────

def cmd_recommend(args):
    """Generate pattern-based recommendations."""
    recommendations = []
    scores = {"block_rate": 0, "reread": 0, "agent_ratio": 0, "model_mix": 0}

    # 1. Agent efficiency analysis
    audit_entries = read_jsonl_fault_tolerant(str(AUDIT_FILE))
    cutoff_7d = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
    recent_blocks = [e for e in audit_entries if e.get("event") == "block" and e.get("ts", "") >= cutoff_7d]
    recent_allows = [e for e in audit_entries if e.get("event") == "allow" and e.get("ts", "") >= cutoff_7d]

    if recent_blocks:
        block_rate = len(recent_blocks) / (len(recent_blocks) + len(recent_allows)) * 100 if (recent_blocks or recent_allows) else 0
        scores["block_rate"] = min(block_rate, 100)

        # Group blocks by type
        block_by_type = defaultdict(int)
        for e in recent_blocks:
            atype = e.get("type", "") or "unknown"
            block_by_type[atype] += 1

        for atype, count in sorted(block_by_type.items(), key=lambda x: x[1], reverse=True):
            if count >= 3:
                recommendations.append({
                    "level": "HIGH",
                    "text": f"{atype} agents blocked {count} times this week",
                    "action": "Consider using Grep/Read directly instead",
                })

    # 2. Re-read detection
    reread_counts: dict[str, int] = defaultdict(int)
    for reads_file in STATE_DIR.glob("*-reads.json"):
        try:
            data = json.loads(reads_file.read_text())
            if isinstance(data, dict):
                reads_list = data.get("reads", [])
                if isinstance(reads_list, list):
                    for entry in reads_list:
                        if isinstance(entry, dict):
                            fpath = entry.get("path", "")
                            if fpath:
                                reread_counts[fpath] += 1
        except (OSError, json.JSONDecodeError):
            continue

    heavy_rereads = [(f, c) for f, c in reread_counts.items() if c >= 5]
    if heavy_rereads:
        scores["reread"] = min(len(heavy_rereads) * 10, 100)
        for filepath, count in sorted(heavy_rereads, key=lambda x: x[1], reverse=True)[:3]:
            short_path = filepath.replace(str(HOME), "~")
            recommendations.append({
                "level": "MED",
                "text": f"Re-read {short_path} {count} times recently",
                "action": "Keep in context or use targeted Grep",
            })

    # 3. Model mix analysis from daily snapshots
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    daily_path = DAILY_DIR / f"{today}.json"
    if daily_path.exists():
        try:
            snap = json.loads(daily_path.read_text())
            models = snap.get("models", {})
            opus_cost = sum(v.get("costUSD", 0) for k, v in models.items() if "opus" in k.lower())
            sonnet_cost = sum(v.get("costUSD", 0) for k, v in models.items() if "sonnet" in k.lower())
            total_model_cost = opus_cost + sonnet_cost
            if total_model_cost > 0:
                opus_pct = opus_cost / total_model_cost * 100
                scores["model_mix"] = max(0, opus_pct - 50)  # Penalize heavy Opus usage
                if opus_pct > 80:
                    recommendations.append({
                        "level": "INFO",
                        "text": f"Opus is {opus_pct:.0f}% of today's cost ({fmt_cost(opus_cost)} vs Sonnet {fmt_cost(sonnet_cost)})",
                        "action": "Consider Sonnet for routine tasks to stay within allocation",
                    })
        except (OSError, json.JSONDecodeError):
            pass

    # 4. Temporal patterns
    daily_files = sorted(DAILY_DIR.glob("*.json"))[-7:]
    if len(daily_files) >= 3:
        daily_costs = []
        for p in daily_files:
            try:
                snap = json.loads(p.read_text())
                daily_costs.append({
                    "date": p.stem,
                    "day": datetime.strptime(p.stem, "%Y-%m-%d").strftime("%A"),
                    "cost": snap.get("totals", {}).get("costUSD", 0),
                })
            except (OSError, json.JSONDecodeError):
                continue

        if daily_costs:
            max_day = max(daily_costs, key=lambda x: x["cost"])
            min_day = min(daily_costs, key=lambda x: x["cost"])
            if max_day["cost"] > min_day["cost"] * 2 and max_day["cost"] > 50:
                recommendations.append({
                    "level": "LOW",
                    "text": f"Peak usage: {max_day['day']} ({fmt_cost(max_day['cost'])}) vs {min_day['day']} ({fmt_cost(min_day['cost'])})",
                    "action": "Consider spreading heavy tasks across the week",
                })

    # Calculate waste score
    waste_components = [
        scores["block_rate"] * 0.20,
        scores["reread"] * 0.30,
        scores["agent_ratio"] * 0.25,
        scores["model_mix"] * 0.25,
    ]
    waste_score = int(sum(waste_components))
    waste_score = min(waste_score, 100)

    # Rating
    if waste_score <= 15:
        rating = "Excellent"
    elif waste_score <= 30:
        rating = "Good"
    elif waste_score <= 50:
        rating = "Fair"
    else:
        rating = "Needs improvement"

    print(f"\n  Recommendations")
    print(f"  {'=' * 55}")

    if not recommendations:
        print(f"  No issues detected. Usage patterns look efficient.")
    else:
        for i, rec in enumerate(recommendations, 1):
            level = rec["level"]
            print(f"  {i}. [{level}] {rec['text']}")
            print(f"     -> {rec['action']}")

    print(f"\n  Waste Score: {waste_score}/100 ({rating})")
    print(f"    Block rate penalty:  {scores['block_rate']:.0f}%")
    print(f"    Re-read penalty:     {scores['reread']:.0f}%")
    print(f"    Model mix penalty:   {scores['model_mix']:.0f}%")

    # Savings summary
    savings = compute_savings()
    if savings.get("totalBlocks", 0) > 0:
        print(f"\n  Guard Impact: {savings['totalBlocks']} blocks saved est. {fmt_cost(savings['totalCostSaved'])}")

    print()


# ─── Savings Command ─────────────────────────────────────────────────────────

def cmd_savings(args):
    """Show token-guard savings report."""
    print_savings(args.date if hasattr(args, "date") and args.date else None)


# ─── Report Command ──────────────────────────────────────────────────────────

def cmd_report(args):
    """Full combined report."""
    print("\n" + "=" * 60)
    print("  TOKEN USAGE ANALYTICS REPORT")
    print("=" * 60)

    cmd_status(args)
    cmd_today(args)
    cmd_week(args)
    cmd_agents(args)
    cmd_savings(args)
    cmd_recommend(args)


# ─── Export Command ──────────────────────────────────────────────────────────

def cmd_export(args):
    """Export data to CSV."""
    output_path = args.out or os.path.expanduser("~/token-report.csv")
    daily_files = sorted(DAILY_DIR.glob("*.json"))

    if not daily_files:
        print("No daily snapshots to export.")
        return

    rows = []
    for p in daily_files:
        try:
            snap = json.loads(p.read_text())
        except (OSError, json.JSONDecodeError):
            continue

        t = snap.get("totals", {})
        ag = snap.get("agents", {})
        g = snap.get("guard", {})

        row = {
            "date": snap.get("date", p.stem),
            "sessions": t.get("sessions", 0),
            "messages": t.get("messages", 0),
            "inputTokens": t.get("inputTokens", 0),
            "outputTokens": t.get("outputTokens", 0),
            "cacheCreationTokens": t.get("cacheCreationTokens", 0),
            "cacheReadTokens": t.get("cacheReadTokens", 0),
            "costUSD": t.get("costUSD", 0),
            "agentsSpawned": ag.get("spawned", 0),
            "agentsBlocked": ag.get("blocked", 0),
            "guardAllows": g.get("allows", 0),
            "guardBlocks": g.get("blocks", 0),
            "estimatedCostSaved": g.get("estimatedCostSaved", 0),
        }

        # Model breakdown columns
        for mk, mv in snap.get("models", {}).items():
            row[f"cost_{mk}"] = mv.get("costUSD", 0)

        rows.append(row)

    if not rows:
        print("No data to export.")
        return

    # Determine all columns
    all_cols = list(rows[0].keys())
    for r in rows[1:]:
        for k in r:
            if k not in all_cols:
                all_cols.append(k)

    with open(output_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=all_cols)
        writer.writeheader()
        for r in rows:
            writer.writerow(r)

    print(f"Exported {len(rows)} days to {output_path}")


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _is_stale(path: Path, max_age_minutes: int = 5) -> bool:
    """Check if a file is older than max_age_minutes."""
    try:
        mtime = path.stat().st_mtime
        age = (datetime.now(timezone.utc).timestamp() - mtime) / 60
        return age > max_age_minutes
    except OSError:
        return True


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(
        description="Token Usage Analytics CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Examples:\n"
               "  python3 token-analytics.py status\n"
               "  python3 token-analytics.py today\n"
               "  python3 token-analytics.py week\n"
               "  python3 token-analytics.py agents\n"
               "  python3 token-analytics.py recommend\n"
               "  python3 token-analytics.py report\n",
    )
    sp = p.add_subparsers(dest="cmd", required=True)

    sp.add_parser("status", help="Current session token consumption")
    sp.add_parser("today", help="Today's usage summary")
    sp.add_parser("week", help="This week with daily trend")

    rng = sp.add_parser("range", help="Historical date range")
    rng.add_argument("--from", dest="start", required=True, help="Start date YYYY-MM-DD")
    rng.add_argument("--to", dest="end", help="End date YYYY-MM-DD (default: today)")

    sp.add_parser("agents", help="Per-agent-type breakdown")
    sp.add_parser("recommend", help="Pattern-based recommendations")

    sav = sp.add_parser("savings", help="Token-guard savings report")
    sav.add_argument("--date", help="Filter to date prefix (YYYY-MM-DD)")

    sp.add_parser("report", help="Full combined report")

    exp = sp.add_parser("export", help="Export to CSV")
    exp.add_argument("--format", default="csv", choices=["csv"])
    exp.add_argument("--out", help="Output path (default: ~/token-report.csv)")

    args = p.parse_args()

    cmd_map = {
        "status": cmd_status,
        "today": cmd_today,
        "week": cmd_week,
        "range": cmd_range,
        "agents": cmd_agents,
        "recommend": cmd_recommend,
        "savings": cmd_savings,
        "report": cmd_report,
        "export": cmd_export,
    }

    func = cmd_map.get(args.cmd)
    if func:
        func(args)
    else:
        p.print_help()


if __name__ == "__main__":
    main()
