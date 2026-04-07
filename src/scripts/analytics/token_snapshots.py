#!/usr/bin/env python3
"""Token Analytics — Historical daily/weekly/monthly snapshot system.

Generates day-level snapshot files from Claude Code session JSONL data,
enabling historical trend analysis. Supports backfill from existing data,
aggregation to weekly/monthly summaries, and automatic rotation.

Storage layout:
  ~/.claude/token-analytics/
    daily/YYYY-MM-DD.json     # One per day, ~3-5KB each
    weekly/YYYY-Wnn.json      # Aggregated from daily
    monthly/YYYY-MM.json      # Aggregated from weekly
    sessions/YYYY-MM-DD.jsonl # Per-session summaries (from Stop hook)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# Add scripts dir to path for imports
SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

# Add hooks dir for hook_utils
HOOKS_DIR = Path.home() / ".claude" / "hooks"
if str(HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(HOOKS_DIR))

from hook_utils import read_jsonl_fault_tolerant, save_json_state

try:
    from pricing import calculate_cost_from_usage, normalize_model_name
except ImportError:
    def calculate_cost_from_usage(model, usage):
        return 0.0
    def normalize_model_name(m):
        return m

HOME = Path.home()
CLAUDE_DIR = HOME / ".claude"
ANALYTICS_DIR = CLAUDE_DIR / "token-analytics"
DAILY_DIR = ANALYTICS_DIR / "daily"
WEEKLY_DIR = ANALYTICS_DIR / "weekly"
MONTHLY_DIR = ANALYTICS_DIR / "monthly"
SESSIONS_DIR = ANALYTICS_DIR / "sessions"
PROJECTS_DIR = CLAUDE_DIR / "projects"
AGENT_METRICS_FILE = CLAUDE_DIR / "hooks" / "session-state" / "agent-metrics.jsonl"
AUDIT_FILE = CLAUDE_DIR / "hooks" / "session-state" / "audit.jsonl"

# Rotation policy
DAILY_KEEP_DAYS = 14
WEEKLY_KEEP_WEEKS = 12


def ensure_dirs():
    for d in (DAILY_DIR, WEEKLY_DIR, MONTHLY_DIR, SESSIONS_DIR):
        d.mkdir(parents=True, exist_ok=True)


def utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def parse_date(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def iter_session_jsonl_for_date(target_date: str) -> list[dict]:
    """Iterate all session JSONL files, yielding usage records for a specific date.

    Returns list of dicts with: model, usage, sessionId, timestamp.
    Uses file mtime for fast filtering.
    """
    target_dt = parse_date(target_date)
    target_end = target_dt + timedelta(days=1)
    records = []

    if not PROJECTS_DIR.exists():
        return records

    for proj_dir in PROJECTS_DIR.iterdir():
        if not proj_dir.is_dir():
            continue
        for fp in proj_dir.glob("*.jsonl"):
            # Skip files not modified around the target date (1-day buffer)
            try:
                mtime = datetime.fromtimestamp(fp.stat().st_mtime, tz=timezone.utc)
                if mtime + timedelta(days=1) < target_dt:
                    continue
            except OSError:
                continue

            try:
                with fp.open("r", encoding="utf-8", errors="ignore") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            continue

                        # Only care about assistant messages with usage
                        if entry.get("type") != "assistant":
                            continue
                        msg = entry.get("message", {})
                        if not isinstance(msg, dict):
                            continue
                        usage = msg.get("usage")
                        if not usage or not isinstance(usage, dict):
                            continue

                        # Check timestamp falls in target date
                        ts_str = entry.get("timestamp", "")
                        if not ts_str:
                            continue
                        try:
                            ts = datetime.fromisoformat(
                                ts_str.replace("Z", "+00:00")
                            )
                        except (ValueError, TypeError):
                            continue

                        if ts < target_dt or ts >= target_end:
                            continue

                        records.append({
                            "model": msg.get("model", "unknown"),
                            "usage": usage,
                            "sessionId": entry.get("sessionId", "unknown"),
                            "timestamp": ts_str,
                            "ts": ts,
                        })
            except (OSError, PermissionError):
                continue

    return records


def load_agent_metrics_for_date(target_date: str) -> dict:
    """Load agent-metrics.jsonl entries for a specific date.

    Returns: {spawned, blocked (from audit), byType: {type: {count, tokens, costUSD}}}
    """
    result = {"spawned": 0, "byType": {}}

    entries = read_jsonl_fault_tolerant(str(AGENT_METRICS_FILE))
    for e in entries:
        if e.get("event") != "agent_completed":
            continue
        ts_str = e.get("ts", "")
        if not ts_str.startswith(target_date):
            continue

        result["spawned"] += 1
        atype = e.get("agent_type", "unknown") or "unknown"
        at = result["byType"].setdefault(atype, {
            "count": 0, "tokens": 0, "costUSD": 0.0
        })
        at["count"] += 1
        at["tokens"] += int(e.get("input_tokens", 0)) + int(e.get("output_tokens", 0))
        at["costUSD"] += float(e.get("cost_usd", 0.0) or 0)

    return result


def load_guard_stats_for_date(target_date: str) -> dict:
    """Load token-guard audit entries for a specific date.

    Returns: {allows, blocks, estimatedTokensSaved, estimatedCostSaved, blocksByRule}
    """
    result = {
        "allows": 0,
        "blocks": 0,
        "estimatedTokensSaved": 0,
        "estimatedCostSaved": 0.0,
        "blocksByRule": {},
    }

    entries = read_jsonl_fault_tolerant(str(AUDIT_FILE))
    for e in entries:
        ts_str = e.get("ts", "")
        if not ts_str.startswith(target_date):
            continue

        event = e.get("event", "")
        if event == "allow":
            result["allows"] += 1
        elif event == "block":
            result["blocks"] += 1
            reason = e.get("reason", "unknown")
            result["blocksByRule"][reason] = result["blocksByRule"].get(reason, 0) + 1
            result["estimatedTokensSaved"] += int(
                e.get("estimated_tokens_saved", 0) or 0
            )
            result["estimatedCostSaved"] += float(
                e.get("estimated_cost_saved", 0.0) or 0
            )

    return result


def generate_daily_snapshot(target_date: str) -> dict:
    """Generate a complete daily snapshot for the given date (YYYY-MM-DD)."""
    records = iter_session_jsonl_for_date(target_date)

    # Aggregate totals
    totals = {
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheCreationTokens": 0,
        "cacheReadTokens": 0,
        "costUSD": 0.0,
        "messages": 0,
        "sessions": 0,
    }
    models: dict[str, dict] = {}
    session_costs: dict[str, float] = {}
    session_msgs: dict[str, int] = {}

    for r in records:
        usage = r["usage"]
        model_raw = r["model"]
        model_key = normalize_model_name(model_raw)
        sid = r["sessionId"][:8] if r.get("sessionId") else "unknown"
        cost = calculate_cost_from_usage(model_raw, usage)

        totals["messages"] += 1
        totals["inputTokens"] += int(usage.get("input_tokens", 0) or 0)
        totals["outputTokens"] += int(usage.get("output_tokens", 0) or 0)
        totals["cacheCreationTokens"] += int(
            usage.get("cache_creation_input_tokens", 0) or 0
        )
        totals["cacheReadTokens"] += int(
            usage.get("cache_read_input_tokens", 0) or 0
        )
        totals["costUSD"] += cost

        # Per-model
        mk = model_key or model_raw or "unknown"
        m = models.setdefault(mk, {
            "messages": 0,
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheCreationTokens": 0,
            "cacheReadTokens": 0,
            "costUSD": 0.0,
        })
        m["messages"] += 1
        m["inputTokens"] += int(usage.get("input_tokens", 0) or 0)
        m["outputTokens"] += int(usage.get("output_tokens", 0) or 0)
        m["cacheCreationTokens"] += int(
            usage.get("cache_creation_input_tokens", 0) or 0
        )
        m["cacheReadTokens"] += int(usage.get("cache_read_input_tokens", 0) or 0)
        m["costUSD"] += cost

        # Per-session
        session_costs[sid] = session_costs.get(sid, 0.0) + cost
        session_msgs[sid] = session_msgs.get(sid, 0) + 1

    totals["sessions"] = len(session_costs)
    totals["costUSD"] = round(totals["costUSD"], 2)
    for m in models.values():
        m["costUSD"] = round(m["costUSD"], 2)

    # Top sessions by cost
    top_sessions = sorted(
        [{"id": k, "costUSD": round(v, 2), "messages": session_msgs.get(k, 0)}
         for k, v in session_costs.items()],
        key=lambda x: x["costUSD"],
        reverse=True,
    )[:5]

    # Agent and guard data
    agents = load_agent_metrics_for_date(target_date)
    guard = load_guard_stats_for_date(target_date)
    agents["blocked"] = guard["blocks"]
    guard["estimatedCostSaved"] = round(guard["estimatedCostSaved"], 2)

    for at_data in agents.get("byType", {}).values():
        at_data["costUSD"] = round(at_data.get("costUSD", 0), 2)

    snapshot = {
        "date": target_date,
        "generatedAt": utc_now(),
        "totals": totals,
        "models": models,
        "agents": agents,
        "guard": guard,
        "topSessions": top_sessions,
    }
    return snapshot


def save_daily_snapshot(target_date: str, snapshot: dict | None = None) -> Path:
    """Generate and save a daily snapshot."""
    ensure_dirs()
    if snapshot is None:
        snapshot = generate_daily_snapshot(target_date)
    path = DAILY_DIR / f"{target_date}.json"
    save_json_state(str(path), snapshot)
    return path


def aggregate_daily_files(paths: list[Path]) -> dict:
    """Merge multiple daily snapshots into an aggregate summary."""
    agg = {
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheCreationTokens": 0,
        "cacheReadTokens": 0,
        "costUSD": 0.0,
        "messages": 0,
        "sessions": 0,
    }
    models_agg: dict[str, dict] = {}
    agents_agg = {"spawned": 0, "blocked": 0, "byType": {}}
    guard_agg = {
        "allows": 0,
        "blocks": 0,
        "estimatedTokensSaved": 0,
        "estimatedCostSaved": 0.0,
        "blocksByRule": {},
    }
    daily_costs: list[dict] = []
    dates_covered: list[str] = []

    for p in paths:
        try:
            snap = json.loads(p.read_text())
        except (OSError, json.JSONDecodeError):
            continue

        dates_covered.append(snap.get("date", p.stem))
        t = snap.get("totals", {})
        agg["inputTokens"] += t.get("inputTokens", 0)
        agg["outputTokens"] += t.get("outputTokens", 0)
        agg["cacheCreationTokens"] += t.get("cacheCreationTokens", 0)
        agg["cacheReadTokens"] += t.get("cacheReadTokens", 0)
        agg["costUSD"] += t.get("costUSD", 0.0)
        agg["messages"] += t.get("messages", 0)
        agg["sessions"] += t.get("sessions", 0)

        daily_costs.append({
            "date": snap.get("date", p.stem),
            "costUSD": round(t.get("costUSD", 0.0), 2),
            "messages": t.get("messages", 0),
        })

        for mk, mv in snap.get("models", {}).items():
            m = models_agg.setdefault(mk, {
                "messages": 0, "inputTokens": 0, "outputTokens": 0,
                "cacheCreationTokens": 0, "cacheReadTokens": 0, "costUSD": 0.0,
            })
            for k in m:
                m[k] += mv.get(k, 0)

        ag = snap.get("agents", {})
        agents_agg["spawned"] += ag.get("spawned", 0)
        agents_agg["blocked"] += ag.get("blocked", 0)
        for atype, adata in ag.get("byType", {}).items():
            at = agents_agg["byType"].setdefault(atype, {
                "count": 0, "tokens": 0, "costUSD": 0.0
            })
            at["count"] += adata.get("count", 0)
            at["tokens"] += adata.get("tokens", 0)
            at["costUSD"] += adata.get("costUSD", 0.0)

        g = snap.get("guard", {})
        guard_agg["allows"] += g.get("allows", 0)
        guard_agg["blocks"] += g.get("blocks", 0)
        guard_agg["estimatedTokensSaved"] += g.get("estimatedTokensSaved", 0)
        guard_agg["estimatedCostSaved"] += g.get("estimatedCostSaved", 0.0)
        for rule, count in g.get("blocksByRule", {}).items():
            guard_agg["blocksByRule"][rule] = guard_agg["blocksByRule"].get(rule, 0) + count

    agg["costUSD"] = round(agg["costUSD"], 2)
    for m in models_agg.values():
        m["costUSD"] = round(m["costUSD"], 2)
    guard_agg["estimatedCostSaved"] = round(guard_agg["estimatedCostSaved"], 2)
    for at in agents_agg.get("byType", {}).values():
        at["costUSD"] = round(at.get("costUSD", 0), 2)

    return {
        "generatedAt": utc_now(),
        "datesCovered": sorted(dates_covered),
        "daysCount": len(dates_covered),
        "totals": agg,
        "models": models_agg,
        "agents": agents_agg,
        "guard": guard_agg,
        "dailyCosts": sorted(daily_costs, key=lambda x: x["date"]),
    }


def aggregate_to_weekly(iso_year: int, iso_week: int) -> Path | None:
    """Merge daily snapshots for an ISO week into a weekly summary."""
    ensure_dirs()
    # Find all daily files for this week
    daily_files = []
    # Monday of the ISO week
    jan4 = datetime(iso_year, 1, 4, tzinfo=timezone.utc)
    start_of_week = jan4 + timedelta(weeks=iso_week - 1, days=-jan4.weekday())
    for i in range(7):
        day = start_of_week + timedelta(days=i)
        day_str = day.strftime("%Y-%m-%d")
        p = DAILY_DIR / f"{day_str}.json"
        if p.exists():
            daily_files.append(p)

    if not daily_files:
        return None

    agg = aggregate_daily_files(daily_files)
    agg["isoWeek"] = f"{iso_year}-W{iso_week:02d}"
    path = WEEKLY_DIR / f"{iso_year}-W{iso_week:02d}.json"
    save_json_state(str(path), agg)
    return path


def aggregate_to_monthly(year: int, month: int) -> Path | None:
    """Merge weekly snapshots for a month into a monthly summary."""
    ensure_dirs()
    ym = f"{year}-{month:02d}"

    # Collect weekly files that overlap this month
    weekly_files = []
    for wf in sorted(WEEKLY_DIR.glob(f"{year}-W*.json")):
        try:
            data = json.loads(wf.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        dates = data.get("datesCovered", [])
        if any(d.startswith(ym) for d in dates):
            weekly_files.append(wf)

    # Also try daily files directly for the month (more accurate)
    daily_files = sorted(DAILY_DIR.glob(f"{ym}-*.json"))
    if daily_files:
        agg = aggregate_daily_files(daily_files)
    elif weekly_files:
        # Fallback: aggregate from weekly
        agg = aggregate_daily_files(weekly_files)  # works on any snapshot format
    else:
        return None

    agg["month"] = ym
    path = MONTHLY_DIR / f"{ym}.json"
    save_json_state(str(path), agg)
    return path


def rotate_snapshots():
    """Apply rotation policy: daily>14d → weekly; weekly>12w → monthly."""
    ensure_dirs()
    now = datetime.now(timezone.utc)
    rotated_daily = 0
    rotated_weekly = 0

    # Daily → Weekly rotation
    cutoff_daily = now - timedelta(days=DAILY_KEEP_DAYS)
    old_daily: dict[tuple[int, int], list[Path]] = {}  # (year, week) → files
    for p in sorted(DAILY_DIR.glob("*.json")):
        try:
            date_str = p.stem
            dt = parse_date(date_str)
        except (ValueError, TypeError):
            continue

        if dt < cutoff_daily:
            iso_year, iso_week, _ = dt.isocalendar()
            old_daily.setdefault((iso_year, iso_week), []).append(p)

    for (iso_year, iso_week), files in old_daily.items():
        weekly_path = WEEKLY_DIR / f"{iso_year}-W{iso_week:02d}.json"
        if not weekly_path.exists():
            aggregate_to_weekly(iso_year, iso_week)
        # Delete old daily files
        for f in files:
            try:
                f.unlink()
                rotated_daily += 1
            except OSError:
                pass

    # Weekly → Monthly rotation
    cutoff_weekly = now - timedelta(weeks=WEEKLY_KEEP_WEEKS)
    old_weekly: dict[str, list[Path]] = {}  # YYYY-MM → files
    for p in sorted(WEEKLY_DIR.glob("*.json")):
        try:
            data = json.loads(p.read_text())
        except (OSError, json.JSONDecodeError):
            continue

        dates = data.get("datesCovered", [])
        if not dates:
            continue
        first_date = parse_date(dates[0])
        if first_date < cutoff_weekly:
            ym = dates[0][:7]
            old_weekly.setdefault(ym, []).append(p)

    for ym, files in old_weekly.items():
        year, month = int(ym[:4]), int(ym[5:7])
        monthly_path = MONTHLY_DIR / f"{ym}.json"
        if not monthly_path.exists():
            aggregate_to_monthly(year, month)
        for f in files:
            try:
                f.unlink()
                rotated_weekly += 1
            except OSError:
                pass

    return rotated_daily, rotated_weekly


def backfill_snapshots(
    start_date: str | None = None, end_date: str | None = None
) -> int:
    """Backfill daily snapshots from existing session JSONL files."""
    ensure_dirs()

    # Find date range from JSONL file mtimes
    if not PROJECTS_DIR.exists():
        return 0

    min_date = datetime.now(timezone.utc)
    max_date = datetime(2020, 1, 1, tzinfo=timezone.utc)

    for proj_dir in PROJECTS_DIR.iterdir():
        if not proj_dir.is_dir():
            continue
        for fp in proj_dir.glob("*.jsonl"):
            try:
                mtime = datetime.fromtimestamp(fp.stat().st_mtime, tz=timezone.utc)
                ctime = datetime.fromtimestamp(fp.stat().st_ctime, tz=timezone.utc)
                if ctime < min_date:
                    min_date = ctime
                if mtime > max_date:
                    max_date = mtime
            except OSError:
                continue

    if start_date:
        min_date = parse_date(start_date)
    if end_date:
        max_date = parse_date(end_date)

    # Generate snapshots for each day
    count = 0
    current = min_date.replace(hour=0, minute=0, second=0, microsecond=0)
    end = max_date.replace(hour=0, minute=0, second=0, microsecond=0)

    while current <= end:
        date_str = current.strftime("%Y-%m-%d")
        daily_path = DAILY_DIR / f"{date_str}.json"
        if not daily_path.exists():
            snapshot = generate_daily_snapshot(date_str)
            # Only save if there's actual data
            if snapshot["totals"]["messages"] > 0:
                save_daily_snapshot(date_str, snapshot)
                count += 1
                print(f"  {date_str}: {snapshot['totals']['messages']} msgs, "
                      f"${snapshot['totals']['costUSD']:.2f}")
        current += timedelta(days=1)

    return count


def show_snapshot(date_str: str):
    """Print a formatted daily snapshot."""
    path = DAILY_DIR / f"{date_str}.json"
    if not path.exists():
        print(f"No snapshot for {date_str}. Run: python3 {__file__} snapshot --date {date_str}")
        return

    snap = json.loads(path.read_text())
    t = snap["totals"]

    print(f"\n  Daily Snapshot: {date_str}")
    print(f"  {'=' * 50}")
    print(f"  Sessions:    {t['sessions']}")
    print(f"  Messages:    {t['messages']:,}")
    print(f"  Cost (equiv): ${t['costUSD']:.2f}")
    print(f"  Tokens:")
    print(f"    Input:       {t['inputTokens']:,}")
    print(f"    Output:      {t['outputTokens']:,}")
    print(f"    Cache Write: {t['cacheCreationTokens']:,}")
    print(f"    Cache Read:  {t['cacheReadTokens']:,}")

    if snap.get("models"):
        print(f"\n  Models:")
        for mk, mv in sorted(snap["models"].items(), key=lambda x: x[1]["costUSD"], reverse=True):
            pct = (mv["costUSD"] / t["costUSD"] * 100) if t["costUSD"] > 0 else 0
            print(f"    {mk}: ${mv['costUSD']:.2f} ({pct:.0f}%) — {mv['messages']} msgs")

    ag = snap.get("agents", {})
    if ag.get("spawned") or ag.get("blocked"):
        print(f"\n  Agents: {ag['spawned']} spawned, {ag.get('blocked', 0)} blocked")
        for atype, adata in sorted(
            ag.get("byType", {}).items(),
            key=lambda x: x[1]["costUSD"],
            reverse=True,
        ):
            print(f"    {atype}: {adata['count']}x — {adata['tokens']:,} tokens — ${adata['costUSD']:.2f}")

    g = snap.get("guard", {})
    if g.get("blocks"):
        print(f"\n  Guard: {g['allows']} allows, {g['blocks']} blocks")
        if g["estimatedCostSaved"] > 0:
            print(f"    Est. saved: ${g['estimatedCostSaved']:.2f}")

    ts = snap.get("topSessions", [])
    if ts:
        print(f"\n  Top Sessions:")
        for s in ts[:3]:
            print(f"    {s['id']}: ${s['costUSD']:.2f} ({s['messages']} msgs)")
    print()


def cmd_snapshot(args):
    """Generate today's (or specified date's) snapshot."""
    date_str = args.date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    print(f"Generating snapshot for {date_str}...")
    snapshot = generate_daily_snapshot(date_str)
    path = save_daily_snapshot(date_str, snapshot)
    print(f"Saved: {path}")
    show_snapshot(date_str)


def cmd_backfill(args):
    """Backfill historical daily snapshots."""
    print("Backfilling daily snapshots from session JSONL data...")
    start = time.time()
    count = backfill_snapshots(args.start, args.end)
    elapsed = time.time() - start
    print(f"\nDone: {count} snapshots created in {elapsed:.1f}s")


def cmd_rotate(args):
    """Run rotation policy."""
    print("Running snapshot rotation...")
    daily_count, weekly_count = rotate_snapshots()
    print(f"Rotated: {daily_count} daily → weekly, {weekly_count} weekly → monthly")


def cmd_show(args):
    """Show a daily snapshot."""
    show_snapshot(args.date)


def cmd_list(args):
    """List available snapshots."""
    ensure_dirs()
    daily = sorted(DAILY_DIR.glob("*.json"))
    weekly = sorted(WEEKLY_DIR.glob("*.json"))
    monthly = sorted(MONTHLY_DIR.glob("*.json"))

    print(f"\n  Snapshots Available")
    print(f"  {'=' * 40}")
    print(f"  Daily:   {len(daily)} files", end="")
    if daily:
        print(f" ({daily[0].stem} to {daily[-1].stem})")
    else:
        print()
    print(f"  Weekly:  {len(weekly)} files", end="")
    if weekly:
        print(f" ({weekly[0].stem} to {weekly[-1].stem})")
    else:
        print()
    print(f"  Monthly: {len(monthly)} files", end="")
    if monthly:
        print(f" ({monthly[0].stem} to {monthly[-1].stem})")
    else:
        print()
    print()


def main():
    p = argparse.ArgumentParser(
        description="Token analytics snapshot management"
    )
    sp = p.add_subparsers(dest="cmd", required=True)

    snap = sp.add_parser("snapshot", help="Generate daily snapshot")
    snap.add_argument("--date", help="Date (YYYY-MM-DD), default: today")
    snap.set_defaults(func=cmd_snapshot)

    bf = sp.add_parser("backfill", help="Backfill historical snapshots")
    bf.add_argument("--start", help="Start date (YYYY-MM-DD)")
    bf.add_argument("--end", help="End date (YYYY-MM-DD)")
    bf.set_defaults(func=cmd_backfill)

    rot = sp.add_parser("rotate", help="Run rotation policy")
    rot.set_defaults(func=cmd_rotate)

    sh = sp.add_parser("show", help="Show a daily snapshot")
    sh.add_argument("date", help="Date (YYYY-MM-DD)")
    sh.set_defaults(func=cmd_show)

    ls = sp.add_parser("list", help="List available snapshots")
    ls.set_defaults(func=cmd_list)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
