#!/usr/bin/env python3
"""Runtime path helpers for hook code running against installed or materialized runtimes."""

from __future__ import annotations

import os
from pathlib import Path


def runtime_dir() -> Path:
    raw = os.environ.get("CLAUDE_RUNTIME_DIR", "").strip()
    if raw:
        return Path(os.path.expanduser(raw))
    return Path.home() / ".claude"


def runtime_path(*parts: str) -> Path:
    return runtime_dir().joinpath(*parts)


def hooks_dir() -> Path:
    return runtime_path("hooks")


def session_state_dir() -> Path:
    return hooks_dir() / "session-state"


def scripts_dir() -> Path:
    return runtime_path("scripts")


def cost_dir() -> Path:
    return runtime_path("cost")


def logs_dir() -> Path:
    return runtime_path("logs")


def projects_dir() -> Path:
    return runtime_path("projects")


def terminals_dir() -> Path:
    return runtime_path("terminals")


def token_analytics_dir() -> Path:
    return runtime_path("token-analytics")


def teams_dir() -> Path:
    return runtime_path("teams")


def worktrees_dir() -> Path:
    return runtime_path("worktrees")
