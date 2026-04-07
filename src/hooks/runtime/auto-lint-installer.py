#!/usr/bin/env python3
"""
auto-lint-installer.py — SessionStart hook

Fires every time a Claude session starts. If the current directory is one of
your GitHub repos and is missing the auto-lint CI workflow, installs it
automatically and pushes. Zero user action required.

Skips:
  - Not a git repo
  - Remote isn't DrewDawson2027/* (not your repo)
  - .github/workflows/auto-lint.yml already exists
  - No write access / push fails (silently skips)
"""

import json
import os
import subprocess
import sys
from pathlib import Path

OWNER = "DrewDawson2027"

PYTHON_WORKFLOW = """\
name: Auto-Lint

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  lint:
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.head_ref }}
          token: ${{ secrets.GITHUB_TOKEN }}
          fetch-depth: 0

      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Ruff fix
        run: |
          pip install ruff --quiet
          ruff check --fix . 2>/dev/null || true
          ruff format . 2>/dev/null || true

      - name: Commit fixes
        uses: stefanzweifel/git-auto-commit-action@v5
        with:
          commit_message: "ci: auto-lint fixes"
          commit_author: "github-actions[bot] <github-actions[bot]@users.noreply.github.com>"
"""

JS_WORKFLOW = """\
name: Auto-Lint

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  lint:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write

    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.head_ref }}
          token: ${{ secrets.GITHUB_TOKEN }}
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install deps
        run: npm ci --ignore-scripts 2>/dev/null || npm install --ignore-scripts 2>/dev/null || true

      - name: Prettier
        run: npx --yes prettier --write "**/*.{js,jsx,ts,tsx,json,css,md,yml,yaml}" --ignore-path .gitignore 2>/dev/null || true

      - name: ESLint fix
        run: npx --yes eslint --fix "**/*.{js,jsx,ts,tsx}" --ignore-path .gitignore 2>/dev/null || true

      - name: Commit fixes
        uses: stefanzweifel/git-auto-commit-action@v5
        with:
          commit_message: "ci: auto-lint fixes"
          commit_author: "github-actions[bot] <github-actions[bot]@users.noreply.github.com>"
"""

MIXED_WORKFLOW = """\
name: Auto-Lint

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  lint:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write

    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.head_ref }}
          token: ${{ secrets.GITHUB_TOKEN }}
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install deps
        run: npm ci --ignore-scripts 2>/dev/null || npm install --ignore-scripts 2>/dev/null || true

      - name: Prettier
        run: npx --yes prettier --write "**/*.{js,jsx,ts,tsx,json,css,md,yml,yaml}" --ignore-path .gitignore 2>/dev/null || true

      - name: ESLint fix
        run: npx --yes eslint --fix "**/*.{js,jsx,ts,tsx}" --ignore-path .gitignore 2>/dev/null || true

      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Ruff fix
        run: |
          pip install ruff --quiet
          ruff check --fix . 2>/dev/null || true
          ruff format . 2>/dev/null || true

      - name: Commit fixes
        uses: stefanzweifel/git-auto-commit-action@v5
        with:
          commit_message: "ci: auto-lint fixes"
          commit_author: "github-actions[bot] <github-actions[bot]@users.noreply.github.com>"
"""


def run(cmd, cwd=None, capture=True):
    result = subprocess.run(
        cmd, shell=True, capture_output=capture, text=True, cwd=cwd
    )
    return result.stdout.strip(), result.returncode


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}

    project_dir = data.get("cwd") or os.getcwd()

    # ── 1. Is this a git repo? ────────────────────────────────────────────────
    _, rc = run("git rev-parse --git-dir", cwd=project_dir)
    if rc != 0:
        sys.exit(0)

    # ── 2. Is this YOUR repo? ─────────────────────────────────────────────────
    remote, rc = run("git remote get-url origin", cwd=project_dir)
    if rc != 0 or OWNER not in remote:
        sys.exit(0)

    # ── 3. Already installed? ─────────────────────────────────────────────────
    workflow_path = Path(project_dir) / ".github" / "workflows" / "auto-lint.yml"
    if workflow_path.exists():
        sys.exit(0)

    # ── 4. Detect language ────────────────────────────────────────────────────
    has_js = (Path(project_dir) / "package.json").exists()
    has_py = (
        (Path(project_dir) / "pyproject.toml").exists()
        or (Path(project_dir) / "setup.py").exists()
        or (Path(project_dir) / "requirements.txt").exists()
        or any(Path(project_dir).glob("*.py"))
    )

    if has_js and has_py:
        workflow = MIXED_WORKFLOW
    elif has_js:
        workflow = JS_WORKFLOW
    else:
        workflow = PYTHON_WORKFLOW

    # ── 5. Write workflow ─────────────────────────────────────────────────────
    workflow_path.parent.mkdir(parents=True, exist_ok=True)
    workflow_path.write_text(workflow)

    # ── 6. Commit and push ────────────────────────────────────────────────────
    run(f"git add .github/workflows/auto-lint.yml", cwd=project_dir)
    _, rc = run(
        'git commit -m "ci: add autonomous auto-lint workflow"',
        cwd=project_dir,
    )
    if rc != 0:
        # Nothing staged or commit failed — clean up and exit silently
        workflow_path.unlink(missing_ok=True)
        sys.exit(0)

    _, rc = run("git push", cwd=project_dir)
    if rc != 0:
        # Protected branch or no push access — leave file, don't push
        # User can PR it manually or merge on next session
        pass

    # Log it (silent — no stdout so Claude doesn't see it as a system reminder)
    log_path = Path.home() / ".claude" / "logs" / "auto-lint-installer.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "a") as f:
        f.write(f"installed: {project_dir} ({remote})\n")

    sys.exit(0)


if __name__ == "__main__":
    main()
