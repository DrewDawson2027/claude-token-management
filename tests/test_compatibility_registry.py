from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

OPS_DIR = Path(__file__).resolve().parents[1] / "src" / "hooks" / "ops"
INFRA_DIR = Path(__file__).resolve().parents[1] / "src" / "hooks" / "infrastructure"
for candidate in (OPS_DIR, INFRA_DIR):
    candidate_str = str(candidate)
    if candidate_str not in sys.path:
        sys.path.insert(0, candidate_str)


def load_registry_module(monkeypatch, runtime_root: Path):
    monkeypatch.setenv("CLAUDE_RUNTIME_DIR", str(runtime_root))
    sys.modules.pop("compatibility_registry", None)
    return importlib.import_module("compatibility_registry")


def test_default_compatibility_report_has_benchmark_and_repro_coverage(
    tmp_path, monkeypatch
):
    runtime_root = tmp_path / ".claude"
    registry_mod = load_registry_module(monkeypatch, runtime_root)

    report = registry_mod.build_report(registry_mod.default_registry())

    assert report["summary"]["total_issues"] >= 8
    assert report["summary"]["issues_with_benchmarks"] >= 5
    assert report["summary"]["issues_with_repro_commands"] >= 5
    assert report["summary"]["benchmark_coverage_pct"] > 50


def test_compatibility_intake_persists_new_issue(tmp_path, monkeypatch):
    runtime_root = tmp_path / ".claude"
    registry_mod = load_registry_module(monkeypatch, runtime_root)

    registry_mod.upsert_issue(
        issue_id="new-runtime-regression",
        title="New runtime regression",
        issue_class="compatibility",
        severity="high",
        ownership="upstream",
        status="active",
        impact="Fresh regression intake should persist to the runtime registry.",
        local_controls=["compatibility registry"],
        detection=["manual intake"],
        benchmarks=["drain_bench.prompt-cache"],
        repro_commands=["claude-token-guard ops compatibility --json"],
        unresolved_reason="Awaiting reproduction and benchmark rerun.",
    )

    stored = json.loads(registry_mod.registry_path().read_text())
    issue_ids = {issue["issue_id"] for issue in stored["issues"]}
    assert "new-runtime-regression" in issue_ids

    report = registry_mod.build_report(stored)
    assert report["summary"]["total_issues"] >= len(registry_mod.DEFAULT_ISSUES) + 1
