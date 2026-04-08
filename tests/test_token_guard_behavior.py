from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
HOOK_INFRA = REPO_ROOT / "src" / "hooks" / "infrastructure"
TOKEN_GUARD = REPO_ROOT / "src" / "hooks" / "guards" / "token-guard.py"

if str(HOOK_INFRA) not in sys.path:
    sys.path.insert(0, str(HOOK_INFRA))

spec = importlib.util.spec_from_file_location("token_guard", TOKEN_GUARD)
token_guard = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(token_guard)


def test_type_switching_normalizes_control_chars_for_identical_descriptions():
    description = "000\x1f\x1f\x1f\x1f0\x1f0"
    state = {
        "blocked_attempts": [
            {"type": "Explore", "description": description, "timestamp": 0}
        ]
    }

    is_evasion, blocked_type = token_guard.check_type_switching(
        state, description, "general-purpose"
    )

    assert is_evasion is True
    assert blocked_type == "Explore"
