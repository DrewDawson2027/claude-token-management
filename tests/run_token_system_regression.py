#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CONFIG_DIR = REPO_ROOT / "config"
DATA_DIR = REPO_ROOT / "data"
HOOKS_SRC = REPO_ROOT / "src" / "hooks"
SCRIPTS_SRC = REPO_ROOT / "src" / "scripts"
COORD_SRC = REPO_ROOT / "src" / "coordinator"
CLI_SRC = REPO_ROOT / "src" / "cli" / "claude_token_guard"
LEAD_TOOLS_SRC = REPO_ROOT / "src" / "lead-tools"
HOOK_TESTS_VENDOR = REPO_ROOT / "tests" / "vendor" / "hooks-runtime"
PYPROJECT_TOML = REPO_ROOT / "pyproject.toml"
MASTER_AGENT_MODES = {
    "coder": ["build-mode.md", "debug-mode.md", "review-mode.md", "refactor-mode.md"],
    "researcher": [
        "academic-mode.md",
        "market-mode.md",
        "technical-mode.md",
        "general-mode.md",
    ],
    "architect": [
        "database-design.md",
        "api-design.md",
        "system-design.md",
        "frontend-design.md",
    ],
    "workflow": [
        "gsd-exec.md",
        "feature-workflow.md",
        "git-workflow.md",
        "autonomous.md",
    ],
}


def node_bin() -> str | None:
    for candidate in (
        "/opt/homebrew/bin/node",
        "/opt/homebrew/Cellar/node/25.6.1_1/bin/node",
        shutil.which("node"),
    ):
        if candidate and Path(candidate).exists():
            return candidate
    return None


def npm_bin() -> str | None:
    for candidate in (
        "/opt/homebrew/bin/npm",
        "/opt/homebrew/Cellar/node/25.6.1_1/bin/npm",
        shutil.which("npm"),
    ):
        if candidate and Path(candidate).exists():
            return candidate
    return None


def pytest_python() -> str | None:
    candidates = []
    for candidate in (
        "/opt/homebrew/bin/python3",
        "/opt/homebrew/opt/python@3.14/bin/python3.14",
        shutil.which("python3"),
        sys.executable,
    ):
        if candidate and candidate not in candidates and Path(candidate).exists():
            candidates.append(candidate)
    for candidate in candidates:
        try:
            probe = subprocess.run(
                [candidate, "-c", "import pytest"],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except Exception:
            continue
        if probe.returncode == 0:
            return candidate
    return None


def run(name: str, cmd: list[str], *, env: dict[str, str], cwd: Path, timeout: int = 600):
    t0 = time.time()
    try:
        cp = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(cwd),
            env=env,
        )
        return {
            "name": name,
            "cmd": cmd,
            "rc": cp.returncode,
            "seconds": round(time.time() - t0, 2),
            "stdout_tail": (cp.stdout or "")[-2000:],
            "stderr_tail": (cp.stderr or "")[-2000:],
        }
    except Exception as exc:
        return {
            "name": name,
            "cmd": cmd,
            "rc": 1,
            "seconds": round(time.time() - t0, 2),
            "error": str(exc),
        }


def copy_flat(src_dir: Path, dest_dir: Path) -> None:
    if not src_dir.exists():
        return
    dest_dir.mkdir(parents=True, exist_ok=True)
    for path in sorted(src_dir.iterdir()):
        if path.is_file():
            shutil.copy2(path, dest_dir / path.name)


def copy_tree(src: Path, dest: Path) -> None:
    if not src.exists():
        return
    shutil.copytree(src, dest, dirs_exist_ok=True)


def rewrite_settings(src: Path, dest: Path, claude_dir: Path) -> None:
    data = json.loads(src.read_text(encoding="utf-8"))

    def rewrite(value):
        if isinstance(value, dict):
            return {k: rewrite(v) for k, v in value.items()}
        if isinstance(value, list):
            return [rewrite(v) for v in value]
        if isinstance(value, str):
            return value.replace("/Users/drewdawson/.claude", str(claude_dir))
        return value

    dest.write_text(json.dumps(rewrite(data), indent=2) + "\n", encoding="utf-8")


