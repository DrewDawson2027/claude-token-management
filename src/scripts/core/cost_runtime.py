#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import os
import subprocess
import sys
import time
import cost_data as _cost_data
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, TypedDict
from cost_base import parse_ts_dt as parse_ts, read_json, safe_id, utc_now, write_json

try:
    from pricing import calculate_cost_from_usage as _pricing_calc
except ImportError:
    _pricing_calc = None  # pricing module not available; cost_usd stays None

# ── Typed contracts for key return types ─────────────────────────────────────
# Prevents key-name mismatches at development time. Functions below annotate
# their return types; callers can rely on these shapes without reading the body.


class BudgetStatus(TypedDict):
    scope: str
    period: str
    limitUSD: float
    currentUSD: float | None
    pct: float | None
    level: str  # ok | warning | critical | none


class UsageTotals(TypedDict):
    totalUSD: float | None
    localCostUSD: float | None
    inputTokens: int
    outputTokens: int
    cacheCreationTokens: int
    cacheReadTokens: int
    messages: int


class SummaryResult(TypedDict):
    generatedAt: str
    window: str
    source: str  # hybrid | local
    totals: UsageTotals
    budget: BudgetStatus

CLAUDE = _cost_data.CLAUDE
COST_DIR = _cost_data.COST_DIR
PROJECTS_DIR = _cost_data.PROJECTS_DIR
TEAMS_DIR = _cost_data.TEAMS_DIR
TERMINALS_DIR = _cost_data.TERMINALS_DIR
REPORTS_DIR = _cost_data.REPORTS_DIR
CONFIG_FILE = _cost_data.CONFIG_FILE
BUDGETS_FILE = _cost_data.BUDGETS_FILE
CACHE_FILE = _cost_data.CACHE_FILE
USAGE_INDEX_FILE = _cost_data.USAGE_INDEX_FILE
PRICING_CACHE_FILE = _cost_data.PRICING_CACHE_FILE
STATUSLINE_CACHE_FILE = _cost_data.STATUSLINE_CACHE_FILE


def load_or_init_files() -> None:
    _cost_data.ensure_cost_files()


@dataclass
class UsageRecord:
    ts: datetime
    session_id: str | None
    agent_id: str | None
    model: str | None
    project_path: str | None
    project_name: str | None
    message_type: str | None
    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: int
    cache_read_input_tokens: int
    cost_usd: float | None
    raw: dict[str, Any]


def _int(v: Any) -> int:
    try:
        return int(v or 0)
    except Exception:
        return 0


