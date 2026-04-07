#!/usr/bin/env bash
# Open all active project workspaces in cmux.
# Run this from inside cmux to get a full project dashboard.
# Usage: bash ~/.claude/mcp-coordinator/scripts/cmux-projects.sh
set -euo pipefail

if [[ -z "${CMUX_WORKSPACE_ID:-}" && -z "${CMUX_SURFACE_ID:-}" ]]; then
  echo "Error: not running inside cmux. Open cmux first, then run this script." >&2
  exit 1
fi

echo "Booting cmux project workspaces..."

# Rename current workspace as home base
cmux rename-workspace "home"

open_project() {
  local name="$1"
  local path="$2"
  local cmd="${3:-exec zsh}"
  if [[ -d "$path" ]]; then
    cmux new-workspace --cwd "$path" --command "bash -c 'echo \"[$name] $path\" && $cmd'"
    cmux rename-workspace "$name"
    echo "  ✓ $name → $path"
  else
    echo "  ✗ $name → $path (not found, skipping)"
  fi
}

# Claude infrastructure
open_project "mcp-coordinator"  "$HOME/.claude/mcp-coordinator"
open_project "lean-ralph"       "$HOME/Desktop/Claude Code/lean-ralph"

# Active projects
open_project "trust-engine"     "$HOME/.claude/worktrees/slot-1"
open_project "lead-system"      "$HOME/.claude/worktrees/slot-2"
open_project "claude-mem"       "$HOME/projects/claude-mem"
open_project "n8n"              "$HOME/projects/n8n-server"
open_project "pi-mono"          "$HOME/projects/pi-mono"

echo ""
echo "All workspaces open. Navigate tabs in cmux sidebar."
echo "Tip: each workspace has CMUX_WORKSPACE_ID set — Claude will detect cmux automatically."
