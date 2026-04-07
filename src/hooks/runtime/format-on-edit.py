#!/usr/bin/env python3
"""PostToolUse formatter hook — fires on Write|Edit.

Reads the actual file_path from tool_input (not $TOOL_RESULT_FILE which is
a temp JSON blob). Tries: bun run format (project-level), then npx prettier,
then black. All failures are silent — this must never block Claude.

Boris pattern: "bun run format || true" — same intent, cross-project safe.
"""

import json
import os
import subprocess
import sys


def run(cmd, cwd=None, timeout=12):
    try:
        return subprocess.run(cmd, capture_output=True, cwd=cwd, timeout=timeout)
    except Exception:
        return None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    file_path = data.get("tool_input", {}).get("file_path", "")
    if not file_path or not os.path.exists(file_path):
        sys.exit(0)

    project_dir = data.get("cwd", os.path.dirname(file_path))
    ext = os.path.splitext(file_path)[1].lower()

    # 1. Try project-level format script (Boris's exact pattern — bun run format)
    if os.path.exists(os.path.join(project_dir, "package.json")):
        r = run(["bun", "run", "format", "--", file_path], cwd=project_dir)
        if r and r.returncode == 0:
            sys.exit(0)

    # 2. prettier (JS/TS/JSON/CSS/MD/YAML) — only if available
    prettier_exts = {
        ".js",
        ".jsx",
        ".ts",
        ".tsx",
        ".json",
        ".css",
        ".scss",
        ".md",
        ".yaml",
        ".yml",
        ".html",
    }
    if ext in prettier_exts:
        # Check if prettier is available before running
        r = run(["npx", "--no-install", "prettier", "--version"], timeout=5)
        if r and r.returncode == 0:
            run(["npx", "--no-install", "prettier", "--write", file_path])
        else:
            # Fall back to checking if prettier is installed globally
            r = run(["which", "prettier"], timeout=3)
            if r and r.returncode == 0:
                run(["prettier", "--write", file_path])
        sys.exit(0)

    # 3. black (Python)
    if ext == ".py":
        r = run(["black", "--quiet", file_path])
        if r and r.returncode != 0:
            run(["python3", "-m", "black", "--quiet", file_path])


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
