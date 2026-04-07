#!/usr/bin/env python3
"""Proactive cost/hook alerting with dedup and local+inbox delivery."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List

from guard_normalize import normalize_session_key, short_hash
from ops_sources import (
    COST_DIR,
    HOOKS_DIR,
    INBOX_DIR,
    STATE_DIR,
    cost_json,
    ensure_inbox_dir,
    load_cost_config,
    read_json,
    read_jsonl_with_stats,
    utc_now_iso,
    write_json,
)

ALERTS_FILE = COST_DIR / "alerts.jsonl"
ALERT_STATE_FILE = COST_DIR / "alert-state.json"
EDIT_NOTIFY = HOOKS_DIR / "edit-notify.sh"
AUDIT_LOG = STATE_DIR / "audit.jsonl"
METRICS_LOG = STATE_DIR / "agent-metrics.jsonl"
SELF_HEAL_LOG = STATE_DIR / "self-heal.jsonl"

SCHEMA_VERSION = 1


def _append_jsonl(path: Path, record: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, separators=(",", ":")) + "\n")


def _load_state() -> Dict[str, Any]:
    state = read_json(ALERT_STATE_FILE, {}) or {}
    state.setdefault("last_sent", {})
    state.setdefault("suppressed", {})
    state.setdefault("active", {})
    return state


def _save_state(state: Dict[str, Any]) -> None:
    write_json(ALERT_STATE_FILE, state)


def _deliver_local(message: str) -> bool:
    try:
        if EDIT_NOTIFY.exists() and os.access(EDIT_NOTIFY, os.X_OK):
            import subprocess

            subprocess.run(["bash", str(EDIT_NOTIFY)], check=False, timeout=5)
            return True
    except Exception:
        pass
    try:
        print(f"\aALERT: {message}", file=sys.stderr)
        return True
    except Exception:
        return False


def _deliver_inbox(title: str, message: str, severity: str) -> bool:
    try:
        ensure_inbox_dir()
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = INBOX_DIR / f"ops-alert-{ts}-{severity}.md"
        body = f"# Token Management Alert\n\n- Severity: {severity}\n- Time: {utc_now_iso()}\n\n{title}\n\n{message}\n"
        path.write_text(body)
        return True
    except Exception:
        return False


def _cooldown_for(severity: str, cfg: Dict[str, Any]) -> int:
    if severity == "crit":
        return int(cfg.get("alert_repeat_crit_seconds", 600) or 600)
    return int(cfg.get("alert_cooldown_seconds", 1800) or 1800)


def _should_send(
    dedup_key: str, severity: str, state: Dict[str, Any], cfg: Dict[str, Any]
) -> bool:
    now = time.time()
    last = float((state.get("last_sent") or {}).get(dedup_key) or 0)
    cooldown = _cooldown_for(severity, cfg)
    if now - last < cooldown:
        state.setdefault("suppressed", {})[dedup_key] = (
            int((state.get("suppressed") or {}).get(dedup_key) or 0) + 1
        )
        return False
    state.setdefault("last_sent", {})[dedup_key] = now
    return True


def _emit_alert(
    *,
    severity: str,
    category: str,
    dedup_key: str,
    trigger_source: str,
    message: str,
    session_key: str = "",
    cost_context: Dict[str, Any] | None = None,
    budget_context: Dict[str, Any] | None = None,
    deliver: bool = True,
) -> Dict[str, Any]:
    cfg = load_cost_config()
    channels = [str(x) for x in (cfg.get("alert_channels") or ["local", "inbox"])]
    state = _load_state()
    should_send = _should_send(dedup_key, severity, state, cfg)
    delivered_local = False
    delivered_inbox = False
    if should_send and deliver and bool(cfg.get("alerts_enabled", True)):
        if "local" in channels:
            delivered_local = _deliver_local(message)
        if "inbox" in channels:
            delivered_inbox = _deliver_inbox(category, message, severity)
    alert_id = short_hash(f"{utc_now_iso()}|{category}|{dedup_key}|{message}", 16)
    record: Dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "record_type": "alert_event",
        "ts": utc_now_iso(),
        "alert_id": alert_id,
        "severity": severity,
        "category": category,
        "dedup_key": dedup_key,
        "trigger_source": trigger_source,
        "message": message,
        "session_key": normalize_session_key(session_key) if session_key else "",
        "cost_context": cost_context or {},
        "budget_context": budget_context or {},
        "delivered_local": bool(delivered_local),
        "delivered_inbox": bool(delivered_inbox),
        "suppressed": not should_send,
    }
    _append_jsonl(ALERTS_FILE, record)
    state.setdefault("active", {})[dedup_key] = {
        "severity": severity,
        "category": category,
        "message": message,
        "last_seen": time.time(),
    }
    _save_state(state)
    return record


def _recent_fault_count(hours: int = 1) -> int:
    entries, _ = read_jsonl_with_stats(AUDIT_LOG)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    count = 0
    for e in entries[-500:]:
        if e.get("event") != "fault":
            continue
        ts = e.get("ts")
        try:
            dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            if dt >= cutoff:
                count += 1
        except Exception:
            continue
    return count


def _data_quality_signal() -> Dict[str, Any]:
    out = {"malformed_ratio": 0.0, "malformed_lines": 0, "parsed_lines": 0}
    total_lines = 0
    malformed = 0
    parsed = 0
    for path in [AUDIT_LOG, METRICS_LOG, SELF_HEAL_LOG]:
        _, st = read_jsonl_with_stats(path)
        total_lines += int(st.get("lines") or 0)
        malformed += int(st.get("malformed") or 0)
        parsed += int(st.get("parsed") or 0)
    out["parsed_lines"] = parsed
    out["malformed_lines"] = malformed
    out["malformed_ratio"] = round((malformed / total_lines) if total_lines else 0.0, 4)
    return out


def evaluate_alerts(
    trigger_source: str = "manual", deliver: bool = True, session_key: str = ""
) -> Dict[str, Any]:
    alerts: List[Dict[str, Any]] = []
    cfg = load_cost_config()
    if not bool(cfg.get("alerts_enabled", True)):
        return {"alerts": [], "enabled": False}

    rc_b, budget, _ = cost_json(["budget-status", "--period", "daily"], timeout=5)
    if rc_b == 0 and isinstance(budget, dict):
        level = str(budget.get("level") or "none").lower()
        pct = budget.get("pct")
        if level in {"warning", "warn", "critical", "crit"}:
            sev = "crit" if level in {"critical", "crit"} else "warn"
            msg = f"Daily budget {level.upper()}: {pct}% used (current=${budget.get('currentUSD')} / limit=${budget.get('limitUSD')})"
            alerts.append(
                _emit_alert(
                    severity=sev,
                    category="budget",
                    dedup_key=f"budget:daily:{level}",
                    trigger_source=trigger_source,
                    message=msg,
                    session_key=session_key,
                    budget_context=budget,
                    deliver=deliver,
                )
            )

    rc_br, burn, _ = cost_json(["burn-rate-check"], timeout=6)
    if rc_br == 0 and isinstance(burn, dict) and bool(burn.get("alert")):
        alerts.append(
            _emit_alert(
                severity="crit",
                category="burn_rate",
                dedup_key="burn_rate:daily_projection",
                trigger_source=trigger_source,
                message=str(burn.get("message") or "Burn rate alert"),
                session_key=session_key,
                cost_context=burn,
                deliver=deliver,
            )
        )

    rc_a, anomaly, _ = cost_json(["anomaly-check"], timeout=6)
    if (
        rc_a == 0
        and isinstance(anomaly, dict)
        and int(anomaly.get("anomalyCount") or 0) > 0
    ):
        alerts.append(
            _emit_alert(
                severity="warn",
                category="anomaly",
                dedup_key=f"anomaly:{int(anomaly.get('anomalyCount') or 0)}",
                trigger_source=trigger_source,
                message=f"Cost anomalies detected: {anomaly.get('anomalyCount')} (sensitivity={anomaly.get('sensitivity')})",
                session_key=session_key,
                cost_context=anomaly,
                deliver=deliver,
            )
        )

    dq = _data_quality_signal()
    if dq["malformed_ratio"] > 0.2 and dq["malformed_lines"] >= 5:
        alerts.append(
            _emit_alert(
                severity="warn",
                category="data_quality",
                dedup_key="data_quality:malformed_ratio",
                trigger_source=trigger_source,
                message=f"Malformed log ratio is high ({dq['malformed_ratio'] * 100:.1f}% over {dq['parsed_lines'] + dq['malformed_lines']} lines)",
                session_key=session_key,
                cost_context=dq,
                deliver=deliver,
            )
        )

    faults = _recent_fault_count(hours=1)
    if faults >= 3:
        alerts.append(
            _emit_alert(
                severity="warn",
                category="hook_fault",
                dedup_key="hook_fault:recent_fault_spike",
                trigger_source=trigger_source,
                message=f"Hook fault spike detected: {faults} fault events in the last hour",
                session_key=session_key,
                cost_context={"recent_faults_1h": faults},
                deliver=deliver,
            )
        )

    return {
        "enabled": True,
        "alerts": alerts,
        "count": len(alerts),
        "trigger_source": trigger_source,
    }


def alert_status(limit: int = 20) -> Dict[str, Any]:
    entries, stats = read_jsonl_with_stats(ALERTS_FILE)
    state = _load_state()
    return {
        "schema_version": 1,
        "generated_at": utc_now_iso(),
        "stats": stats,
        "recent": entries[-limit:],
        "active": state.get("active") or {},
        "suppressed": state.get("suppressed") or {},
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Token management proactive alerts")
    sp = ap.add_subparsers(dest="cmd", required=True)
    ev = sp.add_parser("evaluate")
    ev.add_argument("--source", default="manual")
    ev.add_argument("--session-key", default="")
    ev.add_argument("--no-deliver", action="store_true")
    ev.add_argument("--json", action="store_true")
    st = sp.add_parser("status")
    st.add_argument("--limit", type=int, default=20)
    st.add_argument("--json", action="store_true")
    args = ap.parse_args()
    if args.cmd == "evaluate":
        doc = evaluate_alerts(
            trigger_source=args.source,
            deliver=not args.no_deliver,
            session_key=args.session_key,
        )
        if args.json:
            print(json.dumps(doc, indent=2))
        else:
            print(f"Alerts evaluated: {doc.get('count', 0)}")
            for a in doc.get("alerts", []):
                print(
                    f"- {a.get('severity')} {a.get('category')}: {a.get('message')}{' (suppressed)' if a.get('suppressed') else ''}"
                )
        return 0
    doc = alert_status(limit=args.limit)
    if args.json:
        print(json.dumps(doc, indent=2))
    else:
        print(f"Recent alerts: {len(doc.get('recent') or [])}")
        for a in doc.get("recent", []):
            print(
                f"- {a.get('ts')} [{a.get('severity')}] {a.get('category')}: {a.get('message')}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
