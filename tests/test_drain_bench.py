from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
for candidate in (
    REPO_ROOT / "src" / "scripts" / "core",
    REPO_ROOT / "src" / "cli",
):
    candidate_str = str(candidate)
    if candidate.exists() and candidate_str not in sys.path:
        sys.path.insert(0, candidate_str)

from drain_bench import build_report, load_scenarios, render_markdown  # noqa: E402
from claude_token_guard import cli  # noqa: E402


def test_drain_bench_report_passes_fixture_cases():
    fixture = REPO_ROOT / "tests" / "fixtures" / "token-drain-scenarios.json"
    report = build_report(load_scenarios(str(fixture)))
    assert report["summary"]["failed"] == 0
    assert report["summary"]["passed"] == report["summary"]["total"]


def test_drain_bench_report_shape_is_machine_readable():
    fixture = REPO_ROOT / "tests" / "fixtures" / "token-drain-scenarios.json"
    report = build_report(load_scenarios(str(fixture)))
    assert report["schema_version"] == 1
    assert report["summary"]["total"] == 9
    assert len(report["suites"]) == 6


def test_drain_bench_markdown_mentions_runtime_and_suite_names():
    fixture = REPO_ROOT / "tests" / "fixtures" / "token-drain-scenarios.json"
    report = build_report(load_scenarios(str(fixture)))
    markdown = render_markdown(report)
    assert "Token Drain Benchmark Report" in markdown
    assert "prompt-cache" in markdown
    assert "Runtime:" in markdown


def test_cli_benchmark_command_emits_json(capsys, monkeypatch):
    fixture = REPO_ROOT / "tests" / "fixtures" / "token-drain-scenarios.json"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "claude-token-guard",
            "benchmark",
            "--suite",
            "drain",
            "--fixture",
            str(fixture),
            "--json",
        ],
    )
    cli.cmd_benchmark()
    out = capsys.readouterr().out
    parsed = json.loads(out)
    assert parsed["summary"]["failed"] == 0
    assert any(suite["suite"] == "prompt-cache" for suite in parsed["suites"])
