#!/usr/bin/env python3
"""
Credential Guard Hook — PreToolUse
Blocks writes/edits that contain hardcoded credentials, secrets, or tokens.
Fires on: Write, Edit, MultiEdit, Bash(git commit)

CLI mode:
  --scan-staged   Scan staged git diff + staged filenames for credential leakage.
"""

import json, re, subprocess, sys

PATTERNS: list[tuple[str, str]] = [
    # Generic secret shapes
    (
        r'(?i)(password|passwd|pwd)\s*[:=]\s*["\']?[^\s"\'<>{}\[\]]{8,}',
        "hardcoded password",
    ),
    (
        r'(?i)(secret|api_?key|apikey|access_?key)\s*[:=]\s*["\']?[A-Za-z0-9+/=_\-]{16,}',
        "hardcoded secret/key",
    ),
    (r"(?i)bearer\s+[A-Za-z0-9\-._~+/]+=*", "Bearer token in code"),
    # Common token formats
    (r"ghp_[A-Za-z0-9]{36}", "GitHub personal access token"),
    (r"ghs_[A-Za-z0-9]{36}", "GitHub Actions token"),
    (r"sk-[A-Za-z0-9]{48}", "OpenAI API key"),
    (r"sk-ant-[A-Za-z0-9\-_]{32,}", "Anthropic API key"),
    (r"xox[baprs]-[A-Za-z0-9\-]{10,}", "Slack token"),
    (r"AKIA[0-9A-Z]{16}", "AWS access key ID"),
    (r"[0-9a-z]{32}-us[0-9]+-[0-9]+", "Mailchimp API key"),
    # .env patterns being written into non-.env files
    (r"^\s*[A-Z_]{4,}=.{8,}$", "raw env var assignment"),
]

# Files/patterns exempt from the raw env-var check
EXEMPT_PATHS = re.compile(
    r"\.(env|envrc|env\.example|env\.sample|env\.local|env\.test)$", re.IGNORECASE
)
# Only flag raw env vars in source code files, not config/env files
SOURCE_EXTS = re.compile(
    r"\.(ts|tsx|js|jsx|py|go|rs|rb|java|cs|php|swift|kt|sh|bash)$", re.IGNORECASE
)
# Common non-secret env vars that should never trigger the raw env var pattern
ENV_VAR_ALLOWLIST = {
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "LANG",
    "TERM",
    "EDITOR",
    "NODE_ENV",
    "DEBUG",
}
GIT_STAGE_OR_COMMIT = re.compile(r"\bgit\b[^\n;|&]*\b(add|commit)\b", re.IGNORECASE)


def _added_lines_from_diff(diff_text: str) -> str:
    added = []
    for line in diff_text.splitlines():
        if line.startswith("+++") or line.startswith("@@"):
            continue
        if line.startswith("+"):
            added.append(line[1:])
    return "\n".join(added)


def _scan_staged_diff() -> list[str]:
    violations = []

    try:
        inside = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            capture_output=True,
            text=True,
            check=False,
        )
        if inside.returncode != 0 or inside.stdout.strip().lower() != "true":
            return violations
    except Exception:
        return violations

    staged_files: list[str] = []
    try:
        names = subprocess.run(
            ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
            capture_output=True,
            text=True,
            check=False,
        )
        if names.returncode == 0:
            staged_files = [
                line.strip() for line in names.stdout.splitlines() if line.strip()
            ]
    except Exception:
        staged_files = []

    for path in staged_files:
        if EXEMPT_PATHS.search(path):
            violations.append("staged .env file")

    for path in staged_files:
        try:
            diff = subprocess.run(
                ["git", "diff", "--cached", "--", path],
                capture_output=True,
                text=True,
                check=False,
            )
            if diff.returncode == 0 and diff.stdout.strip():
                added_only = _added_lines_from_diff(diff.stdout)
                if added_only.strip():
                    violations.extend(check_content(added_only, path))
        except Exception:
            continue

    return sorted(set(violations))


def check_content(content: str, filepath: str) -> list[str]:
    """Return list of violation messages, or empty if clean."""
    violations = []
    is_source = SOURCE_EXTS.search(filepath or "")
    is_exempt = EXEMPT_PATHS.search(filepath or "")

    is_shell = bool(re.search(r"\.(sh|bash)$", filepath or "", re.IGNORECASE))
    is_test = bool(
        re.search(r"\.(test|spec)\.(mjs|js|ts|py)$", filepath or "", re.IGNORECASE)
    )

    for pattern, label in PATTERNS:
        # Skip auth-header pattern checks in test files (test fixtures, not real creds)
        if is_test and "token in code" in label:
            continue
        # Skip raw env-var check for non-source files, exempt paths, and shell scripts
        # Shell scripts legitimately use UPPERCASE_VAR=value syntax
        if label == "raw env var assignment" and (
            is_exempt or not is_source or is_shell
        ):
            continue
        matches = re.findall(pattern, content, re.MULTILINE)
        if matches:
            # For raw env var assignments, filter out allowlisted non-secret vars
            if label == "raw env var assignment":
                has_real_violation = False
                for line in content.splitlines():
                    m = re.match(r"^\s*([A-Z_]{4,})=.{8,}$", line)
                    if m and m.group(1) not in ENV_VAR_ALLOWLIST:
                        has_real_violation = True
                        break
                if not has_real_violation:
                    continue
            violations.append(label)

    return violations


def main():
    if "--scan-staged" in sys.argv:
        staged_violations = _scan_staged_diff()
        if staged_violations:
            print(
                "credential-guard: Blocked staged changes — detected: "
                + ", ".join(staged_violations)
                + ". Remove secrets from staged diff before commit."
            )
            sys.exit(2)
        sys.exit(0)

    try:
        raw = sys.stdin.read()
        if not raw.strip():
            sys.exit(0)
        data = json.loads(raw)
    except Exception:
        sys.exit(0)

    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})

    content = ""
    filepath = ""

    if tool_name == "Write":
        content = tool_input.get("content", "")
        filepath = tool_input.get("file_path", "")
    elif tool_name in ("Edit", "MultiEdit"):
        filepath = tool_input.get("file_path", "")
        if tool_name == "Edit":
            content = tool_input.get("new_string", "")
        else:
            edits = tool_input.get("edits", [])
            content = "\n".join(e.get("new_string", "") for e in edits)
    elif tool_name == "Bash":
        cmd = tool_input.get("command", "")
        # Block git stage/commit flows if staged content includes secrets or .env files.
        # This scans `git diff --cached` and staged file names via _scan_staged_diff().
        if GIT_STAGE_OR_COMMIT.search(cmd):
            staged_violations = _scan_staged_diff()
            if staged_violations:
                print(
                    "credential-guard: Blocked staged changes — detected: "
                    + ", ".join(staged_violations)
                    + ". Remove secrets from staged diff before commit."
                )
                sys.exit(2)
        sys.exit(0)
    else:
        sys.exit(0)

    # Don't scan .env files themselves (they're meant to hold secrets, just shouldn't be committed)
    if EXEMPT_PATHS.search(filepath):
        sys.exit(0)

    violations = check_content(content, filepath)
    if violations:
        items = ", ".join(violations)
        print(
            f"credential-guard: Blocked write to '{filepath}' — detected: {items}. Use environment variables instead."
        )
        sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
