"""
cost_data — data I/O layer extracted from cost_runtime.py.

Contains: UsageRecord, iter_usage_records (refactored), team membership maps,
usage fingerprinting, index helpers, window utilities, and run_ccusage.

Imports from cost_base for shared primitives (read_json, write_json, etc.).
cost_runtime.py imports from this module to keep its own focus on aggregation,
rendering, and the CLI layer.

Split rationale: the original cost_runtime.py was 1236 lines mixing data I/O,
aggregation, rendering, and CLI concerns. This module contains only the data
reading/writing layer (~450 lines), making each piece independently testable.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from cost_base import read_json, parse_ts_dt

try:
    from pricing import calculate_cost_from_usage as _pricing_calc
except ImportError:
    _pricing_calc = None  # pricing module not available; cost_usd stays None

HOME = Path.home()
CLAUDE = HOME / ".claude"
COST_DIR = CLAUDE / "cost"
PROJECTS_DIR = CLAUDE / "projects"
TEAMS_DIR = CLAUDE / "teams"
USAGE_INDEX_FILE = COST_DIR / "usage-index.json"

# Alias parse_ts_dt as parse_ts for internal use (datetime return type)
parse_ts = parse_ts_dt


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


# ── iter_usage_records — refactored into composable sub-functions ──────────────
# Original was a 70-line monolith with nested exception handlers, recent-mode
# deque optimization, and timestamp parsing all interleaved. Split into three
# testable helpers so each concern can be exercised independently.


def _scan_jsonl_files(since_hint: datetime | None) -> list[Path]:
    """
    Return all *.jsonl paths under PROJECTS_DIR that could contain records
    on or after since_hint (if provided). Uses file mtime as a pre-filter:
    files whose mtime+1d < since_hint are skipped to avoid reading cold history.

    Why +1 day slack: mtime reflects last write, not last record timestamp.
    A file written just before midnight may contain records from today.
    """
    if not PROJECTS_DIR.exists():
        return []
    result = []
    for fp in PROJECTS_DIR.rglob("*.jsonl"):
        if since_hint is not None:
            try:
                mtime = datetime.fromtimestamp(fp.stat().st_mtime, tz=timezone.utc)
                if mtime + timedelta(days=1) < since_hint:
                    continue
            except Exception:
                pass  # On stat failure, include the file conservatively
        result.append(fp)
    return result


def _tail_read_recent(path: Path, tail_lines: int = 5000) -> list[str]:
    """
    Memory-efficient tail-read for large files in recent-mode.

    Uses a fixed-size deque to buffer only the last N lines without loading
    the entire file. Triggered when file size > 2 MB AND a since_hint is
    provided (recent-mode), because recent records are always at the tail.
    """
    dq: deque[str] = deque(maxlen=tail_lines)
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            dq.append(line)
    return list(dq)


def _parse_jsonl_record(d: dict[str, Any]) -> UsageRecord | None:
    """
    Map one raw JSONL dict to a UsageRecord. Returns None if the record
    lacks a usage block (schema mismatch) or a parseable timestamp.

    Handles two timestamp formats:
      1. ISO 8601 string in "timestamp" or "createdAt"
      2. Unix epoch (ms if > 10^10, otherwise seconds) as a numeric "timestamp"
    """
    msg = d.get("message") or {}
    usage = msg.get("usage")
    if not isinstance(usage, dict):
        return None

    ts = parse_ts(d.get("timestamp") or d.get("createdAt"))
    if ts is None:
        try:
            ts_val = d.get("timestamp")
            if isinstance(ts_val, (int, float)):
                ts = datetime.fromtimestamp(
                    float(ts_val) / (1000 if ts_val > 10_000_000_000 else 1),
                    tz=timezone.utc,
                )
        except Exception:
            pass
    if ts is None:
        return None

    return UsageRecord(
        ts=ts,
        session_id=(d.get("sessionId") or "")[:8] or None,
        agent_id=d.get("agentId"),
        model=msg.get("model"),
        project_path=d.get("cwd"),
        project_name=Path(d.get("cwd") or "").name if d.get("cwd") else None,
        message_type=msg.get("type"),
        input_tokens=_int(usage.get("input_tokens")),
        output_tokens=_int(usage.get("output_tokens")),
        cache_creation_input_tokens=_int(usage.get("cache_creation_input_tokens")),
        cache_read_input_tokens=_int(usage.get("cache_read_input_tokens")),
        cost_usd=_float(
            usage.get("costUSD") or usage.get("cost_usd") or usage.get("total_cost_usd")
        )
        or (
            _pricing_calc(msg.get("model", ""), usage)
            if _pricing_calc and msg.get("model")
            else None
        ),
        raw=d,
    )


def iter_usage_records(since_hint: datetime | None = None) -> list[UsageRecord]:
    """
    Load all usage records from project JSONL files. Orchestration only —
    no parsing logic lives here; delegate to the three sub-functions above.

    since_hint: optional lower bound. Enables two optimizations:
      1. File-level mtime pre-filtering (_scan_jsonl_files)
      2. Tail-read mode for large files (_tail_read_recent) when within 8 days
    """
    recent_mode = since_hint is not None and (
        datetime.now(timezone.utc) - since_hint
    ) <= timedelta(days=8)
    rows: list[UsageRecord] = []
    for fp in _scan_jsonl_files(since_hint):
        try:
            if recent_mode and fp.stat().st_size > 2_000_000:
                raw_lines = _tail_read_recent(fp)
            else:
                with fp.open("r", encoding="utf-8", errors="ignore") as f:
                    raw_lines = list(f)

            for line in raw_lines:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                r = _parse_jsonl_record(d)
                if r is not None:
                    rows.append(r)
        except Exception:
            continue
    return rows


# ── Team + index helpers ───────────────────────────────────────────────────────


def team_membership_maps() -> (
    tuple[dict[str, str], dict[str, str], dict[str, dict[str, str]]]
):
    """Return (session→team, session→member, team:member→meta) maps from team configs."""
    session_to_team: dict[str, str] = {}
    session_to_member: dict[str, str] = {}
    member_meta: dict[str, dict[str, str]] = {}
    if not TEAMS_DIR.exists():
        return session_to_team, session_to_member, member_meta
    for cfg in TEAMS_DIR.glob("*/config.json"):
        team_id = cfg.parent.name
        data = read_json(cfg, {}) or {}
        for m in data.get("members", []):
            sid = (m.get("sessionId") or "")[:8]
            mid = m.get("memberId")
            if sid and mid:
                session_to_team[sid] = team_id
                session_to_member[sid] = mid
            if mid:
                member_meta[f"{team_id}:{mid}"] = {
                    "role": str(m.get("role") or ""),
                    "kind": str(m.get("kind") or ""),
                    "sessionId": sid,
                }
    return session_to_team, session_to_member, member_meta


def project_usage_fingerprint() -> dict[str, Any]:
    """Fingerprint of all JSONL files (count, total size, latest mtime). Used for index cache invalidation."""
    count = 0
    total_size = 0
    latest_mtime = 0.0
    if PROJECTS_DIR.exists():
        for fp in PROJECTS_DIR.rglob("*.jsonl"):
            try:
                st = fp.stat()
            except Exception:
                continue
            count += 1
            total_size += int(getattr(st, "st_size", 0) or 0)
            latest_mtime = max(latest_mtime, float(getattr(st, "st_mtime", 0.0) or 0.0))
    return {
        "fileCount": count,
        "totalSize": total_size,
        "latestMtime": round(latest_mtime, 3),
    }


def load_usage_index() -> dict[str, Any]:
    return read_json(
        USAGE_INDEX_FILE, {"generatedAt": None, "fingerprint": {}, "windows": {}}
    ) or {"generatedAt": None, "fingerprint": {}, "windows": {}}


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
    if since and ts < since:
        return False
    if until and ts > until:
        return False
    return True


def parse_window(
    window: str, since: str | None, until: str | None
) -> tuple[datetime | None, datetime | None]:
    now = datetime.now(timezone.utc)
    if since or until:
        sdt = (
            parse_ts(since + "T00:00:00Z")
            if since and len(since) == 10
            else parse_ts(since)
        )
        udt = (
            parse_ts(until + "T23:59:59Z")
            if until and len(until) == 10
            else parse_ts(until)
        )
        return sdt, udt
    if window == "today":
        start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
        return start, None
    if window == "week":
        start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc) - timedelta(
            days=7
        )
        return start, None
    if window == "month":
        start = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
        return start, None
    if window == "active_block":
        start = now - timedelta(hours=5)
        return start, None
    return None, None


# ── ccusage subprocess wrapper ─────────────────────────────────────────────────


def run_ccusage(args: list[str], timeout_sec: int = 10) -> tuple[bool, str, Any]:
    """
    Run ccusage CLI and return (ok, raw_text, parsed_json_or_None).

    ok=False means the tool is unavailable or failed; callers fall back to
    local-only aggregation in that case.
    """
    try:
        ccusage_bin = shutil.which("ccusage") or "/opt/homebrew/bin/ccusage"
        r = subprocess.run(
            [ccusage_bin] + args,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
        )
        if r.returncode != 0:
            return False, r.stderr.strip() or r.stdout.strip(), None
        text = r.stdout.strip()
        try:
            return True, text, json.loads(text)
        except Exception:
            return True, text, None
    except FileNotFoundError:
        return False, "ccusage not found", None
    except subprocess.TimeoutExpired:
        return False, f"ccusage timed out after {timeout_sec}s", None
    except Exception as e:
        return False, str(e), None


def _find_numeric_fields(obj: Any, acc: dict[str, list[float]], path: str = "") -> None:
    """Recursively collect numeric fields from ccusage JSON output for summary extraction."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            _find_numeric_fields(v, acc, f"{path}.{k}" if path else k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _find_numeric_fields(v, acc, f"{path}[{i}]")
    elif isinstance(obj, (int, float)):
        acc.setdefault(path, []).append(float(obj))


