"""
cost_base — shared primitives for cost_runtime.py and team_runtime.py.

Eliminates the DRY violations where read_json, write_json, safe_id, utc_now,
and parse_ts existed in both files with slightly different implementations.

The atomic write_json from cost_runtime is the canonical version (safer).
safe_id supports both behaviors via strict=True (raises SystemExit, cost_runtime
style) and strict=False (returns cleaned string, team_runtime style).
parse_ts is split into parse_ts_dt (returns datetime) and parse_ts_epoch
(returns float/epoch) since the two callers needed different types.
"""

from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SAFE_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def utc_now() -> str:
    """Return current UTC time as ISO 8601 string (Z suffix, no microseconds)."""
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def read_json(path: Path, default: Any = None) -> Any:
    """Read and parse a JSON file. Returns default on any error."""
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def write_json(path: Path, data: Any) -> None:
    """Atomically write data as JSON. Uses PID+timestamp temp file then rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(
        path.suffix + f".{os.getpid()}.{int(time.time() * 1000)}.tmp"
    )
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    tmp.replace(path)


def safe_id(v: str, label: str, *, strict: bool = True) -> str:
    """
    Validate and return v as a safe identifier.

    strict=True (default, cost_runtime behavior): raises SystemExit on invalid input.
    strict=False (team_runtime behavior): strips invalid chars and returns cleaned string.
    """
    if strict:
        if not isinstance(v, str) or not v or len(v) > 120 or not SAFE_ID_RE.match(v):
            raise SystemExit(f"Invalid {label}")
        return v
    else:
        # Permissive: strip invalid chars, truncate, fall back to "item"
        cleaned = re.sub(r"[^A-Za-z0-9._-]", "-", str(v or ""))[:60]
        return cleaned if cleaned else "item"


def parse_ts_dt(ts: str | None) -> datetime | None:
    """Parse ISO 8601 timestamp string into a timezone-aware datetime. Returns None on failure."""
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


def parse_ts_epoch(ts: str | None) -> float:
    """Parse ISO 8601 timestamp string into a Unix epoch float. Returns 0.0 on failure."""
    if not ts:
        return 0.0
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.timestamp()
    except Exception:
        # Try direct numeric parse as fallback (team_runtime passes epoch strings sometimes)
        try:
            return float(ts)
        except Exception:
            return 0.0
