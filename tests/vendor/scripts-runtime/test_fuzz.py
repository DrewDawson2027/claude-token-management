"""Fuzz tests for JSON/JSONL/event parsing resilience using hypothesis."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pytest
from hypothesis import given, settings, HealthCheck
from hypothesis import strategies as st

TESTS_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = TESTS_DIR.parent
for p in [str(SCRIPTS_DIR), str(TESTS_DIR)]:
    if p not in sys.path:
        sys.path.insert(0, p)

import team_runtime as tr
from conftest import write_json, seed_team

# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------
safe_id_chars = st.text(
    alphabet="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-",
    min_size=1,
    max_size=50,
)

hostile_strings = st.one_of(
    st.text(min_size=0, max_size=200),
    st.sampled_from(
        [
            "",
            " ",
            "\n",
            "\t",
            "\0",
            "\x00\x01\x02",
            "../../../etc/passwd",
            "/dev/null",
            '{"injection": true}',
            "'; DROP TABLE teams; --",
            "a" * 500,
            "null",
            "undefined",
            "NaN",
            "Infinity",
            '<script>alert("xss")</script>',
        ]
    ),
)

json_payloads = st.one_of(
    st.dictionaries(st.text(max_size=20), st.text(max_size=50), max_size=5),
    st.just({}),
    st.just({"id": "test", "type": "event"}),
)


# ---------------------------------------------------------------------------
# safe_id fuzz tests
# ---------------------------------------------------------------------------
class TestSafeIdFuzz:
    @given(safe_id_chars)
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_valid_ids_accepted(self, s):
        # Skip strings containing ".." which safe_id rejects
        if ".." in s:
            return
        result = tr.safe_id(s, "test")
        assert result == s

    @given(hostile_strings)
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_hostile_ids_rejected_or_accepted(self, s):
        """Hostile strings should either be rejected (ValueError) or pass validation."""
        try:
            result = tr.safe_id(s, "test")
            assert tr.SAFE_ID_RE.match(result)
        except ValueError:
            pass  # Expected for invalid IDs

    def test_empty_id_rejected(self):
        with pytest.raises(ValueError):
            tr.safe_id("", "test")

    def test_path_traversal_rejected(self):
        with pytest.raises(ValueError):
            tr.safe_id("../../../etc/passwd", "test")

    def test_null_bytes_rejected(self):
        with pytest.raises(ValueError):
            tr.safe_id("id\x00evil", "test")

    def test_long_id_rejected(self):
        with pytest.raises(ValueError):
            tr.safe_id("a" * 200, "test")

    def test_spaces_rejected(self):
        with pytest.raises(ValueError):
            tr.safe_id("has space", "test")


# ---------------------------------------------------------------------------
# JSONL parsing fuzz tests
# ---------------------------------------------------------------------------
class TestReadJsonlFuzz:
    def test_corrupt_lines_skipped(self, tmp_path):
        path = tmp_path / "test.jsonl"
        lines = [
            '{"valid": 1}',
            "not json at all",
            '{"also_valid": 2}',
            "",
            "{broken json",
            '{"third": 3}',
            "random garbage",
        ]
        path.write_text("\n".join(lines))
        result = tr.read_jsonl(path)
        assert len(result) == 3
        assert result[0] == {"valid": 1}
        assert result[1] == {"also_valid": 2}
        assert result[2] == {"third": 3}

    def test_binary_garbage_survives(self, tmp_path):
        """Binary garbage should not crash read_jsonl."""
        path = tmp_path / "garbage.jsonl"
        # Write a mix of binary garbage and valid JSON
        with path.open("w", encoding="utf-8", errors="replace") as f:
            f.write("garbage line\n")
            f.write('{"ok": true}\n')
            f.write("more garbage\n")
        result = tr.read_jsonl(path)
        assert len(result) == 1
        assert result[0] == {"ok": True}

    def test_empty_file(self, tmp_path):
        path = tmp_path / "empty.jsonl"
        path.write_text("")
        result = tr.read_jsonl(path)
        assert result == []

    def test_nonexistent_file(self, tmp_path):
        path = tmp_path / "nope.jsonl"
        result = tr.read_jsonl(path)
        assert result == []

    @given(st.lists(json_payloads, min_size=0, max_size=20))
    @settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow])
    def test_roundtrip_jsonl(self, payloads):
        """Written JSONL should be readable."""
        import tempfile

        with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
            path = Path(f.name)
        try:
            tr.write_jsonl(path, payloads)
            result = tr.read_jsonl(path)
            assert len(result) == len(payloads)
        finally:
            path.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# read_json fuzz tests
# ---------------------------------------------------------------------------
class TestReadJsonFuzz:
    def test_binary_garbage_returns_default(self, tmp_path):
        path = tmp_path / "garbage.json"
        path.write_bytes(b"\x00\x01\x02\xff\xfe")
        result = tr.read_json(path, {"fallback": True})
        assert result == {"fallback": True}

    def test_nonexistent_returns_default(self, tmp_path):
        result = tr.read_json(tmp_path / "nope.json", {"default": True})
        assert result == {"default": True}

    def test_valid_json_returned(self, tmp_path):
        path = tmp_path / "valid.json"
        path.write_text('{"key": "value"}')
        result = tr.read_json(path)
        assert result == {"key": "value"}


# ---------------------------------------------------------------------------
# Event compact fuzz tests
# ---------------------------------------------------------------------------
class TestEventCompactFuzz:
    def test_large_event_file_compacts(self, claude_dir):
        team_id = "compact-test"
        team_dir = claude_dir / "teams" / team_id
        team_dir.mkdir(parents=True, exist_ok=True)
        for sub in ["mailboxes", "control", "claims", "cursors"]:
            (team_dir / sub).mkdir(exist_ok=True)

        write_json(
            team_dir / "config.json",
            {
                "teamId": team_id,
                "name": team_id,
                "members": [],
                "createdAt": "2026-02-20T00:00:00Z",
            },
        )
        write_json(
            team_dir / "runtime.json",
            {
                "state": "running",
                "event_seq": 5000,
                "tmux_session": None,
            },
        )
        write_json(team_dir / "tasks.json", {"tasks": []})
        write_json(team_dir / "worker-map.json", {"workers": []})

        events_path = team_dir / "events.jsonl"
        with events_path.open("w") as f:
            for i in range(2000):
                f.write(
                    json.dumps({"id": i, "ts": "2026-02-20T00:00:00Z", "type": "test"})
                    + "\n"
                )

        store = tr.TeamStore(team_id)
        removed = store.compact_events(keep=500)
        assert removed == 1500

        remaining = tr.read_jsonl(events_path)
        assert len(remaining) == 500
        assert remaining[0]["id"] == 1500

    def test_compact_noop_when_small(self, claude_dir):
        team_id = "compact-small"
        team_dir = claude_dir / "teams" / team_id
        team_dir.mkdir(parents=True, exist_ok=True)
        for sub in ["mailboxes", "control", "claims", "cursors"]:
            (team_dir / sub).mkdir(exist_ok=True)

        write_json(
            team_dir / "config.json",
            {
                "teamId": team_id,
                "name": team_id,
                "members": [],
                "createdAt": "2026-02-20T00:00:00Z",
            },
        )
        write_json(
            team_dir / "runtime.json",
            {
                "state": "running",
                "event_seq": 10,
                "tmux_session": None,
            },
        )
        write_json(team_dir / "tasks.json", {"tasks": []})
        write_json(team_dir / "worker-map.json", {"workers": []})

        events_path = team_dir / "events.jsonl"
        with events_path.open("w") as f:
            for i in range(10):
                f.write(
                    json.dumps({"id": i, "ts": "2026-02-20T00:00:00Z", "type": "test"})
                    + "\n"
                )

        store = tr.TeamStore(team_id)
        removed = store.compact_events(keep=1000)
        assert removed == 0


# ---------------------------------------------------------------------------
# Hypothesis: task state transitions
# ---------------------------------------------------------------------------
valid_statuses = st.sampled_from(
    [
        "pending",
        "blocked",
        "claimed",
        "in_progress",
        "completed",
        "cancelled",
        "awaiting_approval",
    ]
)


class TestTaskStateFuzz:
    @given(valid_statuses, valid_statuses)
    @settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow])
    def test_status_transitions_dont_crash(self, from_status, to_status):
        """Any valid status transition should not crash (may be rejected gracefully)."""
        import tempfile

        tmp = Path(tempfile.mkdtemp())
        base = tmp / ".claude"
        teams = base / "teams"
        terminals = base / "terminals"
        for d in [
            teams,
            terminals,
            terminals / "inbox",
            terminals / "results",
            base / "archives" / "teams",
        ]:
            d.mkdir(parents=True, exist_ok=True)

        # Temporarily patch module-level dirs
        import team_runtime as _tr

        old_teams = _tr.TEAMS_DIR
        old_terminals = _tr.TERMINALS_DIR
        old_inbox = _tr.INBOX_DIR
        old_results = _tr.RESULTS_DIR
        old_archives = _tr.ARCHIVES_DIR
        _tr.TEAMS_DIR = teams
        _tr.TERMINALS_DIR = terminals
        _tr.INBOX_DIR = terminals / "inbox"
        _tr.RESULTS_DIR = terminals / "results"
        _tr.ARCHIVES_DIR = base / "archives" / "teams"

        try:
            team_id = "fuzz-trans"
            seed_team(
                base,
                team_id,
                tasks=[
                    {
                        "taskId": "FT-1",
                        "title": "Fuzz task",
                        "status": from_status,
                        "assignee": "worker1",
                        "dependsOn": [],
                        "priority": "normal",
                        "description": "",
                        "labels": [],
                        "createdAt": "2026-02-20T00:00:00Z",
                    },
                ],
            )
            try:
                _tr.cmd_task_update(
                    argparse.Namespace(
                        team_id=team_id,
                        task_id="FT-1",
                        status=to_status,
                        member_id=None,
                        note=None,
                        add_label=None,
                        remove_label=None,
                    )
                )
            except (SystemExit, ValueError, KeyError):
                pass
        finally:
            _tr.TEAMS_DIR = old_teams
            _tr.TERMINALS_DIR = old_terminals
            _tr.INBOX_DIR = old_inbox
            _tr.RESULTS_DIR = old_results
            _tr.ARCHIVES_DIR = old_archives
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)
