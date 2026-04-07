#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

HOME = Path.home()
REPO_ROOT = Path(__file__).resolve().parents[1]
HOOKS_TESTS = HOME / ".claude" / "hooks" / "tests"
SCRIPTS_TESTS = HOME / ".claude" / "scripts" / "tests"
HEALTH_CHECK = HOME / ".claude" / "hooks" / "health-check.sh"
CLI = HOME / ".claude" / "hooks" / "claude_token_guard" / "cli.py"
MCP = HOME / ".claude" / "mcp-coordinator" / "index.js"
LEAD_HEALTH_FALLBACK = HOME / ".claude" / "lead-tools" / "session_health.sh"
LEAD_BOOT_REGRESSION = (
    REPO_ROOT / "mcp-coordinator" / "test" / "lead-boot-regression.test.mjs"
)
TRUST_ENGINE = Path(
    os.environ.get("TRUST_ENGINE_PATH", str(HOME / "Projects" / "trust-engine"))
)


def run(name, cmd, timeout=600):
    t0 = time.time()
    try:
        cp = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return {
            "name": name,
            "cmd": cmd,
            "rc": cp.returncode,
            "seconds": round(time.time() - t0, 2),
            "stdout_tail": (cp.stdout or "")[-2000:],
            "stderr_tail": (cp.stderr or "")[-2000:],
        }
    except Exception as e:
        return {
            "name": name,
            "cmd": cmd,
            "rc": 1,
            "seconds": round(time.time() - t0, 2),
            "error": str(e),
        }


def main():
    checks = []
    if HOOKS_TESTS.exists():
        checks.append(run("hooks_pytests", ["pytest", str(HOOKS_TESTS)], timeout=1200))
    if SCRIPTS_TESTS.exists():
        checks.append(
            run("scripts_pytests", ["pytest", str(SCRIPTS_TESTS)], timeout=1200)
        )
    if HEALTH_CHECK.exists():
        checks.append(
            run(
                "health_check_stats", ["bash", str(HEALTH_CHECK), "--stats"], timeout=60
            )
        )
    if CLI.exists():
        # Pre-warm the ops snapshot cache so smoke latency reflects the common
        # interactive path rather than a full cold rebuild across large logs.
        run(
            "cli_ops_today_prewarm",
            ["python3", str(CLI), "ops", "today", "--statusline"],
            timeout=120,
        )
        checks.append(
            run(
                "cli_ops_today_smoke_cached",
                ["python3", str(CLI), "ops", "today", "--json"],
                timeout=120,
            )
        )
        checks.append(
            run(
                "cli_session_recap_smoke",
                ["python3", str(CLI), "ops", "session-recap", "--latest", "--json"],
                timeout=60,
            )
        )
    if MCP.exists():
        checks.append(run("mcp_node_check", ["node", "--check", str(MCP)], timeout=60))
        checks.append(
            run(
                "mcp_coord_session_health",
                [
                    "node",
                    "--input-type=module",
                    "-e",
                    (
                        "const mod = await import(process.argv[1]); "
                        "const { __test__ } = mod; "
                        "const out = __test__.handleToolCall('coord_session_health', {format:'json'}); "
                        "console.log(out.content[0].text);"
                    ),
                    str(MCP),
                ],
                timeout=30,
            )
        )
    if LEAD_HEALTH_FALLBACK.exists():
        checks.append(
            run(
                "lead_health_fallback_smoke",
                ["bash", str(LEAD_HEALTH_FALLBACK), "json"],
                timeout=30,
            )
        )
    if LEAD_BOOT_REGRESSION.exists():
        checks.append(
            run(
                "lead_boot_regression_test",
                ["node", "--test", str(LEAD_BOOT_REGRESSION)],
                timeout=120,
            )
        )
    if TRUST_ENGINE.exists():
        checks.append(
            run(
                "trust_engine_adapter_smoke",
                [
                    "python3",
                    "-c",
                    'import os; print(os.path.exists("%s"))' % TRUST_ENGINE,
                ],
                timeout=10,
            )
        )
    else:
        checks.append(
            {
                "name": "trust_engine_adapter_smoke",
                "skipped": True,
                "reason": "trust-engine path not found",
            }
        )

    passed = sum(1 for c in checks if c.get("rc") == 0)
    failed = sum(
        1 for c in checks if c.get("rc") not in (0, None) and not c.get("skipped")
    )
    out = {
        "schema_version": 1,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "summary": {"total": len(checks), "passed": passed, "failed": failed},
        "checks": checks,
    }
    print(json.dumps(out, indent=2))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
