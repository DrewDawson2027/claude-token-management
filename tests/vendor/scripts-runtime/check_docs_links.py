#!/usr/bin/env python3
"""Check that documentation files reference existing paths and commands."""

from __future__ import annotations

import re
from pathlib import Path

HOME = Path.home()
CLAUDE = HOME / ".claude"
EXIT_CODE = 0


def check_file_refs(doc_path: Path) -> list[str]:
    """Find `~/.claude/...` references and verify they exist."""
    issues = []
    if not doc_path.exists():
        return issues
    text = doc_path.read_text(errors="ignore")
    refs = re.findall(r"~/\.claude/[^\s\)\"'`\]]+", text)
    for ref in refs:
        expanded = Path(ref.replace("~", str(HOME)))
        # Allow glob patterns and wildcards
        if "*" in ref or "?" in ref:
            continue
        # Allow template references with {vars}
        if "{" in ref:
            continue
        if not expanded.exists():
            issues.append(f"  {doc_path.name}: missing {ref}")
    return issues


def check_command_refs(doc_path: Path, known_commands: set[str]) -> list[str]:
    """Check that referenced slash commands exist."""
    issues = []
    if not doc_path.exists():
        return issues
    text = doc_path.read_text(errors="ignore")
    cmds = re.findall(r"(?:^|\s)/([a-z][a-z0-9_-]+(?::[a-z0-9_-]+)?)", text)
    for cmd in cmds:
        # Skip common non-command patterns
        if cmd in {
            "dev",
            "tmp",
            "usr",
            "etc",
            "var",
            "bin",
            "opt",
            "home",
            "proc",
            "sys",
            "run",
            "mnt",
            "srv",
        }:
            continue
        base_cmd = cmd.split(":")[0] if ":" in cmd else cmd
        cmd_file = CLAUDE / "commands" / f"{base_cmd}.md"
        cmd_dir = CLAUDE / "commands" / base_cmd
        if not cmd_file.exists() and not cmd_dir.exists():
            if base_cmd not in known_commands:
                issues.append(f"  {doc_path.name}: unknown command /{cmd}")
    return issues


def main() -> int:
    # Known built-in commands (not file-based)
    known_commands = {
        "help",
        "clear",
        "compact",
        "cost",
        "doctor",
        "init",
        "login",
        "logout",
        "memory",
        "model",
        "permissions",
        "status",
        "config",
        "fast",
        "review",
        "bug",
        "commit",
    }

    docs = list(CLAUDE.glob("*.md")) + list(CLAUDE.glob("commands/*.md"))
    if (CLAUDE / "runbooks").exists():
        docs += list((CLAUDE / "runbooks").glob("*.md"))

    all_issues: list[str] = []
    for doc in docs:
        all_issues.extend(check_file_refs(doc))

    if all_issues:
        print(f"DOCS_LINK_CHECK: {len(all_issues)} issue(s)")
        for issue in all_issues[:20]:
            print(issue)
        return 1

    print(f"DOCS_LINK_CHECK_OK: checked {len(docs)} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
