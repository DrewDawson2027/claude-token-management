#!/bin/bash
# Hook Health Check — validates all hooks are working and provides audit stats
#
# Usage:
#   bash ~/.claude/hooks/health-check.sh            # Full installed-runtime health check
#   bash ~/.claude/hooks/health-check.sh --stats   # Token guard audit stats
#   bash ~/.claude/hooks/health-check.sh --cleanup  # Prune stale session state
#
# Scope:
#   This script validates the installed ~/.claude runtime (blessed path).
#   Fresh-checkout certification lives in the repository command:
#     npm run cert:a-plus:fresh
#
# Part of the Token Management System:
#   token-guard.py          → blocks illegal agent spawns (PreToolUse)
#   read-efficiency-guard.py → blocks wasteful reads (PreToolUse, matcher: Read)
#   health-check.sh         → validates + reports (manual)

STATE_DIR="$HOME/.claude/hooks/session-state"
AUDIT_LOG="$STATE_DIR/audit.jsonl"
METRICS_LOG="$STATE_DIR/agent-metrics.jsonl"
ALERTS_LOG="$HOME/.claude/cost/alerts.jsonl"
ALERT_STATE="$HOME/.claude/cost/alert-state.json"
OPS_SNAPSHOT_CACHE="$HOME/.claude/cost/ops-snapshot-cache.json"
# shellcheck disable=SC2034  # referenced by prompt sync tooling / future checks
PROMPT_SOURCE="$HOME/Projects/claude-lead-system/hooks/prompts/task_preflight_checklist.md"
PROMPT_SYNC_TOOL="$HOME/Projects/claude-lead-system/hooks/prompt_sync.py"

sanitize_count() {
  local raw="$1"
  raw=$(printf '%s\n' "$raw" | tail -n1 | tr -cd '0-9')
  printf '%s' "${raw:-0}"
}

recent_event_count() {
  local file="$1"
  local cutoff="$2"
  local event_name="$3"
  python3 - "$file" "$cutoff" "$event_name" <<'PY'
import json
import sys

path, cutoff, event_name = sys.argv[1:4]
count = 0

try:
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                entry = json.loads(raw)
            except Exception:
                continue
            ts = str(entry.get("ts", ""))
            if ts[:10] >= cutoff and entry.get("event") == event_name:
                count += 1
except Exception:
    pass

print(count)
PY
}

# --cleanup: remove stale session state files (>24h old)
if [ "$1" = "--cleanup" ]; then
  COUNT=$(find "$STATE_DIR" -name "*.json" -not -name "audit.jsonl" -mtime +1 2>/dev/null | wc -l | tr -d ' ')
  find "$STATE_DIR" -name "*.json" -not -name "audit.jsonl" -mtime +1 -delete 2>/dev/null
  find "$STATE_DIR" -name "*.lock" -mtime +1 -delete 2>/dev/null
  echo "Cleaned $COUNT stale session state files"
  exit 0
fi

