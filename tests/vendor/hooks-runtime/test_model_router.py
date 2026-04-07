import json
import os
import subprocess
import sys
from pathlib import Path

HOOK = Path(__file__).resolve().parents[1] / "model-router.py"


def write_settings(home: Path, model: str) -> None:
    claude_dir = home / ".claude"
    claude_dir.mkdir(parents=True, exist_ok=True)
    (claude_dir / "settings.local.json").write_text(
        json.dumps({"model": model}), encoding="utf-8"
    )


def make_task_input(subagent_type: str, *, model: str = "", prompt: str = "do work"):
    tool_input = {
        "subagent_type": subagent_type,
        "description": f"run {subagent_type}",
        "prompt": prompt,
        "run_in_background": True,
    }
    if model:
        tool_input["model"] = model
    return {
        "tool_name": "Task",
        "session_id": "routertest1234",
        "tool_input": tool_input,
    }


def run_router(payload: dict, *, home: Path):
    env = os.environ.copy()
    env["HOME"] = str(home)
    result = subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    return result.returncode, result.stdout.strip(), result.stderr.strip()


def parse_reason(stdout: str) -> str:
    data = json.loads(stdout)
    return data.get("reason", "")


def test_blocks_explicit_opus(tmp_path):
    write_settings(tmp_path, "claude-sonnet-4-6")
    code, stdout, _ = run_router(
        make_task_input("general-purpose", model="opus"),
        home=tmp_path,
    )
    assert code == 2
    assert "unsupported model 'opus'" in parse_reason(stdout)


def test_allows_versioned_sonnet_default(tmp_path):
    write_settings(tmp_path, "claude-sonnet-4-6")
    code, stdout, stderr = run_router(
        make_task_input("general-purpose"),
        home=tmp_path,
    )
    assert code == 0
    assert stdout == ""
    assert stderr == ""


def test_blocks_unsupported_configured_default(tmp_path):
    write_settings(tmp_path, "claude-opus-4-6")
    code, stdout, _ = run_router(
        make_task_input("general-purpose"),
        home=tmp_path,
    )
    assert code == 2
    assert "worker model must resolve to sonnet or haiku" in parse_reason(stdout)


def test_explore_like_agents_require_haiku(tmp_path):
    write_settings(tmp_path, "claude-sonnet-4-6")
    code, stdout, _ = run_router(
        make_task_input("scout"),
        home=tmp_path,
    )
    assert code == 2
    assert "MUST use model: 'haiku'" in parse_reason(stdout)


def test_allows_versioned_haiku_for_required_types(tmp_path):
    write_settings(tmp_path, "claude-sonnet-4-6")
    code, stdout, stderr = run_router(
        make_task_input("scout", model="claude-haiku-4-5"),
        home=tmp_path,
    )
    assert code == 0
    assert stderr == ""
    assert stdout == ""
