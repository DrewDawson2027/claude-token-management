from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
HOOK = REPO_ROOT / "src" / "hooks" / "guards" / "budget-guard.py"


def run_budget_guard(runtime_root: Path, payload: dict):
    env = os.environ.copy()
    env["CLAUDE_RUNTIME_DIR"] = str(runtime_root)
    env["PYTHONPATH"] = os.pathsep.join(
        [
            str(REPO_ROOT / "src" / "hooks" / "guards"),
            str(REPO_ROOT / "src" / "hooks" / "infrastructure"),
            env.get("PYTHONPATH", ""),
        ]
    )
    return subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )


def write_session(runtime_root: Path, session_id: str, source: str):
    terminals = runtime_root / "terminals"
    terminals.mkdir(parents=True, exist_ok=True)
    safe = "".join(ch for ch in session_id if ch.isalnum() or ch in "-_")[:8]
    (terminals / f"session-{safe}.json").write_text(
        json.dumps({"session": safe, "source": source}), encoding="utf-8"
    )


def write_budget_files(runtime_root: Path):
    hooks = runtime_root / "hooks"
    cost = runtime_root / "cost"
    hooks.mkdir(parents=True, exist_ok=True)
    cost.mkdir(parents=True, exist_ok=True)
    (hooks / "token-guard-config.json").write_text(
        json.dumps({"budget_guard": {"enabled": True}}), encoding="utf-8"
    )
    (cost / "budgets.json").write_text(
        json.dumps({"global": {"dailyUSD": 0, "monthlyUSD": 200}, "thresholds": {}}),
        encoding="utf-8",
    )
    (cost / "cache.json").write_text(
        json.dumps({"generatedAt": "2026-04-07T00:00:00Z", "windows": {}}),
        encoding="utf-8",
    )


def test_resume_source_blocks_until_ack(tmp_path):
    runtime_root = tmp_path / ".claude"
    write_budget_files(runtime_root)
    write_session(runtime_root, "resumeabc123", "resume")

    cp = run_budget_guard(runtime_root, {"session_id": "resumeabc123", "tool_name": "Read"})
    assert cp.returncode == 2
    assert "compatibility risk detected" in cp.stderr


def test_resume_source_allows_after_ack(tmp_path):
    runtime_root = tmp_path / ".claude"
    write_budget_files(runtime_root)
    session_id = "resumeabc123"
    write_session(runtime_root, session_id, "resume")
    ack_path = runtime_root / "hooks" / "session-state" / "resume-risk-ack-resumeabc123"
    ack_path.parent.mkdir(parents=True, exist_ok=True)
    ack_path.touch()

    cp = run_budget_guard(runtime_root, {"session_id": session_id, "tool_name": "Read"})
    assert cp.returncode == 0, cp.stderr
