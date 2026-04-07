#!/usr/bin/env python3
"""
System Health Dashboard — unified view over Claude Code infrastructure data.

Data sources:
  - agent-metrics.jsonl    → agent spawn counts, lifecycle, cost
  - activity.jsonl         → tool usage per session
  - usage-index.json       → token usage by model (today/week)
  - budgets.json           → budget limits and thresholds
  - session-*.json         → active/closed session metadata
  - token-guard-config.json → agent limits and budget config
  - teams/index.json       → team count
"""

import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

CLAUDE_DIR = Path.home() / ".claude"
HOOKS_STATE = CLAUDE_DIR / "hooks" / "session-state"
TERMINALS = CLAUDE_DIR / "terminals"
COST_DIR = CLAUDE_DIR / "cost"
TEAMS_DIR = CLAUDE_DIR / "teams"


def load_jsonl(path, max_records=5000):
    """Load JSONL or multi-line JSON file, skipping malformed entries."""
    records = []
    if not path.exists():
        return records
    with open(path) as f:
        content = f.read()

    # Try line-by-line first (true JSONL)
    for line in content.splitlines():
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            records.append(json.loads(line))
            if len(records) >= max_records:
                return records
        except json.JSONDecodeError:
            continue

    if records:
        return records

    # Fallback: split on "}\n{" boundaries (handles multi-line JSON objects)
    # Prepend { if file starts truncated
    chunks = content.split("}\n{")
    for i, chunk in enumerate(chunks):
        piece = chunk.strip()
        if not piece:
            continue
        # Re-add braces lost in split
        if not piece.startswith("{"):
            piece = "{" + piece
        if not piece.endswith("}"):
            piece = piece + "}"
        try:
            records.append(json.loads(piece))
            if len(records) >= max_records:
                return records
        except json.JSONDecodeError:
            continue

    return records


def load_json(path):
    """Load JSON file, return empty dict on failure."""
    if not path.exists():
        return {}
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}


def parse_ts(ts_str):
    """Parse ISO timestamp string to datetime."""
    if not ts_str:
        return None
    try:
        ts_str = ts_str.replace("Z", "+00:00")
        return datetime.fromisoformat(ts_str)
    except (ValueError, TypeError):
        return None


def agent_summary(metrics):
    """Summarize agent spawns and costs from agent-metrics.jsonl."""
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=now.weekday())

    spawns_today = 0
    spawns_week = 0
    spawns_total = 0
    cost_today = 0.0
    cost_week = 0.0
    cost_total = 0.0
    types_today = Counter()
    sessions_seen = set()

    for r in metrics:
        ts = parse_ts(r.get("ts"))
        if not ts:
            continue

        event = r.get("event", "")
        record_type = r.get("record_type", "")

        if event == "start" or (record_type == "lifecycle" and event == "start"):
            spawns_total += 1
            agent_type = r.get("agent_type", "unknown")
            session = r.get("session", r.get("session_key", ""))
            if session:
                sessions_seen.add(session)
            if ts >= today_start:
                spawns_today += 1
                types_today[agent_type] += 1
            if ts >= week_start:
                spawns_week += 1

        if record_type == "usage":
            cost = r.get("cost_usd", 0.0)
            cost_total += cost
            if ts >= today_start:
                cost_today += cost
            if ts >= week_start:
                cost_week += cost

    return {
        "spawns_today": spawns_today,
        "spawns_week": spawns_week,
        "spawns_total": spawns_total,
        "cost_today": cost_today,
        "cost_week": cost_week,
        "cost_total": cost_total,
        "types_today": dict(types_today.most_common(10)),
        "sessions_seen": len(sessions_seen),
    }


def tool_usage(activity):
    """Summarize tool usage from activity.jsonl."""
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    tools_today = Counter()
    tools_total = Counter()
    sessions_today = set()

    for r in activity:
        ts = parse_ts(r.get("ts"))
        tool = r.get("tool", "")
        session = r.get("session", "")
        if not tool:
            continue
        tools_total[tool] += 1
        if ts and ts >= today_start:
            tools_today[tool] += 1
            if session:
                sessions_today.add(session)

    return {
        "tools_today": dict(tools_today.most_common(10)),
        "tools_total": dict(tools_total.most_common(10)),
        "sessions_today": len(sessions_today),
        "total_ops": sum(tools_total.values()),
    }


