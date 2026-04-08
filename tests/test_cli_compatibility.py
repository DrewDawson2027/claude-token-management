from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CLI = REPO_ROOT / "src" / "cli" / "claude_token_guard" / "cli.py"


def run_cli(tmp_path: Path, *args: str):
    env = os.environ.copy()
    env["CLAUDE_RUNTIME_DIR"] = str(tmp_path / ".claude")
    env["PYTHONPATH"] = str(REPO_ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )


def test_ops_compatibility_json_report(tmp_path):
    cp = run_cli(tmp_path, "ops", "compatibility", "--json")
    assert cp.returncode == 0, cp.stderr
    doc = json.loads(cp.stdout)
    assert doc["summary"]["total_issues"] >= 8
    assert doc["summary"]["issues_with_repro_commands"] >= 5


def test_ops_compatibility_intake_updates_registry(tmp_path):
    cp = run_cli(
        tmp_path,
        "ops",
        "compatibility",
        "intake",
        "--issue-id",
        "cli-added-regression",
        "--title",
        "CLI added regression",
        "--issue-class",
        "compatibility",
        "--severity",
        "high",
        "--ownership",
        "upstream",
        "--status",
        "active",
        "--impact",
        "CLI intake should persist a new compatibility issue.",
        "--local-control",
        "compatibility registry",
        "--detection",
        "manual intake",
        "--repro-command",
        "claude-token-guard ops compatibility --json",
        "--json",
    )
    assert cp.returncode == 0, cp.stderr
    doc = json.loads(cp.stdout)
    issue_ids = {issue["issue_id"] for issue in doc["issues"]}
    assert "cli-added-regression" in issue_ids
