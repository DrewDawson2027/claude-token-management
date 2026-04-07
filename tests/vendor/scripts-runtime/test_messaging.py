"""Integration tests for messaging: send, inbox, ack, broadcast, threads, announcements."""

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
from conftest import seed_team


class TestMessageSendReceiveAck:
    def test_send_and_inbox(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "msg-team")
        result = tr.cmd_message_send(
            argparse.Namespace(
                team_id="msg-team",
                from_member="lead",
                to_member="worker1",
                content="Hello worker",
                priority="normal",
                message_id=None,
                ttl_seconds=86400,
                reply_to_message_id=None,
                thread_id=None,
            )
        )
        assert "lead" in result
        assert "worker1" in result

        inbox = tr.cmd_message_inbox(
            argparse.Namespace(
                team_id="msg-team",
                member_id="worker1",
                clear=False,
            )
        )
        assert "worker1" in inbox

    def test_ack_message(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "ack-team")
        tr.cmd_message_send(
            argparse.Namespace(
                team_id="ack-team",
                from_member="lead",
                to_member="worker1",
                content="Ack me",
                priority="normal",
                message_id="M-ack-001",
                ttl_seconds=86400,
                reply_to_message_id=None,
                thread_id=None,
            )
        )
        result = tr.cmd_message_ack(
            argparse.Namespace(
                team_id="ack-team",
                member_id="worker1",
                message_id="M-ack-001",
                outcome="completed",
                note="Done",
            )
        )
        assert "acknowledged" in result.lower() or "ack" in result.lower()

    def test_duplicate_message_suppressed(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "dup-msg")
        args = argparse.Namespace(
            team_id="dup-msg",
            from_member="lead",
            to_member="worker1",
            content="Dup test",
            priority="normal",
            message_id="M-dup-001",
            ttl_seconds=86400,
            reply_to_message_id=None,
            thread_id=None,
        )
        tr.cmd_message_send(args)
        result = tr.cmd_message_send(
            argparse.Namespace(
                team_id="dup-msg",
                from_member="lead",
                to_member="worker1",
                content="Dup test",
                priority="normal",
                message_id="M-dup-001",
                ttl_seconds=86400,
                reply_to_message_id=None,
                thread_id=None,
            )
        )
        assert "Duplicate" in result or "already exists" in result


class TestBroadcast:
    def test_broadcast_delivers_to_all(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "bcast-team")
        result = tr.cmd_message_broadcast(
            argparse.Namespace(
                team_id="bcast-team",
                from_member="lead",
                content="All hands",
                priority="normal",
                message_id_prefix="B",
                ttl_seconds=86400,
                exclude_members=[],
                include_lead=False,
                announcement=False,
                reply_to_message_id=None,
            )
        )
        assert (
            "worker1" in result
            or "broadcast" in result.lower()
            or "Delivered" in result
        )


class TestMessageThread:
    def test_thread_grouping(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "thread-team")
        tr.cmd_message_send(
            argparse.Namespace(
                team_id="thread-team",
                from_member="lead",
                to_member="worker1",
                content="Thread start",
                priority="normal",
                message_id="T-001",
                ttl_seconds=86400,
                reply_to_message_id=None,
                thread_id=None,
            )
        )
        tr.cmd_message_send(
            argparse.Namespace(
                team_id="thread-team",
                from_member="worker1",
                to_member="lead",
                content="Reply",
                priority="normal",
                message_id="T-002",
                ttl_seconds=86400,
                reply_to_message_id="T-001",
                thread_id=None,
            )
        )
        result = tr.cmd_message_thread(
            argparse.Namespace(
                team_id="thread-team",
                thread_id="T-001",
                limit=10,
            )
        )
        assert "T-001" in result


class TestAnnouncements:
    def test_announcement_sticky(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "ann-team")
        result = tr.cmd_team_announce(
            argparse.Namespace(
                team_id="ann-team",
                from_member="lead",
                content="Important update",
                sticky=True,
                priority="high",
                message_id_prefix="ANN",
                ttl_seconds=86400,
            )
        )
        assert "announce" in result.lower() or "ANN" in result or "Delivered" in result

        anns = tr.cmd_message_announcements(
            argparse.Namespace(
                team_id="ann-team",
                include_expired=False,
                only_sticky=True,
                limit=10,
            )
        )
        assert "Important update" in anns or "sticky" in anns.lower() or "ANN" in anns


class TestReceiptsDashboard:
    def test_receipts_stats(self, claude_dir, mock_subprocess):
        seed_team(claude_dir, "rcpt-team")
        tr.cmd_message_send(
            argparse.Namespace(
                team_id="rcpt-team",
                from_member="lead",
                to_member="worker1",
                content="Track me",
                priority="normal",
                message_id="R-001",
                ttl_seconds=86400,
                reply_to_message_id=None,
                thread_id=None,
            )
        )
        result = tr.cmd_message_receipts_dashboard(
            argparse.Namespace(
                team_id="rcpt-team",
            )
        )
        assert (
            "open" in result.lower()
            or "stale" in result.lower()
            or "delivery" in result.lower()
            or "Delivery" in result
        )
