from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

CORE_DIR = Path(__file__).resolve().parents[1] / "src" / "scripts" / "core"
if str(CORE_DIR) not in sys.path:
    sys.path.insert(0, str(CORE_DIR))


def load_cost_modules(monkeypatch, runtime_root: Path):
    monkeypatch.setenv("CLAUDE_RUNTIME_DIR", str(runtime_root))
    for name in ("cost_runtime", "cost_data"):
        sys.modules.pop(name, None)
    cost_data = importlib.import_module("cost_data")
    cost_runtime = importlib.import_module("cost_runtime")
    return cost_data, cost_runtime


def test_cost_data_bootstrap_creates_authoritative_runtime_files(tmp_path, monkeypatch):
    runtime_root = tmp_path / ".claude"
    cost_data, _ = load_cost_modules(monkeypatch, runtime_root)

    cost_data.ensure_cost_files()

    assert cost_data.CONFIG_FILE.exists()
    assert cost_data.BUDGETS_FILE.exists()
    assert cost_data.CACHE_FILE.exists()
    assert cost_data.USAGE_INDEX_FILE.exists()
    assert cost_data.PRICING_CACHE_FILE.exists()

    assert json.loads(cost_data.CONFIG_FILE.read_text()) == cost_data.default_cost_config()
    assert json.loads(cost_data.BUDGETS_FILE.read_text()) == cost_data.default_budgets_doc()

    cache_doc = json.loads(cost_data.CACHE_FILE.read_text())
    index_doc = json.loads(cost_data.USAGE_INDEX_FILE.read_text())
    pricing_doc = json.loads(cost_data.PRICING_CACHE_FILE.read_text())

    assert cache_doc["source"] == "local"
    assert isinstance(cache_doc["generatedAt"], str) and cache_doc["generatedAt"]
    assert index_doc["fingerprint"] == {}
    assert index_doc["windows"] == {}
    assert isinstance(index_doc["generatedAt"], str) and index_doc["generatedAt"]
    assert "pricing metadata mirror" in pricing_doc["note"]


def test_cost_runtime_uses_shared_cost_data_bootstrap_contract(tmp_path, monkeypatch):
    runtime_root = tmp_path / ".claude"
    cost_data, cost_runtime = load_cost_modules(monkeypatch, runtime_root)

    cost_runtime.load_or_init_files()

    assert cost_runtime.CONFIG_FILE == cost_data.CONFIG_FILE
    assert cost_runtime.BUDGETS_FILE == cost_data.BUDGETS_FILE
    assert cost_runtime.CACHE_FILE == cost_data.CACHE_FILE
    assert cost_runtime.USAGE_INDEX_FILE == cost_data.USAGE_INDEX_FILE
    assert cost_runtime.PRICING_CACHE_FILE == cost_data.PRICING_CACHE_FILE

    assert json.loads(cost_runtime.CONFIG_FILE.read_text()) == cost_data.default_cost_config()
    assert json.loads(cost_runtime.BUDGETS_FILE.read_text()) == cost_data.default_budgets_doc()