def materialize_runtime() -> tuple[Path, dict[str, Path]]:
    root = Path(tempfile.mkdtemp(prefix="token-management-runtime-"))
    home = root / "home"
    claude = home / ".claude"
    hooks = claude / "hooks"
    scripts = claude / "scripts"
    coordinator = claude / "mcp-coordinator"
    cost = claude / "cost"
    lead_tools = claude / "lead-tools"

    for path in (
        hooks,
        hooks / "lib",
        hooks / "session-state",
        scripts,
        coordinator,
        cost,
        lead_tools,
        claude / "cache" / "read-results",
        claude / "commands",
        claude / "logs",
        claude / "projects",
        claude / "terminals",
        claude / "token-analytics" / "sessions",
        claude / "token-analytics" / "daily",
        claude / "agents",
        claude / "master-agents",
        home / ".local" / "bin",
    ):
        path.mkdir(parents=True, exist_ok=True)

    # Flatten categorized hook sources into the runtime hook root.
    for category in ("guards", "routing", "tracking", "infrastructure", "ops", "runtime"):
        copy_flat(HOOKS_SRC / category, hooks)
    copy_tree(HOOKS_SRC / "lib", hooks / "lib")
    copy_tree(CLI_SRC, hooks / "claude_token_guard")

    # Flatten script sources into ~/.claude/scripts.
    for category in ("core", "analytics", "reporting"):
        copy_flat(SCRIPTS_SRC / category, scripts)

    # Coordinator package.
    for name in ("index.js", "package.json", "package-lock.json", ".c8rc.json", "stryker.config.mjs"):
        src = COORD_SRC / name
        if src.exists():
            shutil.copy2(src, coordinator / name)
    for name in ("lib", "scripts", "test", "hooks"):
        copy_tree(COORD_SRC / name, coordinator / name)
    copy_tree(LEAD_TOOLS_SRC, lead_tools)

    # Vendored hook tests run against the assembled runtime.
    copy_tree(HOOK_TESTS_VENDOR, hooks / "tests")
    if PYPROJECT_TOML.exists():
        shutil.copy2(PYPROJECT_TOML, hooks / "pyproject.toml")

    # Config and snapshot data.
    shutil.copy2(CONFIG_DIR / "token-guard-config.json", hooks / "token-guard-config.json")
    shutil.copy2(CONFIG_DIR / "routing-policy.json", hooks / "routing-policy.json")
    shutil.copy2(CONFIG_DIR / "budgets.json", cost / "budgets.json")
    shutil.copy2(CONFIG_DIR / "pricing-cache.json", cost / "pricing-cache.json")
    rewrite_settings(CONFIG_DIR / "settings.json", claude / "settings.json", claude)
    rewrite_settings(CONFIG_DIR / "settings.local.json", claude / "settings.local.json", claude)

    # Cost + alert snapshots.
    shutil.copy2(DATA_DIR / "cost-cache-snapshot.json", cost / "cache.json")
    shutil.copy2(DATA_DIR / "usage-index-snapshot.json", cost / "usage-index.json")
    shutil.copy2(DATA_DIR / "statusline-snapshot.json", cost / "statusline-cache.json")
    shutil.copy2(DATA_DIR / "alerts" / "alert-state.json", cost / "alert-state.json")
    shutil.copy2(DATA_DIR / "alerts" / "alerts.jsonl", cost / "alerts.jsonl")
    shutil.copy2(DATA_DIR / "ops-snapshot.json", cost / "ops-snapshot-cache.json")

    for session_file in sorted((DATA_DIR / "sessions").glob("*.jsonl")):
        shutil.copy2(session_file, claude / "token-analytics" / "sessions" / session_file.name)

    # Health-check-friendly install markers.
    (claude / ".lead-system-install.json").write_text('{"mode":"full"}\n', encoding="utf-8")
    (claude / "commands" / "lead.md").write_text(
        "---\nallowed-tools:\n- Bash(python3 *)\n- Bash(git status*)\n- Grep\n- Glob\n---\n",
        encoding="utf-8",
    )
    for launcher in ("claudex", "sidecarctl"):
        path = home / ".local" / "bin" / launcher
        path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        path.chmod(0o755)
    for agent in ("master-coder", "master-researcher", "master-architect", "master-workflow"):
        (claude / "agents" / f"{agent}.md").write_text(f"# {agent}\n", encoding="utf-8")
    (claude / "agents" / "MANIFEST.md").write_text("# MANIFEST\n", encoding="utf-8")
    for agent, mode_files in MASTER_AGENT_MODES.items():
        agent_dir = claude / "master-agents" / agent
        refs_dir = agent_dir / "refs"
        refs_dir.mkdir(parents=True, exist_ok=True)
        for mode_file in mode_files:
            (agent_dir / mode_file).write_text(
                f"# {agent} {mode_file}\n",
                encoding="utf-8",
            )

    return root, {
        "home": home,
        "claude": claude,
        "hooks": hooks,
        "scripts": scripts,
        "coordinator": coordinator,
        "cost": cost,
    }


