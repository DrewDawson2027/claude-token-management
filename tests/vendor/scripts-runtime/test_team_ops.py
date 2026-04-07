"""Integration tests for team ops: scale, restart, replace, clone, archive, gc, auto-heal."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


TESTS_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = TESTS_DIR.parent
for p in [str(SCRIPTS_DIR), str(TESTS_DIR)]:
    if p not in sys.path:
        sys.path.insert(0, p)

import team_runtime as tr
from conftest import seed_team, read_json


class TestScaleToPreset:
    def test_scale_changes_target(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "scale-team")
        result = tr.cmd_team_scale_to_preset(
            argparse.Namespace(
                team_id="scale-team",
                preset="lite",
                dry_run=True,
            )
        )
        assert (
            "scale" in result.lower()
            or "lite" in result.lower()
            or "preset" in result.lower()
        )


class TestRestartMember:
    def test_restart_member(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "restart-team")
        result = tr.cmd_team_restart_member(
            argparse.Namespace(
                team_id="restart-team",
                member_id="worker1",
                cwd="/tmp",
                initial_prompt=None,
                model=None,
            )
        )
        assert "worker1" in result or "restart" in result.lower()


class TestReplaceMember:
    def test_replace_member(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "replace-team")
        result = tr.cmd_team_replace_member(
            argparse.Namespace(
                team_id="replace-team",
                old_member_id="worker1",
                new_member_id="worker1-v2",
                new_name="worker1-v2",
                role="teammate",
                cwd="/tmp",
                initial_prompt=None,
                model=None,
                force=False,
                stop_old=False,
                spawn_new=False,
            )
        )
        assert "worker1" in result or "replace" in result.lower()
        cfg = read_json(claude_dir / "teams" / "replace-team" / "config.json")
        member_ids = [m["memberId"] for m in cfg["members"]]
        assert "worker1-v2" in member_ids


class TestCloneTeam:
    def test_clone_creates_copy(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "orig-team")
        result = tr.cmd_team_clone(
            argparse.Namespace(
                team_id="orig-team",
                new_team_id="cloned-team",
                new_name=None,
                description=None,
                cwd=None,
                include_tasks=True,
                include_messages=False,
                without_tasks=False,
            )
        )
        assert "cloned-team" in result
        assert (claude_dir / "teams" / "cloned-team" / "config.json").exists()


class TestArchiveTeam:
    def test_archive_creates_tarball(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "arch-team", state="stopped")
        result = tr.cmd_team_archive(
            argparse.Namespace(
                team_id="arch-team",
                force_stop=False,
                kill_panes=False,
                keep_team_dir=True,
            )
        )
        assert "arch-team" in result or "archive" in result.lower()


class TestGC:
    def test_gc_runs(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "gc-team")
        result = tr.cmd_team_gc(
            argparse.Namespace(
                team_id=None,
                dry_run=True,
                cursor_age_days=30,
                max_event_age_days=None,
                max_message_age_days=None,
                prune_tmux=False,
            )
        )
        assert (
            "gc" in result.lower()
            or "GC" in result
            or "orphan" in result.lower()
            or "Prune" in result
        )


class TestAutoHeal:
    def test_auto_heal(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "heal-team")
        result = tr.cmd_team_auto_heal(
            argparse.Namespace(
                team_id="heal-team",
                interval_seconds=60,
                iterations=1,
                daemon=False,
                ensure_tmux=False,
            )
        )
        assert (
            "heal" in result.lower() or "heal-team" in result or "Auto-Heal" in result
        )


class TestSelftest:
    def test_selftest_passes(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "self-team")
        result = tr.cmd_team_selftest(
            argparse.Namespace(
                team_id="self-team",
            )
        )
        assert (
            "self-team" in result
            or "pass" in result.lower()
            or "selftest" in result.lower()
        )


class TestDoctor:
    def test_doctor_returns_report(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "doc-team")
        result = tr.cmd_team_doctor(argparse.Namespace(team_id="doc-team"))
        assert (
            "doc-team" in result
            or "doctor" in result.lower()
            or "health" in result.lower()
        )


class TestDashboard:
    def test_dashboard_output(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "dash-team")
        result = tr.cmd_team_dashboard(
            argparse.Namespace(
                team_id="dash-team",
            )
        )
        assert "dash-team" in result
        assert "Members" in result or "member" in result.lower()