# --stats: show token guard audit statistics
if [ "$1" = "--stats" ]; then
  echo ""
  echo "=== Token Guard Audit Stats ==="
  echo ""

  if [ ! -f "$AUDIT_LOG" ]; then
    echo "  No audit log found. Stats will appear after token-guard.py runs."
    echo "  Expected location: $AUDIT_LOG"
    exit 0
  fi

  TOTAL=$(sanitize_count "$(wc -l < "$AUDIT_LOG" 2>/dev/null)")
  BLOCKS=$(sanitize_count "$(grep -c '"event": "block"' "$AUDIT_LOG" 2>/dev/null || true)")
  ALLOWS=$(sanitize_count "$(grep -c '"event": "allow"' "$AUDIT_LOG" 2>/dev/null || true)")

  if [ "$TOTAL" -gt 0 ]; then
    RATE=$((BLOCKS * 100 / TOTAL))
  else
    RATE=0
  fi

  # Most blocked type
  if [ "$BLOCKS" -gt 0 ]; then
    MOST_BLOCKED=$(grep '"event": "block"' "$AUDIT_LOG" | \
      grep -o '"type": "[^"]*"' | sort | uniq -c | sort -rn | head -1 | \
      awk '{print $3 " (" $1 ")"}' | tr -d '"')
  else
    MOST_BLOCKED="none"
  fi

  # Unique sessions
  SESSIONS=$(sanitize_count "$(grep -o '"session": "[^"]*"' "$AUDIT_LOG" | sort -u | wc -l 2>/dev/null || true)")

  # Last 7 days only
  WEEK_AGO=$(date -v-7d +%Y-%m-%d 2>/dev/null || date -d "7 days ago" +%Y-%m-%d 2>/dev/null || echo "0000-00-00")
  RECENT_BLOCKS=$(sanitize_count "$(recent_event_count "$AUDIT_LOG" "$WEEK_AGO" "block")")
  RECENT_ALLOWS=$(sanitize_count "$(recent_event_count "$AUDIT_LOG" "$WEEK_AGO" "allow")")
  RECENT_TOTAL=$((RECENT_BLOCKS + RECENT_ALLOWS))

  if [ "$RECENT_TOTAL" -gt 0 ]; then
    RECENT_RATE=$((RECENT_BLOCKS * 100 / RECENT_TOTAL))
  else
    RECENT_RATE=0
  fi

  echo "  All Time:"
  echo "    Total decisions:  $TOTAL"
  echo "    Blocks:           $BLOCKS"
  echo "    Allows:           $ALLOWS"
  echo "    Block rate:       ${RATE}%"
  echo "    Most blocked:     $MOST_BLOCKED"
  echo "    Sessions tracked: $SESSIONS"
  echo ""
  echo "  Last 7 Days:"
  echo "    Decisions:        $RECENT_TOTAL"
  echo "    Blocks:           $RECENT_BLOCKS"
  echo "    Allows:           $RECENT_ALLOWS"
  echo "    Block rate:       ${RECENT_RATE}%"
  echo ""

  # Show recent blocks detail
  if [ "$BLOCKS" -gt 0 ]; then
    echo "  Recent Blocks (last 5):"
    grep '"event": "block"' "$AUDIT_LOG" | tail -5 | while read -r line; do
      TS=$(echo "$line" | grep -o '"ts": "[^"]*"' | cut -d'"' -f4)
      TYPE=$(echo "$line" | grep -o '"type": "[^"]*"' | cut -d'"' -f4)
      REASON=$(echo "$line" | grep -o '"reason": "[^"]*"' | cut -d'"' -f4)
      echo "    $TS  $TYPE  ($REASON)"
    done
  fi

  # Alert log/cache reporting (ops tier)
  if [ -f "$ALERTS_LOG" ]; then
    ALERT_TOTAL=$(wc -l < "$ALERTS_LOG" | tr -d ' ')
    ALERT_SUPPRESSED=$(grep -c '"suppressed":true' "$ALERTS_LOG" 2>/dev/null || true)
    ALERT_SUPPRESSED=${ALERT_SUPPRESSED:-0}
    echo ""
    echo "  Alerts:"
    echo "    alert events:      $ALERT_TOTAL"
    echo "    suppressed alerts: $ALERT_SUPPRESSED"
  else
    echo ""
    echo "  Alerts:"
    echo "    alert log: not yet created"
  fi
  if [ -f "$OPS_SNAPSHOT_CACHE" ]; then
    SNAP_TS=$(python3 - <<PY 2>/dev/null
import json
try:
    d=json.load(open("$OPS_SNAPSHOT_CACHE"))
    print(d.get("generated_at","unknown"))
except Exception:
    print("invalid")
PY
)
    echo "    ops snapshot cache: $SNAP_TS"
  else
    echo "    ops snapshot cache: not yet created"
  fi

  # Prompt hash verification (source-of-truth -> live settings)
  if [ -f "$PROMPT_SYNC_TOOL" ]; then
    PROMPT_SYNC_JSON=$(python3 "$PROMPT_SYNC_TOOL" --verify-only 2>/dev/null || true)
    if [ -n "$PROMPT_SYNC_JSON" ]; then
      PROMPT_MATCH=$(PROMPT_SYNC_JSON="$PROMPT_SYNC_JSON" python3 - <<'PY' 2>/dev/null
import json,os
try:
    d=json.loads(os.environ.get("PROMPT_SYNC_JSON","{}"))
    print("true" if d.get("live_settings",{}).get("matches") else "false")
except Exception:
    print("unknown")
PY
)
      PROMPT_HASH=$(PROMPT_SYNC_JSON="$PROMPT_SYNC_JSON" python3 - <<'PY' 2>/dev/null
import json,os
try:
    d=json.loads(os.environ.get("PROMPT_SYNC_JSON","{}"))
    print(d.get("prompt_hash","unknown"))
except Exception:
    print("unknown")
PY
)
      echo ""
      if [ "$PROMPT_MATCH" = "true" ]; then
        echo "  Prompt sync:        PASS (hash=$PROMPT_HASH)"
      else
        echo "  Prompt sync:        WARN (live settings prompt differs from source; hash=$PROMPT_HASH)"
      fi
    fi
  fi

  echo ""
  exit 0
fi

# Default: full health check
echo ""
echo "=== Claude Code Hook Health Check ==="
echo "Scope: installed ~/.claude runtime (blessed path)"
echo "Fresh-checkout certification command: npm run cert:a-plus:fresh"
echo ""

# ── Install-state detection ───────────────────────────────────────────
# Distinguish "not installed" from "broken code" so operators don't chase
# phantom failures when install.sh simply hasn't been run.
INSTALL_MARKER="$HOME/.claude/.lead-system-install.json"
INSTALL_MODE="unknown"
INSTALL_STATE="unknown"

if [ -f "$INSTALL_MARKER" ]; then
  INSTALL_MODE=$(python3 - <<'PY' 2>/dev/null
import json, os
try:
    d = json.load(open(os.path.expanduser("~/.claude/.lead-system-install.json")))
    print(d.get("mode", "unknown"))
except Exception:
    print("unknown")
PY
)
  INSTALL_STATE="installed"
  echo "  Install state: INSTALLED (mode=$INSTALL_MODE)"
elif [ -d "$HOME/.claude/lead-sidecar" ] || [ -d "$HOME/.claude/mcp-coordinator" ]; then
  INSTALL_STATE="partial"
  echo "  Install state: PARTIAL (components exist but install marker missing)"
  echo "  ⚠  Re-run install.sh to complete installation and create install marker."
else
  # Check if we're running from the repo rather than from ~/.claude/hooks
  SCRIPT_SELF="$(cd "$(dirname "$0")" && pwd)"
  if [ "$SCRIPT_SELF" = "$HOME/.claude/hooks" ]; then
    # Running from installed location but no install marker and no sidecar
    echo "  Install state: NOT INSTALLED"
    echo ""
    echo "  The Lead System has not been installed."
    echo "  Run: bash install.sh --allow-unsigned-release"
    echo "  Then: claudex → /lead"
    echo ""
    exit 2
  else
    # Running from repo checkout — skip install-state enforcement
    INSTALL_STATE="repo"
    echo "  Install state: REPO (running from source checkout)"
  fi
fi
echo ""

PASS=0
FAIL=0
WARN=0

check() {
  local name="$1" file="$2" required="$3"
  if [ ! -f "$file" ]; then
    if [ "$required" = "required" ]; then
      echo "  FAIL  $name — file missing: $file"
      FAIL=$((FAIL + 1))
    else
      echo "  SKIP  $name — not installed"
    fi
    return
  fi
  if [ ! -x "$file" ] && [[ "$file" == *.sh ]]; then
    echo "  FAIL  $name — not executable: $file"
    FAIL=$((FAIL + 1))
    return
  fi
  # Check syntax
  if [[ "$file" == *.sh ]]; then
    if bash -n "$file" 2>/dev/null; then
      echo "  PASS  $name"
      PASS=$((PASS + 1))
    else
      echo "  FAIL  $name — syntax error"
      FAIL=$((FAIL + 1))
    fi
  elif [[ "$file" == *.py ]]; then
    if python3 -c "import py_compile, sys; py_compile.compile(sys.argv[1], doraise=True)" "$file" 2>/dev/null; then
      echo "  PASS  $name"
      PASS=$((PASS + 1))
    else
      echo "  FAIL  $name — syntax error"
      FAIL=$((FAIL + 1))
    fi
  elif [[ "$file" == *.js ]]; then
    local node_bin="${COORDINATOR_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
    if [ -z "$node_bin" ] && [ -x /opt/homebrew/bin/node ]; then
      node_bin="/opt/homebrew/bin/node"
    fi
    if [ -n "$node_bin" ] && "$node_bin" --check "$file" 2>/dev/null; then
      echo "  PASS  $name"
      PASS=$((PASS + 1))
    elif [ -n "$node_bin" ]; then
      echo "  FAIL  $name — syntax error"
      FAIL=$((FAIL + 1))
    else
      echo "  FAIL  $name — node runtime unavailable"
      FAIL=$((FAIL + 1))
    fi
  fi
}

has_hook_command() {
   local file="$1" needle="$2"
   [ -f "$file" ] || return 1
   jq -e --arg needle "$needle" '.. | objects | .command? // empty | select(contains($needle))' "$file" >/dev/null 2>&1
 }

LOCAL_SETTINGS="$HOME/.claude/settings.local.json"
GLOBAL_SETTINGS="$HOME/.claude/settings.json"

has_any_hook_command() {
   local needle="$1"
   shift
   local file
   for file in "$@"; do
     if has_hook_command "$file" "$needle"; then
       return 0
     fi
   done
   return 1
 }

coordinator_command_from_settings() {
  python3 - "$LOCAL_SETTINGS" "$GLOBAL_SETTINGS" <<'PY'
import json
import sys

for path in sys.argv[1:]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        continue
    coord = (data.get("mcpServers") or {}).get("coordinator") or {}
    command = coord.get("command")
    if isinstance(command, str) and command:
        print(command)
        raise SystemExit(0)
PY
}

has_valid_coordinator_registration() {
  local file="$1"
  [ -f "$file" ] || return 1
  python3 - "$file" <<'PY' >/dev/null
import json
import os
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    data = json.load(fh)

coord = (data.get("mcpServers") or {}).get("coordinator") or {}
command = coord.get("command")
args = coord.get("args") or []

if not isinstance(command, str) or not command:
    raise SystemExit(1)
if os.path.basename(command) != "node":
    raise SystemExit(1)
if not any("/.claude/mcp-coordinator/index.js" in str(arg) for arg in args):
    raise SystemExit(1)
PY
}

lead_permission_status() {
   python3 - <<'PY' 2>/dev/null || true
import json, os

claude_dir = os.path.expanduser("~/.claude")
local_path = os.path.join(claude_dir, "settings.local.json")
global_path = os.path.join(claude_dir, "settings.json")
lead_path = os.path.join(claude_dir, "commands", "lead.md")
install_marker = os.path.join(claude_dir, ".lead-system-install.json")

def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None

mode = "unknown"
meta = read_json(install_marker)
if isinstance(meta, dict):
    mode = str(meta.get("mode", "unknown"))
if mode not in {"full", "hybrid"}:
    print(f"skip|mode={mode}|")
    raise SystemExit(0)
if not os.path.isfile(lead_path):
    print(f"skip|mode={mode}|")
    raise SystemExit(0)

tools = []
in_tools = False
with open(lead_path, "r", encoding="utf-8") as f:
    for raw in f:
        stripped = raw.strip()
        if not in_tools:
            if stripped == "allowed-tools:":
                in_tools = True
            continue
        if stripped == "---":
            break
        if stripped.startswith("- "):
            tools.append(stripped[2:].strip())
        elif stripped and not raw.startswith(" "):
            break

if not tools:
    print(f"skip|mode={mode}|")
    raise SystemExit(0)

allow = set()
sources = []
for label, path in (("local", local_path), ("global", global_path)):
    data = read_json(path)
    if not isinstance(data, dict):
        continue
    sources.append(label)
    for item in (data.get("permissions") or {}).get("allow") or []:
        if isinstance(item, str):
            allow.add(item)

missing = [tool for tool in tools if tool not in allow]
status = "pass" if not missing else "fail"
print(f"{status}|mode={mode};sources={','.join(sources) or 'none'}|{','.join(missing)}")
PY
 }

 echo "Hooks:"
 check "terminal-heartbeat" ~/.claude/hooks/terminal-heartbeat.sh required
 check "session-register" ~/.claude/hooks/session-register.sh required
 check "check-inbox" ~/.claude/hooks/check-inbox.sh required
 check "hook-lib-portable" ~/.claude/hooks/lib/portable.sh required
 check "session-end" ~/.claude/hooks/session-end.sh required
 check "teammate-lifecycle" ~/.claude/hooks/teammate-lifecycle.sh required
 check "token-guard" ~/.claude/hooks/token-guard.py required
 check "model-router" ~/.claude/hooks/model-router.py required
 check "read-efficiency-guard" ~/.claude/hooks/read-efficiency-guard.py required
 check "hook-utils" ~/.claude/hooks/hook_utils.py required

 if [ -x ~/.claude/hooks/check-inbox.sh ]; then
   if printf '%s' '{"session_id":"healthchk1234abcd","tool_name":"Read","tool_input":{}}' | \
     CLAUDE_LEAD_INTERRUPT_ON_NOTICES=0 bash ~/.claude/hooks/check-inbox.sh >/dev/null 2>&1; then
     echo "  PASS  check-inbox runtime self-test"
     PASS=$((PASS + 1))
   else
     echo "  FAIL  check-inbox runtime self-test (valid payload returned non-zero)"
     FAIL=$((FAIL + 1))
   fi
 fi

echo ""
echo "MCP Coordinator:"
check "coordinator" ~/.claude/mcp-coordinator/index.js required
COORDINATOR_NODE_BIN="$(coordinator_command_from_settings)"
if [ -z "$COORDINATOR_NODE_BIN" ]; then
  COORDINATOR_NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [ -f "$HOME/.claude/mcp-coordinator/scripts/spawn-smoke.mjs" ]; then
  if [ -n "$COORDINATOR_NODE_BIN" ] && "$COORDINATOR_NODE_BIN" "$HOME/.claude/mcp-coordinator/scripts/spawn-smoke.mjs" >/dev/null 2>&1; then
    echo "  PASS  coordinator spawn smoke"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  coordinator spawn smoke"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  FAIL  coordinator spawn smoke script missing"
  FAIL=$((FAIL + 1))
fi
if [ "${COORDINATOR_VISIBLE_SPAWN_SMOKE:-0}" = "1" ]; then
  if [ -f "$HOME/.claude/mcp-coordinator/scripts/visible-spawn-smoke.mjs" ]; then
    if [ -n "$COORDINATOR_NODE_BIN" ] && "$COORDINATOR_NODE_BIN" "$HOME/.claude/mcp-coordinator/scripts/visible-spawn-smoke.mjs" >/dev/null 2>&1; then
      echo "  PASS  coordinator visible spawn smoke"
      PASS=$((PASS + 1))
    else
      echo "  FAIL  coordinator visible spawn smoke"
      FAIL=$((FAIL + 1))
    fi
  else
    echo "  FAIL  coordinator visible spawn smoke script missing"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  INFO  coordinator visible spawn smoke skipped (set COORDINATOR_VISIBLE_SPAWN_SMOKE=1)"
fi

echo ""
echo "Token Management:"
 if [ -f ~/.claude/hooks/token-guard-config.json ]; then
   if python3 -c "import json; json.load(open('$HOME/.claude/hooks/token-guard-config.json'))" 2>/dev/null; then
     MAX_AGENTS=$(python3 -c "import json; print(json.load(open('$HOME/.claude/hooks/token-guard-config.json')).get('max_agents', '?'))" 2>/dev/null)
     CONFIG_SCHEMA=$(python3 -c "import json; print(json.load(open('$HOME/.claude/hooks/token-guard-config.json')).get('schema_version', 1))" 2>/dev/null)
     echo "  PASS  config valid (schema_version=$CONFIG_SCHEMA, max_agents=$MAX_AGENTS)"
     PASS=$((PASS + 1))
     if [ "$CONFIG_SCHEMA" -lt 2 ] 2>/dev/null; then
       echo "  WARN  config schema_version < 2 (upgrade recommended)"
       WARN=$((WARN + 1))
     fi
   else
     echo "  FAIL  config is invalid JSON"
     FAIL=$((FAIL + 1))
   fi
 else
   echo "  WARN  no config file (using defaults)"
   WARN=$((WARN + 1))
 fi

 STATE_COUNT=$(find "$STATE_DIR" -maxdepth 1 -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
 echo "  INFO  $STATE_COUNT active session state files"

 if [ -f "$AUDIT_LOG" ]; then
   AUDIT_LINES=$(wc -l < "$AUDIT_LOG" | tr -d ' ')
   echo "  INFO  audit log: $AUDIT_LINES entries"
 else
   echo "  INFO  audit log: not yet created (will appear after first Task call)"
 fi

 if [ -f "$AUDIT_LOG" ] || [ -f "$METRICS_LOG" ]; then
   DQ_OUT=$(python3 - <<PY 2>/dev/null
import json, os
state_dir = os.path.expanduser("$STATE_DIR")
audit = os.path.join(state_dir, "audit.jsonl")
metrics = os.path.join(state_dir, "agent-metrics.jsonl")
invalid_legacy_session = 0
v2_audit = 0
v1_audit = 0
faults = 0
empty_agent_type = 0
untagged_metrics = 0
def lines(path):
    if not os.path.isfile(path): return []
    out = []
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out
for e in lines(audit):
    if int(e.get("schema_version", 1) or 1) >= 2:
        v2_audit += 1
    else:
        v1_audit += 1
    s = str(e.get("session", "")) if "session" in e else ""
    if ("/" in s or ".." in s or "\\" in s):
        invalid_legacy_session += 1
    if e.get("event") == "fault":
        faults += 1
for m in lines(metrics):
    if "record_type" not in m:
        untagged_metrics += 1
    if m.get("event") == "agent_completed" and not str(m.get("agent_type", "")).strip():
        empty_agent_type += 1
print(f"audit_v2={v2_audit} audit_v1={v1_audit} invalid_legacy_session={invalid_legacy_session} faults={faults} untagged_metrics={untagged_metrics} empty_agent_type={empty_agent_type}")
PY
)
   [ -n "$DQ_OUT" ] && echo "  INFO  data-quality: $DQ_OUT"
 fi

 echo ""
 echo "Prompt Sync:"
 if [ -f "$PROMPT_SYNC_TOOL" ]; then
   PROMPT_SYNC_JSON=$(python3 "$PROMPT_SYNC_TOOL" --verify-only 2>/dev/null || true)
   if [ -n "$PROMPT_SYNC_JSON" ]; then
     PROMPT_STATUS=$(PROMPT_SYNC_JSON="$PROMPT_SYNC_JSON" python3 - <<'PY' 2>/dev/null
import json,os
try:
    d=json.loads(os.environ.get("PROMPT_SYNC_JSON","{}"))
    live=d.get("live_settings",{})
    if live.get("matches"):
        print("PASS")
    elif live.get("exists"):
        print("INFO")
    else:
        print("WARN")
except Exception:
    print("WARN")
PY
)
     PROMPT_HASH=$(PROMPT_SYNC_JSON="$PROMPT_SYNC_JSON" python3 - <<'PY' 2>/dev/null
import json,os
try:
    d=json.loads(os.environ.get("PROMPT_SYNC_JSON","{}")); print(d.get("prompt_hash","unknown"))
except Exception:
    print("unknown")
PY
)
     if [ "$PROMPT_STATUS" = "PASS" ]; then
       echo "  PASS  preflight prompt hash matches source ($PROMPT_HASH)"
       PASS=$((PASS + 1))
     elif [ "$PROMPT_STATUS" = "INFO" ]; then
       echo "  INFO  preflight prompt hash repo-only ($PROMPT_HASH)"
     else
       echo "  WARN  preflight prompt drift (run prompt_sync.py --apply-live) hash=$PROMPT_HASH"
       WARN=$((WARN + 1))
     fi
   else
     echo "  INFO  prompt sync tool returned no data"
   fi
 else
   echo "  INFO  prompt sync tool not found ($PROMPT_SYNC_TOOL)"
 fi

 echo ""
 echo "Alerts & Ops Cache:"
 if [ -f "$ALERTS_LOG" ]; then
   ALERT_LINES=$(wc -l < "$ALERTS_LOG" | tr -d ' ')
   LAST_ALERT=$(tail -1 "$ALERTS_LOG" 2>/dev/null | jq -r '.ts // "unknown"' 2>/dev/null)
   echo "  INFO  alerts.jsonl: $ALERT_LINES entries, last: $LAST_ALERT"
 else
   echo "  INFO  alerts.jsonl: not yet created"
 fi
 if [ -f "$ALERT_STATE" ]; then
   if python3 -c "import json; json.load(open('$ALERT_STATE'))" 2>/dev/null; then
     echo "  PASS  alert-state.json valid"
     PASS=$((PASS + 1))
   else
     echo "  WARN  alert-state.json invalid JSON"
     WARN=$((WARN + 1))
   fi
 else
   echo "  INFO  alert-state.json: not yet created"
 fi
 if [ -f "$OPS_SNAPSHOT_CACHE" ]; then
   SNAP_META=$(python3 - <<PY 2>/dev/null
import json
try:
    d=json.load(open("$OPS_SNAPSHOT_CACHE"))
    print(f"{d.get('generated_at','unknown')} schema={d.get('schema_version','?')}")
except Exception:
    print("invalid")
PY
)
   if [ "$SNAP_META" = "invalid" ]; then
     echo "  WARN  ops-snapshot-cache.json invalid JSON"
     WARN=$((WARN + 1))
   else
     echo "  INFO  ops-snapshot-cache.json: $SNAP_META"
   fi
 else
   echo "  INFO  ops-snapshot-cache.json: not yet created"
 fi

 SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
 DEFAULT_REPO_ROOT=""
 CANDIDATE_REPO_ROOT="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)"
 if [ -n "$CANDIDATE_REPO_ROOT" ] && [ -d "$CANDIDATE_REPO_ROOT/.git" ] && [ -d "$CANDIDATE_REPO_ROOT/hooks" ]; then
   DEFAULT_REPO_ROOT="$CANDIDATE_REPO_ROOT"
 fi
 REPO_ROOT="${CLAUDE_LEAD_REPO_ROOT:-$DEFAULT_REPO_ROOT}"
 if [ -n "$REPO_ROOT" ] && [ -d "$REPO_ROOT/hooks" ]; then
   DRIFT_COUNT=$(LEAD_HEALTH_REPO_ROOT="$REPO_ROOT" python3 - <<PY 2>/dev/null
import filecmp, os
repo_root = os.environ.get("LEAD_HEALTH_REPO_ROOT", "")
repo = os.path.join(repo_root, "hooks") if repo_root else ""
live = os.path.join(os.path.expanduser("~"), ".claude", "hooks")
files = ["token-guard.py","read-efficiency-guard.py","agent-metrics.py","self-heal.py","health-check.sh","hook_utils.py","token-guard-config.json"]
drift = 0
for name in files:
    a = os.path.join(repo, name)
    b = os.path.join(live, name)
    if os.path.isfile(a) and os.path.isfile(b) and not filecmp.cmp(a, b, shallow=False):
        drift += 1
print(drift)
PY
)
   echo "  INFO  repo/live hook drift count: ${DRIFT_COUNT:-unknown}"
 else
   echo "  INFO  repo/live hook drift count: skipped (set CLAUDE_LEAD_REPO_ROOT to compare against a local clone)"
 fi

 echo ""
 echo "Repo Advisories:"
 if [ -n "$REPO_ROOT" ] && [ -d "$REPO_ROOT" ]; then
   if [ -f "$REPO_ROOT/.github/workflows/benchmark-publish.yml" ]; then
     echo "  PASS  benchmark workflow present (.github/workflows/benchmark-publish.yml)"
     PASS=$((PASS + 1))
   else
     echo "  WARN  benchmark workflow missing (repo-side advisory)"
     WARN=$((WARN + 1))
   fi
   if [ -f "$REPO_ROOT/docs/TOKEN_MANAGEMENT_BENCHMARK_PUBLISHING.md" ]; then
     echo "  PASS  benchmark publishing doc present"
     PASS=$((PASS + 1))
   else
     echo "  WARN  benchmark publishing doc missing (repo-side advisory)"
     WARN=$((WARN + 1))
   fi
 else
   echo "  INFO  repo advisories skipped (set CLAUDE_LEAD_REPO_ROOT to compare against a local clone)"
 fi

 echo ""
 echo "Dependencies:"
 if command -v jq &>/dev/null; then
   echo "  PASS  jq installed ($(jq --version 2>/dev/null))"
   PASS=$((PASS + 1))
 else
   echo "  FAIL  jq not installed — heartbeat won't work"
   FAIL=$((FAIL + 1))
 fi

 if [ -n "$COORDINATOR_NODE_BIN" ] && [ -x "$COORDINATOR_NODE_BIN" ]; then
   NODE_VERSION=$("$COORDINATOR_NODE_BIN" --version 2>/dev/null || echo "unknown")
   NODE_MAJOR=$(echo "$NODE_VERSION" | sed -E 's/^v([0-9]+).*/\1/')
   if [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] && [ "$NODE_MAJOR" -ge 18 ]; then
     echo "  PASS  node installed ($NODE_VERSION via $COORDINATOR_NODE_BIN)"
     PASS=$((PASS + 1))
   elif [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]]; then
     echo "  FAIL  node version unsupported ($NODE_VERSION) — require >=18"
     FAIL=$((FAIL + 1))
   else
     echo "  FAIL  node version unreadable ($NODE_VERSION) — require >=18"
     FAIL=$((FAIL + 1))
   fi
 else
   echo "  FAIL  node not installed — MCP coordinator won't work"
   FAIL=$((FAIL + 1))
 fi

 echo ""
 echo "Settings:"
 if [ -f "$LOCAL_SETTINGS" ] || [ -f "$GLOBAL_SETTINGS" ]; then
  if { [ -f "$LOCAL_SETTINGS" ] && jq -e '.mcpServers.coordinator.args[]? | strings | contains("__HOME__")' "$LOCAL_SETTINGS" &>/dev/null; } || { [ -f "$GLOBAL_SETTINGS" ] && jq -e '.mcpServers.coordinator.args[]? | strings | contains("__HOME__")' "$GLOBAL_SETTINGS" &>/dev/null; }; then
    echo "  FAIL  unresolved __HOME__ placeholder in coordinator args"
    FAIL=$((FAIL + 1))
  elif has_valid_coordinator_registration "$LOCAL_SETTINGS"; then
    echo "  PASS  coordinator MCP registered in local settings"
    PASS=$((PASS + 1))
  elif has_valid_coordinator_registration "$GLOBAL_SETTINGS"; then
    echo "  PASS  coordinator MCP registered in global settings"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  coordinator MCP missing or miswired"
    FAIL=$((FAIL + 1))
  fi
  if has_any_hook_command "terminal-heartbeat" "$LOCAL_SETTINGS" "$GLOBAL_SETTINGS"; then
    echo "  PASS  heartbeat registered in settings"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  heartbeat NOT registered in PostToolUse"
    FAIL=$((FAIL + 1))
  fi
  if has_any_hook_command "check-inbox" "$LOCAL_SETTINGS" "$GLOBAL_SETTINGS"; then
    echo "  PASS  inbox hook registered in settings"
    PASS=$((PASS + 1))
  else
    echo "  WARN  inbox hook not found (messaging may not work)"
    WARN=$((WARN + 1))
  fi
  if has_any_hook_command "teammate-lifecycle.sh TeammateIdle" "$LOCAL_SETTINGS" "$GLOBAL_SETTINGS"; then
    echo "  PASS  teammate-lifecycle registered in TeammateIdle"
    PASS=$((PASS + 1))
  else
    echo "  WARN  TeammateIdle hook not registered (native team idle telemetry missing)"
    WARN=$((WARN + 1))
  fi
  if has_any_hook_command "teammate-lifecycle.sh TaskCompleted" "$LOCAL_SETTINGS" "$GLOBAL_SETTINGS"; then
    echo "  PASS  teammate-lifecycle registered in TaskCompleted"
    PASS=$((PASS + 1))
  else
    echo "  WARN  TaskCompleted hook not registered (native completion telemetry missing)"
    WARN=$((WARN + 1))
  fi
 else
   echo "  FAIL  settings.local.json and settings.json not found"
   FAIL=$((FAIL + 1))
 fi

 echo ""
 echo "Blessed Path:"
 if [ -f ~/.claude/commands/lead.md ]; then
   echo "  PASS  /lead command installed"
   PASS=$((PASS + 1))
 else
   echo "  FAIL  /lead command missing"
   FAIL=$((FAIL + 1))
 fi
 if [ -e ~/.local/bin/claudex ]; then
   echo "  PASS  claudex launcher installed"
   PASS=$((PASS + 1))
 elif [ "$INSTALL_STATE" = "installed" ]; then
   echo "  FAIL  claudex launcher missing from ~/.local/bin (re-run install.sh)"
   FAIL=$((FAIL + 1))
 else
   echo "  WARN  claudex launcher not linked (run install.sh to create ~/.local/bin/claudex)"
   WARN=$((WARN + 1))
 fi
 if [ -e ~/.local/bin/sidecarctl ]; then
   echo "  PASS  sidecarctl launcher installed"
   PASS=$((PASS + 1))
 elif [ "$INSTALL_STATE" = "installed" ]; then
   echo "  FAIL  sidecarctl launcher missing from ~/.local/bin (re-run install.sh)"
   FAIL=$((FAIL + 1))
 else
   echo "  WARN  sidecarctl launcher not linked (run install.sh to create ~/.local/bin/sidecarctl)"
   WARN=$((WARN + 1))
 fi

 LEAD_PERMISSION_CHECK=$(lead_permission_status)
 LEAD_PERMISSION_STATUS=${LEAD_PERMISSION_CHECK%%|*}
 LEAD_PERMISSION_REST=${LEAD_PERMISSION_CHECK#*|}
 LEAD_PERMISSION_META=${LEAD_PERMISSION_REST%%|*}
 LEAD_PERMISSION_MISSING=${LEAD_PERMISSION_CHECK##*|}
 case "$LEAD_PERMISSION_STATUS" in
   pass)
     echo "  PASS  /lead permissions cover command tool surface ($LEAD_PERMISSION_META)"
     PASS=$((PASS + 1))
     ;;
   fail)
     echo "  FAIL  /lead permissions missing: ${LEAD_PERMISSION_MISSING} ($LEAD_PERMISSION_META)"
     FAIL=$((FAIL + 1))
     ;;
   skip)
     echo "  INFO  /lead permission surface check skipped ($LEAD_PERMISSION_META)"
     ;;
 esac

 if has_any_hook_command "token-guard" "$LOCAL_SETTINGS" "$GLOBAL_SETTINGS"; then
   echo "  PASS  token-guard registered in settings"
   PASS=$((PASS + 1))
elif [ "$INSTALL_STATE" = "installed" ]; then
  echo "  FAIL  token-guard NOT registered in settings"
  FAIL=$((FAIL + 1))
else
  echo "  WARN  token-guard not registered (run install.sh to sync settings)"
  WARN=$((WARN + 1))
fi

if has_any_hook_command "model-router" "$LOCAL_SETTINGS" "$GLOBAL_SETTINGS"; then
  echo "  PASS  model-router registered in settings"
  PASS=$((PASS + 1))
elif [ "$INSTALL_STATE" = "installed" ]; then
  echo "  FAIL  model-router NOT registered in settings"
  FAIL=$((FAIL + 1))
else
  echo "  WARN  model-router not registered (run install.sh to sync settings)"
  WARN=$((WARN + 1))
fi

if has_any_hook_command "read-efficiency-guard" "$LOCAL_SETTINGS" "$GLOBAL_SETTINGS"; then
  echo "  PASS  read-efficiency-guard registered in settings"
  PASS=$((PASS + 1))
elif [ "$INSTALL_STATE" = "installed" ]; then
  echo "  FAIL  read-efficiency-guard NOT registered in settings"
  FAIL=$((FAIL + 1))
else
  echo "  WARN  read-efficiency-guard not registered (run install.sh to sync settings)"
  WARN=$((WARN + 1))
fi

if has_any_hook_command "budget-guard.py" "$LOCAL_SETTINGS" "$GLOBAL_SETTINGS"; then
  echo "  PASS  budget-guard registered in settings"
  PASS=$((PASS + 1))
elif [ "$INSTALL_STATE" = "installed" ]; then
  echo "  FAIL  budget-guard NOT registered in settings"
  FAIL=$((FAIL + 1))
else
  echo "  WARN  budget-guard not registered (run install.sh to sync settings)"
  WARN=$((WARN + 1))
fi

if has_any_hook_command "review-gate.py" "$LOCAL_SETTINGS" "$GLOBAL_SETTINGS"; then
  echo "  PASS  review-gate registered in settings"
  PASS=$((PASS + 1))
elif [ "$INSTALL_STATE" = "installed" ]; then
  echo "  FAIL  review-gate NOT registered in settings"
  FAIL=$((FAIL + 1))
else
  echo "  WARN  review-gate not registered (run install.sh to sync settings)"
  WARN=$((WARN + 1))
fi

if has_any_hook_command "read-cache.py" "$LOCAL_SETTINGS" "$GLOBAL_SETTINGS"; then
  echo "  PASS  read-cache registered in settings"
  PASS=$((PASS + 1))
elif [ "$INSTALL_STATE" = "installed" ]; then
  echo "  FAIL  read-cache NOT registered in settings"
  FAIL=$((FAIL + 1))
else
  echo "  WARN  read-cache not registered (run install.sh to sync settings)"
  WARN=$((WARN + 1))
fi

if has_any_hook_command "result-compressor.py" "$LOCAL_SETTINGS" "$GLOBAL_SETTINGS"; then
  echo "  PASS  result-compressor registered in settings"
  PASS=$((PASS + 1))
elif [ "$INSTALL_STATE" = "installed" ]; then
  echo "  FAIL  result-compressor NOT registered in settings"
  FAIL=$((FAIL + 1))
else
  echo "  WARN  result-compressor not registered (run install.sh to sync settings)"
  WARN=$((WARN + 1))
fi

if has_any_hook_command "self-heal.py" "$LOCAL_SETTINGS" "$GLOBAL_SETTINGS"; then
  echo "  PASS  self-heal registered in settings"
  PASS=$((PASS + 1))
elif [ "$INSTALL_STATE" = "installed" ]; then
  echo "  FAIL  self-heal NOT registered in settings"
  FAIL=$((FAIL + 1))
else
  echo "  WARN  self-heal not registered (run install.sh to sync settings)"
  WARN=$((WARN + 1))
fi

if has_any_hook_command "session-slo-check.py" "$LOCAL_SETTINGS" "$GLOBAL_SETTINGS"; then
  echo "  PASS  session-slo-check registered in settings"
  PASS=$((PASS + 1))
elif [ "$INSTALL_STATE" = "installed" ]; then
  echo "  FAIL  session-slo-check NOT registered in settings"
  FAIL=$((FAIL + 1))
else
  echo "  WARN  session-slo-check not registered (run install.sh to sync settings)"
  WARN=$((WARN + 1))
fi

if has_any_hook_command "routing-reminder.py" "$LOCAL_SETTINGS" "$GLOBAL_SETTINGS"; then
  echo "  PASS  routing-reminder registered in settings"
  PASS=$((PASS + 1))
elif [ "$INSTALL_STATE" = "installed" ]; then
  echo "  FAIL  routing-reminder NOT registered in settings"
  FAIL=$((FAIL + 1))
else
  echo "  WARN  routing-reminder not registered (run install.sh to sync settings)"
  WARN=$((WARN + 1))
fi

if has_any_hook_command "session-tracker.py" "$LOCAL_SETTINGS" "$GLOBAL_SETTINGS"; then
  echo "  PASS  session-tracker registered in settings"
  PASS=$((PASS + 1))
elif [ "$INSTALL_STATE" = "installed" ]; then
  echo "  FAIL  session-tracker NOT registered in settings"
  FAIL=$((FAIL + 1))
else
  echo "  WARN  session-tracker not registered (run install.sh to sync settings)"
  WARN=$((WARN + 1))
fi

echo ""
echo "Master Agents:"
AGENT_PASS=0
AGENT_FAIL=0
for agent in master-coder master-researcher master-architect master-workflow; do
  if [ -f ~/.claude/agents/${agent}.md ]; then
    echo "  PASS  ${agent}.md"
    AGENT_PASS=$((AGENT_PASS + 1))
    PASS=$((PASS + 1))
  elif [ "$INSTALL_STATE" = "installed" ]; then
    echo "  FAIL  ${agent}.md — missing (re-run install.sh)"
    AGENT_FAIL=$((AGENT_FAIL + 1))
    FAIL=$((FAIL + 1))
  else
    echo "  WARN  ${agent}.md — not installed (run install.sh)"
    AGENT_FAIL=$((AGENT_FAIL + 1))
    WARN=$((WARN + 1))
  fi
done
if [ -f ~/.claude/master-agents/MANIFEST.md ]; then
  echo "  PASS  MANIFEST.md"
  PASS=$((PASS + 1))
elif [ "$INSTALL_STATE" = "installed" ]; then
  echo "  FAIL  MANIFEST.md — missing (re-run install.sh)"
  FAIL=$((FAIL + 1))
else
  echo "  WARN  MANIFEST.md — not installed (run install.sh)"
  WARN=$((WARN + 1))
fi
MODE_COUNT=$(find ~/.claude/master-agents -name "*.md" -not -name "MANIFEST.md" -not -path "*/refs/*" 2>/dev/null | wc -l | tr -d ' ')
echo "  INFO  $MODE_COUNT mode files found (expected 17)"
if [ "$MODE_COUNT" -lt 17 ]; then
  echo "  WARN  some mode files may be missing"
  WARN=$((WARN + 1))
fi

echo ""
echo "Session Files:"
ACTIVE=$(find ~/.claude/terminals -maxdepth 1 -type f -name 'session-*.json' 2>/dev/null | wc -l | tr -d ' ')
echo "  INFO  $ACTIVE session file(s) on disk"

echo ""
echo "Activity Log:"
if [ -f ~/.claude/terminals/activity.jsonl ]; then
  LINES=$(wc -l < ~/.claude/terminals/activity.jsonl | tr -d ' ')
  LAST=$(tail -1 ~/.claude/terminals/activity.jsonl 2>/dev/null | jq -r '.ts // "unknown"' 2>/dev/null)
  echo "  INFO  $LINES entries, last: $LAST"
else
  echo "  WARN  no activity log yet"
  WARN=$((WARN + 1))
fi

echo ""
echo "─────────────────────────────────"
echo "  Results: $PASS passed, $FAIL failed, $WARN warnings"
if [ "$FAIL" -gt 0 ]; then
  echo "  STATUS: UNHEALTHY — fix the failures above"
  exit 1
else
  echo "  STATUS: HEALTHY"
  exit 0
fi
