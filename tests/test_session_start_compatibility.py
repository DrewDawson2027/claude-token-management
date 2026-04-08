from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

INFRA_DIR = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "hooks"
    / "infrastructure"
)
if str(INFRA_DIR) not in sys.path:
    sys.path.insert(0, str(INFRA_DIR))

MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "hooks"
    / "tracking"
    / "session-slo-check.py"
)
SPEC = importlib.util.spec_from_file_location("session_slo_check", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_resume_source_emits_compatibility_warning():
    lines = MODULE.build_resume_warning("resume")
    text = "\n".join(lines)
    assert "COMPATIBILITY WARNING" in text
    assert "prompt-cache regressions" in text


def test_startup_source_ignores_fresh_session():
    source = MODULE.extract_startup_source({"source": "startup"})
    assert source == ""
