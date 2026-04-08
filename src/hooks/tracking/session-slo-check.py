#!/usr/bin/env python3
"""
Session SLO / Parity Self-Check — SessionStart hook.

Runs observability.py health-report in fast mode at session start and
surfaces a WARNING banner to stdout if any SLO is red. This means you
see broken system state BEFORE starting work, not mid-task.

Behaviour:
  - Green/no data → silent (no output, exit 0)
  - Any red SLO   → prints a compact warning block to stdout (visible in session)
  - Timeout/error → silent exit(0) — never blocks session start

Timeout: 3 seconds max (kept tight to avoid blocking session start).
Fail-open: all errors → exit(0).
"""

import json
import subprocess
import sys
from pathlib import Path
from runtime_paths import hooks_dir, scripts_dir

OBS_SCRIPT = scripts_dir() / "observability.py"
TIMEOUT_SECONDS = 3

# Phrases that indicate a red/failing SLO in health-report output
RED_INDICATORS = ["FAIL", "RED", "CRITICAL", "SLO BREACH", "ALERT", "ERROR", "DOWN"]
RESUME_SOURCES = {"resume", "continue", "restore", "reopen"}


def run_health_report() -> tuple[int, str]:
    """Run observability.py health-report, return (returncode, stdout+stderr)."""
    if not OBS_SCRIPT.exists():
        return -1, ""
    try:
        result = subprocess.run(
            [sys.executable, str(OBS_SCRIPT), "health-report"],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
        )
        combined = result.stdout + result.stderr
        return result.returncode, combined
    except subprocess.TimeoutExpired:
        return -2, ""
    except Exception:
        return -3, ""


def extract_red_lines(output: str) -> list[str]:
    """Find lines that indicate a red/failing state."""
    red = []
    for line in output.splitlines():
        upper = line.upper()
        if any(indicator in upper for indicator in RED_INDICATORS):
            red.append(line.rstrip())
    return red


def extract_startup_source(input_data: dict) -> str:
    source = str(input_data.get("source") or "").strip().lower()
    if source in RESUME_SOURCES:
        return source
    return ""


def build_resume_warning(source: str) -> list[str]:
    if not source:
        return []
    return [
        "",
        "╔══════════════════════════════════════════════════════════╗",
        "║  ⚠  COMPATIBILITY WARNING — resume/continue session     ║",
        "╚══════════════════════════════════════════════════════════╝",
        "",
        f"  Session source: {source}",
        "  Known issue class: prompt-cache regressions can inflate input tokens",
        "  Mitigation: prefer a fresh session for heavy work if burn spikes or cache hits look poor.",
        "  Check: `claude-token-guard ops compatibility --json` or rerun the drain benchmark.",
        "",
    ]


def main() -> None:
    try:
        input_data = json.loads(sys.stdin.read() or "{}")
    except Exception:
        input_data = {}

    rc, output = run_health_report()
    source = extract_startup_source(input_data if isinstance(input_data, dict) else {})
    resume_warning = build_resume_warning(source)

    if rc < 0 or not output.strip():
        if resume_warning:
            print("\n".join(resume_warning))
        sys.exit(0)

    red_lines = extract_red_lines(output)

    if not red_lines and not resume_warning:
        sys.exit(0)

    # Surface the warning
    banner = list(resume_warning)
    if red_lines:
        banner.extend(
            [
                "",
                "╔══════════════════════════════════════════════════════════╗",
                "║  ⚠  SLO WARNING — system health issues detected         ║",
                "╚══════════════════════════════════════════════════════════╝",
                "",
            ]
        )
        for line in red_lines[:10]:  # cap at 10 lines
            banner.append(f"  {line}")

        banner += [
            "",
            "Run `/ops-cost` or `python3 ~/.claude/scripts/observability.py health-report`",
            "to investigate before starting work.",
            "",
        ]

    print("\n".join(banner))

    # Hook health check — append per-hook metrics if available
    try:
        hook_health_script = hooks_dir() / "hook_health.py"
        if hook_health_script.exists() and red_lines:
            result = subprocess.run(
                [sys.executable, str(hook_health_script), "--human"],
                capture_output=True, text=True, timeout=2,
            )
            if result.returncode == 0 and result.stdout.strip():
                health_lines = result.stdout.strip().splitlines()
                # Only show if there are issues
                if any(w in result.stdout for w in ("RED", "WARN", "CRITICAL", "SLOW")):
                    print("\n  Hook Health:")
                    for line in health_lines[-5:]:
                        print(f"    {line}")
    except Exception:
        pass

    sys.exit(0)  # always exit 0 — this is informational only


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(0)  # always fail-open
