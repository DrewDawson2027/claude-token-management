#!/usr/bin/env python3
"""Shared source adapters for token guard ops views."""

from __future__ import annotations

import json
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

HOME = Path.home()
CLAUDE_DIR = HOME / ".claude"
HOOKS_DIR = CLAUDE_DIR / "hooks"
STATE_DIR = HOOKS_DIR / "session-state"
SCRIPTS_DIR = CLAUDE_DIR / "scripts"
COST_DIR = CLAUDE_DIR / "cost"
TERMINALS_DIR = CLAUDE_DIR / "terminals"
INBOX_DIR = TERMINALS_DIR / "inbox"
COST_RUNTIME = SCRIPTS_DIR / "cost_runtime.py"
OBS_SCRIPT = SCRIPTS_DIR / "observability.py"


DEFAULT_COST_CONFIG: Dict[str, Any] = {
    "alerts_enabled": True,
    "alert_channels": ["local", "inbox"],
    "alert_cooldown_seconds": 1800,
    "alert_repeat_crit_seconds": 600,
    "ops_snapshot_cache_ttl_seconds": 60,
    "ops_trends_cache_ttl_seconds": 300,
    "trends_default_window_days": 7,
}


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def write_json(path: Path, data: Any) -> bool:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(
            path.suffix + f".{os.getpid()}.{int(time.time() * 1000)}.tmp"
        )
        tmp.write_text(json.dumps(data, indent=2) + "\n")
        tmp.replace(path)
        return True
    except Exception:
        return False


def read_jsonl_with_stats(path: Path) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    rows: List[Dict[str, Any]] = []
    stats = {"lines": 0, "parsed": 0, "malformed": 0, "missing": 0}
    if not path.exists():
        stats["missing"] = 1
        return rows, stats
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                stats["lines"] += 1
                try:
                    doc = json.loads(line)
                    if isinstance(doc, dict):
                        rows.append(doc)
                        stats["parsed"] += 1
                    else:
                        stats["malformed"] += 1
                except Exception:
                    stats["malformed"] += 1
    except Exception:
        stats["missing"] = 1
    return rows, stats


def parse_ts(ts: Any) -> datetime | None:
    if not ts:
        return None
    if isinstance(ts, (int, float)):
        try:
            val = float(ts)
            if val > 10_000_000_000:
                val /= 1000.0
            return datetime.fromtimestamp(val, tz=timezone.utc)
        except Exception:
            return None
    if not isinstance(ts, str):
        return None
    raw = ts.strip()
    for candidate in (raw, raw.replace("Z", "+00:00"), raw + "Z"):
        try:
            dt = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc)
        except Exception:
            continue
    return None


def in_window(entry: Dict[str, Any], since: datetime, until: datetime) -> bool:
    dt = parse_ts(entry.get("ts") or entry.get("timestamp") or entry.get("generatedAt"))
    if dt is None:
        return False
    return since <= dt <= until


def local_day_window(now: datetime | None = None) -> Tuple[datetime, datetime]:
    now = now or datetime.now().astimezone()
    start_local = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end_local = now
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)


def run_python_json(
    script: Path,
    argv: List[str],
    timeout: int = 30,
    extra_env: Dict[str, str] | None = None,
) -> Tuple[int, Any, str]:
    if not script.exists():
        return 1, None, f"missing script: {script}"
    try:
        env = os.environ.copy()
        if extra_env:
            env.update(extra_env)
        cp = subprocess.run(
            ["python3", str(script), *argv],
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
        out = (cp.stdout or "").strip()
        err = (cp.stderr or "").strip()
        parsed = None
        if out:
            try:
                parsed = json.loads(out)
            except Exception:
                parsed = None
        return cp.returncode, parsed, (err or out)
    except Exception as e:
        return 1, None, str(e)


def run_python_text(
    script: Path,
    argv: List[str],
    timeout: int = 30,
    extra_env: Dict[str, str] | None = None,
) -> Tuple[int, str]:
    if not script.exists():
        return 1, f"missing script: {script}"
    try:
        env = os.environ.copy()
        if extra_env:
            env.update(extra_env)
        cp = subprocess.run(
            ["python3", str(script), *argv],
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
        return cp.returncode, ((cp.stdout or "") + (cp.stderr or "")).strip()
    except Exception as e:
        return 1, str(e)


def cost_json(argv: List[str], timeout: int = 30) -> Tuple[int, Any, str]:
    args = list(argv)
    if "--json" not in args:
        args.append("--json")
    return run_python_json(
        COST_RUNTIME,
        args,
        timeout=timeout,
        extra_env={"TOKEN_GUARD_ALERT_EVAL": "1"},
    )


def cost_text(argv: List[str], timeout: int = 30) -> Tuple[int, str]:
    return run_python_text(
        COST_RUNTIME,
        argv,
        timeout=timeout,
        extra_env={"TOKEN_GUARD_ALERT_EVAL": "1"},
    )


def load_cost_config() -> Dict[str, Any]:
    path = COST_DIR / "config.json"
    cfg = read_json(path, {}) or {}
    for k, v in DEFAULT_COST_CONFIG.items():
        cfg.setdefault(k, v)
    return cfg


def load_budgets() -> Dict[str, Any]:
    return read_json(COST_DIR / "budgets.json", {}) or {}


def source_freshness(paths: List[Path]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    now = time.time()
    for p in paths:
        try:
            st = p.stat()
            out[str(p)] = {
                "exists": True,
                "mtime": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc)
                .replace(microsecond=0)
                .isoformat()
                .replace("+00:00", "Z"),
                "age_seconds": round(max(0.0, now - st.st_mtime), 1),
                "size": st.st_size,
            }
        except Exception:
            out[str(p)] = {"exists": False}
    return out


def ensure_inbox_dir() -> None:
    INBOX_DIR.mkdir(parents=True, exist_ok=True)


def read_recent_lines(path: Path, limit: int = 200) -> List[str]:
    if not path.exists():
        return []
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()
        return [ln.rstrip("\n") for ln in lines[-limit:]]
    except Exception:
        return []
