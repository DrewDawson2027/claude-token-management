#!/usr/bin/env python3
"""Read Cache — lightweight content-hash cache for file reads.

Part of the Token Management System (Innovation #7: Semantic Caching).

How it works:
  PreToolUse hook for Read tool.
  On Read: compute (file_path, mtime, size) triple.
  If cache hit with matching triple → log advisory with cached summary.
  Cache dir: ~/.claude/cache/read-results/
  TTL: 5 minutes per entry, max 50 entries.

This is ADVISORY ONLY (non-blocking, exit 0).
It supplements read-efficiency-guard — instead of just blocking,
it tells you what the file contained from your earlier read.
"""

import hashlib
import json
import os
import sys
import time
from runtime_paths import runtime_path

CACHE_DIR = str(runtime_path("cache", "read-results"))
CACHE_INDEX = os.path.join(CACHE_DIR, "index.json")
TTL_SECONDS = 300  # 5 minutes
MAX_ENTRIES = 50
SUMMARY_MAX_CHARS = 200  # Max chars for cached summary


def load_index() -> dict:
    """Load cache index."""
    try:
        with open(CACHE_INDEX) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def save_index(index: dict) -> None:
    """Save cache index with file locking to prevent concurrent corruption."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    try:
        from hook_utils import lock, unlock

        with open(CACHE_INDEX, "a+") as f:
            lock(f)
            try:
                f.seek(0)
                f.truncate()
                json.dump(index, f, indent=2)
            finally:
                unlock(f)
    except OSError:
        pass


def file_key(file_path: str) -> str:
    """Generate a stable cache key from file path."""
    return hashlib.sha256(file_path.encode()).hexdigest()[:16]


def file_triple(file_path: str):
    """Get (mtime, size) tuple for a file. Returns None if file doesn't exist."""
    try:
        st = os.stat(file_path)
        return (st.st_mtime, st.st_size)
    except OSError:
        return None


def evict_expired(index: dict) -> dict:
    """Remove expired entries from cache index."""
    now = time.time()
    keys_to_remove = [
        k for k, v in index.items() if now - v.get("cached_at", 0) > TTL_SECONDS
    ]
    for k in keys_to_remove:
        del index[k]

    # Enforce max entries (remove oldest)
    if len(index) > MAX_ENTRIES:
        sorted_keys = sorted(index.keys(), key=lambda k: index[k].get("cached_at", 0))
        for k in sorted_keys[: len(index) - MAX_ENTRIES]:
            del index[k]

    return index


def get_summary(file_path: str) -> str:
    """Generate a brief summary of a file's content."""
    try:
        with open(file_path, "r", errors="replace") as f:
            content = f.read(1000)  # Read first 1000 chars only
        # First few non-empty lines as summary
        lines = [l.strip() for l in content.split("\n") if l.strip()][:5]
        summary = " | ".join(lines)
        if len(summary) > SUMMARY_MAX_CHARS:
            summary = summary[:SUMMARY_MAX_CHARS] + "..."
        return summary
    except (OSError, UnicodeDecodeError):
        return "(binary or unreadable)"


def main():
    try:
        input_data = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    if not isinstance(input_data, dict):
        sys.exit(0)

    tool_name = input_data.get("tool_name", "")
    if tool_name != "Read":
        sys.exit(0)

    tool_input = input_data.get("tool_input", {})
    file_path = tool_input.get("file_path", "")
    if not file_path:
        sys.exit(0)

    # Expand path
    file_path = os.path.expanduser(file_path)

    index = load_index()
    index = evict_expired(index)

    key = file_key(file_path)
    triple = file_triple(file_path)

    if triple is None:
        sys.exit(0)  # File doesn't exist, let Read handle the error

    mtime, size = triple

    # Check cache
    if key in index:
        cached = index[key]
        if cached.get("mtime") == mtime and cached.get("size") == size:
            # Cache hit — file unchanged
            summary = cached.get("summary", "")
            hits = cached.get("hits", 0) + 1
            index[key]["hits"] = hits
            index[key]["last_hit"] = time.time()
            save_index(index)

            print(
                f"READ CACHE HIT: '{os.path.basename(file_path)}' unchanged since last read. "
                f"Summary: {summary}",
                file=sys.stderr,
            )
            sys.exit(0)

    # Cache miss — store current file state
    summary = get_summary(file_path)
    index[key] = {
        "path": file_path,
        "mtime": mtime,
        "size": size,
        "summary": summary,
        "cached_at": time.time(),
        "hits": 0,
        "last_hit": None,
    }
    save_index(index)

    sys.exit(0)  # Always non-blocking


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        try:
            from hook_utils import record_hook_outcome

            code = e.code if isinstance(e.code, int) else 0
            record_hook_outcome("read-cache", "success" if code == 0 else "error")
        except Exception:
            pass
        raise
    except Exception:
        try:
            from hook_utils import record_hook_outcome

            record_hook_outcome("read-cache", "fail_open")
        except Exception:
            pass
        sys.exit(0)
