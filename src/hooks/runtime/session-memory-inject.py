#!/usr/bin/env python3
"""
Session Memory Injection — SessionStart hook.

Reads persistent memory from claude-mem SQLite + session-cache context files,
then prints them to stdout so Claude Code injects them as a memory document
at the top of the new session. Eliminates cold-start amnesia.

Output format: Claude Code surfaces SessionStart stdout as a system message.

Sources (in priority order):
  1. ~/.claude-mem/claude-mem.db  — claude-mem observations + session summaries
  2. ~/.claude/session-cache/compaction-state.json  — last compaction metadata
  3. ~/.claude/session-cache/*.md                   — saved context docs
  4. ~/.planning/CURRENT_PLAN.md                    — active plan (if exists)

Fail-open: any error → silent exit(0), never blocks session start.
"""

import json
import sqlite3
import sys
from pathlib import Path
from datetime import datetime, timezone

HOME = Path.home()
CACHE_DIR = HOME / ".claude" / "session-cache"
PLANNING_DIR = HOME / ".planning"
CLAUDE_MEM_DB = HOME / ".claude-mem" / "claude-mem.db"

MAX_TOTAL_CHARS = 10000  # ~2.5k tokens safety cap for SessionStart injection
MAX_FILE_BYTES = 6000
ACTIVE_PLAN_MAX_CHARS = 2000
RECENT_GIT_MAX_CHARS = 1000
SESSION_SUMMARIES_MAX_CHARS = 4000
RECENT_OBSERVATIONS_MAX_CHARS = 3000
EVERYTHING_ELSE_MAX_CHARS = 2000
FINAL_TRUNCATION_MARKER = "\n[...truncated to 2.5K token budget]"
MEM_RECENT_DAYS = 7  # look back window for claude-mem observations
MEM_MAX_OBSERVATIONS = 6  # index only — details available on-demand in DB
MEM_MAX_SUMMARIES = 2  # one-liners only


def cap_text(
    text: str | None, max_chars: int, marker: str = "\n… [truncated]"
) -> str | None:
    if text is None:
        return None
    if max_chars <= 0:
        return ""
    if len(text) <= max_chars:
        return text
    if len(marker) >= max_chars:
        return text[:max_chars]
    return text[: max_chars - len(marker)] + marker


def load_claude_mem() -> tuple[str | None, str | None]:
    """Query claude-mem SQLite for recent cross-session summaries and observations."""
    if not CLAUDE_MEM_DB.exists():
        return None, None
    try:
        con = sqlite3.connect(str(CLAUDE_MEM_DB), timeout=3)
        con.row_factory = sqlite3.Row
        # claude-mem stores epoch in milliseconds
        cutoff_ms = (
            int(datetime.now(timezone.utc).timestamp()) - (MEM_RECENT_DAYS * 86400)
        ) * 1000
        summary_lines = []
        observation_lines = []

        # Recent session summaries — high-signal compressed history
        cur = con.execute(
            """SELECT project, request, learned, completed, next_steps, created_at_epoch
               FROM session_summaries
               WHERE created_at_epoch >= ?
               ORDER BY created_at_epoch DESC
               LIMIT ?""",
            (cutoff_ms, MEM_MAX_SUMMARIES),
        )
        rows = cur.fetchall()
        if rows:
            summary_lines.append("### Recent Session Summaries")
            for r in rows:
                age_h = max(
                    0,
                    int(
                        (
                            datetime.now(timezone.utc).timestamp()
                            - r["created_at_epoch"] / 1000
                        )
                        / 3600
                    ),
                )
                age_str = f"{age_h}h ago" if age_h < 48 else f"{age_h // 24}d ago"
                proj = r["project"] or "unknown"
                parts = []
                if r["request"]:
                    parts.append(f"asked: {r['request'][:120]}")
                if r["learned"]:
                    parts.append(f"learned: {r['learned'][:120]}")
                if r["completed"]:
                    parts.append(f"done: {r['completed'][:120]}")
                if r["next_steps"]:
                    parts.append(f"next: {r['next_steps'][:80]}")
                body = " | ".join(parts)[:400] if parts else "(no details)"
                summary_lines.append(f"- [{age_str}] **{proj}**: {body}")

        # Recent observations (facts, decisions, patterns learned)
        cur = con.execute(
            """SELECT title, narrative, facts, type, created_at_epoch
               FROM observations
               WHERE created_at_epoch >= ?
               ORDER BY created_at_epoch DESC
               LIMIT ?""",
            (cutoff_ms, MEM_MAX_OBSERVATIONS),
        )
        rows = cur.fetchall()
        if rows:
            observation_lines.append("### Recent Observations")
            for r in rows:
                age_h = max(
                    0,
                    int(
                        (
                            datetime.now(timezone.utc).timestamp()
                            - r["created_at_epoch"] / 1000
                        )
                        / 3600
                    ),
                )
                age_str = f"{age_h}h ago" if age_h < 48 else f"{age_h // 24}d ago"
                title = (r["title"] or r["type"] or "observation").strip()
                # Short snippet only — full detail lives in the DB, readable on demand
                body = (r["narrative"] or r["facts"] or "").strip()[:80]
                if body:
                    observation_lines.append(f"- [{age_str}] **{title}**: {body}")
                else:
                    observation_lines.append(f"- [{age_str}] **{title}**")

        con.close()
        summaries = "\n".join(summary_lines) if summary_lines else None
        observations = "\n".join(observation_lines) if observation_lines else None
        return summaries, observations
    except Exception:
        return None, None


