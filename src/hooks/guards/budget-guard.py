#!/usr/bin/env python3
"""
Budget Guard — PreToolUse hook that enforces real-time spending limits.

Fires before EVERY tool call (matcher: ".*"), providing a hot enforcement layer
that blocks or warns when budget thresholds are exceeded.

Supports two plan modes:
  - "max": Claude Code Max plan ($200/mo subscription).
    On Max, the real constraint is RATE LIMIT HEADROOM, not dollar spend.
    Optimization target: preserve rate limit capacity for the current work session.
    Primary check: rolling token throughput over the last hour vs. estimated
    hourly rate limit. Dollar spend is warning-only (you already paid $200/mo).
    Configurable: hourly_token_limit, hourly_warn_pct, hourly_block_pct.
  - "api": API key billing. Per-token cost; daily USD tracking is primary.

Fast path: reads ~/.claude/cost/cache.json (written by cost_runtime statusline).
  - If cache mtime < ttl seconds: decision in <1ms (one JSON file read)
  - If cache is stale: subprocess call to cost_runtime.py to refresh (amortized)

Rate limit state: ~/.claude/token-analytics/daily/<today>.json (if available).

Config: Primary: ~/.claude/cost/budgets.json (budget values)
       Secondary: ~/.claude/hooks/token-guard-config.json (operational settings)
State:  ~/.claude/cost/cache.json (read-only from this hook)

Exit codes: 0 = allow, 2 = block
Circuit breaker: fail-CLOSED (exit 2) when tripped — blocks all tool calls
General errors: fail-open (exit 0)
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Tuple

THIS_DIR = Path(__file__).resolve().parent
INFRA_DIR = THIS_DIR.parent / "infrastructure"
for candidate in (THIS_DIR, INFRA_DIR):
    candidate_str = str(candidate)
    if candidate.is_dir() and candidate_str not in sys.path:
        sys.path.insert(0, candidate_str)

try:
    from runtime_paths import (
        cost_dir,
        hooks_dir,
        scripts_dir,
        session_state_dir,
        terminals_dir,
        token_analytics_dir,
    )
except Exception:
    def hooks_dir() -> Path:
        return Path.home() / ".claude" / "hooks"

    def scripts_dir() -> Path:
        return Path.home() / ".claude" / "scripts"

    def session_state_dir() -> Path:
        return hooks_dir() / "session-state"

    def terminals_dir() -> Path:
        return Path.home() / ".claude" / "terminals"

    def cost_dir() -> Path:
        return Path.home() / ".claude" / "cost"

    def token_analytics_dir() -> Path:
        return Path.home() / ".claude" / "token-analytics"


SESSIONS_DIR = token_analytics_dir() / "sessions"

HOOKS_DIR = hooks_dir()
SCRIPTS_DIR = scripts_dir()
COST_DIR = cost_dir()
CONFIG_PATH = os.environ.get(
    "TOKEN_GUARD_CONFIG_PATH",
    str(HOOKS_DIR / "token-guard-config.json"),
)
BUDGETS_PATH = COST_DIR / "budgets.json"
CACHE_FILE = COST_DIR / "cache.json"
STATE_DIR = session_state_dir()
TERMINALS_DIR = terminals_dir()

# How long a subprocess refresh may run before we give up and fail-open
REFRESH_TIMEOUT_SECONDS = 4

# Cooldown between refresh attempts to avoid subprocess pile-ups
REFRESH_COOLDOWN_FILE = "/tmp/budget-guard-refresh.ts"
REFRESH_COOLDOWN_SECONDS = 30
RESUME_RISK_SOURCES = {"resume", "continue", "restore", "reopen"}


def load_config() -> dict:
    """Load budget config — primary: budgets.json, fallback: token-guard-config.json."""
    defaults = {
        "enabled": True,
        "plan_type": "max",
        "monthly_usd": 200.0,
        "daily_usd": 0.0,
        "cache_ttl_seconds": 60,
        "fail_open": True,
        "block_on_critical": True,
        "warn_on_warning": True,
        "hourly_token_limit": 200_000,
        "hourly_warn_pct": 75,
        "hourly_block_pct": 92,
        "resume_source_guard_enabled": True,
        "resume_source_guard_block": True,
    }

    # Primary: budgets.json (single source of truth for budget values)
    try:
        budgets = json.loads(BUDGETS_PATH.read_text())
        g = budgets.get("global", {})
        t = budgets.get("thresholds", {})
        defaults["daily_usd"] = g.get("dailyUSD", defaults["daily_usd"])
        defaults["monthly_usd"] = g.get("monthlyUSD", defaults["monthly_usd"])
        defaults["hourly_warn_pct"] = t.get("warnPct", defaults["hourly_warn_pct"])
        defaults["hourly_block_pct"] = t.get("critPct", defaults["hourly_block_pct"])
    except Exception:
        pass

    # Secondary: token-guard-config.json (operational settings only)
    try:
        raw = json.loads(Path(CONFIG_PATH).read_text())
        section = raw.get("budget_guard") or {}
        for key in (
            "enabled",
            "plan_type",
            "cache_ttl_seconds",
            "fail_open",
            "block_on_critical",
            "warn_on_warning",
            "hourly_token_limit",
            "resume_source_guard_enabled",
            "resume_source_guard_block",
        ):
            if key in section:
                defaults[key] = section[key]
    except Exception:
        pass

    return defaults


def _refresh_cooldown_ok() -> bool:
    """Return True if enough time has passed since last refresh attempt."""
    try:
        last = float(Path(REFRESH_COOLDOWN_FILE).read_text().strip())
        return (time.time() - last) >= REFRESH_COOLDOWN_SECONDS
    except Exception:
        return True


def refresh_cache(config: dict) -> None:
    """Shell out to cost_runtime.py to write a fresh cache.json. Non-fatal on failure."""
    if not _refresh_cooldown_ok():
        return
    try:
        Path(REFRESH_COOLDOWN_FILE).write_text(str(time.time()))
    except Exception:
        pass
    cost_runtime = SCRIPTS_DIR / "cost_runtime.py"
    if not cost_runtime.exists():
        return
    try:
        subprocess.run(
            [sys.executable, str(cost_runtime), "statusline", "--json"],
            timeout=REFRESH_TIMEOUT_SECONDS,
            capture_output=True,
        )
    except Exception:
        pass  # fail-open — stale cache is fine


def _load_sessions_for_date(date_str: str) -> list:
    """Load all session records from sessions/{date}.jsonl. Returns [] on any error."""
    sessions_file = SESSIONS_DIR / f"{date_str}.jsonl"
    if not sessions_file.exists():
        return []
    records = []
    try:
        for line in sessions_file.read_text(
            encoding="utf-8", errors="replace"
        ).splitlines():
            line = line.strip()
            if line:
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    except Exception:
        pass
    return records


def check_rate_limit_headroom(config: dict) -> Tuple[str, Optional[float]]:
    """
    Max plan primary check: rolling hourly token usage vs. estimated rate limit.

    Reads sessions JSONL and sums tokens from sessions that ended in the last 60 minutes.
    Returns (level, pct) where pct = tokens_last_hour / hourly_token_limit * 100.

    Falls back to ("none", None) if data unavailable — fail-open.
    """
    try:
        today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        records = _load_sessions_for_date(today_str)
        if not records:
            return "none", None

        hourly_limit = float(config.get("hourly_token_limit", 200_000))
        warn_pct = float(config.get("hourly_warn_pct", 75))
        block_pct = float(config.get("hourly_block_pct", 92))

        now_ts = time.time()
        one_hour_ago = now_ts - 3600
        tokens_last_hour = 0

        # Sum tokens from sessions that ended within the last hour
        for r in records:
            ended_at = r.get("endedAt") or r.get("startedAt") or ""
            if not ended_at:
                continue
            try:
                dt = datetime.fromisoformat(ended_at.replace("Z", "+00:00"))
                if dt.timestamp() >= one_hour_ago:
                    t = r.get("totals", {})
                    tokens_last_hour += int(t.get("inputTokens", 0) or 0) + int(
                        t.get("outputTokens", 0) or 0
                    )
            except Exception:
                pass

        # Fallback: use full daily total as conservative worst-case hourly estimate
        if tokens_last_hour == 0:
            daily_tokens = sum(
                int(r.get("totals", {}).get("inputTokens", 0) or 0)
                + int(r.get("totals", {}).get("outputTokens", 0) or 0)
                for r in records
            )
            if daily_tokens:
                tokens_last_hour = daily_tokens

        if tokens_last_hour == 0 or hourly_limit <= 0:
            return "none", None

        pct = (tokens_last_hour / hourly_limit) * 100.0
        level = "ok"
        if pct >= block_pct:
            level = "critical"
        elif pct >= warn_pct:
            level = "warning"

        return level, round(pct, 1)

    except Exception:
        return "none", None  # fail-open


def fast_path_budget(config: dict) -> Tuple[str, Optional[float]]:
    """
    Return (level, pct) based on plan type.

    Max plan: primary = rate limit headroom (tokens/hour vs. limit).
              secondary = monthly spend (warning-only, non-blocking).
    API plan: primary = daily USD spend vs. daily_usd budget.

    level: "ok" | "warning" | "critical" | "none"
    pct: percentage of limit used (0-100+), or None if unavailable.

    Falls back to (none, None) on any error so the hook fails open.
    """
    plan_type = config.get("plan_type", "max")

    if plan_type == "max":
        # PRIMARY: rate limit headroom check
        return check_rate_limit_headroom(config)

    # API plan: dollar-based check via cache.json
    try:
        stat = CACHE_FILE.stat()
        ttl = float(config.get("cache_ttl_seconds", 60))
        if time.time() - stat.st_mtime > ttl:
            refresh_cache(config)
            try:
                stat = CACHE_FILE.stat()
            except Exception:
                return "none", None

        data = json.loads(CACHE_FILE.read_text())
        windows = data.get("windows") or {}
        today = windows.get("today") or windows.get("active_block") or {}
        budget = today.get("budget") or {}
        level = budget.get("level", "none")
        pct = budget.get("pct")
        return level, pct if isinstance(pct, (int, float)) else None

    except Exception:
        return "none", None  # fail-open


def _pct_to_level(pct: float) -> str:
    """Convert a percentage to a severity level using standard thresholds."""
    if pct >= 95.0:
        return "critical"
    if pct >= 80.0:
        return "warning"
    return "ok"


def _severity(level: str) -> int:
    """Return numeric severity for comparison. Higher = more severe."""
    return {"none": 0, "ok": 1, "warning": 2, "critical": 3}.get(level, 0)


def check_daily_token_budget() -> None:
    """
    Advisory daily token leanness check.

    Emits stderr warnings when today's total tokens exceed thresholds:
      >80M  → warning (delegate heavy reads to Haiku)
      >150M → stronger advisory (consider compacting)

    Non-blocking: always returns None. Fail-open on any error.
    """
    try:
        today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        records = _load_sessions_for_date(today_str)
        if not records:
            return

        total_tokens = sum(
            int(r.get("totals", {}).get("inputTokens", 0) or 0)
            + int(r.get("totals", {}).get("outputTokens", 0) or 0)
            for r in records
        )

        if total_tokens >= 150_000_000:
            print(
                f"🛑 CONTEXT BLOAT RISK: {total_tokens / 1_000_000:.0f}M tokens used today (150M+ threshold). "
                f"Consider compacting and using background Haiku agents for remaining work.",
                file=sys.stderr,
            )
        elif total_tokens >= 80_000_000:
            print(
                f"⚠️ HIGH CONTEXT DAY: {total_tokens / 1_000_000:.0f}M tokens used today. "
                f"Delegate heavy reads to background Haiku agents.",
                file=sys.stderr,
            )
    except Exception:
        pass  # fail-open — advisory only


def load_payload() -> dict:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return {}
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def resume_ack_path(session_id: str) -> Path:
    safe = "".join(ch for ch in str(session_id or "") if ch.isalnum() or ch in "-_")[:64]
    return STATE_DIR / f"resume-risk-ack-{safe}"


def lookup_session_source(session_id: str) -> str:
    safe = "".join(ch for ch in str(session_id or "") if ch.isalnum() or ch in "-_")[:8]
    if not safe:
        return ""
    session_file = TERMINALS_DIR / f"session-{safe}.json"
    try:
        data = json.loads(session_file.read_text())
        return str(data.get("source") or "").strip().lower()
    except Exception:
        return ""


def enforce_resume_source_guard(config: dict, payload: dict) -> None:
    if not config.get("resume_source_guard_enabled", True):
        return
    session_id = str(payload.get("session_id") or "").strip()
    if not session_id:
        return
    source = lookup_session_source(session_id)
    if source not in RESUME_RISK_SOURCES:
        return
    if os.environ.get("CLAUDE_ACK_RESUME_RISK") == "1":
        return
    ack_path = resume_ack_path(session_id)
    if ack_path.exists():
        return
    message = (
        "BLOCKED: resume/continue session compatibility risk detected. "
        f"Source={source}. Known prompt-cache regressions can inflate token burn "
        "before useful work begins. Preferred path: start a fresh session for heavy work. "
        f"To acknowledge and continue anyway: touch {ack_path}"
    )
    print(message, file=sys.stderr)
    if config.get("resume_source_guard_block", True):
        sys.exit(2)


def main() -> None:
    try:
        from circuit_breaker import check_circuit, record_success, record_failure

        if not check_circuit("budget-guard"):
            print(
                "BLOCKED: Budget guard circuit breaker tripped — blocking until resolved. "
                "Check ~/.claude/hooks/session-state/circuit-breaker.json",
                file=sys.stderr,
            )
            os.system(
                "osascript -e 'display notification "
                '"Budget guard circuit breaker tripped" '
                'with title "Claude Budget Alert"\' 2>/dev/null'
            )
            sys.exit(2)  # Fail CLOSED
    except ImportError:
        pass

    payload = load_payload()
    config = load_config()

    if not config.get("enabled", True):
        sys.exit(0)

    enforce_resume_source_guard(config, payload)

    # Advisory: warn if today's total token burn is unusually high
    check_daily_token_budget()

    level, pct = fast_path_budget(config)
    pct_str = f" ({pct:.0f}%)" if isinstance(pct, (int, float)) else ""

    if level == "critical" and config.get("block_on_critical", True):
        if config.get("plan_type") == "max":
            limit = config.get("hourly_token_limit", 200_000)
            print(
                f"RATE LIMIT HEADROOM CRITICAL{pct_str}: Hourly token throughput near limit "
                f"(est. {limit:,} tok/hr). Pausing to preserve capacity for current session. "
                f"Wait a few minutes or set hourly_block_pct higher in token-guard-config.json "
                f"budget_guard section to adjust.",
                file=sys.stderr,
            )
        else:
            print(
                f"BUDGET EXCEEDED{pct_str}: Daily limit reached. "
                f"Run /cost to review. To override: set block_on_critical=false in "
                f"token-guard-config.json budget_guard section.",
                file=sys.stderr,
            )
        sys.exit(2)

    if level == "warning" and config.get("warn_on_warning", True):
        if config.get("plan_type") == "max":
            print(
                f"RATE LIMIT HEADROOM WARNING{pct_str}: Hourly token rate is elevated. "
                f"Consider pausing heavy agent use to preserve session capacity.",
                file=sys.stderr,
            )
        else:
            print(
                f"BUDGET WARNING{pct_str}: Approaching spending limit.", file=sys.stderr
            )
        # Non-blocking — continue

    try:
        record_success("budget-guard")
    except Exception:
        pass
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        try:
            from hook_utils import record_hook_outcome

            code = e.code if isinstance(e.code, int) else 0
            outcome = (
                "success" if code == 0 else "fail_closed" if code == 2 else "error"
            )
            record_hook_outcome("budget-guard", outcome)
        except Exception:
            pass
        raise
    except Exception:
        try:
            from circuit_breaker import record_failure

            record_failure("budget-guard")
        except Exception:
            pass
        try:
            from hook_utils import record_hook_outcome

            record_hook_outcome("budget-guard", "fail_open")
        except Exception:
            pass
        sys.exit(0)  # fail-open
