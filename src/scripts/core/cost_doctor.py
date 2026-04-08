#!/usr/bin/env python3
from __future__ import annotations
import json
import shutil
import subprocess
from runtime_paths import runtime_dir

CLAUDE = runtime_dir()
PROJECTS = CLAUDE / "projects"
COST_RUNTIME = CLAUDE / "scripts" / "cost_runtime.py"

out = {"checks": []}


def add(name, ok, detail):
    out["checks"].append({"name": name, "ok": bool(ok), "detail": detail})


add("cost_runtime_exists", COST_RUNTIME.exists(), str(COST_RUNTIME))
add(
    "ccusage_in_path",
    shutil.which("ccusage") is not None,
    shutil.which("ccusage") or "missing",
)
add("projects_dir_exists", PROJECTS.exists(), str(PROJECTS))

if COST_RUNTIME.exists():
    try:
        p = subprocess.run(
            ["python3", str(COST_RUNTIME), "summary", "--window", "today", "--json"],
            capture_output=True,
            text=True,
            timeout=12,
        )
        add("cost_runtime_summary", p.returncode == 0, (p.stderr or p.stdout)[:500])
    except Exception as e:
        add("cost_runtime_summary", False, str(e))

out["status"] = "PASS" if all(c["ok"] for c in out["checks"]) else "WARN"
print(json.dumps(out, indent=2))