def build_env(home: Path, hooks: Path, scripts: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["HOME"] = str(home)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(hooks), str(scripts), env.get("PYTHONPATH", "")]
    ).rstrip(os.pathsep)
    path_entries: list[str] = []
    for candidate in (node_bin(), npm_bin(), "/opt/homebrew/bin"):
        if candidate:
            candidate_path = Path(candidate)
            entry = str(candidate_path if candidate_path.is_dir() else candidate_path.parent)
            if entry not in path_entries:
                path_entries.append(entry)
    if path_entries:
        env["PATH"] = os.pathsep.join(path_entries + [env.get("PATH", "")]).rstrip(
            os.pathsep
        )
    return env


def main() -> int:
    runtime_root, paths = materialize_runtime()
    env = build_env(paths["home"], paths["hooks"], paths["scripts"])
    node = node_bin()
    py_for_pytest = pytest_python()
    npm = npm_bin()

    checks = []
    hooks_tests = paths["hooks"] / "tests"
    health = paths["hooks"] / "health-check.sh"
    cost_runtime = paths["scripts"] / "cost_runtime.py"
    observability = paths["scripts"] / "observability.py"
    coordinator = paths["coordinator"] / "index.js"
    spawn_smoke = paths["coordinator"] / "scripts" / "spawn-smoke.mjs"

    if hooks_tests.exists() and py_for_pytest:
        checks.append(
            run(
                "hooks_pytests",
                [py_for_pytest, "-m", "pytest", str(hooks_tests), "-q"],
                env=env,
                cwd=REPO_ROOT,
                timeout=1800,
            )
        )
    elif hooks_tests.exists():
        checks.append(
            {
                "name": "hooks_pytests",
                "skipped": True,
                "reason": "no python interpreter with pytest available",
            }
        )

    schema_validation = REPO_ROOT / "tests" / "validate_schemas.py"
    if schema_validation.exists() and py_for_pytest:
        checks.append(
            run(
                "schema_validation",
                [py_for_pytest, str(schema_validation)],
                env=env,
                cwd=REPO_ROOT,
                timeout=300,
            )
        )

    if health.exists():
        checks.append(
            run(
                "health_check_stats",
                ["bash", str(health), "--stats"],
                env=env,
                cwd=REPO_ROOT,
                timeout=60,
            )
        )

    if cost_runtime.exists():
        checks.append(
            run(
                "cost_runtime_statusline",
                [sys.executable, str(cost_runtime), "statusline"],
                env=env,
                cwd=REPO_ROOT,
                timeout=120,
            )
        )

    if observability.exists():
        checks.append(
            run(
                "observability_health_report",
                [sys.executable, str(observability), "health-report"],
                env=env,
                cwd=REPO_ROOT,
                timeout=120,
            )
        )

    if node and npm and (paths["coordinator"] / "package.json").exists():
        checks.append(
            run(
                "coordinator_npm_ci",
                [npm, "ci", "--ignore-scripts"],
                env=env,
                cwd=paths["coordinator"],
                timeout=1800,
            )
        )

    if node and coordinator.exists():
        checks.append(
            run(
                "coordinator_node_check",
                [node, "--check", str(coordinator)],
                env=env,
                cwd=REPO_ROOT,
                timeout=60,
            )
        )

    if node and spawn_smoke.exists():
        checks.append(
            run(
                "coordinator_spawn_smoke",
                [node, str(spawn_smoke)],
                env=env,
                cwd=REPO_ROOT,
                timeout=120,
            )
        )

    passed = sum(1 for c in checks if c.get("rc") == 0)
    failed = sum(
        1 for c in checks if c.get("rc") not in (0, None) and not c.get("skipped")
    )

    out = {
        "schema_version": 2,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "runtime_root": str(runtime_root),
        "summary": {"total": len(checks), "passed": passed, "failed": failed},
        "checks": checks,
    }
    print(json.dumps(out, indent=2))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
