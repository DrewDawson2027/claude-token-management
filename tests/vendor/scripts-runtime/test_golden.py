"""Golden-file tests: seed known state, compare outputs against golden files."""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = TESTS_DIR.parent
for p in [str(SCRIPTS_DIR), str(TESTS_DIR)]:
    if p not in sys.path:
        sys.path.insert(0, p)

import team_runtime as tr
from conftest import seed_team, seed_messages, seed_events

GOLDEN_DIR = Path(__file__).parent / "golden"
UPDATE_GOLDEN = os.environ.get("UPDATE_GOLDEN", "0") == "1"


def _normalize_output(text: str) -> str:
    """Normalize timestamps and dynamic values for stable comparison."""
    text = re.sub(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", "<TS>", text)
    text = re.sub(r"M\d{13,}", "M<EPOCH>", text)
    # Normalize age strings like "5m", "42s", and decimal durations like "300.0s".
    text = re.sub(r"\b\d+(?:\.\d+)?[smhd]\b", "<AGE>", text)
    return text


def _compare_golden(name: str, actual: str):
    golden_path = GOLDEN_DIR / f"{name}.txt"
    actual_normalized = _normalize_output(actual)

    if UPDATE_GOLDEN:
        GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
        golden_path.write_text(actual_normalized)
        return

    if not golden_path.exists():
        GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
        golden_path.write_text(actual_normalized)
        pytest.skip(f"Golden file {name}.txt created -- re-run to validate")

    expected = golden_path.read_text()
    assert actual_normalized == expected, (
        f"Golden file mismatch for {name}.\n"
        f"Set UPDATE_GOLDEN=1 to regenerate.\n"
        f"--- Expected (first 500) ---\n{expected[:500]}\n"
        f"--- Actual (first 500) ---\n{actual_normalized[:500]}"
    )


def _seed_known_state(claude_dir: Path) -> str:
    team_id = "golden-team"
    members = [
        {
            "memberId": "lead",
            "name": "lead",
            "role": "lead",
            "sessionId": "goldsess1",
            "paneId": "%0",
        },
        {
            "memberId": "alice",
            "name": "alice",
            "role": "teammate",
            "sessionId": "goldsess2",
            "paneId": "%1",
        },
        {
            "memberId": "bob",
            "name": "bob",
            "role": "teammate",
            "sessionId": "goldsess3",
            "paneId": "%2",
        },
    ]
    tasks = [
        {
            "taskId": "GT-1",
            "title": "Build auth module",
            "status": "completed",
            "assignee": "alice",
            "dependsOn": [],
            "priority": "high",
            "description": "Implement JWT auth",
            "labels": ["backend"],
            "createdAt": "2026-02-19T10:00:00Z",
            "completedAt": "2026-02-19T18:00:00Z",
        },
        {
            "taskId": "GT-2",
            "title": "Write tests",
            "status": "in_progress",
            "assignee": "bob",
            "dependsOn": ["GT-1"],
            "priority": "normal",
            "description": "Unit tests for auth",
            "labels": ["test"],
            "createdAt": "2026-02-19T10:00:00Z",
        },
        {
            "taskId": "GT-3",
            "title": "Deploy to staging",
            "status": "blocked",
            "assignee": None,
            "dependsOn": ["GT-2"],
            "priority": "low",
            "description": "Deploy after tests pass",
            "labels": ["ops"],
            "createdAt": "2026-02-19T10:00:00Z",
        },
    ]
    seed_team(claude_dir, team_id, members=members, tasks=tasks)

    seed_messages(
        claude_dir,
        team_id,
        [
            {
                "id": "GM-1",
                "ts": "2026-02-19T12:00:00Z",
                "fromMember": "lead",
                "toMember": "alice",
                "priority": "normal",
                "content": "Start on auth",
                "channelType": "p2p",
                "status": "acknowledged",
                "threadId": "GM-1",
                "deliveredAt": "2026-02-19T12:00:01Z",
                "acknowledgedAt": "2026-02-19T12:05:00Z",
                "retryCount": 0,
                "expiresAt": "2026-02-20T12:00:00Z",
            },
        ],
    )

    seed_events(
        claude_dir,
        team_id,
        [
            {
                "id": 1,
                "ts": "2026-02-19T10:00:00Z",
                "type": "TeamBootstrapped",
                "spawned": ["alice", "bob"],
                "preset": "standard",
            },
        ],
    )

    return team_id


class TestGoldenDashboard:
    def test_dashboard_golden(self, claude_dir, mock_subprocess):
        team_id = _seed_known_state(claude_dir)
        result = tr.cmd_team_dashboard(argparse.Namespace(team_id=team_id))
        _compare_golden("dashboard", result)


class TestGoldenStatus:
    def test_status_golden(self, claude_dir, mock_subprocess):
        team_id = _seed_known_state(claude_dir)
        result = tr.cmd_team_status(
            argparse.Namespace(
                team_id=team_id,
                include_tasks=False,
            )
        )
        _compare_golden("status", result)


class TestGoldenTaskList:
    def test_task_list_golden(self, claude_dir, mock_subprocess):
        team_id = _seed_known_state(claude_dir)
        result = tr.cmd_task_list(
            argparse.Namespace(
                team_id=team_id,
                status=None,
                label=None,
            )
        )
        _compare_golden("task_list", result)


class TestGoldenTaskGraph:
    def test_task_graph_golden(self, claude_dir, mock_subprocess):
        team_id = _seed_known_state(claude_dir)
        result = tr.cmd_task_graph(argparse.Namespace(team_id=team_id))
        _compare_golden("task_graph", result)


class TestGoldenCostSummary:
    def test_cost_render_golden(self, cost_dir):
        import cost_runtime as cr

        cr.load_or_init_files()
        res = {
            "window": "today",
            "source": "local",
            "totals": {
                "totalUSD": 3.45,
                "localCostUSD": 3.45,
                "inputTokens": 150000,
                "outputTokens": 75000,
                "cacheCreationTokens": 10000,
                "cacheReadTokens": 50000,
                "messages": 42,
            },
            "budget": {
                "scope": "global",
                "period": "daily",
                "limitUSD": 10.0,
                "currentUSD": 3.45,
                "pct": 34.5,
                "level": "ok",
            },
            "local": {"models": {}, "teams": {}},
        }
        rendered = cr.render_summary(res)
        _compare_golden("cost_summary", rendered)