def _float(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except Exception:
        return None


def iter_usage_records(since_hint: datetime | None = None) -> list[UsageRecord]:
    return _cost_data.iter_usage_records(since_hint)


def team_membership_maps() -> tuple[
    dict[str, str], dict[str, str], dict[str, dict[str, str]]
]:
    return _cost_data.team_membership_maps()


def project_usage_fingerprint() -> dict[str, Any]:
    return _cost_data.project_usage_fingerprint()


def load_usage_index() -> dict[str, Any]:
    return _cost_data.load_usage_index()


def _summary_index_eligible(
    window: str,
    since: str | None,
    until: str | None,
    team_id: str | None,
    session_id: str | None,
    project: str | None,
    breakdown: bool,
) -> bool:
    return (
        window in {"today", "week", "month"}
        and not since
        and not until
        and not team_id
        and not session_id
        and not project
        and not breakdown
    )


def in_window(ts: datetime, since: datetime | None, until: datetime | None) -> bool:
    return _cost_data.in_window(ts, since, until)


def parse_window(
    window: str, since: str | None, until: str | None
) -> tuple[datetime | None, datetime | None]:
    return _cost_data.parse_window(window, since, until)


def aggregate_local(
    records: list[UsageRecord],
    *,
    team_id: str | None = None,
    session_id: str | None = None,
    project: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
) -> dict[str, Any]:
    s2t, s2m, _ = team_membership_maps()
    totals = {
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheCreationTokens": 0,
        "cacheReadTokens": 0,
        "localCostUSD": 0.0,
        "localCostKnown": True,
        "messages": 0,
    }
    models: dict[str, dict[str, Any]] = {}
    sessions: dict[str, dict[str, Any]] = {}
    teams: dict[str, dict[str, Any]] = {}
    members: dict[str, dict[str, Any]] = {}
    filtered = 0
    for r in records:
        if not in_window(r.ts, since, until):
            continue
        sid = (r.session_id or "")[:8] or None
        r_team = s2t.get(sid or "") if sid else None
        r_member = s2m.get(sid or "") if sid and r_team else None
        if team_id and r_team != team_id:
            continue
        if session_id and sid != session_id[:8]:
            continue
        if (
            project
            and (r.project_name or "").lower() != project.lower()
            and (r.project_path or "").lower() != project.lower()
        ):
            continue
        filtered += 1
        totals["messages"] += 1
        totals["inputTokens"] += r.input_tokens
        totals["outputTokens"] += r.output_tokens
        totals["cacheCreationTokens"] += r.cache_creation_input_tokens
        totals["cacheReadTokens"] += r.cache_read_input_tokens
        if r.cost_usd is not None:
            totals["localCostUSD"] += r.cost_usd
        else:
            totals["localCostKnown"] = False
        mk = r.model or "unknown"
        m = models.setdefault(
            mk,
            {
                "messages": 0,
                "inputTokens": 0,
                "outputTokens": 0,
                "cacheCreationTokens": 0,
                "cacheReadTokens": 0,
                "localCostUSD": 0.0,
                "localCostKnown": True,
            },
        )
        m["messages"] += 1
        m["inputTokens"] += r.input_tokens
        m["outputTokens"] += r.output_tokens
        m["cacheCreationTokens"] += r.cache_creation_input_tokens
        m["cacheReadTokens"] += r.cache_read_input_tokens
        if r.cost_usd is not None:
            m["localCostUSD"] += r.cost_usd
        else:
            m["localCostKnown"] = False
        if sid:
            s = sessions.setdefault(
                sid,
                {
                    "messages": 0,
                    "modelSet": set(),
                    "inputTokens": 0,
                    "outputTokens": 0,
                    "cacheCreationTokens": 0,
                    "cacheReadTokens": 0,
                    "teamId": r_team,
                    "memberId": r_member,
                },
            )
            s["messages"] += 1
            s["modelSet"].add(mk)
            s["inputTokens"] += r.input_tokens
            s["outputTokens"] += r.output_tokens
            s["cacheCreationTokens"] += r.cache_creation_input_tokens
            s["cacheReadTokens"] += r.cache_read_input_tokens
        if r_team:
            t = teams.setdefault(
                r_team,
                {
                    "messages": 0,
                    "inputTokens": 0,
                    "outputTokens": 0,
                    "cacheCreationTokens": 0,
                    "cacheReadTokens": 0,
                },
            )
            t["messages"] += 1
            t["inputTokens"] += r.input_tokens
            t["outputTokens"] += r.output_tokens
            t["cacheCreationTokens"] += r.cache_creation_input_tokens
            t["cacheReadTokens"] += r.cache_read_input_tokens
        if r_team and r_member:
            key = f"{r_team}:{r_member}"
            mm = members.setdefault(
                key,
                {
                    "teamId": r_team,
                    "memberId": r_member,
                    "messages": 0,
                    "inputTokens": 0,
                    "outputTokens": 0,
                },
            )
            mm["messages"] += 1
            mm["inputTokens"] += r.input_tokens
            mm["outputTokens"] += r.output_tokens

    for s in sessions.values():
        s["models"] = sorted(s.pop("modelSet"))

    return {
        "source": "local",
        "filteredMessages": filtered,
        "totals": totals,
        "models": models,
        "sessions": sessions,
        "teams": teams,
        "members": members,
    }


def run_ccusage(args: list[str], timeout_sec: int = 10) -> tuple[bool, str, Any | None]:
    ok, text, parsed = _cost_data.run_ccusage(args, timeout_sec=timeout_sec)
    return ok, text, parsed


def _find_numeric_fields(obj: Any, acc: dict[str, list[float]], path: str = "") -> None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = f"{path}.{k}" if path else k
            if isinstance(v, (int, float)):
                acc.setdefault(k, []).append(float(v))
                acc.setdefault(p, []).append(float(v))
            else:
                _find_numeric_fields(v, acc, p)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _find_numeric_fields(v, acc, f"{path}[{i}]")


def extract_ccusage_summary(parsed: Any) -> dict[str, Any]:
    return _cost_data.extract_ccusage_summary(parsed)


def budgets() -> dict[str, Any]:
    load_or_init_files()
    return read_json(BUDGETS_FILE, {}) or {}


def compute_budget_status(
    *,
    amount_usd: float | None,
    team_id: str | None = None,
    project: str | None = None,
    period: str = "daily",
) -> BudgetStatus:
    b = budgets()
    key = {"daily": "dailyUSD", "weekly": "weeklyUSD", "monthly": "monthlyUSD"}[period]
    threshold = b.get("thresholds", {"warnPct": 80, "critPct": 95})
    limit = None
    scope = "global"
    if team_id:
        limit = ((b.get("teams") or {}).get(team_id) or {}).get(key)
        if limit:
            scope = f"team:{team_id}"
    if project and not limit:
        limit = ((b.get("projects") or {}).get(project) or {}).get(key)
        if limit:
            scope = f"project:{project}"
    if not limit:
        limit = (b.get("global") or {}).get(key) or 0
    if not limit or amount_usd is None:
        return {
            "scope": scope,
            "period": period,
            "limitUSD": limit or 0,
            "currentUSD": amount_usd,
            "pct": None,
            "level": "none",
        }
    pct = (amount_usd / float(limit)) * 100.0 if limit else None
    level = "ok"
    if pct is not None and pct >= float(threshold.get("critPct", 95)):
        level = "critical"
    elif pct is not None and pct >= float(threshold.get("warnPct", 80)):
        level = "warning"
    return {
        "scope": scope,
        "period": period,
        "limitUSD": float(limit),
        "currentUSD": float(amount_usd),
        "pct": round(pct or 0, 2),
        "level": level,
    }


def summarize(
    window: str,
    since: str | None,
    until: str | None,
    team_id: str | None,
    session_id: str | None,
    project: str | None,
    mode: str | None,
    breakdown: bool,
    *,
    use_index: bool = True,
) -> dict[str, Any]:
    load_or_init_files()
    if use_index and _summary_index_eligible(
        window, since, until, team_id, session_id, project, breakdown
    ):
        idx = load_usage_index()
        if idx.get("fingerprint") == project_usage_fingerprint():
            cached = (idx.get("windows") or {}).get(window)
            if isinstance(cached, dict):
                return cached
    sdt, udt = parse_window(window, since, until)
    recs = iter_usage_records(sdt)
    local = aggregate_local(
        recs,
        team_id=team_id,
        session_id=session_id,
        project=project,
        since=sdt,
        until=udt,
    )

    cfg = read_json(CONFIG_FILE, {}) or {}
    offline = bool(cfg.get("offlineDefault", True))
    cc_cmd = "daily"
    cc_args = [cc_cmd, "--json"]
    if offline:
        cc_args.append("--offline")
    # limit query range when possible
    if sdt:
        cc_args += ["--since", sdt.strftime("%Y%m%d")]
    if udt:
        cc_args += ["--until", udt.strftime("%Y%m%d")]
    if project:
        cc_args += ["--project", project]
    ok, cc_text, cc_parsed = run_ccusage(
        cc_args, timeout_sec=int((cfg.get("timeouts") or {}).get("ccusageSeconds", 10))
    )
    cc_summary = (
        extract_ccusage_summary(cc_parsed)
        if cc_parsed is not None
        else {"totalUSD": None, "raw": None}
    )

    total_usd = cc_summary.get("totalUSD")
    local_usd = (
        local["totals"]["localCostUSD"] if local["totals"]["localCostKnown"] else None
    )
    provenance = "hybrid" if ok else "local"
    budget = compute_budget_status(
        amount_usd=total_usd if total_usd is not None else local_usd,
        team_id=team_id,
        project=project,
        period="daily"
        if window in {"today", "active_block"}
        else ("weekly" if window == "week" else "monthly"),
    )

    result = {
        "generatedAt": utc_now(),
        "window": window,
        "filters": {
            "since": since,
            "until": until,
            "team_id": team_id,
            "session_id": session_id,
            "project": project,
        },
        "source": provenance,
        "ccusage": {
            "ok": ok,
            "summary": cc_summary if ok else None,
            "error": None if ok else cc_text,
        },
        "local": local,
        "totals": {
            "totalUSD": total_usd,
            "localCostUSD": local_usd,
            "inputTokens": local["totals"]["inputTokens"],
            "outputTokens": local["totals"]["outputTokens"],
            "cacheCreationTokens": local["totals"]["cacheCreationTokens"],
            "cacheReadTokens": local["totals"]["cacheReadTokens"],
            "messages": local["totals"]["messages"],
        },
        "budget": budget,
    }
    cache = read_json(CACHE_FILE, {"windows": {}}) or {"windows": {}}
    cache["generatedAt"] = result["generatedAt"]
    cache["source"] = result["source"]
    key = (
        window
        if not team_id and not session_id and not project
        else f"{window}|team={team_id or ''}|session={session_id or ''}|project={project or ''}"
    )
    cache.setdefault("windows", {})[key] = result
    write_json(CACHE_FILE, cache)
    return result


def refresh_usage_index_cache(force: bool = False) -> dict[str, Any]:
    load_or_init_files()
    fp = project_usage_fingerprint()
    idx = load_usage_index()
    if (
        not force
        and idx.get("fingerprint") == fp
        and isinstance(idx.get("windows"), dict)
        and all(k in idx.get("windows", {}) for k in ("today", "week", "month"))
    ):
        return idx
    windows: dict[str, Any] = {}
    for w in ("today", "week", "month"):
        windows[w] = summarize(
            w, None, None, None, None, None, None, False, use_index=False
        )
        windows[w]["source"] = str(windows[w].get("source") or "local") + "+indexed"
    idx = {"generatedAt": utc_now(), "fingerprint": fp, "windows": windows}
    write_json(USAGE_INDEX_FILE, idx)
    return idx


def _burn_rate_projection(
    today_res: dict[str, Any], active_block_res: dict[str, Any]
) -> dict[str, Any]:
    t_total = (today_res.get("totals") or {}).get("totalUSD")
    if t_total is None:
        t_total = (today_res.get("totals") or {}).get("localCostUSD")
    ab_total = (active_block_res.get("totals") or {}).get("totalUSD")
    if ab_total is None:
        ab_total = (active_block_res.get("totals") or {}).get("localCostUSD")
    rate = None
    projected = None
    if ab_total is not None:
        rate = float(ab_total) / 5.0
        projected = rate * 24.0
    return {
        "todayUSD": t_total,
        "activeBlockUSD": ab_total,
        "hourlyUSD": rate,
        "projectedDailyUSD": projected,
    }


def format_money(v: float | None) -> str:
    return "n/a" if v is None else f"${v:,.2f}"


def render_summary(res: dict[str, Any], breakdown: bool = False) -> str:
    t = res["totals"]
    lines = [
        f"## Cost Summary ({res['window']})",
        f"- Source: {res['source']}",
        f"- Total Cost: {format_money(t.get('totalUSD'))} (local-known: {format_money(t.get('localCostUSD'))})",
        f"- Tokens: in={t['inputTokens']:,} out={t['outputTokens']:,} cache_create={t['cacheCreationTokens']:,} cache_read={t['cacheReadTokens']:,}",
        f"- Messages: {t['messages']:,}",
    ]
    b = res.get("budget") or {}
    if b.get("limitUSD"):
        lines.append(
            f"- Budget ({b.get('scope')} {b.get('period')}): {format_money(b.get('currentUSD'))} / {format_money(b.get('limitUSD'))} [{b.get('level')}] ({b.get('pct')}%)"
        )
    elif b.get("level") != "none":
        lines.append(f"- Budget: {b}")
    if breakdown:
        models = res.get("local", {}).get("models", {})
        if models:
            lines.append("\n### Models (local token breakdown)")
            for model, m in sorted(
                models.items(),
                key=lambda kv: (
                    kv[1].get("inputTokens", 0) + kv[1].get("outputTokens", 0)
                ),
                reverse=True,
            )[:20]:
                lines.append(
                    f"- {model}: msgs={m['messages']} in={m['inputTokens']:,} out={m['outputTokens']:,}"
                )
        teams = res.get("local", {}).get("teams", {})
        if teams:
            lines.append("\n### Teams (local token breakdown)")
            for team, m in sorted(
                teams.items(),
                key=lambda kv: (
                    kv[1].get("inputTokens", 0) + kv[1].get("outputTokens", 0)
                ),
                reverse=True,
            )[:20]:
                lines.append(
                    f"- {team}: msgs={m['messages']} in={m['inputTokens']:,} out={m['outputTokens']:,}"
                )
    return "\n".join(lines)


def cmd_summary(args: argparse.Namespace) -> int:
    res = summarize(
        args.window,
        args.since,
        args.until,
        args.team_id,
        args.session_id,
        args.project,
        args.mode,
        args.breakdown,
    )
    if args.json:
        print(json.dumps(res, indent=2))
    else:
        print(render_summary(res, breakdown=args.breakdown))
    return 0


def cmd_session(args: argparse.Namespace) -> int:
    sid = safe_id(args.session_id[:8], "session_id")
    res = summarize(args.window, args.since, args.until, None, sid, None, None, True)
    if args.json:
        print(json.dumps(res, indent=2))
    else:
        print(render_summary(res, breakdown=True))
    return 0


def cmd_team(args: argparse.Namespace) -> int:
    team_id = safe_id(args.team_id, "team_id")
    res = summarize(
        args.window, args.since, args.until, team_id, None, None, None, True
    )
    if args.json:
        print(json.dumps(res, indent=2))
    else:
        print(render_summary(res, breakdown=True))
        if args.include_members:
            members = res.get("local", {}).get("members", {})
            if members:
                print("\n### Members")
                for k, v in sorted(members.items()):
                    print(
                        f"- {k}: msgs={v['messages']} in={v['inputTokens']:,} out={v['outputTokens']:,}"
                    )
    return 0


def cmd_active_block(args: argparse.Namespace) -> int:
    res = summarize(
        "active_block", None, None, args.team_id, None, args.project, None, True
    )
    if args.json:
        print(json.dumps(res, indent=2))
    else:
        print(render_summary(res, breakdown=True))
    return 0


def cmd_statusline(args: argparse.Namespace) -> int:
    cfg = read_json(CONFIG_FILE, {}) or {}
    offline = (
        args.offline
        if args.offline is not None
        else bool(cfg.get("offlineDefault", True))
    )
    csrc = args.cost_source or str(cfg.get("costSourceDefault", "both"))
    cc_args = ["statusline", "--cost-source", csrc]
    if offline:
        cc_args.append("--offline")
    ok, text, _ = run_ccusage(
        cc_args,
        timeout_sec=int((cfg.get("timeouts") or {}).get("statuslineSeconds", 4)),
    )
    if ok and text:
        print(text)
        return 0
    # Fallback local compact line
    res = summarize(
        "today", None, None, args.team_id, args.session_id, args.project, None, False
    )
    b = res.get("budget") or {}
    level = (b.get("level") or "none").upper()
    print(
        f"COST today={format_money(res['totals'].get('totalUSD') or res['totals'].get('localCostUSD'))} in={res['totals']['inputTokens']:,} out={res['totals']['outputTokens']:,} budget={level}"
    )
    return 0


def cmd_hook_statusline(args: argparse.Namespace) -> int:
    load_or_init_files()
    cfg = read_json(CONFIG_FILE, {}) or {}
    scfg = cfg.get("statusline") or {}
    cooldown = int(scfg.get("hookCooldownSeconds", 30))
    show_only_on_change = bool(scfg.get("showOnlyOnChange", True))
    cache = read_json(STATUSLINE_CACHE_FILE, {}) or {}
    now = time.time()
    last_ts = float(cache.get("ts") or 0)
    if now - last_ts < cooldown:
        return 0
    # Build line
    cmd = ["python3", str(Path(__file__)), "statusline"]
    if args.team_id:
        cmd += ["--team-id", args.team_id]
    if args.session_id:
        cmd += ["--session-id", args.session_id]
    cp = subprocess.run(cmd, capture_output=True, text=True)
    line = (cp.stdout or "").strip()
    if not line:
        return 0
    if show_only_on_change and cache.get("line") == line:
        cache["ts"] = now
        write_json(STATUSLINE_CACHE_FILE, cache)
        return 0
    print(f"--- COST STATUSLINE ---\n{line}\n--- END COST STATUSLINE ---")
    write_json(STATUSLINE_CACHE_FILE, {"ts": now, "line": line})
    return 0


def cmd_budget_status(args: argparse.Namespace) -> int:
    period = args.period
    res = summarize(
        {"daily": "today", "weekly": "week", "monthly": "month"}[period],
        None,
        None,
        args.team_id,
        None,
        args.project,
        None,
        False,
    )
    b = compute_budget_status(
        amount_usd=res["totals"].get("totalUSD") or res["totals"].get("localCostUSD"),
        team_id=args.team_id,
        project=args.project,
        period=period,
    )
    if args.json:
        print(json.dumps(b, indent=2))
    else:
        print(
            f"Budget {b['scope']} {b['period']}: current={format_money(b.get('currentUSD'))} limit={format_money(b.get('limitUSD'))} level={b.get('level')} pct={b.get('pct')}"
        )
    return 0


def cmd_set_budget(args: argparse.Namespace) -> int:
    b = budgets()
    period_key = {"daily": "dailyUSD", "weekly": "weeklyUSD", "monthly": "monthlyUSD"}[
        args.period
    ]
    if args.scope == "global":
        b.setdefault("global", {})[period_key] = float(args.amount_usd)
    elif args.scope == "team":
        team_id = safe_id(args.team_id, "team_id")
        b.setdefault("teams", {}).setdefault(team_id, {})[period_key] = float(
            args.amount_usd
        )
    elif args.scope == "project":
        if not args.project:
            raise SystemExit("--project required for project scope")
        b.setdefault("projects", {}).setdefault(args.project, {})[period_key] = float(
            args.amount_usd
        )
    write_json(BUDGETS_FILE, b)
    print(
        f"Updated budget: scope={args.scope} period={args.period} amount={args.amount_usd}"
    )
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    res = summarize(
        args.window,
        args.since,
        args.until,
        args.team_id,
        args.session_id,
        args.project,
        None,
        True,
    )
    fmt = args.format
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_path = REPORTS_DIR / f"cost-export-{ts}.{fmt}"
    if fmt == "json":
        write_json(out_path, res)
    elif fmt == "md":
        out_path.write_text(render_summary(res, breakdown=True) + "\n")
    elif fmt == "csv":
        with out_path.open("w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["scope", "id", "messages", "inputTokens", "outputTokens"])
            for sid, v in (res.get("local", {}).get("sessions", {}) or {}).items():
                w.writerow(
                    [
                        "session",
                        sid,
                        v.get("messages", 0),
                        v.get("inputTokens", 0),
                        v.get("outputTokens", 0),
                    ]
                )
            for tid, v in (res.get("local", {}).get("teams", {}) or {}).items():
                w.writerow(
                    [
                        "team",
                        tid,
                        v.get("messages", 0),
                        v.get("inputTokens", 0),
                        v.get("outputTokens", 0),
                    ]
                )
    print(f"Exported {fmt}: {out_path}")
    return 0


def cmd_index_refresh(args: argparse.Namespace) -> int:
    idx = refresh_usage_index_cache(force=bool(args.force))
    if args.json:
        print(json.dumps(idx, indent=2))
    else:
        fp = idx.get("fingerprint") or {}
        print(
            "Refreshed usage index: "
            f"generatedAt={idx.get('generatedAt')} "
            f"files={fp.get('fileCount')} size={fp.get('totalSize')} latestMtime={fp.get('latestMtime')}"
        )
    return 0


def _preset_from_budget_pct(
    pct: float | None, *, no_budget_preset: str = "standard"
) -> str:
    if pct is None:
        return no_budget_preset
    if pct <= 40:
        return "heavy"
    if pct <= 75:
        return "standard"
    return "lite"


def _compute_recommendation_confidence(
    today_res: dict, cache_doc: dict | None = None
) -> float:
    """Compute confidence score 0.0-1.0 for budget recommendation."""
    score = 0.5  # baseline
    totals = today_res.get("totals", {})
    messages = totals.get("messages", 0)
    if messages >= 50:
        score += 0.2
    elif messages >= 10:
        score += 0.1
    source = today_res.get("source", "")
    if "hybrid" in str(source):
        score += 0.2
    elif "local" in str(source):
        score += 0.05
    if cache_doc:
        gen = cache_doc.get("generatedAt", "")
        if gen:
            try:
                from datetime import datetime, timezone

                age_sec = (
                    datetime.now(timezone.utc)
                    - datetime.fromisoformat(gen.replace("Z", "+00:00"))
                ).total_seconds()
                if age_sec < 300:
                    score += 0.1
            except Exception:
                pass
    return min(1.0, round(score, 2))


def cmd_team_budget_recommend(args: argparse.Namespace) -> int:
    refresh_usage_index_cache(force=False)
    team_id = args.team_id
    bdoc = budgets()
    team_has_budget = bool(
        team_id and (((bdoc.get("teams") or {}).get(team_id) or {}).get("dailyUSD"))
    )
    today = summarize(
        "today",
        None,
        None,
        team_id if team_has_budget else None,
        None,
        args.project,
        None,
        False,
    )
    active_block = summarize(
        "active_block",
        None,
        None,
        team_id if team_has_budget else None,
        None,
        args.project,
        None,
        False,
        use_index=False,
    )
    budget = today.get("budget") or {}
    projection = _burn_rate_projection(today, active_block)
    preset = _preset_from_budget_pct(budget.get("pct"))
    burn_alert = None
    proj = projection.get("projectedDailyUSD")
    lim = budget.get("limitUSD")
    if proj is not None and lim:
        if float(proj) >= float(lim):
            burn_alert = f"Projected daily burn {proj:.2f} exceeds cap {float(lim):.2f}"
    # Confidence scoring
    cache_doc = read_json(CACHE_FILE, None)
    confidence = _compute_recommendation_confidence(today, cache_doc)
    # Alternatives with rationale
    hourly = projection.get("hourlyUSD")
    alternatives = []
    for p_name, desc in [
        ("lite", "Minimal parallelism, lowest cost"),
        ("standard", "Balanced parallelism and cost"),
        ("heavy", "Maximum parallelism, highest cost"),
    ]:
        mult = {"lite": 0.5, "standard": 1.0, "heavy": 2.0}[p_name]
        est_daily = round(float(hourly or 0) * 24.0 * mult, 2) if hourly else None
        alternatives.append(
            {"preset": p_name, "reason": desc, "estimatedDailyUSD": est_daily}
        )
    # Rationale
    pct = budget.get("pct")
    if pct is not None:
        rationale = f"At {pct:.1f}% of daily budget ({format_money(budget.get('currentUSD'))} / {format_money(lim)}), '{preset}' optimizes cost vs productivity."
    else:
        rationale = "No budget configured. Defaulting to standard preset."
    out = {
        "generatedAt": utc_now(),
        "team_id": team_id,
        "project": args.project,
        "scope": budget.get("scope"),
        "period": budget.get("period"),
        "budget": budget,
        "projection": projection,
        "recommendedPreset": preset,
        "reason": "budget_pct" if pct is not None else "no_budget_configured",
        "burnRateAlert": burn_alert,
        "confidence": confidence,
        "alternatives": alternatives,
        "rationale": rationale,
    }
    if args.json:
        print(json.dumps(out, indent=2))
    else:
        print(
            f"Recommended preset: {preset} (confidence: {confidence})\n"
            f"- Rationale: {rationale}\n"
            f"- Scope: {out.get('scope')} period={out.get('period')}\n"
            f"- Budget pct: {pct}\n"
            f"- Today's cost: {projection.get('todayUSD')}\n"
            f"- Active-block hourly burn: {projection.get('hourlyUSD')}\n"
            f"- Projected daily burn: {projection.get('projectedDailyUSD')}\n"
            f"- Alert: {burn_alert or 'none'}\n"
            f"- Alternatives: {', '.join(a['preset'] + '(~' + format_money(a.get('estimatedDailyUSD')) + '/d)' for a in alternatives)}"
        )
    return 0


def cmd_burn_rate_check(args: argparse.Namespace) -> int:
    refresh_usage_index_cache(force=False)
    team_id = getattr(args, "team_id", None)
    project = getattr(args, "project", None)
    today = summarize("today", None, None, team_id, None, project, None, False)
    active_block = summarize(
        "active_block", None, None, team_id, None, project, None, False, use_index=False
    )
    projection = _burn_rate_projection(today, active_block)
    budget = today.get("budget") or {}
    limit_usd = budget.get("limitUSD")
    proj_daily = projection.get("projectedDailyUSD")
    alert = False
    message = "No alert"
    hours_to_exhaustion = None
    if proj_daily is not None and limit_usd and float(limit_usd) > 0:
        current = budget.get("currentUSD") or 0
        remaining = float(limit_usd) - float(current)
        hourly = projection.get("hourlyUSD")
        if hourly and float(hourly) > 0:
            hours_to_exhaustion = round(remaining / float(hourly), 1)
        if float(proj_daily) >= float(limit_usd):
            alert = True
            message = f"Budget exceeded in {hours_to_exhaustion or '?'}h at current rate (${proj_daily:.2f}/day vs ${float(limit_usd):.2f} cap)"
    out = {
        "alert": alert,
        "message": message,
        "projectedDailyUSD": proj_daily,
        "limitUSD": limit_usd,
        "currentUSD": budget.get("currentUSD"),
        "hoursToExhaustion": hours_to_exhaustion,
        "hourlyBurnUSD": projection.get("hourlyUSD"),
        "scope": budget.get("scope"),
    }
    if getattr(args, "json", False):
        print(json.dumps(out, indent=2))
    else:
        print(f"Burn-rate: {'ALERT' if alert else 'OK'} — {message}")
        if hours_to_exhaustion is not None:
            print(f"Hours to exhaustion: {hours_to_exhaustion}h")
    return 0


def cmd_anomaly_check(args: argparse.Namespace) -> int:
    team_id = getattr(args, "team_id", None)
    sensitivity = float(getattr(args, "sensitivity", None) or 2.0)
    # Build baseline from cached daily summaries
    idx = load_usage_index()
    windows = idx.get("windows", {})
    baselines: list[dict] = []
    for key in ["today", "week", "month"]:
        entry = windows.get(key)
        if isinstance(entry, dict) and entry.get("totals"):
            baselines.append(entry)
    if not baselines:
        out = {
            "anomalies": [],
            "message": "Insufficient baseline data for anomaly detection",
        }
        if getattr(args, "json", False):
            print(json.dumps(out, indent=2))
        else:
            print(out["message"])
        return 0
    # Current session metrics
    current = summarize(
        "active_block", None, None, team_id, None, None, None, False, use_index=False
    )
    ct = current.get("totals", {})
    # Baseline averages from weekly data (divide by 7 for daily, by 24 for hourly)
    week_entry = windows.get("week")
    baseline_totals = (week_entry or {}).get("totals", {}) if week_entry else {}
    avg_daily_msgs = (baseline_totals.get("messages", 0) or 0) / 7.0
    avg_daily_tokens = (
        (baseline_totals.get("inputTokens", 0) or 0)
        + (baseline_totals.get("outputTokens", 0) or 0)
    ) / 7.0
    avg_daily_cost = (
        baseline_totals.get("totalUSD") or baseline_totals.get("localCostUSD") or 0
    ) / 7.0
    # Current daily rates (from today's data)
    today_entry = windows.get("today", {})
    today_totals = (today_entry or {}).get("totals", {}) if today_entry else ct
    cur_msgs = today_totals.get("messages", 0) or 0
    cur_tokens = (today_totals.get("inputTokens", 0) or 0) + (
        today_totals.get("outputTokens", 0) or 0
    )
    cur_cost = today_totals.get("totalUSD") or today_totals.get("localCostUSD") or 0
    anomalies = []
    if avg_daily_msgs > 0 and cur_msgs > sensitivity * avg_daily_msgs:
        anomalies.append(
            {
                "type": "message_volume_spike",
                "current": cur_msgs,
                "baseline": round(avg_daily_msgs, 1),
                "ratio": round(cur_msgs / avg_daily_msgs, 2),
            }
        )
    if avg_daily_tokens > 0 and cur_tokens > sensitivity * avg_daily_tokens:
        anomalies.append(
            {
                "type": "token_usage_spike",
                "current": cur_tokens,
                "baseline": round(avg_daily_tokens, 1),
                "ratio": round(cur_tokens / avg_daily_tokens, 2),
            }
        )
    if avg_daily_cost > 0 and float(cur_cost) > sensitivity * avg_daily_cost:
        anomalies.append(
            {
                "type": "cost_delta_spike",
                "currentUSD": float(cur_cost),
                "baselineUSD": round(avg_daily_cost, 2),
                "ratio": round(float(cur_cost) / avg_daily_cost, 2),
            }
        )
    out = {
        "anomalies": anomalies,
        "anomalyCount": len(anomalies),
        "sensitivity": sensitivity,
        "baseline": {
            "dailyMessages": round(avg_daily_msgs, 1),
            "dailyTokens": round(avg_daily_tokens),
            "dailyCostUSD": round(avg_daily_cost, 2),
        },
        "current": {
            "messages": cur_msgs,
            "tokens": cur_tokens,
            "costUSD": float(cur_cost),
        },
    }
    if getattr(args, "json", False):
        print(json.dumps(out, indent=2))
    else:
        if anomalies:
            print(f"ANOMALIES DETECTED ({len(anomalies)}):")
            for a in anomalies:
                print(f"  - {a['type']}: {a.get('ratio', '?')}x baseline")
        else:
            print("No anomalies detected.")
    return 0


def cmd_spend_leaderboard(args: argparse.Namespace) -> int:
    window = getattr(args, "window", "today") or "today"
    group_by = getattr(args, "group_by", "session") or "session"
    limit = int(getattr(args, "limit", None) or 10)
    res = summarize(window, None, None, None, None, None, None, True)
    local = res.get("local", {})
    entries: list[dict] = []
    if group_by == "session":
        for sid, v in (local.get("sessions", {}) or {}).items():
            entries.append(
                {
                    "id": sid,
                    "group": "session",
                    "messages": v.get("messages", 0),
                    "inputTokens": v.get("inputTokens", 0),
                    "outputTokens": v.get("outputTokens", 0),
                    "costUSD": v.get("localCostUSD") or 0,
                }
            )
    elif group_by == "team":
        for tid, v in (local.get("teams", {}) or {}).items():
            entries.append(
                {
                    "id": tid,
                    "group": "team",
                    "messages": v.get("messages", 0),
                    "inputTokens": v.get("inputTokens", 0),
                    "outputTokens": v.get("outputTokens", 0),
                    "costUSD": v.get("localCostUSD") or 0,
                }
            )
    elif group_by == "model":
        models: dict[str, dict] = {}
        for sid, v in (local.get("sessions", {}) or {}).items():
            model = v.get("model", "unknown")
            if model not in models:
                models[model] = {
                    "messages": 0,
                    "inputTokens": 0,
                    "outputTokens": 0,
                    "costUSD": 0,
                }
            models[model]["messages"] += v.get("messages", 0)
            models[model]["inputTokens"] += v.get("inputTokens", 0)
            models[model]["outputTokens"] += v.get("outputTokens", 0)
            models[model]["costUSD"] += v.get("localCostUSD") or 0
        for mid, v in models.items():
            entries.append({"id": mid, "group": "model", **v})
    entries.sort(key=lambda x: float(x.get("costUSD") or 0), reverse=True)
    total_cost = sum(float(e.get("costUSD") or 0) for e in entries)
    for e in entries:
        e["pctOfTotal"] = round(
            (float(e.get("costUSD") or 0) / total_cost * 100) if total_cost > 0 else 0,
            1,
        )
    entries = entries[:limit]
    out = {
        "window": window,
        "groupBy": group_by,
        "totalCostUSD": round(total_cost, 4),
        "entries": entries,
    }
    if getattr(args, "json", False):
        print(json.dumps(out, indent=2))
    else:
        print(f"Spend Leaderboard ({window}, by {group_by}):")
        print(f"Total: {format_money(total_cost)}")
        for i, e in enumerate(entries, 1):
            print(
                f"  {i}. {e['id']}: {format_money(e.get('costUSD'))} ({e['pctOfTotal']}%) msgs={e['messages']} tokens={e['inputTokens'] + e['outputTokens']:,}"
            )
    return 0


def cmd_daily_report(args: argparse.Namespace) -> int:
    from datetime import datetime

    team_id = getattr(args, "team_id", None)
    window = getattr(args, "window", "today") or "today"
    res = summarize(window, None, None, team_id, None, None, None, True)
    budget = res.get("budget", {})
    active_block = summarize(
        "active_block", None, None, team_id, None, None, None, False, use_index=False
    )
    projection = _burn_rate_projection(res, active_block)
    # Anomaly check inline
    idx = load_usage_index()
    week_entry = (idx.get("windows", {}) or {}).get("week", {})
    bt = (week_entry or {}).get("totals", {})
    avg_daily_cost = (bt.get("totalUSD") or bt.get("localCostUSD") or 0) / 7.0
    cur_cost = (
        res.get("totals", {}).get("totalUSD")
        or res.get("totals", {}).get("localCostUSD")
        or 0
    )
    anomaly_flag = (
        float(cur_cost) > 2.0 * avg_daily_cost if avg_daily_cost > 0 else False
    )
    # Build report
    ts = datetime.now().strftime("%Y%m%d")
    totals = res.get("totals", {})
    lines = [
        f"# Daily Cost Report — {ts}",
        "",
        "## Summary",
        f"- Window: {window}",
        f"- Total Cost: {format_money(totals.get('totalUSD'))} (local: {format_money(totals.get('localCostUSD'))})",
        f"- Tokens: in={totals.get('inputTokens', 0):,} out={totals.get('outputTokens', 0):,}",
        f"- Messages: {totals.get('messages', 0):,}",
        "",
        "## Budget Status",
        f"- Scope: {budget.get('scope')} | Period: {budget.get('period')}",
        f"- Current: {format_money(budget.get('currentUSD'))} / {format_money(budget.get('limitUSD'))}",
        f"- Level: {budget.get('level')} ({budget.get('pct')}%)",
        "",
        "## Burn-Rate Projection",
        f"- Hourly burn: {format_money(projection.get('hourlyUSD'))}",
        f"- Projected daily: {format_money(projection.get('projectedDailyUSD'))}",
    ]
    if projection.get("projectedDailyUSD") and budget.get("limitUSD"):
        remaining = float(budget["limitUSD"]) - float(budget.get("currentUSD") or 0)
        hourly = projection.get("hourlyUSD")
        if hourly and float(hourly) > 0:
            lines.append(
                f"- Hours to exhaustion: {round(remaining / float(hourly), 1)}h"
            )
    lines += ["", "## Anomalies"]
    if anomaly_flag:
        lines.append(
            f"- COST SPIKE: today ({format_money(cur_cost)}) > 2x weekly avg ({format_money(avg_daily_cost)})"
        )
    else:
        lines.append("- None detected")
    # Top spenders
    local = res.get("local", {})
    sessions = local.get("sessions", {}) or {}
    sorted_sessions = sorted(
        sessions.items(),
        key=lambda x: float(x[1].get("localCostUSD") or 0),
        reverse=True,
    )[:5]
    lines += ["", "## Top Sessions"]
    for sid, v in sorted_sessions:
        lines.append(
            f"- {sid}: {format_money(v.get('localCostUSD'))} ({v.get('messages', 0)} msgs)"
        )
    # Recommendations
    lines += ["", "## Recommendations"]
    if budget.get("level") == "critical":
        lines.append("- CRITICAL: Consider scaling teams to lite preset")
    elif budget.get("level") == "warning":
        lines.append(
            "- WARNING: Monitor burn rate, consider downshifting if spend continues"
        )
    elif anomaly_flag:
        lines.append("- Investigate cost spike — check for runaway sessions")
    else:
        lines.append("- Budget healthy. No action needed.")
    report = "\n".join(lines)
    out_path = REPORTS_DIR / f"cost-daily-{ts}.md"
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path.write_text(report + "\n")
    if getattr(args, "json", False):
        print(
            json.dumps(
                {
                    "path": str(out_path),
                    "anomaly": anomaly_flag,
                    "budgetLevel": budget.get("level"),
                },
                indent=2,
            )
        )
    else:
        print(f"Daily report written: {out_path}")
        print(report)
    return 0


def cmd_cost_trends(args: argparse.Namespace) -> int:
    period = getattr(args, "period", "week") or "week"
    fmt = getattr(args, "format", "md") or "md"
    window_days = 30 if period == "month" else 7
    hooks_dir = CLAUDE / "hooks"
    if str(hooks_dir) not in sys.path:
        sys.path.insert(0, str(hooks_dir))
    try:
        from ops_trends import build_trends, render_text as render_ops_trends

        doc = build_trends(window_days=window_days, include_legacy=True)
        out = {
            "period": period,
            "series": doc.get("legacy_series", []),  # backward-compatible field
            "weekOverWeekChangePct": doc.get("weekOverWeekChangePct"),
            "rollingSeries": doc.get("series", []),
            "summary": doc.get("summary", {}),
        }
        if fmt == "json" or getattr(args, "json", False):
            print(json.dumps(out, indent=2))
        else:
            print(render_ops_trends(doc))
        return 0
    except Exception:
        # Fallback to original coarse implementation if ops_trends is unavailable
        idx = load_usage_index()
        windows = idx.get("windows", {})
        series: list[dict] = []
        for key in ["today", "week", "month"]:
            entry = windows.get(key)
            if isinstance(entry, dict) and entry.get("totals"):
                t = entry["totals"]
                series.append(
                    {
                        "window": key,
                        "costUSD": t.get("totalUSD") or t.get("localCostUSD") or 0,
                        "messages": t.get("messages", 0),
                        "inputTokens": t.get("inputTokens", 0),
                        "outputTokens": t.get("outputTokens", 0),
                    }
                )
        if not series:
            print("No trend data available. Run index-refresh first.")
            return 1
        for s in series:
            divisor = {"today": 1, "week": 7, "month": 30}.get(s["window"], 1)
            s["dailyAvgCostUSD"] = round(float(s["costUSD"]) / divisor, 2)
            s["dailyAvgMessages"] = round(s["messages"] / divisor, 1)
        today_cost = next(
            (s["costUSD"] for s in series if s["window"] == "today"), None
        )
        week_avg = next(
            (s["dailyAvgCostUSD"] for s in series if s["window"] == "week"), None
        )
        wow_change = None
        if today_cost is not None and week_avg and week_avg > 0:
            wow_change = round(((float(today_cost) - week_avg) / week_avg) * 100, 1)
        out = {"period": period, "series": series, "weekOverWeekChangePct": wow_change}
        if fmt == "json" or getattr(args, "json", False):
            print(json.dumps(out, indent=2))
        else:
            print("Cost Trends:")
            print(
                f"{'Window':<10} {'Cost':>10} {'Daily Avg':>10} {'Messages':>10} {'Tokens':>15}"
            )
            for s in series:
                print(
                    f"{s['window']:<10} {format_money(s['costUSD']):>10} {format_money(s['dailyAvgCostUSD']):>10} {s['messages']:>10,} {s['inputTokens'] + s['outputTokens']:>15,}"
                )
            if wow_change is not None:
                direction = "UP" if wow_change > 0 else "DOWN"
                print(f"\nWeek-over-week: {direction} {abs(wow_change)}%")
        return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Claude cost parity runtime")
    sp = p.add_subparsers(dest="cmd", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--window",
        choices=["today", "week", "month", "active_block", "custom"],
        default="today",
    )
    common.add_argument("--since")
    common.add_argument("--until")
    common.add_argument("--team-id")
    common.add_argument("--session-id")
    common.add_argument("--project")
    common.add_argument("--json", action="store_true")
    common.add_argument("--breakdown", action="store_true")
    common.add_argument("--mode")

    sp.add_parser("summary", parents=[common])
    ses = sp.add_parser("session", parents=[common])
    ses.set_defaults(_require_session=True)
    t = sp.add_parser("team", parents=[common])
    t.set_defaults(_require_team=True)
    t.add_argument("--include-members", action="store_true")
    ab = sp.add_parser("active-block", parents=[common])

    sl = sp.add_parser("statusline")
    sl.add_argument("--team-id")
    sl.add_argument("--session-id")
    sl.add_argument("--project")
    sl.add_argument("--cost-source")
    sl.add_argument("--offline", action="store_true", default=None)

    hs = sp.add_parser("hook-statusline")
    hs.add_argument("--session-id")
    hs.add_argument("--team-id")

    bs = sp.add_parser("budget-status")
    bs.add_argument("--team-id")
    bs.add_argument("--project")
    bs.add_argument("--period", choices=["daily", "weekly", "monthly"], default="daily")
    bs.add_argument("--json", action="store_true")

    sb = sp.add_parser("set-budget")
    sb.add_argument("--scope", choices=["global", "team", "project"], required=True)
    sb.add_argument("--team-id")
    sb.add_argument("--project")
    sb.add_argument("--period", choices=["daily", "weekly", "monthly"], required=True)
    sb.add_argument("--amount-usd", type=float, required=True)

    ex = sp.add_parser("export", parents=[common])
    ex.add_argument("--format", choices=["json", "md", "csv"], required=True)

    ix = sp.add_parser("index-refresh")
    ix.add_argument("--force", action="store_true")
    ix.add_argument("--json", action="store_true")

    br = sp.add_parser("team-budget-recommend")
    br.add_argument("--team-id")
    br.add_argument("--project")
    br.add_argument("--json", action="store_true")

    brc = sp.add_parser("burn-rate-check")
    brc.add_argument("--team-id")
    brc.add_argument("--project")
    brc.add_argument("--json", action="store_true")

    ac = sp.add_parser("anomaly-check")
    ac.add_argument("--team-id")
    ac.add_argument("--sensitivity", type=float, default=2.0)
    ac.add_argument("--json", action="store_true")

    sl2 = sp.add_parser("spend-leaderboard")
    sl2.add_argument("--window", choices=["today", "week", "month"], default="today")
    sl2.add_argument(
        "--group-by", choices=["session", "team", "model"], default="session"
    )
    sl2.add_argument("--limit", type=int, default=10)
    sl2.add_argument("--json", action="store_true")

    dr = sp.add_parser("daily-report")
    dr.add_argument("--team-id")
    dr.add_argument("--window", choices=["today", "week", "month"], default="today")
    dr.add_argument("--auto", action="store_true")
    dr.add_argument("--json", action="store_true")

    ct = sp.add_parser("cost-trends")
    ct.add_argument("--period", choices=["week", "month"], default="week")
    ct.add_argument("--format", choices=["json", "md"], default="md")
    ct.add_argument("--json", action="store_true")

    return p


def _maybe_emit_proactive_alerts(cmd_name: str) -> None:
    """Evaluate alerts opportunistically after cost commands (non-blocking)."""
    if os.environ.get("TOKEN_GUARD_ALERT_EVAL") == "1":
        return
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return
    if cmd_name not in {
        "summary",
        "budget-status",
        "burn-rate-check",
        "anomaly-check",
        "daily-report",
        "cost-trends",
        "statusline",
        "hook-statusline",
    }:
        return
    hooks_alerts = CLAUDE / "hooks" / "ops_alerts.py"
    if not hooks_alerts.exists():
        return
    try:
        subprocess.run(
            [
                "python3",
                str(hooks_alerts),
                "evaluate",
                "--source",
                f"cost_runtime:{cmd_name}",
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except Exception:
        pass


def main() -> int:
    load_or_init_files()
    args = build_parser().parse_args()
    rc = 1
    if args.cmd == "summary":
        rc = cmd_summary(args)
    elif args.cmd == "session":
        if not args.session_id:
            print("--session-id is required for session command", file=sys.stderr)
            rc = 2
        else:
            rc = cmd_session(args)
    elif args.cmd == "team":
        if not args.team_id:
            print("--team-id is required for team command", file=sys.stderr)
            rc = 2
        else:
            rc = cmd_team(args)
    elif args.cmd == "active-block":
        rc = cmd_active_block(args)
    elif args.cmd == "statusline":
        rc = cmd_statusline(args)
    elif args.cmd == "hook-statusline":
        rc = cmd_hook_statusline(args)
    elif args.cmd == "budget-status":
        rc = cmd_budget_status(args)
    elif args.cmd == "set-budget":
        rc = cmd_set_budget(args)
    elif args.cmd == "export":
        rc = cmd_export(args)
    elif args.cmd == "index-refresh":
        rc = cmd_index_refresh(args)
    elif args.cmd == "team-budget-recommend":
        rc = cmd_team_budget_recommend(args)
    elif args.cmd == "burn-rate-check":
        rc = cmd_burn_rate_check(args)
    elif args.cmd == "anomaly-check":
        rc = cmd_anomaly_check(args)
    elif args.cmd == "spend-leaderboard":
        rc = cmd_spend_leaderboard(args)
    elif args.cmd == "daily-report":
        rc = cmd_daily_report(args)
    elif args.cmd == "cost-trends":
        rc = cmd_cost_trends(args)
    else:
        print("unknown command", file=sys.stderr)
        rc = 1
    try:
        if rc == 0:
            _maybe_emit_proactive_alerts(args.cmd)
    except Exception:
        pass
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
