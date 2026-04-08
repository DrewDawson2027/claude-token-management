#!/usr/bin/env python3
"""Runtime path helpers for installed and materialized Claude runtimes."""

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
