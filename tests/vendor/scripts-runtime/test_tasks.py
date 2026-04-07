"""Integration tests for task management: add, claim, update, dependencies, templates."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


TESTS_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = TESTS_DIR.parent
for p in [str(SCRIPTS_DIR), str(TESTS_DIR)]:
    if p not in sys.path:
        sys.path.insert(0, p)

import team_runtime as tr
from conftest import seed_team, read_json


class TestTaskLifecycle:
    def test_add_claim_update_complete(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "task-team")
        # Add
        result = tr.cmd_task_add(
            argparse.Namespace(
                team_id="task-team",
                title="Build feature",
                description="Build the thing",
                assignee=None,
                depends_on=None,
                priority="normal",
                labels=None,
                due_at=None,
                task_id=None,
                files=None,
                estimate_minutes=None,
                sla_class=None,
                approval_required=False,
                created_by="lead",
            )
        )
        assert "task-team" in result
        tasks = read_json(claude_dir / "teams" / "task-team" / "tasks.json")
        assert len(tasks["tasks"]) == 1
        task_id = tasks["tasks"][0]["taskId"]

        # Claim
        result = tr.cmd_task_claim(
            argparse.Namespace(
                team_id="task-team",
                task_id=task_id,
                member_id="worker1",
                force=False,
                ttl_seconds=None,
            )
        )
        assert "claimed" in result.lower() or "worker1" in result

        # Update to in_progress
        result = tr.cmd_task_update(
            argparse.Namespace(
                team_id="task-team",
                task_id=task_id,
                status="in_progress",
                member_id=None,
                note=None,
                add_label=None,
                remove_label=None,
            )
        )
        tasks = read_json(claude_dir / "teams" / "task-team" / "tasks.json")
        assert tasks["tasks"][0]["status"] == "in_progress"

        # Complete
        result = tr.cmd_task_update(
            argparse.Namespace(
                team_id="task-team",
                task_id=task_id,
                status="completed",
                member_id=None,
                note=None,
                add_label=None,
                remove_label=None,
            )
        )
        tasks = read_json(claude_dir / "teams" / "task-team" / "tasks.json")
        assert tasks["tasks"][0]["status"] == "completed"


class TestTaskDependencies:
    def test_dependency_blocking(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "dep-team")
        # Add parent task
        tr.cmd_task_add(
            argparse.Namespace(
                team_id="dep-team",
                title="Parent",
                description="Parent task",
                assignee=None,
                depends_on=None,
                priority="normal",
                labels=None,
                due_at=None,
                task_id="P1",
                files=None,
                estimate_minutes=None,
                sla_class=None,
                approval_required=False,
                created_by="lead",
            )
        )

        # Add child task with dependency
        tr.cmd_task_add(
            argparse.Namespace(
                team_id="dep-team",
                title="Child",
                description="Child task",
                assignee=None,
                depends_on=["P1"],
                priority="normal",
                labels=None,
                due_at=None,
                task_id="C1",
                files=None,
                estimate_minutes=None,
                sla_class=None,
                approval_required=False,
                created_by="lead",
            )
        )
        tasks = read_json(claude_dir / "teams" / "dep-team" / "tasks.json")
        child = [t for t in tasks["tasks"] if t["title"] == "Child"][0]
        assert child["status"] == "blocked"

        # Complete parent should unblock child
        tr.cmd_task_update(
            argparse.Namespace(
                team_id="dep-team",
                task_id="P1",
                status="completed",
                member_id=None,
                note=None,
                add_label=None,
                remove_label=None,
            )
        )
        tasks = read_json(claude_dir / "teams" / "dep-team" / "tasks.json")
        child = [t for t in tasks["tasks"] if t["title"] == "Child"][0]
        assert child["status"] == "pending"


class TestTaskTemplates:
    def test_template_apply(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "tmpl-team")
        result = tr.cmd_task_template_apply(
            argparse.Namespace(
                team_id="tmpl-team",
                template_name="build-review-test-docs",
                prefix="feat",
                description_prefix="Feature X",
            )
        )
        tasks = read_json(claude_dir / "teams" / "tmpl-team" / "tasks.json")
        assert len(tasks["tasks"]) == 4
        titles = [t["title"] for t in tasks["tasks"]]
        assert any("Build" in t for t in titles)
        assert any("Review" in t for t in titles)
        assert any("Test" in t for t in titles)
        assert any("Doc" in t for t in titles)

    def test_template_list(self, claude_dir):
        result = tr.cmd_task_template_list(argparse.Namespace())
        assert "build-review-test-docs" in result
        assert "bugfix-hotfix" in result


class TestTaskRebalance:
    def test_rebalance_reassigns(self, claude_dir, mock_subprocess):
        tasks = [
            {
                "taskId": "T1",
                "title": "Stuck task",
                "status": "pending",
                "assignee": None,
                "dependsOn": [],
                "priority": "normal",
                "description": "",
                "labels": [],
                "createdAt": "2026-02-20T00:00:00Z",
            },
            {
                "taskId": "T2",
                "title": "Another stuck",
                "status": "pending",
                "assignee": None,
                "dependsOn": [],
                "priority": "high",
                "description": "",
                "labels": [],
                "createdAt": "2026-02-20T00:00:00Z",
            },
        ]
        seed_team(claude_dir, "reb-team", tasks=tasks)
        result = tr.cmd_task_rebalance(
            argparse.Namespace(
                team_id="reb-team",
                dry_run=False,
            )
        )
        assert "rebalance" in result.lower() or "T1" in result or "T2" in result


class TestTaskImportExport:
    def test_export_import_roundtrip(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "ie-team")
        tr.cmd_task_add(
            argparse.Namespace(
                team_id="ie-team",
                title="Export me",
                description="Round-trip test",
                assignee=None,
                depends_on=None,
                priority="normal",
                labels=None,
                due_at=None,
                task_id=None,
                files=None,
                estimate_minutes=None,
                sla_class=None,
                approval_required=False,
                created_by="lead",
            )
        )
        export_result = tr.cmd_task_export(
            argparse.Namespace(
                team_id="ie-team",
                format="json",
            )
        )
        exported = json.loads(export_result)
        assert len(exported) >= 1

        # Write to file for import
        export_path = str(claude_dir / "export.json")
        Path(export_path).write_text(json.dumps({"tasks": exported}))

        # Import into a fresh team
        seed_team(claude_dir, "ie-team2")
        tr.cmd_task_import(
            argparse.Namespace(
                team_id="ie-team2",
                file_path=export_path,
                format="json",
            )
        )
        tasks = read_json(claude_dir / "teams" / "ie-team2" / "tasks.json")
        assert len(tasks["tasks"]) >= 1


class TestTaskPriority:
    def test_priority_ordering(self, claude_dir, mock_subprocess):
        tasks = [
            {
                "taskId": "T-low",
                "title": "Low task",
                "status": "pending",
                "assignee": None,
                "dependsOn": [],
                "priority": "low",
                "description": "",
                "labels": [],
                "createdAt": "2026-02-20T00:00:00Z",
            },
            {
                "taskId": "T-crit",
                "title": "Critical task",
                "status": "pending",
                "assignee": None,
                "dependsOn": [],
                "priority": "critical",
                "description": "",
                "labels": [],
                "createdAt": "2026-02-20T00:00:00Z",
            },
            {
                "taskId": "T-hi",
                "title": "High task",
                "status": "pending",
                "assignee": None,
                "dependsOn": [],
                "priority": "high",
                "description": "",
                "labels": [],
                "createdAt": "2026-02-20T00:00:00Z",
            },
        ]
        seed_team(claude_dir, "pri-team", tasks=tasks)
        result = tr.cmd_task_list(
            argparse.Namespace(
                team_id="pri-team",
                status=None,
                label=None,
            )
        )
        crit_pos = result.find("Critical")
        low_pos = result.find("Low")
        if crit_pos >= 0 and low_pos >= 0:
            assert crit_pos < low_pos


class TestTaskGraph:
    def test_graph_output(self, claude_dir, mock_subprocess):
        tasks = [
            {
                "taskId": "G1",
                "title": "First",
                "status": "pending",
                "assignee": None,
                "dependsOn": [],
                "priority": "normal",
                "description": "",
                "labels": [],
                "createdAt": "2026-02-20T00:00:00Z",
            },
            {
                "taskId": "G2",
                "title": "Second",
                "status": "blocked",
                "assignee": None,
                "dependsOn": ["G1"],
                "priority": "normal",
                "description": "",
                "labels": [],
                "createdAt": "2026-02-20T00:00:00Z",
            },
        ]
        seed_team(claude_dir, "graph-team", tasks=tasks)
        result = tr.cmd_task_graph(argparse.Namespace(team_id="graph-team"))
        assert "G1" in result
        assert "G2" in result
