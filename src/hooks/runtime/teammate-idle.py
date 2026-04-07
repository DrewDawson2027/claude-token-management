#!/usr/bin/env python3
"""
TeammateIdle hook — quality gate for agent teams.

Fires when a teammate is about to go idle. Exit code 2 sends feedback
to the teammate and keeps them working. Exit code 0 lets them idle.

Supports dual schema:
  - Coordinator: teammate_id, task, output, files_changed
  - Native Agent Teams: teammate_name, task_in_progress (nested), idle_reason

Wire in settings.json under hooks.TeammateIdle.
"""

import json
import sys
import os
import re


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        payload = {}

    # Dual-schema: native fields as primary, coordinator as fallback
    teammate_id = payload.get("teammate_name") or payload.get("teammate_id", "unknown")
    task_obj = payload.get("task_in_progress")
    task_name = (
        (task_obj.get("title", "") if isinstance(task_obj, dict) else "")
        or payload.get("task", "")
    )
    idle_reason = payload.get("idle_reason", "")
    output = payload.get("output", "")
    files_changed = payload.get("files_changed", [])
    is_native = "teammate_name" in payload or "task_in_progress" in payload

    log_path = os.path.expanduser("~/.claude/logs/teammate-idle.log")
    os.makedirs(os.path.dirname(log_path), exist_ok=True)

    issues = []

    # ── Check 1: TODO/FIXME left in changed files ──
    for fpath in files_changed:
        try:
            text = open(fpath).read()
            todos = re.findall(r"(TODO|FIXME|HACK|XXX).*", text)
            if todos:
                issues.append(f"File {fpath} has {len(todos)} unresolved TODO/FIXME comment(s). Address them or document why they're intentional.")
        except Exception:
            pass

    # ── Check 2: Evidence of verification in output ──
    output_lower = output.lower()
    has_verification = any(kw in output_lower for kw in [
        "test", "passed", "✓", "all tests", "no errors", "lint",
        "build succeeded", "pytest", "npm test", "yarn test",
        "cargo test", "go test", "verified", "checked",
    ])
    has_errors = any(kw in output_lower for kw in [
        "error:", "failed:", "assertion error", "traceback", "exception",
        "syntax error", "type error", "compilation failed",
    ])

    if has_errors:
        issues.append("Output contains errors or failures. Fix them before going idle.")

    if files_changed and not has_verification and not has_errors:
        issues.append("Files were changed but no test/lint/build verification was found in output. Run tests and confirm they pass.")

    # ── Check 3: Task deliverable vs completion ──
    if is_native and idle_reason:
        error_reasons = ["error", "failed", "exception", "crash", "timeout"]
        if any(kw in idle_reason.lower() for kw in error_reasons):
            issues.append(f"Teammate went idle due to error: {idle_reason}. Investigate and retry.")

    if task_name:
        deliverable_keywords = ["create", "write", "implement", "add", "fix", "refactor", "migrate"]
        task_lower = task_name.lower()
        if any(kw in task_lower for kw in deliverable_keywords):
            completion_keywords = ["done", "complete", "created", "written", "implemented", "fixed", "added", "migrated"]
            if not any(kw in output_lower for kw in completion_keywords) and not files_changed:
                issues.append(f"Task '{task_name}' sounds like it requires deliverables but no files were changed and no completion signal found in output.")

    # ── Write audit log ──
    with open(log_path, "a") as f:
        import datetime
        ts = datetime.datetime.now().isoformat()
        if issues:
            f.write(f"[{ts}] HELD   teammate={teammate_id} task='{task_name}' issues={len(issues)}\n")
            for issue in issues:
                f.write(f"  - {issue}\n")
        else:
            f.write(f"[{ts}] PASSED teammate={teammate_id} task='{task_name}'\n")

    if issues:
        feedback = "Quality gate failed — address the following before going idle:\n"
        for i, issue in enumerate(issues, 1):
            feedback += f"\n{i}. {issue}"
        feedback += "\n\nFix these issues, then report back."
        print(feedback)
        sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