def session_summary():
    """Summarize sessions from terminals/session-*.json."""
    active = 0
    closed = 0
    total_turns = 0
    files_touched = set()

    for f in TERMINALS.glob("session-*.json"):
        data = load_json(f)
        status = data.get("status", "unknown")
        if status == "active":
            active += 1
        else:
            closed += 1
        total_turns += data.get("turn_count", 0)
        for ft in data.get("files_touched", []):
            files_touched.add(ft)

    return {
        "active": active,
        "closed": closed,
        "total": active + closed,
        "total_turns": total_turns,
        "unique_files": len(files_touched),
    }


def token_summary():
    """Summarize token usage from usage-index.json."""
    data = load_json(COST_DIR / "usage-index.json")
    windows = data.get("windows", {})
    today = windows.get("today", {})
    local = today.get("local", {})
    totals = local.get("totals", {})
    models = local.get("models", {})

    model_summary = {}
    for model, stats in models.items():
        if model == "<synthetic>":
            continue
        msgs = stats.get("messages", 0)
        if msgs > 0:
            model_summary[model] = {
                "messages": msgs,
                "input": stats.get("inputTokens", 0),
                "output": stats.get("outputTokens", 0),
                "cache_read": stats.get("cacheReadTokens", 0),
                "cache_create": stats.get("cacheCreationTokens", 0),
            }

    return {
        "total_messages": totals.get("messages", 0),
        "input_tokens": totals.get("inputTokens", 0),
        "output_tokens": totals.get("outputTokens", 0),
        "cache_read": totals.get("cacheReadTokens", 0),
        "cache_create": totals.get("cacheCreationTokens", 0),
        "models": model_summary,
    }


def budget_summary():
    """Summarize budget config and guard settings."""
    budgets = load_json(COST_DIR / "budgets.json")
    guard_cfg = load_json(CLAUDE_DIR / "hooks" / "token-guard-config.json")

    global_budget = budgets.get("global", {})
    budget_guard = guard_cfg.get("budget_guard", {})

    return {
        "daily_limit": global_budget.get("dailyUSD", 0),
        "monthly_limit": budget_guard.get("monthly_usd", 0),
        "max_agents_per_session": guard_cfg.get("max_agents", "?"),
        "warn_pct": budgets.get("thresholds", {}).get("warnPct", 80),
        "crit_pct": budgets.get("thresholds", {}).get("critPct", 95),
    }


def team_summary():
    """Count teams."""
    idx = load_json(TEAMS_DIR / "index.json")
    teams = idx.get("teams", [])
    return {"count": len(teams), "names": [t.get("name", "?") for t in teams]}


def disk_summary():
    """Quick disk usage of key dirs."""
    dirs = ["debug", "projects", "plugins", "hooks", "teams", "terminals",
            "cost", "scripts", "mcp-coordinator", "telemetry"]
    result = {}
    for d in dirs:
        p = CLAUDE_DIR / d
        if p.exists():
            total = sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
            if total > 1_000_000:
                result[d] = f"{total / 1_000_000:.1f} MB"
            elif total > 1_000:
                result[d] = f"{total / 1_000:.0f} KB"
            else:
                result[d] = f"{total} B"
    return result


def fmt_tokens(n):
    """Format token count with K/M suffix."""
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n/1_000:.1f}K"
    return str(n)


