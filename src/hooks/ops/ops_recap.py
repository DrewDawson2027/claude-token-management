#!/usr/bin/env python3
"""Session recap for token management activity."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import datetime
from typing import Any, Dict, List, Tuple

from guard_contracts import entry_reason, entry_session_key, entry_type
from guard_normalize import normalize_session_key
from ops_sources import (
    STATE_DIR,
    cost_json,
    parse_ts,
    read_jsonl_with_stats,
    utc_now_iso,
)

ALERTS_FILE = STATE_DIR.parent.parent / "cost" / "alerts.jsonl"
AUDIT_LOG = STATE_DIR / "audit.jsonl"
METRICS_LOG = STATE_DIR / "agent-metrics.jsonl"
HEAL_LOG = STATE_DIR / "self-heal.jsonl"


def _load_logs() -> Tuple[
    list[dict], dict, list[dict], dict, list[dict], dict, list[dict], dict
]:
    audit, audit_stats = read_jsonl_with_stats(AUDIT_LOG)
    metrics, metric_stats = read_jsonl_with_stats(METRICS_LOG)
    heal, heal_stats = read_jsonl_with_stats(HEAL_LOG)
    alerts, alert_stats = read_jsonl_with_stats(ALERTS_FILE)
    return (
        audit,
        audit_stats,
        metrics,
        metric_stats,
        heal,
        heal_stats,
        alerts,
        alert_stats,
    )


def _latest_session_key(audit: list[dict], metrics: list[dict]) -> str:
    best: tuple[float, str] = (0.0, "")
    for entry in audit + metrics:
        sk = normalize_session_key(entry.get("session_key") or entry.get("session"))
        dt = parse_ts(entry.get("ts") or entry.get("timestamp"))
        if not dt:
            continue
        ts = dt.timestamp()
        if ts >= best[0]:
            best = (ts, sk)
    return best[1] or "unknown"


def build_session_recap(
    session_id: str | None = None, latest: bool = False
) -> Dict[str, Any]:
    audit, audit_stats, metrics, metric_stats, heal, heal_stats, alerts, alert_stats = (
        _load_logs()
    )
    session_key = normalize_session_key(session_id) if session_id else ""
    if latest or not session_key:
        session_key = _latest_session_key(audit, metrics)

    audit_session = [e for e in audit if entry_session_key(e) == session_key]
    metric_session = [
        e
        for e in metrics
        if normalize_session_key(e.get("session_key") or e.get("session"))
        == session_key
    ]
    usage_rows = [
        e
        for e in metric_session
        if (e.get("record_type") == "usage" or e.get("event") == "agent_completed")
    ]
    lifecycle_rows = [
        e
        for e in metric_session
        if (e.get("record_type") == "lifecycle" or e.get("event") in {"start", "stop"})
    ]
    alert_rows = [
        e for e in alerts if normalize_session_key(e.get("session_key")) == session_key
    ]

    dts: List[datetime] = []
    for e in audit_session + metric_session:
        dt = parse_ts(e.get("ts") or e.get("timestamp"))
        if dt:
            dts.append(dt)
    started = min(dts).isoformat().replace("+00:00", "Z") if dts else ""
    ended = max(dts).isoformat().replace("+00:00", "Z") if dts else ""

    blocks = [e for e in audit_session if e.get("event") == "block"]
    shadow_near = [
        e
        for e in audit_session
        if e.get("event") in {"warn", "shadow"} and bool(e.get("would_block"))
    ]
    agents_spawned = len(
        [e for e in lifecycle_rows if e.get("event") == "start"]
    ) or len([e for e in audit_session if e.get("event") in {"allow", "allow_team"}])
    tokens_used = sum(int(e.get("total_tokens") or 0) for e in usage_rows)
    cost_usd = round(sum(float(e.get("cost_usd") or 0) for e in usage_rows), 4)

    rc_b, budget, _ = cost_json(["budget-status", "--period", "daily"])
    if rc_b != 0 or not isinstance(budget, dict):
        budget = {"level": "unknown"}

    # self-heal events during session window
    heal_rows: list[dict] = []
    if dts:
        start_dt, end_dt = min(dts), max(dts)
        for e in heal:
            dt = parse_ts(e.get("ts") or e.get("timestamp"))
            if dt and start_dt <= dt <= end_dt:
                heal_rows.append(e)

    doc = {
        "schema_version": 1,
        "generated_at": utc_now_iso(),
        "session_key": session_key,
        "session_started_at": started,
        "session_ended_at": ended,
        "agents_spawned": agents_spawned,
        "blocks_hit": len(blocks),
        "block_rules": dict(
            Counter(
                (e.get("rule_id") or entry_reason(e) or "unknown") for e in blocks
            ).most_common(10)
        ),
        "shadow_near_misses": len(shadow_near),
        "tokens_used": tokens_used,
        "cost_usd": cost_usd,
        "budget_status": budget,
        "alerts_emitted": len(alert_rows),
        "self_heal_events": len(heal_rows),
        "agents": dict(
            Counter(
                entry_type(e)
                for e in audit_session
                if e.get("event") in {"allow", "allow_team"}
            ).most_common(10)
        ),
        "data_quality": {
            "audit": audit_stats,
            "metrics": metric_stats,
            "self_heal": heal_stats,
            "alerts": alert_stats,
            "partial": bool(not usage_rows and lifecycle_rows),
        },
        "sources": {
            "audit_path": str(AUDIT_LOG),
            "metrics_path": str(METRICS_LOG),
            "self_heal_path": str(HEAL_LOG),
            "alerts_path": str(ALERTS_FILE),
        },
    }
    return doc


def render_recap(doc: Dict[str, Any], markdown: bool = False) -> str:
    if markdown:
        lines = [
            f"# Session Recap ({doc.get('session_key')})",
            "",
            f"- Started: {doc.get('session_started_at') or 'unknown'}",
            f"- Ended: {doc.get('session_ended_at') or 'unknown'}",
            f"- Agents spawned: {doc.get('agents_spawned', 0)}",
            f"- Blocks hit: {doc.get('blocks_hit', 0)}",
            f"- Shadow near misses: {doc.get('shadow_near_misses', 0)}",
            f"- Tokens used: {doc.get('tokens_used', 0):,}",
            f"- Cost: ${float(doc.get('cost_usd') or 0):.4f}",
            f"- Budget level: {(doc.get('budget_status') or {}).get('level', 'unknown')}",
            "",
            "## Block Rules",
        ]
        if doc.get("block_rules"):
            for k, v in (doc.get("block_rules") or {}).items():
                lines.append(f"- {k}: {v}")
        else:
            lines.append("- none")
        return "\n".join(lines)
    return (
        f"Session recap: {doc.get('session_key')}\n"
        f"Started: {doc.get('session_started_at') or 'unknown'}\n"
        f"Ended: {doc.get('session_ended_at') or 'unknown'}\n"
        f"Agents: {doc.get('agents_spawned', 0)}\n"
        f"Blocks: {doc.get('blocks_hit', 0)} (shadow near-misses: {doc.get('shadow_near_misses', 0)})\n"
        f"Tokens: {doc.get('tokens_used', 0):,}\n"
        f"Cost: ${float(doc.get('cost_usd') or 0):.4f}\n"
        f"Budget: {(doc.get('budget_status') or {}).get('level', 'unknown')}"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Session recap for token guard")
    ap.add_argument("--session-id")
    ap.add_argument("--latest", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--markdown", action="store_true")
    args = ap.parse_args()
    doc = build_session_recap(session_id=args.session_id, latest=args.latest)
    if args.json:
        print(json.dumps(doc, indent=2))
    else:
        print(render_recap(doc, markdown=args.markdown))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
