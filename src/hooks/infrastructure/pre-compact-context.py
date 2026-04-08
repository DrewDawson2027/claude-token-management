#!/usr/bin/env python3
"""
Pre-Compact Context Save — companion to pre-compact-save.sh

Reads the session transcript right before compaction fires and writes
a task-context .md to session-cache/. session-memory-inject.py already
reads all *.md files in that directory, so this requires zero extra wiring.

Called by pre-compact-save.sh with args: transcript_path session_id cwd
Fail-open: any error → silent exit(0), never blocks compaction.
"""

import json
import sys
from pathlib import Path
from datetime import datetime, timezone
from runtime_paths import runtime_path

MAX_RECENT_MESSAGES = 20
MAX_USER_MSG_CHARS = 600
MAX_ASSISTANT_MSG_CHARS = 1000
MAX_CONTEXT_FILES = 3  # keep only 3 most recent to avoid session-cache bloat


def extract_text(content) -> str:
    """Pull plain text out of a content field (str or list of blocks)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                return block.get("text", "")
    return ""


def main():
    if len(sys.argv) < 2:
        sys.exit(0)

    transcript_path = Path(sys.argv[1])
    session_id = sys.argv[2] if len(sys.argv) > 2 else "unknown"
    cwd = sys.argv[3] if len(sys.argv) > 3 else "unknown"

    if not transcript_path.exists():
        sys.exit(0)

    # Read transcript (JSONL format)
    messages = []
    try:
        for line in transcript_path.read_text(errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                messages.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    except Exception:
        sys.exit(0)

    if not messages:
        sys.exit(0)

    recent = messages[-MAX_RECENT_MESSAGES:]

    # --- Find last user request ---
    last_user_text = ""
    for msg in reversed(recent):
        role = msg.get("role") or msg.get("type", "")
        if role == "user":
            text = extract_text(msg.get("content", ""))
            if text.strip():
                last_user_text = text[:MAX_USER_MSG_CHARS]
                break

    # --- Find last assistant response ---
    last_assistant_text = ""
    for msg in reversed(recent):
        role = msg.get("role") or msg.get("type", "")
        if role == "assistant":
            text = extract_text(msg.get("content", ""))
            if text.strip():
                last_assistant_text = text[:MAX_ASSISTANT_MSG_CHARS]
                break

    # --- Find files being edited ---
    edited_files = []
    for msg in recent:
        content = msg.get("content", [])
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use" and block.get("name") in (
                "Write",
                "Edit",
                "MultiEdit",
            ):
                fp = block.get("input", {}).get("file_path", "")
                if fp and fp not in edited_files:
                    edited_files.append(fp)

    # --- Build the context doc ---
    now = datetime.now(timezone.utc)
    ts_human = now.strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        f"# Session Context (pre-compaction snapshot — {ts_human})",
        "",
        f"**Working directory:** `{cwd}`",
        f"**Session:** `{session_id[:8]}`",
        "",
    ]

    if last_user_text:
        lines += [
            "## Last Task",
            last_user_text,
            "",
        ]

    if last_assistant_text:
        lines += [
            "## Where Claude Left Off",
            last_assistant_text,
            "",
        ]

    if edited_files:
        lines.append("## Files In Play")
        for f in edited_files[-10:]:
            lines.append(f"- `{f}`")
        lines.append("")

    lines.append("*Auto-saved before compaction. Resume from this point.*")

    # --- Write to session-cache ---
    cache_dir = runtime_path("session-cache")
    cache_dir.mkdir(parents=True, exist_ok=True)

    ts_file = now.strftime("%Y%m%d-%H%M%S")
    output_path = cache_dir / f"compaction-context-{ts_file}.md"
    output_path.write_text("\n".join(lines))

    # Prune old context files — keep only the 3 most recent
    old_files = sorted(cache_dir.glob("compaction-context-*.md"))
    for old in old_files[:-MAX_CONTEXT_FILES]:
        try:
            old.unlink()
        except Exception:
            pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