def render(agents, tools, sessions, tokens, budget, teams, disk):
    """Render dashboard as markdown."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = []
    lines.append(f"# System Health — {now}")
    lines.append("")

    # Sessions
    lines.append("## Sessions")
    lines.append(f"| Metric | Value |")
    lines.append(f"|--------|-------|")
    lines.append(f"| Active | {sessions['active']} |")
    lines.append(f"| Closed | {sessions['closed']} |")
    lines.append(f"| Total turns | {sessions['total_turns']} |")
    lines.append(f"| Unique files touched | {sessions['unique_files']} |")
    lines.append("")

    # Agents
    lines.append("## Agents")
    lines.append(f"| Metric | Today | This Week | All Time |")
    lines.append(f"|--------|-------|-----------|----------|")
    lines.append(f"| Spawns | {agents['spawns_today']} | {agents['spawns_week']} | {agents['spawns_total']} |")
    lines.append(f"| Cost (USD) | ${agents['cost_today']:.2f} | ${agents['cost_week']:.2f} | ${agents['cost_total']:.2f} |")
    if agents["types_today"]:
        lines.append("")
        lines.append("Agent types today: " + ", ".join(
            f"{t} ({c})" for t, c in agents["types_today"].items()
        ))
    lines.append("")

    # Token Usage
    lines.append("## Token Usage (Today)")
    lines.append(f"| Metric | Value |")
    lines.append(f"|--------|-------|")
    lines.append(f"| Messages | {tokens['total_messages']} |")
    lines.append(f"| Input | {fmt_tokens(tokens['input_tokens'])} |")
    lines.append(f"| Output | {fmt_tokens(tokens['output_tokens'])} |")
    lines.append(f"| Cache read | {fmt_tokens(tokens['cache_read'])} |")
    lines.append(f"| Cache create | {fmt_tokens(tokens['cache_create'])} |")
    lines.append("")
    if tokens["models"]:
        lines.append("### By Model")
        lines.append("| Model | Messages | Input | Output | Cache Read |")
        lines.append("|-------|----------|-------|--------|------------|")
        for model, stats in sorted(tokens["models"].items(), key=lambda x: -x[1]["messages"]):
            short_model = model.replace("claude-", "").replace("-20250929", "")
            lines.append(
                f"| {short_model} | {stats['messages']} | "
                f"{fmt_tokens(stats['input'])} | {fmt_tokens(stats['output'])} | "
                f"{fmt_tokens(stats['cache_read'])} |"
            )
        lines.append("")

    # Tool Usage
    lines.append("## Tool Usage (Today)")
    if tools["tools_today"]:
        lines.append("| Tool | Count |")
        lines.append("|------|-------|")
        for tool, count in tools["tools_today"].items():
            lines.append(f"| {tool} | {count} |")
    else:
        lines.append("No tool usage recorded today.")
    lines.append("")

    # Budget
    lines.append("## Budget & Limits")
    lines.append(f"| Setting | Value |")
    lines.append(f"|---------|-------|")
    lines.append(f"| Daily limit | ${budget['daily_limit']:.2f} |")
    lines.append(f"| Monthly limit | ${budget['monthly_limit']:.2f} |")
    lines.append(f"| Max agents/session | {budget['max_agents_per_session']} |")
    lines.append(f"| Warning threshold | {budget['warn_pct']}% |")
    lines.append(f"| Critical threshold | {budget['crit_pct']}% |")
    lines.append("")

    # Teams
    lines.append("## Teams")
    lines.append(f"Active teams: {teams['count']}")
    if teams["names"]:
        lines.append(f"Names: {', '.join(teams['names'])}")
    lines.append("")

    # Disk
    lines.append("## Disk Usage")
    lines.append("| Directory | Size |")
    lines.append("|-----------|------|")
    for d, size in sorted(disk.items(), key=lambda x: -float(x[1].split()[0]) if "MB" in x[1] else 0):
        lines.append(f"| {d}/ | {size} |")
    lines.append("")

    return "\n".join(lines)


def main():
    metrics = load_jsonl(HOOKS_STATE / "agent-metrics.jsonl")
    activity = load_jsonl(TERMINALS / "activity.jsonl")

    agents = agent_summary(metrics)
    tools = tool_usage(activity)
    sessions = session_summary()
    tokens = token_summary()
    budget = budget_summary()
    teams = team_summary()
    disk = disk_summary()

    output = render(agents, tools, sessions, tokens, budget, teams, disk)
    print(output)


if __name__ == "__main__":
    main()
