"""Integration tests for cost_runtime: summary, budget, index, export, burn rate."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = TESTS_DIR.parent
for p in [str(SCRIPTS_DIR), str(TESTS_DIR)]:
    if p not in sys.path:
        sys.path.insert(0, p)

import cost_runtime as cr
from conftest import seed_usage_records


def _make_usage_record(
    ts: str, cost_usd: float = 0.01, input_tokens: int = 1000, output_tokens: int = 500
) -> dict:
    return {
        "timestamp": ts,
        "sessionId": "sess00010000-0000-0000-000000000000",
        "message": {
            "model": "claude-sonnet-4-6",
            "type": "assistant",
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0,
                "costUSD": cost_usd,
            },
        },
    }


class TestSummary:
    def test_summary_today_empty(self, cost_dir):
        cr.load_or_init_files()
        res = cr.summarize("today", None, None, None, None, None, None, False)
        assert res["window"] == "today"
        assert res["totals"]["messages"] == 0

    def test_summary_today_with_records(self, cost_dir):
        cr.load_or_init_files()
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        seed_usage_records(
            cr.PROJECTS_DIR,
            [
                _make_usage_record(
                    now, cost_usd=0.05, input_tokens=2000, output_tokens=1000
                ),
                _make_usage_record(
                    now, cost_usd=0.03, input_tokens=1500, output_tokens=800
                ),
            ],
        )
        res = cr.summarize("today", None, None, None, None, None, None, False)
        assert res["totals"]["messages"] == 2
        assert res["totals"]["inputTokens"] == 3500
        assert res["totals"]["outputTokens"] == 1800


class TestBudget:
    def test_set_and_check_budget(self, cost_dir):
        cr.load_or_init_files()
        # Set budget
        b = cr.budgets()
        b.setdefault("global", {})["dailyUSD"] = 10.0
        cr.write_json(cr.BUDGETS_FILE, b)

        status = cr.compute_budget_status(amount_usd=5.0, period="daily")
        assert status["limitUSD"] == 10.0
        assert status["pct"] == 50.0
        assert status["level"] == "ok"

    def test_budget_warning_level(self, cost_dir):
        cr.load_or_init_files()
        b = cr.budgets()
        b.setdefault("global", {})["dailyUSD"] = 10.0
        b["thresholds"] = {"warnPct": 80, "critPct": 95}
        cr.write_json(cr.BUDGETS_FILE, b)

        status = cr.compute_budget_status(amount_usd=8.5, period="daily")
        assert status["level"] == "warning"

    def test_budget_critical_level(self, cost_dir):
        cr.load_or_init_files()
        b = cr.budgets()
        b.setdefault("global", {})["dailyUSD"] = 10.0
        b["thresholds"] = {"warnPct": 80, "critPct": 95}
        cr.write_json(cr.BUDGETS_FILE, b)

        status = cr.compute_budget_status(amount_usd=9.6, period="daily")
        assert status["level"] == "critical"

    def test_team_budget_override(self, cost_dir):
        cr.load_or_init_files()
        b = cr.budgets()
        b.setdefault("global", {})["dailyUSD"] = 100.0
        b.setdefault("teams", {}).setdefault("my-team", {})["dailyUSD"] = 5.0
        cr.write_json(cr.BUDGETS_FILE, b)

        status = cr.compute_budget_status(
            amount_usd=4.0, team_id="my-team", period="daily"
        )
        assert status["limitUSD"] == 5.0
        assert status["scope"] == "team:my-team"


class TestBurnRate:
    def test_burn_rate_projection(self, cost_dir):
        cr.load_or_init_files()
        today_res = {"totals": {"totalUSD": 2.0}}
        active_block_res = {"totals": {"totalUSD": 0.5}}
        proj = cr._burn_rate_projection(today_res, active_block_res)
        assert proj["todayUSD"] == 2.0
        assert proj["activeBlockUSD"] == 0.5
        assert proj["hourlyUSD"] == pytest.approx(0.1)  # 0.5 / 5h
        assert proj["projectedDailyUSD"] == pytest.approx(2.4)  # 0.1 * 24

    def test_burn_rate_none_handling(self, cost_dir):
        cr.load_or_init_files()
        proj = cr._burn_rate_projection({"totals": {}}, {"totals": {}})
        assert proj["hourlyUSD"] is None
        assert proj["projectedDailyUSD"] is None


class TestPresetRecommend:
    def test_preset_from_low_usage(self):
        assert cr._preset_from_budget_pct(20.0) == "heavy"

    def test_preset_from_medium_usage(self):
        assert cr._preset_from_budget_pct(60.0) == "standard"

    def test_preset_from_high_usage(self):
        assert cr._preset_from_budget_pct(85.0) == "lite"

    def test_preset_no_budget(self):
        assert cr._preset_from_budget_pct(None) == "standard"


class TestIndexRefresh:
    def test_index_creates_file(self, cost_dir):
        cr.load_or_init_files()
        idx = cr.refresh_usage_index_cache(force=True)
        assert idx["generatedAt"] is not None
        assert "today" in idx["windows"]
        assert "week" in idx["windows"]
        assert "month" in idx["windows"]

    def test_index_caches_on_same_fingerprint(self, cost_dir):
        cr.load_or_init_files()
        idx1 = cr.refresh_usage_index_cache(force=True)
        idx2 = cr.refresh_usage_index_cache(force=False)
        assert idx1["generatedAt"] == idx2["generatedAt"]


class TestExport:
    def test_export_json(self, cost_dir, tmp_path):
        cr.load_or_init_files()
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        seed_usage_records(cr.PROJECTS_DIR, [_make_usage_record(now)])
        res = cr.summarize("today", None, None, None, None, None, None, True)
        out_path = cr.REPORTS_DIR / "test-export.json"
        cr.write_json(out_path, res)
        assert out_path.exists()
        data = json.loads(out_path.read_text())
        assert data["window"] == "today"


class TestRenderSummary:
    def test_render_format(self, cost_dir):
        cr.load_or_init_files()
        res = cr.summarize("today", None, None, None, None, None, None, False)
        rendered = cr.render_summary(res)
        assert "Cost Summary" in rendered
        assert "today" in rendered


class TestFormatMoney:
    def test_format_none(self):
        assert cr.format_money(None) == "n/a"

    def test_format_value(self):
        assert cr.format_money(12.5) == "$12.50"

    def test_format_large(self):
        assert cr.format_money(1234.56) == "$1,234.56"