def utc_age(ts_str: str) -> str:
    """Return human-readable age like '2h ago'."""
    try:
        dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        delta = datetime.now(timezone.utc) - dt
        s = int(delta.total_seconds())
        if s < 60:
            return f"{s}s ago"
        if s < 3600:
            return f"{s // 60}m ago"
        return f"{s // 3600}h ago"
    except Exception:
        return "unknown age"


def load_compaction_state() -> str | None:
    state_file = CACHE_DIR / "compaction-state.json"
    if not state_file.exists():
        return None
    try:
        data = json.loads(state_file.read_text())
        ts = data.get("ts", "")
        cwd = data.get("cwd", "unknown")
        hint = data.get("recovery_hint", "")
        age = utc_age(ts) if ts else "unknown"
        return (
            f"**Last compaction**: {ts} ({age})\n"
            f"**Working dir at compaction**: `{cwd}`\n"
            f"**Recovery hint**: {hint}"
        )
    except Exception:
        return None


def load_session_md_files() -> list[tuple[str, str]]:
    """Return list of (filename, truncated_content) for *.md in session-cache."""
    results = []
    if not CACHE_DIR.exists():
        return results
    for f in sorted(CACHE_DIR.glob("*.md")):
        try:
            content = f.read_text(encoding="utf-8", errors="replace")
            if len(content) > MAX_FILE_BYTES:
                content = content[:MAX_FILE_BYTES] + "\n… [truncated]"
            results.append((f.name, content.strip()))
        except Exception:
            pass
    return results


def load_current_plan() -> str | None:
    candidates = [
        PLANNING_DIR / "CURRENT_PLAN.md",
        PLANNING_DIR / "current-plan.md",
        HOME / ".claude" / ".planning" / "CURRENT_PLAN.md",
    ]
    for path in candidates:
        if path.exists():
            try:
                content = path.read_text(encoding="utf-8", errors="replace")
                if len(content) > MAX_FILE_BYTES:
                    content = content[:MAX_FILE_BYTES] + "\n… [truncated]"
                return content.strip()
            except Exception:
                pass
    return None


def main() -> None:
    sections = []
    everything_else_remaining = EVERYTHING_ELSE_MAX_CHARS

    def add_with_everything_else_budget(header: str, text: str | None) -> None:
        nonlocal everything_else_remaining
        if not text or everything_else_remaining <= 0:
            return
        trimmed = cap_text(text, everything_else_remaining)
        if trimmed:
            sections.append((header, trimmed))
            everything_else_remaining -= len(trimmed)

    # 0. Active plan
    plan = cap_text(load_current_plan(), ACTIVE_PLAN_MAX_CHARS)
    if plan:
        sections.append(("## Active Plan", plan))

    # 1. Recent git context from cached session docs (if present)
    session_docs = load_session_md_files()
    git_context_parts = []
    other_doc_parts = []
    for name, content in session_docs:
        block = f"### {name}\n{content}"
        if (
            "git" in name.lower()
            and len("\n\n".join(git_context_parts)) < RECENT_GIT_MAX_CHARS
        ):
            git_context_parts.append(block)
        else:
            other_doc_parts.append(block)
    if git_context_parts:
        git_context = cap_text("\n\n".join(git_context_parts), RECENT_GIT_MAX_CHARS)
        if git_context:
            sections.append(("## Recent Git Context", git_context))

    # 2. claude-mem cross-session persistent memory (highest priority)
    mem_summaries, mem_observations = load_claude_mem()
    mem_summaries = cap_text(mem_summaries, SESSION_SUMMARIES_MAX_CHARS)
    if mem_summaries:
        sections.append(("## Recent Session Summaries", mem_summaries))

    mem_observations = cap_text(mem_observations, RECENT_OBSERVATIONS_MAX_CHARS)
    if mem_observations:
        sections.append(("## Recent Observations & Decisions", mem_observations))

    # 3. Compaction state + other cached docs (everything-else pool)
    compaction = load_compaction_state()
    add_with_everything_else_budget("## Last Compaction", compaction)
    if other_doc_parts:
        add_with_everything_else_budget(
            "## Additional Session Cache Context", "\n\n".join(other_doc_parts)
        )

    if not sections:
        # Nothing to inject — silent exit
        sys.exit(0)

    lines = ["<!-- SESSION MEMORY INJECTED BY session-memory-inject.py -->", ""]
    for header, body in sections:
        lines.append(header)
        lines.append("")
        lines.append(body)
        lines.append("")

    output = "\n".join(lines)
    if len(output) > MAX_TOTAL_CHARS:
        if len(FINAL_TRUNCATION_MARKER) >= MAX_TOTAL_CHARS:
            output = FINAL_TRUNCATION_MARKER[:MAX_TOTAL_CHARS]
        else:
            output = (
                output[: MAX_TOTAL_CHARS - len(FINAL_TRUNCATION_MARKER)]
                + FINAL_TRUNCATION_MARKER
            )

    print(output)
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(0)  # always fail-open
