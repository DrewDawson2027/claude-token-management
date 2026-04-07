#!/usr/bin/env python3
"""
TaskCompleted hook — quality gate for task completion in agent teams.

Fires when a teammate tries to mark a task as complete. Exit code 2 prevents
completion and sends feedback. Exit code 0 allows the task to be marked done.

Supports dual schema:
  - Coordinator: task, task_id, completion_message, files_changed, teammate_id
  - Native Agent Teams: task_title, task_id, assignee, completion_time_seconds

Wire in settings.json under hooks.TaskCompleted.
"""

import json
import sys
import os
import datetime


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        payload = {}

    # Dual-schema support: native Agent Teams + coordinator payloads
    task_name = payload.get("task_title") or payload.get("task", "")
    task_id = payload.get("task_id", "unknown")
    completion_msg = payload.get("completion_message", "")
    files_changed = payload.get("files_changed", [])
    teammate_id = payload.get("assignee") or payload.get("teammate_id", "unknown")
    is_native = "task_title" in payload or "assignee" in payload

    log_path = os.path.expanduser("~/.claude/logs/task-completed.log")
    os.makedirs(os.path.dirname(log_path), exist_ok=True)

    issues = []

    # ── Check 1: Completion message must be non-trivial (skip for native — no completion_message) ──
    if not is_native:
        trivial_messages = {
            "done",
            "complete",
            "finished",
            "ok",
            "yes",
            "completed",
            "",
        }
        if completion_msg.strip().lower() in trivial_messages:
            issues.append(
                "Completion message is too vague. Provide a concrete summary: what was changed, "
                "what was tested, and any known caveats."
            )

    # ── Check 2: Implementation tasks need file changes (skip for native — no files_changed) ──
    if not is_native:
        impl_verbs = [
            "implement",
            "create",
            "write",
            "add",
            "fix",
            "build",
            "refactor",
            "migrate",
            "update",
            "modify",
        ]
        task_lower = task_name.lower()
        is_impl_task = any(v in task_lower for v in impl_verbs)

        research_verbs = [
            "review",
            "investigate",
            "research",
            "analyze",
            "explore",
            "examine",
            "read",
            "check",
            "audit",
        ]
        is_research_task = any(v in task_lower for v in research_verbs)

        if is_impl_task and not is_research_task and not files_changed:
            issues.append(
                f"Task '{task_name}' appears to require code changes but no files were modified. "
                "Either implement the changes or explain why no file changes are needed."
            )

    # ── Check 3: No error signals in completion message (both schemas) ──
    msg_lower = completion_msg.lower()
    error_signals = [
        "error:",
        "failed:",
        "exception",
        "traceback",
        "could not",
        "unable to",
        "not found",
    ]
    found_errors = [s for s in error_signals if s in msg_lower]
    if found_errors:
        issues.append(
            f"Completion message contains error signals ({', '.join(found_errors)}). "
            "Resolve these before marking the task done."
        )

    # ── Check 4: Catch empty task names (both schemas) ──
    placeholder_names = {"task", "todo", "work", "item", "thing", "stuff", ""}
    if task_name.strip().lower() in placeholder_names:
        issues.append(
            "Task name is a placeholder. Rename it to something descriptive before completing."
        )

    # ── Write audit log ───────────────────────────────────────────────────────
    ts = datetime.datetime.now().isoformat()
    with open(log_path, "a") as f:
        schema_tag = "native" if is_native else "coordinator"
        if issues:
            f.write(
                f"[{ts}] BLOCKED [{schema_tag}] task_id={task_id} teammate={teammate_id} task='{task_name}' issues={len(issues)}\n"
            )
            for issue in issues:
                f.write(f"  - {issue}\n")
        else:
            f.write(
                f"[{ts}] ALLOWED [{schema_tag}] task_id={task_id} teammate={teammate_id} task='{task_name}'\n"
            )

    # ── Exit code 2 = block + send feedback; 0 = allow ───────────────────────
    if issues:
        feedback = f"Task '{task_name}' cannot be marked complete yet:\n"
        for i, issue in enumerate(issues, 1):
            feedback += f"\n{i}. {issue}"
        feedback += "\n\nAddress the above and resubmit."
        print(feedback)
        sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