def extract_ccusage_summary(parsed: Any) -> dict[str, Any]:
    """
    Extract totalUSD from ccusage JSON output. Handles both structured
    (daily --json) and generic outputs by scanning numeric fields.
    """
    if isinstance(parsed, dict):
        # Common direct fields
        for key in ("totalCost", "total_cost", "totalUSD", "total_usd", "cost"):
            if key in parsed and isinstance(parsed[key], (int, float)):
                return {"totalUSD": float(parsed[key]), "raw": parsed}
        # Nested totals
        totals = parsed.get("totals") or parsed.get("summary") or {}
        if isinstance(totals, dict):
            for key in ("totalCost", "total_cost", "totalUSD", "cost"):
                if key in totals and isinstance(totals[key], (int, float)):
                    return {"totalUSD": float(totals[key]), "raw": parsed}
    # Fallback: scan all numeric fields and sum "cost"-named ones
    acc: dict[str, list[float]] = {}
    _find_numeric_fields(parsed, acc)
    cost_fields = {
        k: v for k, v in acc.items() if "cost" in k.lower() or "usd" in k.lower()
    }
    if cost_fields:
        total = sum(sum(v) for v in cost_fields.values())
        return {"totalUSD": round(total, 6), "raw": parsed}
    return {"totalUSD": None, "raw": parsed}


def _burn_rate_projection(
    today_res: dict[str, Any], active_block_res: dict[str, Any]
) -> dict[str, Any]:
    """
    Project 24-hour spend from a 5-hour active-block window burn rate.

    active_block covers the last 5 hours; rate = active_block / 5 hr.
    projected = rate * 24 hr. Returns None for fields when data is unavailable.
    """
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
        "burnRatePerHour": round(rate, 6) if rate is not None else None,
        "projectedDayUSD": round(projected, 4) if projected is not None else None,
    }
