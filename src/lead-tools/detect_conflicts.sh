#!/bin/bash
# Detect file conflicts across sessions
# Usage: detect_conflicts.sh [my_session_id]

MY_SESSION="${1:-none}"
TERMINALS_DIR="$HOME/.claude/terminals"

python3 << 'PYEOF'
import json, os, sys
from pathlib import Path

terminals_dir = Path.home() / ".claude" / "terminals"
my_session = sys.argv[1] if len(sys.argv) > 1 else "none"

# Read all session files
sessions = []
for f in sorted(terminals_dir.glob("session-*.json")):
    try:
        with open(f) as fh:
            s = json.load(fh)
            if s.get("status") != "closed":
                sessions.append(s)
    except:
        pass

if len(sessions) < 2:
    print("No conflicts possible (fewer than 2 active sessions).")
    sys.exit(0)

# Cross-reference files_touched
file_map = {}  # file -> [sessions]
for s in sessions:
    sid = s.get("session", "?")
    files = set(s.get("files_touched", []) + s.get("current_files", []))
    for f in files:
        basename = os.path.basename(f)
        if basename not in file_map:
            file_map[basename] = []
        file_map[basename].append({
            "session": sid,
            "project": s.get("project", "?"),
            "task": s.get("current_task", "unknown"),
            "full_path": f
        })

# Find conflicts
conflicts = {f: entries for f, entries in file_map.items() if len(entries) > 1}

if not conflicts:
    print("No conflicts detected. Safe to proceed.")
else:
    print("## CONFLICTS DETECTED\n")
    for filename, entries in conflicts.items():
        session_list = ", ".join(e["session"][:8] for e in entries)
        print(f"**{filename}** touched by: {session_list}")
        for e in entries:
            print(f"  - Session {e['session'][:8]} ({e['project']}): \"{e['task']}\"")
        print()
    print("**Recommendation:** Coordinate before editing these files.")
PYEOF
