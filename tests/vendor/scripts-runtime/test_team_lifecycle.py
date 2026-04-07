"""Integration tests for team lifecycle: create, start, stop, bootstrap, recover, teardown."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = TESTS_DIR.parent
for p in [str(SCRIPTS_DIR), str(TESTS_DIR)]:
    if p not in sys.path:
        sys.path.insert(0, p)

import team_runtime as tr
from conftest import seed_team, read_json


class TestTeamCreate:
    def test_create_team(self, claude_dir):
        result = tr.cmd_team_create(
            argparse.Namespace(
                team_id="my-team",
                name="My Team",
                description="A test team",
                lead_session_id="sess1234",
                lead_member_id="lead",
                lead_name="lead",
                cwd="/tmp",
                force=False,
            )
        )
        assert "my-team" in result
        cfg = read_json(claude_dir / "teams" / "my-team" / "config.json")
        assert cfg["id"] == "my-team"
        assert len(cfg["members"]) == 1
        assert cfg["members"][0]["memberId"] == "lead"

    def test_create_duplicate_fails(self, claude_dir):
        args = argparse.Namespace(
            team_id="dup",
            name="Dup",
            description="",
            lead_session_id="s1",
            lead_member_id="lead",
            lead_name="lead",
            cwd="/tmp",
            force=False,
        )
        tr.cmd_team_create(args)
        with pytest.raises(SystemExit, match="already exists"):
            tr.cmd_team_create(
                argparse.Namespace(
                    team_id="dup",
                    name="Dup",
                    description="",
                    lead_session_id="s1",
                    lead_member_id="lead",
                    lead_name="lead",
                    cwd="/tmp",
                    force=False,
                )
            )

    def test_create_force_overwrites(self, claude_dir):
        tr.cmd_team_create(
            argparse.Namespace(
                team_id="dup2",
                name="Dup2",
                description="",
                lead_session_id="s1",
                lead_member_id="lead",
                lead_name="lead",
                cwd="/tmp",
                force=False,
            )
        )
        result = tr.cmd_team_create(
            argparse.Namespace(
                team_id="dup2",
                name="Dup2",
                description="New desc",
                lead_session_id="s1",
                lead_member_id="lead",
                lead_name="lead",
                cwd="/tmp",
                force=True,
            )
        )
        assert "dup2" in result


class TestTeamStartStop:
    def test_start_stop(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "life-team", state="stopped")
        tr.cmd_team_start(argparse.Namespace(team_id="life-team", cwd="/tmp"))
        rt = read_json(claude_dir / "teams" / "life-team" / "runtime.json")
        assert rt["state"] == "running"

        tr.cmd_team_stop(argparse.Namespace(team_id="life-team", kill_panes=False))
        rt = read_json(claude_dir / "teams" / "life-team" / "runtime.json")
        assert rt["state"] == "stopped"

    def test_start_nonexistent_fails(self, claude_dir):
        with pytest.raises(SystemExit):
            tr.cmd_team_start(argparse.Namespace(team_id="no-such-team", cwd="/tmp"))


class TestTeamList:
    def test_list_teams(self, claude_dir):
        seed_team(claude_dir, "alpha")
        seed_team(claude_dir, "beta")
        result = tr.cmd_team_list(argparse.Namespace())
        assert "alpha" in result
        assert "beta" in result


class TestTeamPauseResume:
    def test_pause_resume(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "pr-team", state="running")
        tr.cmd_team_pause(
            argparse.Namespace(
                team_id="pr-team",
                member_ids=[],
                reason="test",
            )
        )
        rt = read_json(claude_dir / "teams" / "pr-team" / "runtime.json")
        assert rt["state"] == "paused"


class TestTeamRecover:
    def test_recover_emits_event(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "rec-team", state="running")
        result = tr.cmd_team_recover(
            argparse.Namespace(
                team_id="rec-team",
                ensure_tmux=False,
                keep_events=None,
                include_workers=True,
            )
        )
        assert "Recover" in result or "Doctor" in result
        events = _read_events(claude_dir, "rec-team")
        assert any(e["type"] == "TeamRecovered" for e in events)


class TestTeamTeardown:
    def test_teardown_cleans_up(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "td-team", state="stopped")
        assert (claude_dir / "teams" / "td-team").exists()
        # Teardown stops and writes summary
        result = tr.cmd_team_teardown(
            argparse.Namespace(
                team_id="td-team",
                kill_panes=False,
            )
        )
        assert "td-team" in result


class TestTeamBootstrap:
    def test_bootstrap_creates_and_starts(self, claude_dir, mock_subprocess):
        result = tr.cmd_team_bootstrap(
            argparse.Namespace(
                team_id="boot-team",
                name="Boot Team",
                description="Test",
                lead_session_id="s1",
                lead_member_id="lead",
                lead_name="lead",
                cwd="/tmp",
                preset="lite",
                teammate=[],
            )
        )
        assert "boot-team" in result
        cfg = read_json(claude_dir / "teams" / "boot-team" / "config.json")
        assert len(cfg["members"]) >= 1
        rt = read_json(claude_dir / "teams" / "boot-team" / "runtime.json")
        assert rt["state"] == "running"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _read_events(claude_dir: Path, team_id: str) -> list[dict]:
    ep = claude_dir / "teams" / team_id / "events.jsonl"
    if not ep.exists():
        return []
    rows = []
    for line in ep.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
    return rows
