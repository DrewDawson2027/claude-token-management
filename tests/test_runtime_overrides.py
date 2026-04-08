from __future__ import annotations

import importlib
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
for candidate in (
    REPO_ROOT / "src" / "scripts" / "core",
    REPO_ROOT / "src" / "hooks" / "ops",
    REPO_ROOT / "src" / "cli",
):
    candidate_str = str(candidate)
    if candidate.exists() and candidate_str not in sys.path:
        sys.path.insert(0, candidate_str)


def test_runtime_override_retargets_core_modules(monkeypatch, tmp_path):
    runtime = tmp_path / "runtime-root"
    runtime.mkdir()
    monkeypatch.setenv("CLAUDE_RUNTIME_DIR", str(runtime))

    import runtime_paths
    import cost_data
    import cost_runtime
    import observability
    import ops_sources
    from claude_token_guard import cli

    runtime_paths = importlib.reload(runtime_paths)
    cost_data = importlib.reload(cost_data)
    cost_runtime = importlib.reload(cost_runtime)
    observability = importlib.reload(observability)
    ops_sources = importlib.reload(ops_sources)
    cli = importlib.reload(cli)

    assert runtime_paths.runtime_dir() == runtime
    assert cost_data.CLAUDE == runtime
    assert cost_runtime.CLAUDE == runtime
    assert observability.CLAUDE == runtime
    assert ops_sources.CLAUDE_DIR == runtime
    assert Path(cli.HOOKS_DIR) == runtime / "hooks"
    assert Path(cli.COST_RUNTIME_PATH) == runtime / "scripts" / "cost_runtime.py"
