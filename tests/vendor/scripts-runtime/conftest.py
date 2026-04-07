"""Shared fixtures for team_runtime and cost_runtime tests."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import pytest

# ---------------------------------------------------------------------------
# Make the scripts package importable
# ---------------------------------------------------------------------------
SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def fake_args(**kwargs: Any) -> argparse.Namespace:
    """Build an argparse.Namespace with sensible defaults for testing."""
    defaults: dict[str, Any] = {
        "team_id": "test-team",
        "json": False,
        "cwd": "/tmp/test-cwd",
    }
    defaults.update(kwargs)
    return argparse.Namespace(**defaults)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text())


# ---------------------------------------------------------------------------
# Core fixture: isolated .claude directory
# ---------------------------------------------------------------------------
@pytest.fixture()
def claude_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Create an isolated .claude directory structure and patch all module-level
    paths in team_runtime and cost_runtime to point at it."""
    base = tmp_path / ".claude"
    teams = base / "teams"
    terminals = base / "terminals"
    inbox = terminals / "inbox"
    results = terminals / "results"
    archives = base / "archives" / "teams"
    cost = base / "cost"
    projects = base / "projects"
    reports = base / "reports"

    for d in [teams, terminals, inbox, results, archives, cost, projects, reports]:
        d.mkdir(parents=True, exist_ok=True)

    import team_runtime as tr

    monkeypatch.setattr(tr, "HOME", tmp_path)
    monkeypatch.setattr(tr, "CLAUDE_DIR", base)
    monkeypatch.setattr(tr, "TEAMS_DIR", teams)
    monkeypatch.setattr(tr, "TERMINALS_DIR", terminals)
    monkeypatch.setattr(tr, "INBOX_DIR", inbox)
    monkeypatch.setattr(tr, "RESULTS_DIR", results)
    monkeypatch.setattr(tr, "ARCHIVES_DIR", archives)
    monkeypatch.setattr(
        tr, "TEAM_PRESET_PROFILE_FILE", cost / "team-preset-profiles.json"
    )
    monkeypatch.setattr(tr, "COST_CACHE_FILE", cost / "cache.json")
    monkeypatch.setattr(tr, "COST_BUDGETS_FILE", cost / "budgets.json")

    return base


@pytest.fixture()
def cost_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Isolated cost runtime directory."""
    base = tmp_path / ".claude"
    cost = base / "cost"
    projects = base / "projects"
    reports = base / "reports"
    teams = base / "teams"
    terminals = base / "terminals"

    for d in [cost, projects, reports, teams, terminals]:
        d.mkdir(parents=True, exist_ok=True)

    import cost_runtime as cr

    monkeypatch.setattr(cr, "HOME", tmp_path)
    monkeypatch.setattr(cr, "CLAUDE", base)
    monkeypatch.setattr(cr, "COST_DIR", cost)
    monkeypatch.setattr(cr, "PROJECTS_DIR", projects)
    monkeypatch.setattr(cr, "TEAMS_DIR", teams)
    monkeypatch.setattr(cr, "TERMINALS_DIR", terminals)
    monkeypatch.setattr(cr, "REPORTS_DIR", reports)
    monkeypatch.setattr(cr, "CONFIG_FILE", cost / "config.json")
    monkeypatch.setattr(cr, "BUDGETS_FILE", cost / "budgets.json")
    monkeypatch.setattr(cr, "CACHE_FILE", cost / "cache.json")
    monkeypatch.setattr(cr, "USAGE_INDEX_FILE", cost / "usage-index.json")
    monkeypatch.setattr(cr, "PRICING_CACHE_FILE", cost / "pricing-cache.json")
    monkeypatch.setattr(cr, "STATUSLINE_CACHE_FILE", cost / "statusline-cache.json")

    return base


# ---------------------------------------------------------------------------
# Seed helpers
# ---------------------------------------------------------------------------
def seed_team(
    claude_dir: Path,
    team_id: str = "test-team",
    members: list[dict] | None = None,
    tasks: list[dict] | None = None,
    state: str = "running",
) -> Path:
    """Create a fully-seeded team directory with config, runtime, tasks."""
    team_dir = claude_dir / "teams" / team_id
    team_dir.mkdir(parents=True, exist_ok=True)
    for sub in ["mailboxes", "control", "claims", "cursors"]:
        (team_dir / sub).mkdir(exist_ok=True)

    if members is None:
        members = [
            {
                "memberId": "lead",
                "name": "lead",
                "role": "lead",
                "sessionId": "sess0001",
                "paneId": "%0",
            },
            {
                "memberId": "worker1",
                "name": "worker1",
                "role": "teammate",
                "sessionId": "sess0002",
                "paneId": "%1",
            },
            {
                "memberId": "worker2",
                "name": "worker2",
                "role": "teammate",
                "sessionId": "sess0003",
                "paneId": "%2",
            },
        ]

    config = {
        "teamId": team_id,
        "name": team_id,
        "description": "Test team",
        "members": members,
        "createdAt": "2026-02-20T00:00:00Z",
        "updatedAt": "2026-02-20T00:00:00Z",
    }
    write_json(team_dir / "config.json", config)

    runtime = {
        "state": state,
        "event_seq": 0,
        "tmux_session": f"claude-{team_id}",
        "updatedAt": "2026-02-20T00:00:00Z",
    }
    write_json(team_dir / "runtime.json", runtime)

    tasks_doc = {"tasks": tasks or [], "updatedAt": "2026-02-20T00:00:00Z"}
    write_json(team_dir / "tasks.json", tasks_doc)

    write_json(team_dir / "worker-map.json", {"workers": []})

    return team_dir


def seed_messages(claude_dir: Path, team_id: str, messages: list[dict]) -> None:
    """Write messages to the team's messages.jsonl."""
    msg_path = claude_dir / "teams" / team_id / "messages.jsonl"
    msg_path.parent.mkdir(parents=True, exist_ok=True)
    with msg_path.open("a") as f:
        for m in messages:
            f.write(json.dumps(m) + "\n")


def seed_events(claude_dir: Path, team_id: str, events: list[dict]) -> None:
    """Write events to the team's events.jsonl."""
    ev_path = claude_dir / "teams" / team_id / "events.jsonl"
    ev_path.parent.mkdir(parents=True, exist_ok=True)
    with ev_path.open("a") as f:
        for e in events:
            f.write(json.dumps(e) + "\n")


def seed_usage_records(projects_dir: Path, records: list[dict]) -> None:
    """Write usage records to a project JSONL file."""
    proj = projects_dir / "test-project"
    proj.mkdir(parents=True, exist_ok=True)
    fp = proj / "usage.jsonl"
    with fp.open("a") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


# ---------------------------------------------------------------------------
# Tmux mock
# ---------------------------------------------------------------------------
@pytest.fixture()
def mock_subprocess(monkeypatch: pytest.MonkeyPatch):
    """Mock subprocess.run to capture tmux commands without executing them."""
    calls: list[dict[str, Any]] = []

    def fake_run(cmd, **kwargs):
        calls.append({"cmd": cmd, "kwargs": kwargs})
        stdout = ""
        # Return fake pane info for tmux split-window/new-window
        if isinstance(cmd, list) and len(cmd) > 1:
            if "split-window" in cmd or "new-window" in cmd:
                stdout = f"%{len(calls)} /dev/ttys{len(calls):03d}"
            elif "has-session" in cmd:
                stdout = ""

        class Result:
            returncode = 0
            stderr = ""

        r = Result()
        r.stdout = stdout
        return r

    import team_runtime as tr

    monkeypatch.setattr(tr.subprocess, "run", fake_run)
    return calls
