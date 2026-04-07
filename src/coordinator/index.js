#!/usr/bin/env node

/**
 * MCP Coordinator Server — thin routing layer.
 * All logic lives in lib/ modules. This file wires up the MCP server,
 * defines tool schemas, and dispatches calls.
 * @module index
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "url";
import { join } from "path";
import { performance } from "perf_hooks";

import { cfg } from "./lib/constants.js";
import {
  sanitizeId,
  sanitizeShortSessionId,
  sanitizeName,
  sanitizeModel,
  sanitizeAgent,
  requireDirectoryPath,
  normalizeFilePath,
  ensureSecureDirectory,
  sleepMs,
  acquireExclusiveFileLock,
  enforceMessageRateLimit,
} from "./lib/security.js";
import { readJSONLLimited, batQuote, text } from "./lib/helpers.js";
import {
  handleListSessions,
  handleGetSession,
  getSessionStatus,
  handleBootSnapshot,
  handleDiscoverPeers,
} from "./lib/sessions.js";
import {
  handleCheckInbox,
  handleSendMessage,
  handleBroadcast,
  handleSendDirective,
  handleSendProtocol,
  handleDrainNativeQueue,
} from "./lib/messaging.js";
import { handleDetectConflicts } from "./lib/conflicts.js";
import { handleSessionHealth } from "./lib/session-health.js";
import {
  handleSpawnWorker,
  handleSpawnWorkers,
  handleSpawnTerminal,
  handleGetResult,
  handleWorkerReport,
  handleWatchOutput,
  getActiveWorkerSummaries,
  handleSendToWorkerPane,
} from "./lib/workers.js";
import {
  handleCreateTask,
  handleUpdateTask,
  handleListTasks,
  handleGetTask,
  handleReassignTask,
  handleGetTaskAudit,
  handleCheckQualityGates,
} from "./lib/tasks.js";
import { handleApprovePlan, handleRejectPlan } from "./lib/approval.js";
import {
  handleShutdownRequest,
  handleShutdownResponse,
} from "./lib/shutdown.js";
import {
  handleWriteContext,
  handleReadContext,
  handleExportContext,
} from "./lib/context-store.js";
import {
  handleListAgents,
  handleGetAgent,
  handleCreateAgent,
  handleUpdateAgent,
  handleDeleteAgent,
  handleSyncAgentManifest,
} from "./lib/agents.js";
import {
  handleCreateTeam,
  handleGetTeam,
  handleListTeams,
  handleDeleteTeam,
  handleUpdateTeamPolicy,
} from "./lib/teams.js";
import {
  handleTeamStatusCompact,
  handleTeamQueueTask,
  handleClaimNextTask,
  handleClaimNextTaskData,
  handleTeamAssignNext,
  handleTeamRebalance,
  handleSidecarStatus,
} from "./lib/team-tasking.js";
import { runGC } from "./lib/gc.js";
import { handleCostComparison } from "./lib/cost-comparison.js";
import { handleWakeSession } from "./lib/platform/wake.js";
import { selectWakeText } from "./lib/platform/wake.js";
import {
  buildPlatformLaunchCommand,
  buildItermProfileCommandLaunchScript,
  isProcessAlive,
  killProcess,
  isSafeTTYPath,
} from "./lib/platform/common.js";

// Legacy cost MCP deprecation metadata (compat helpers for tests and envelope wrappers)
const LEGACY_COST_DEPRECATIONS = {
  coord_cost_summary: {
    canonical_tool: "coord_cost_overview",
    canonical_command: "claude-token-guard cost overview",
  },
  coord_cost_statusline: {
    canonical_tool: "coord_cost_overview",
    canonical_command: "claude-token-guard cost overview --format statusline",
  },
  coord_cost_budget_status: {
    canonical_tool: "coord_cost_budget",
    canonical_command: "claude-token-guard cost budget status",
  },
  coord_cost_set_budget: {
    canonical_tool: "coord_cost_budget",
    canonical_command: "claude-token-guard cost budget set",
  },
  coord_cost_session: {
    canonical_tool: "coord_cost_sessions",
    canonical_command: "claude-token-guard cost sessions show",
  },
  coord_cost_team: {
    canonical_tool: "coord_cost_teams",
    canonical_command: "claude-token-guard cost teams show",
  },
  coord_cost_spend_leaderboard: {
    canonical_tool: "coord_cost_teams",
    canonical_command: "claude-token-guard cost teams leaderboard",
  },
  coord_cost_trends: {
    canonical_tool: "coord_ops_trends",
    canonical_command: "claude-token-guard ops trends",
  },
  coord_cost_anomaly_check: {
    canonical_tool: "coord_ops_alerts",
    canonical_command: "claude-token-guard ops alerts check --kind anomaly",
  },
  coord_cost_burn_rate_check: {
    canonical_tool: "coord_ops_alerts",
    canonical_command: "claude-token-guard ops alerts check --kind burn-rate",
  },
  coord_cost_burn_projection: {
    canonical_tool: "coord_ops_trends",
    canonical_command: "claude-token-guard ops trends",
  },
  coord_cost_anomalies: {
    canonical_tool: "coord_ops_alerts",
    canonical_command: "claude-token-guard ops alerts status",
  },
  coord_cost_daily_report_generate: {
    canonical_tool: "coord_ops_today",
    canonical_command: "claude-token-guard ops today --markdown",
  },
};

function applyLegacyDeprecationToOutput(toolName, data) {
  if (!(toolName in LEGACY_COST_DEPRECATIONS)) return data;
  const raw = typeof data === "string" ? data : String(data ?? "");
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      parsed.deprecated = true;
      parsed.canonical_tool = LEGACY_COST_DEPRECATIONS[toolName].canonical_tool;
      parsed.canonical_command =
        LEGACY_COST_DEPRECATIONS[toolName].canonical_command;
      return JSON.stringify(parsed, null, 2);
    }
  } catch {}
  return `${raw}\n\n[DEPRECATED]\ncanonical_tool=${LEGACY_COST_DEPRECATIONS[toolName].canonical_tool}\ncanonical_command=${LEGACY_COST_DEPRECATIONS[toolName].canonical_command}\n`;
}

function withEnvelope(tool, startedAt, requestId, producer) {
  const envelopeEnabled =
    process.env.CLAUDE_COORDINATOR_RESULT_ENVELOPE === "1";
  const warnings = [];
  const data = applyLegacyDeprecationToOutput(tool, producer());
  if (!envelopeEnabled) return text(data);
  return text(
    JSON.stringify(
      {
        ok: true,
        data: { text: data },
        error: null,
        meta: { tool, durationMs: Date.now() - startedAt, requestId, warnings },
      },
      null,
      2,
    ),
  );
}

// ─────────────────────────────────────────────────────────
// SERVER SETUP
// ─────────────────────────────────────────────────────────

const server = new Server(
  { name: "coordinator", version: "2.0.0" },
  { capabilities: { tools: {} } },
);

// ─────────────────────────────────────────────────────────
// TOOL PROFILES — controls which tools appear in tools/list
// Set COORDINATOR_PROFILE env var: core | teams | ops | full
// Default "core" keeps always-on schema tax to ~12 tools (~4-5k tokens)
// ─────────────────────────────────────────────────────────

const PROFILE = process.env.COORDINATOR_PROFILE || "core";

const CORE_TOOLS = new Set([
  "coord_list_sessions",
  "coord_get_session",
  "coord_check_inbox",
  "coord_detect_conflicts",
  "coord_spawn_terminal",
  "coord_spawn_worker",
  "coord_spawn_workers",
  "coord_get_result",
  "coord_watch_output",
  "coord_wake_session",
  "coord_broadcast",
  "coord_send_message",
  "coord_send_directive",
  "coord_send_protocol",
  "coord_drain_native_queue",
  "coord_discover_peers",
  "coord_boot_snapshot",
  "coord_list_agents",
  "coord_get_agent",
  "coord_create_agent",
  "coord_update_agent",
  "coord_delete_agent",
  "coord_sync_agent_manifest",
]);

const TEAMS_TOOLS = new Set([
  "coord_create_task",
  "coord_update_task",
  "coord_list_tasks",
  "coord_get_task",
  "coord_reassign_task",
  "coord_get_task_audit",
  "coord_check_quality_gates",
  "coord_create_team",
  "coord_get_team",
  "coord_list_teams",
  "coord_delete_team",
  "coord_update_team_policy",
  "coord_team_status_compact",
  "coord_team_queue_task",
  "coord_claim_next_task",
  "coord_team_assign_next",
  "coord_team_rebalance",
]);

const OPS_TOOLS = new Set([
  "coord_write_context",
  "coord_read_context",
  "coord_export_context",
  "coord_approve_plan",
  "coord_reject_plan",
  "coord_shutdown_request",
  "coord_shutdown_response",
  "coord_sidecar_status",
  "coord_cost_comparison",
  "coord_worker_report",
  "coord_session_health",
]);

function toolVisibleInProfile(toolName) {
  if (PROFILE === "full") return true;
  if (PROFILE === "core") return CORE_TOOLS.has(toolName);
  if (PROFILE === "teams") return TEAMS_TOOLS.has(toolName);
  if (PROFILE === "ops") return OPS_TOOLS.has(toolName);
  return true;
}

// ─────────────────────────────────────────────────────────
// TOOL DEFINITIONS (declarative schemas — no logic to test)
// ─────────────────────────────────────────────────────────

/* c8 ignore start — tool schemas are declarative data, tested via dispatch */
const ALL_TOOLS = [
  {
    name: "coord_session_health",
    description:
      "Check session enrichment health for cheap /lead boot: sparse ratio, repair coverage, and no-transcript-read readiness.",
    inputSchema: {
      type: "object",
      properties: {
        include_closed: {
          type: "boolean",
          description: "Include closed sessions (default: false)",
        },
        warn_sparse_ratio: {
          type: "number",
          description: "Warning threshold as fraction (default: 0.10)",
        },
        fail_sparse_ratio: {
          type: "number",
          description: "Fail threshold as fraction (default: 0.25)",
        },
      },
    },
  },
  {
    name: "coord_list_sessions",
    description:
      "List all Claude Code sessions. Shows enriched data: tool_counts, files_touched, recent_ops. Cross-platform.",
    inputSchema: {
      type: "object",
      properties: {
        include_closed: {
          type: "boolean",
          description: "Include closed sessions (default: false)",
        },
        project: { type: "string", description: "Filter by project name" },
      },
    },
  },
  {
    name: "coord_get_session",
    description:
      "Get detailed info about a session including enriched metadata, plan file, and recent prompts.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "First 8 chars of the session ID",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "coord_check_inbox",
    description: "Check and retrieve pending messages for a session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session ID (first 8 chars)",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "coord_detect_conflicts",
    description:
      "Detect file conflicts across sessions using both current_files and files_touched from enriched session data.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Your session ID" },
        files: {
          type: "array",
          items: { type: "string" },
          description: "File paths to check",
        },
      },
      required: ["session_id", "files"],
    },
  },
  {
    name: "coord_spawn_terminal",
    description:
      "Open a Claude terminal in a new tab/split using the requested directory and optional initial prompt.",
    inputSchema: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Working directory for the new terminal",
        },
        initial_prompt: {
          type: "string",
          description: "Optional prompt to pass to Claude on launch",
        },
        layout: {
          type: "string",
          enum: ["tab", "split"],
          description: "Visible terminal layout to request",
        },
      },
      required: ["directory"],
    },
  },
  {
    name: "coord_spawn_worker",
    description:
      "Spawn a worker with explicit launch metadata, handshake verification, and visible-launch fallback handling.",
    inputSchema: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Worker working directory",
        },
        prompt: {
          type: "string",
          description: "Task prompt for the worker",
        },
        model: {
          type: "string",
          description: "Model to use (haiku/sonnet)",
        },
        task_id: {
          type: "string",
          description: "Optional explicit task ID",
        },
        worker_name: {
          type: "string",
          description: "Optional human-friendly worker name",
        },
        layout: {
          type: "string",
          enum: ["tab", "split", "background", "tmux"],
          description: "Requested spawn layout/backend",
        },
        mode: {
          type: "string",
          enum: ["pipe", "interactive"],
          description: "Worker execution mode",
        },
        runtime: {
          type: "string",
          enum: ["claude", "codex"],
          description: "Worker runtime",
        },
        role: {
          type: "string",
          enum: ["researcher", "implementer", "reviewer", "planner"],
          description: "Role preset for worker defaults",
        },
        notify_session_id: {
          type: "string",
          description: "Lead session to notify on completion",
        },
        session_id: {
          type: "string",
          description: "Alias for notify_session_id",
        },
      },
      required: ["directory", "prompt"],
    },
  },
  {
    name: "coord_spawn_workers",
    description: "Spawn multiple workers in one call.",
    inputSchema: {
      type: "object",
      properties: {
        workers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              directory: { type: "string" },
              prompt: { type: "string" },
              model: { type: "string" },
              task_id: { type: "string" },
              worker_name: { type: "string" },
              layout: {
                type: "string",
                enum: ["tab", "split", "background", "tmux"],
              },
              mode: {
                type: "string",
                enum: ["pipe", "interactive"],
              },
              role: {
                type: "string",
                enum: ["researcher", "implementer", "reviewer", "planner"],
              },
            },
            required: ["directory", "prompt"],
          },
          description: "Worker definitions to spawn",
        },
      },
      required: ["workers"],
    },
  },
  {
    name: "coord_get_result",
    description: "Check worker output and completion status.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "Task ID to check",
        },
        tail_lines: {
          type: "number",
          description: "Lines from end to return (default: 100)",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "coord_watch_output",
    description:
      "Live-monitor worker output — equivalent to native Shift+Down. Call with no args to see all active workers' latest line. Call with worker_name to focus on one worker's full output.",
    inputSchema: {
      type: "object",
      properties: {
        worker_name: {
          type: "string",
          description: "Worker name to watch (e.g. 'alpha')",
        },
        task_id: {
          type: "string",
          description: "Task ID (alternative to worker_name)",
        },
        lines: {
          type: "number",
          description: "Number of lines to return (default: 50, max: 500)",
        },
      },
    },
  },
  {
    name: "coord_wake_session",
    description:
      "Wake an idle session. macOS: AppleScript by tty/title. Linux: direct safe TTY write when available. Windows: AppActivate+SendKeys best effort. All platforms fallback to urgent inbox message.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session ID (first 8 chars)",
        },
        message: {
          type: "string",
          description:
            "Text to send to the session (delivered via inbox; terminal gets Enter keystroke only)",
        },
      },
      required: ["session_id", "message"],
    },
  },
  // ── Task Board ──
  {
    name: "coord_create_task",
    description:
      "Create a task on the shared task board with subject, description, assignee, and dependency tracking.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Task title (required)" },
        description: {
          type: "string",
          description: "Detailed task description",
        },
        task_id: {
          type: "string",
          description: "Custom task ID (auto-generated if omitted)",
        },
        assignee: {
          type: "string",
          description: "Worker/session name to assign to",
        },
        priority: {
          type: "string",
          enum: ["low", "normal", "high"],
          description: "Priority (default: normal)",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Files this task will touch",
        },
        blocked_by: {
          type: "array",
          items: { type: "string" },
          description: "Task IDs that must complete first",
        },
        team_name: {
          type: "string",
          description:
            "Team this task belongs to (optional, enables team task views)",
        },
        metadata: {
          type: "object",
          description: "Arbitrary key-value metadata (any JSON object)",
        },
      },
      required: ["subject"],
    },
  },
  {
    name: "coord_update_task",
    description:
      "Update a task: change status, assignee, add dependencies, merge metadata.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID to update" },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "cancelled"],
          description: "New status",
        },
        assignee: {
          type: "string",
          description: "New assignee (empty string to unassign)",
        },
        subject: { type: "string", description: "New subject" },
        description: { type: "string", description: "New description" },
        team_name: {
          type: "string",
          description: "Team name (set empty string to clear)",
        },
        priority: {
          type: "string",
          enum: ["low", "normal", "high"],
          description: "New priority",
        },
        add_blocked_by: {
          type: "array",
          items: { type: "string" },
          description: "Add dependency on these task IDs",
        },
        add_blocks: {
          type: "array",
          items: { type: "string" },
          description: "This task blocks these task IDs",
        },
        metadata: {
          type: "object",
          description:
            "Merge key-value metadata. Set key to null to delete it.",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "coord_list_tasks",
    description:
      "List all tasks on the task board, with dependency and blocker info.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status" },
        assignee: { type: "string", description: "Filter by assignee" },
        team_name: { type: "string", description: "Filter by team_name" },
      },
    },
  },
  {
    name: "coord_get_task",
    description:
      "Get full details of a task including description, files, and dependencies.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID" },
      },
      required: ["task_id"],
    },
  },
  // ── C1: Task Reassignment ──
  {
    name: "coord_reassign_task",
    description:
      "Reassign an in-progress task to a different team member. Creates a handoff snapshot and audit trail entry.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID to reassign" },
        new_assignee: {
          type: "string",
          description: "Name of the new assignee",
        },
        reason: { type: "string", description: "Reason for reassignment" },
        progress_context: {
          type: "string",
          description: "Summary of progress so far for handoff",
        },
      },
      required: ["task_id", "new_assignee"],
    },
  },
  // ── C2: Audit Trail ──
  {
    name: "coord_get_task_audit",
    description:
      "Get the full audit trail for a task — all state changes, assignments, reassignments, and handoffs.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID" },
      },
      required: ["task_id"],
    },
  },
  // ── C3: Quality Gates ──
  {
    name: "coord_check_quality_gates",
    description:
      "Check quality gates and acceptance criteria status for a task.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID to check" },
      },
      required: ["task_id"],
    },
  },
  // ── Teams ──
  {
    name: "coord_create_team",
    description:
      "Create or update a team with members, roles, and project info. Persists across sessions.",
    inputSchema: {
      type: "object",
      properties: {
        team_name: { type: "string", description: "Team name (required)" },
        project: { type: "string", description: "Project name" },
        description: { type: "string", description: "Team purpose" },
        preset: {
          type: "string",
          enum: ["simple", "strict", "native-first"],
          description:
            "Apply a team preset for lower setup (simple/native-first) or strict controlled execution.",
        },
        execution_path: {
          type: "string",
          enum: ["native", "coordinator", "hybrid"],
          description: "Preferred execution path for this team.",
        },
        low_overhead_mode: {
          type: "string",
          enum: ["simple", "advanced"],
          description:
            "simple reduces setup/controls; advanced enables full coordinator policy surface.",
        },
        policy: {
          type: "object",
          description:
            "Team-level defaults/enforcement for worker spawns. Supported keys: permission_mode, require_plan, default_mode, default_runtime, default_context_level, budget_policy, budget_tokens, global_budget_policy, global_budget_tokens, max_active_workers, default_isolate",
        },
        members: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              role: { type: "string" },
              session_id: { type: "string" },
              task_id: { type: "string" },
              color: {
                type: "string",
                enum: [
                  "red",
                  "green",
                  "blue",
                  "yellow",
                  "purple",
                  "cyan",
                  "white",
                ],
              },
            },
            required: ["name"],
          },
          description: "Team members to add/update",
        },
        workers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Worker name" },
              task: {
                type: "string",
                description: "Task prompt for the worker",
              },
              model: {
                type: "string",
                description: "Model to use (haiku/sonnet)",
              },
              directory: {
                type: "string",
                description: "Working directory for the worker",
              },
              parent_session_id: { type: "string" },
            },
            required: ["name", "task"],
          },
          description:
            "Optional: define worker roles for the team (metadata only, does not spawn processes).",
        },
      },
      required: ["team_name"],
    },
  },
  {
    name: "coord_get_team",
    description: "Get team composition, members, and their assigned work.",
    inputSchema: {
      type: "object",
      properties: {
        team_name: { type: "string", description: "Team name" },
      },
      required: ["team_name"],
    },
  },
  {
    name: "coord_list_teams",
    description: "List all teams.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "coord_delete_team",
    description: "Delete a team and optionally clean its associated tasks.",
    inputSchema: {
      type: "object",
      properties: {
        team_name: { type: "string", description: "Team name to delete" },
        clean_tasks: {
          type: "boolean",
          description:
            "Also remove tasks associated with this team (default: false)",
        },
      },
      required: ["team_name"],
    },
  },
  {
    name: "coord_update_team_policy",
    description:
      "Update team policy fields (including interrupt priority weights) for an existing team.",
    inputSchema: {
      type: "object",
      properties: {
        team_name: { type: "string", description: "Team name to update" },
        policy: {
          type: "object",
          description:
            "Policy patch object (validated and merged into existing policy)",
        },
        interrupt_weights: {
          type: "object",
          description:
            "Optional partial interrupt weight update. Allowed keys: approval, bridge, stale, conflict, budget, error, warn, default.",
        },
      },
      required: ["team_name"],
    },
  },
  {
    name: "coord_team_status_compact",
    description:
      "High-signal operational team summary for action panels: members, presence/load, queued tasks, blockers, policy state.",
    inputSchema: {
      type: "object",
      properties: {
        team_name: { type: "string", description: "Existing team name" },
      },
      required: ["team_name"],
    },
  },
  {
    name: "coord_team_queue_task",
    description:
      "Queue a team task without dispatching a worker yet. Stores dispatch prompt and affinity metadata for later assignment.",
    inputSchema: {
      type: "object",
      properties: {
        team_name: { type: "string" },
        subject: { type: "string" },
        prompt: {
          type: "string",
          description: "Dispatch prompt to use later when assigning",
        },
        description: { type: "string" },
        task_id: { type: "string" },
        assignee: { type: "string" },
        priority: { type: "string", enum: ["low", "normal", "high"] },
        files: { type: "array", items: { type: "string" } },
        blocked_by: { type: "array", items: { type: "string" } },
        role_hint: {
          type: "string",
          description: "Preferred role for assignment (e.g. reviewer)",
        },
        load_affinity: {
          type: "string",
          enum: ["research", "implement", "review", "plan"],
        },
        acceptance_criteria: { type: "array", items: { type: "string" } },
        metadata: { type: "object" },
        notify_session_id: { type: "string" },
        parent_session_id: { type: "string" },
      },
      required: ["team_name", "subject", "prompt"],
    },
  },
  {
    name: "coord_claim_next_task",
    description:
      "Mark a teammate's completed team task from its worker task ID, then let that same teammate claim the next unblocked queued task.",
    inputSchema: {
      type: "object",
      properties: {
        team_name: { type: "string" },
        completed_worker_task_id: { type: "string" },
        assignee: {
          type: "string",
          description: "Specific teammate name to continue claiming work as",
        },
        directory: {
          type: "string",
          description:
            "Default working directory for queued tasks missing dispatch.directory",
        },
        worker_task_id: { type: "string" },
        model: { type: "string" },
        agent: { type: "string" },
        role: {
          type: "string",
          enum: ["researcher", "implementer", "reviewer", "planner"],
        },
        mode: { type: "string", enum: ["pipe", "interactive"] },
        runtime: { type: "string", enum: ["claude"] },
        layout: {
          type: "string",
          enum: ["tab", "split", "background", "tmux"],
        },
        isolate: { type: "boolean" },
        notify_session_id: { type: "string" },
        context_summary: { type: "string" },
        parent_session_id: { type: "string" },
      },
      required: ["team_name"],
    },
  },
  {
    name: "coord_team_assign_next",
    description:
      "Select the best teammate for the next queued team task using deterministic load-aware scoring, then dispatch it.",
    inputSchema: {
      type: "object",
      properties: {
        team_name: { type: "string" },
        assignee: {
          type: "string",
          description: "Force a specific assignee instead of auto-scoring",
        },
        directory: {
          type: "string",
          description:
            "Default working directory for queued tasks missing dispatch.directory",
        },
        worker_task_id: { type: "string" },
        model: { type: "string" },
        agent: { type: "string" },
        role: {
          type: "string",
          enum: ["researcher", "implementer", "reviewer", "planner"],
        },
        mode: { type: "string", enum: ["pipe", "interactive"] },
        runtime: { type: "string", enum: ["claude"] },
        layout: { type: "string", enum: ["tab", "split", "background"] },
        isolate: { type: "boolean" },
        notify_session_id: { type: "string" },
        context_summary: { type: "string" },
        parent_session_id: { type: "string" },
      },
      required: ["team_name"],
    },
  },
  {
    name: "coord_team_rebalance",
    description:
      "Re-score queued team tasks and reassign them to the best teammates. Optional dry-run and optional dispatch-next.",
    inputSchema: {
      type: "object",
      properties: {
        team_name: { type: "string" },
        limit: {
          type: "integer",
          description: "Max queued tasks to evaluate (default: all, max 50)",
        },
        apply: {
          type: "boolean",
          description:
            "Apply reassignments (default: true). Set false for dry-run.",
        },
        dispatch_next: {
          type: "boolean",
          description: "After rebalance, dispatch the best queued task.",
        },
        include_in_progress: {
          type: "boolean",
          description:
            "Include guidance for in-progress handoffs (no automatic reassignment in v1).",
        },
        directory: {
          type: "string",
          description: "Default working directory if dispatch_next=true",
        },
        worker_task_id: { type: "string" },
        mode: { type: "string", enum: ["pipe", "interactive"] },
        runtime: { type: "string", enum: ["claude"] },
        layout: { type: "string", enum: ["tab", "split", "background"] },
        isolate: { type: "boolean" },
        notify_session_id: { type: "string" },
        context_summary: { type: "string" },
        parent_session_id: { type: "string" },
      },
      required: ["team_name"],
    },
  },
  {
    name: "coord_sidecar_status",
    description:
      "Check local sidecar installation/runtime status and latest generated snapshot metadata.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "coord_cost_comparison",
    description:
      "Report measured A/B harness evidence for native vs lead paths; suppress savings claims unless claim-safe policy allows them.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  // ── Plan Approval ──
  {
    name: "coord_approve_plan",
    description:
      "Approve a worker's plan, allowing it to proceed with implementation.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "Task ID of the worker whose plan to approve",
        },
        message: { type: "string", description: "Optional approval note" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "coord_reject_plan",
    description: "Reject a worker's plan with feedback, requesting revision.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "Task ID of the worker whose plan to reject",
        },
        feedback: {
          type: "string",
          description: "What needs to change (required)",
        },
      },
      required: ["task_id", "feedback"],
    },
  },
  // ── Shutdown Protocol ──
  {
    name: "coord_shutdown_request",
    description:
      "Request a worker to shut down gracefully. Worker receives the request and can approve or reject. If no response within timeout, force kills. Matches Claude's shutdown_request/shutdown_response pattern.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "Task ID of the worker to shut down",
        },
        target_name: {
          type: "string",
          description: "Worker name (alternative to task_id)",
        },
        target_session: {
          type: "string",
          description: "Session ID (alternative to task_id)",
        },
        message: {
          type: "string",
          description:
            "Shutdown reason/message (default: 'Task complete, wrapping up the session.')",
        },
        force_timeout_seconds: {
          type: "integer",
          description:
            "Seconds before force kill if no response (default: 60, max: 300)",
        },
      },
    },
  },
  {
    name: "coord_shutdown_response",
    description:
      "Worker responds to a shutdown request — approve (will terminate) or reject (will continue working).",
    inputSchema: {
      type: "object",
      properties: {
        request_id: {
          type: "string",
          description:
            "Shutdown request ID from the [SHUTDOWN_REQUEST:...] message",
        },
        approve: {
          type: "boolean",
          description: "true to approve shutdown, false to reject",
        },
        reason: {
          type: "string",
          description: "Reason for rejection (required if approve=false)",
        },
      },
      required: ["request_id", "approve"],
    },
  },
  // ── Context Store ──
  {
    name: "coord_write_context",
    description:
      "Store shared context (decisions, file summaries, architecture notes) that workers can read on boot.",
    inputSchema: {
      type: "object",
      properties: {
        team_name: {
          type: "string",
          description: "Team name (default: 'default')",
        },
        key: {
          type: "string",
          description:
            "Context key (e.g., 'architecture', 'decisions', 'file-index')",
        },
        value: { type: "string", description: "Context content" },
        append: {
          type: "boolean",
          description:
            "Append to existing key instead of replacing (default: false)",
        },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "coord_read_context",
    description:
      "Read shared context for a team. Workers use this to get lead's analysis without re-doing exploration. Set include_lead=true to also get lead's exported conversation context.",
    inputSchema: {
      type: "object",
      properties: {
        team_name: {
          type: "string",
          description: "Team name (default: 'default')",
        },
        key: {
          type: "string",
          description:
            "Optional: specific key to read (returns all if omitted)",
        },
        include_lead: {
          type: "boolean",
          description:
            "Include lead's exported conversation context (from coord_export_context). Default: false",
        },
      },
    },
  },
  {
    name: "coord_export_context",
    description:
      "Export lead's conversation context so ALL spawned workers automatically inherit it. Call this to share your current knowledge: decisions made, files analyzed, user requirements, current state. Workers receive this context in their prompt at spawn time.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Your session ID (first 8 chars)",
        },
        summary: {
          type: "string",
          description:
            "Rich summary of your conversation context: decisions made, files analyzed, user requirements, architecture notes, current state",
        },
      },
      required: ["session_id", "summary"],
    },
  },
  // ── Agents ──
  {
    name: "coord_list_agents",
    description:
      "List custom agent files across user/project/local scopes with scope-resolution metadata and frontmatter validation results.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["all", "local", "project", "user"],
          description: "Scope filter (default: all).",
        },
        include_invalid: {
          type: "boolean",
          description: "Include invalid agent files (default: true).",
        },
        include_shadowed: {
          type: "boolean",
          description:
            "Include lower-precedence duplicates shadowed by higher scope agents (default: true).",
        },
        project_dir: {
          type: "string",
          description: "Project root override for scope resolution.",
        },
      },
    },
  },
  {
    name: "coord_get_agent",
    description:
      "Get a single agent with scope-aware resolution and optional prompt/frontmatter expansion. When scope is omitted, resolves by local->project->user precedence.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: {
          type: "string",
          description: "Agent name (or filename without .md).",
        },
        scope: {
          type: "string",
          enum: ["all", "local", "project", "user"],
          description:
            "Optional explicit scope. all resolves by local->project->user precedence.",
        },
        project_dir: {
          type: "string",
          description: "Project root override for scope resolution.",
        },
        include_prompt: {
          type: "boolean",
          description: "Include prompt body in response (default: true).",
        },
        include_frontmatter: {
          type: "boolean",
          description:
            "Include parsed frontmatter in response (default: true).",
        },
      },
      required: ["agent_name"],
    },
  },
  {
    name: "coord_create_agent",
    description:
      "Create an agent markdown file with validated YAML frontmatter fields: name, description, model, tools, memory, and skills.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "Agent name." },
        scope: {
          type: "string",
          enum: ["local", "project", "user"],
          description: "Target scope (default: project).",
        },
        description: { type: "string", description: "Agent description." },
        model: {
          type: "string",
          description: "Agent model (default: sonnet).",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "Allowed tools list.",
        },
        memory: {
          type: "string",
          enum: ["user", "project", "local"],
          description: "Optional memory scope.",
        },
        skills: {
          type: "array",
          items: { type: "string" },
          description: "Optional skills list.",
        },
        prompt: { type: "string", description: "Agent prompt body." },
        project_dir: { type: "string", description: "Project root override." },
        overwrite: {
          type: "boolean",
          description: "Overwrite if file already exists (default: false).",
        },
      },
      required: ["agent_name", "description"],
    },
  },
  {
    name: "coord_update_agent",
    description:
      "Update an existing agent file. Supports renaming and field patching with full frontmatter revalidation.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: {
          type: "string",
          description: "Existing agent name (or filename).",
        },
        scope: {
          type: "string",
          enum: ["all", "local", "project", "user"],
          description:
            "Optional explicit scope. all updates the effective local->project->user winner.",
        },
        new_name: { type: "string", description: "Optional rename target." },
        description: { type: "string", description: "Updated description." },
        model: { type: "string", description: "Updated model." },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "Updated tools array.",
        },
        memory: {
          type: "string",
          enum: ["user", "project", "local"],
          description:
            "Updated memory scope. Set empty string/null via client to clear.",
        },
        skills: {
          type: "array",
          items: { type: "string" },
          description: "Updated skills array.",
        },
        prompt: { type: "string", description: "Updated prompt body." },
        project_dir: { type: "string", description: "Project root override." },
        overwrite: {
          type: "boolean",
          description:
            "Allow overwriting target if renamed to existing file (default: false).",
        },
      },
      required: ["agent_name"],
    },
  },
  {
    name: "coord_delete_agent",
    description:
      "Delete an agent file from one scope or all scopes when duplicates exist.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "Agent name." },
        scope: {
          type: "string",
          enum: ["all", "local", "project", "user"],
          description:
            "Optional explicit scope. all deletes only the effective winner unless all_scopes=true.",
        },
        all_scopes: {
          type: "boolean",
          description: "Delete matching files from all scopes.",
        },
        project_dir: { type: "string", description: "Project root override." },
      },
      required: ["agent_name"],
    },
  },
  {
    name: "coord_sync_agent_manifest",
    description:
      "Regenerate the Agents table in MANIFEST.md from discovered agent files.",
    inputSchema: {
      type: "object",
      properties: {
        manifest_path: {
          type: "string",
          description:
            "Optional manifest path (default: {project}/MANIFEST.md).",
        },
        scope: {
          type: "string",
          enum: ["all", "local", "project", "user"],
          description: "Scope filter for synced agents (default: all).",
        },
        include_invalid: {
          type: "boolean",
          description: "Include invalid agent files in the generated table.",
        },
        include_shadowed: {
          type: "boolean",
          description: "Include shadowed lower-precedence duplicates.",
        },
        project_dir: { type: "string", description: "Project root override." },
      },
    },
  },
  // ── Broadcast ──
  {
    name: "coord_broadcast",
    description:
      "Send a message to ALL active sessions via their inboxes. Zero API tokens — file writes only.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Sender identifier" },
        content: { type: "string", description: "Message content" },
        priority: {
          type: "string",
          enum: ["normal", "urgent"],
          description: "Priority (default: normal)",
        },
      },
      required: ["from", "content"],
    },
  },
  // ── Send Directive (send + auto-wake) ──
  {
    name: "coord_send_directive",
    description:
      "Send an instruction to a worker/session mid-execution. Writes to inbox AND auto-wakes if session is idle. The lead's primary control tool for interactive workers.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Sender identifier" },
        to: {
          type: "string",
          description:
            "Target session ID (first 8 chars). Use this OR target_name.",
        },
        target_name: {
          type: "string",
          description:
            "Worker name to direct (resolves to session ID). Use this OR to.",
        },
        team_name: {
          type: "string",
          description:
            "Optional team scope for disambiguating target_name/native identities.",
        },
        content: {
          type: "string",
          description: "Instruction/directive content",
        },
        priority: {
          type: "string",
          enum: ["normal", "urgent"],
          description: "Priority (default: normal)",
        },
      },
      required: ["content"],
    },
  },
  // ── Send to Worker Pane (bidirectional tmux) ──
  {
    name: "coord_send_to_worker_pane",
    description:
      "Inject a message directly into a worker's tmux pane via send-keys. The worker's Claude reads it as user input and responds. This is the lead side of the bidirectional messaging protocol — use when a worker has sent you a [W2L:task-id]: message and you want to reply. Worker must be running in tmux layout mode.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Worker's session ID (first 8 chars). Use this OR worker_name.",
        },
        worker_name: {
          type: "string",
          description: "Worker name (e.g. 'implementer-1'). Use this OR session_id.",
        },
        message: {
          type: "string",
          description: "Message to inject. Will be prefixed with [L2W]: automatically.",
        },
      },
      required: ["message"],
    },
  },
  // ── Send Message (MCP tool version) ──
  {
    name: "coord_send_message",
    description:
      "Send a message to a specific session's inbox. Zero API tokens — file write only. Target reads it on next tool call. Supports name-based targeting.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Sender identifier" },
        to: {
          type: "string",
          description:
            "Target session ID (first 8 chars). Use this OR target_name.",
        },
        target_name: {
          type: "string",
          description:
            "Worker name to message (resolves to session ID). Use this OR to.",
        },
        content: { type: "string", description: "Message content" },
        summary: {
          type: "string",
          description:
            "5-10 word preview of message content (matches native SendMessage UI preview)",
        },
        priority: {
          type: "string",
          enum: ["normal", "urgent"],
          description: "Priority (default: normal)",
        },
      },
      required: ["from", "content"],
    },
  },
  // ── Send Protocol (structured handshake messages) ──
  {
    name: "coord_send_protocol",
    description:
      "Send structured protocol messages matching native SendMessage types. Supports shutdown_request, shutdown_response, and plan_approval_response.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: [
            "shutdown_request",
            "shutdown_response",
            "plan_approval_response",
          ],
          description: "Protocol message type",
        },
        recipient: {
          type: "string",
          description: "Worker name to send to (resolves to session ID)",
        },
        to: {
          type: "string",
          description: "Target session ID (alternative to recipient)",
        },
        from: { type: "string", description: "Sender identifier" },
        request_id: {
          type: "string",
          description:
            "Request ID for matching request/response pairs (auto-generated if omitted)",
        },
        approve: {
          type: "boolean",
          description:
            "For shutdown_response and plan_approval_response: whether to approve",
        },
        content: {
          type: "string",
          description: "For plan_approval_response: feedback or revision notes",
        },
      },
      required: ["type"],
    },
  },
  // ── Drain Native Queue (flush outbox to coordinator inbox path) ──
  {
    name: "coord_drain_native_queue",
    description:
      "Process pending native actions from the action queue. Delivers each action via coordinator inbox path and moves processed files to done/. Call this from the lead session to flush the native bridge outbox.",
    inputSchema: { type: "object", properties: {} },
  },
  // ── Discover Peers (teammate discovery) ──
  {
    name: "coord_discover_peers",
    description:
      "Returns list of teammates in a team with names, session IDs, pane IDs, roles, and status. Matches native Agent Teams peer discovery.",
    inputSchema: {
      type: "object",
      properties: {
        team_name: {
          type: "string",
          description: "Team name to discover peers for",
        },
      },
      required: ["team_name"],
    },
  },
  // ── Boot Snapshot (pre-formatted dashboard) ──
  {
    name: "coord_boot_snapshot",
    description:
      "Returns pre-formatted session dashboard: status table, conflict report, and recommended actions. Replaces raw JSON boot loop.",
    inputSchema: {
      type: "object",
      properties: {
        include_git: {
          type: "boolean",
          description:
            "Include git branch/status per project (default: false, adds latency)",
        },
      },
    },
  },
  // ── Worker Report (upward communication) ──
  {
    name: "coord_worker_report",
    description:
      "Workers write progress reports; lead reads them on demand. No polling needed.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task/worker ID" },
        action: {
          type: "string",
          enum: ["write", "read"],
          description:
            "write (worker reports progress) or read (lead checks progress). Default: read",
        },
        status: {
          type: "string",
          enum: [
            "in_progress",
            "blocked",
            "needs_review",
            "completed",
            "failed",
          ],
          description: "Worker's current status (required for write)",
        },
        summary: {
          type: "string",
          description: "Progress summary (required for write)",
        },
        files_changed: {
          type: "array",
          items: { type: "string" },
          description: "Files modified so far (optional, for write)",
        },
        blockers: {
          type: "string",
          description: "What's blocking progress (optional, for write)",
        },
      },
      required: ["task_id"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_TOOLS.filter((t) => toolVisibleInProfile(t.name)),
}));
/* c8 ignore stop */

// ─────────────────────────────────────────────────────────
// TOOL DISPATCH
// ─────────────────────────────────────────────────────────

/**
 * Route a tool call to the appropriate handler module.
 * @param {string} name - Tool name
 * @param {object} args - Tool arguments
 * @returns {object} MCP text response
 */
const _initializedDirs = new Set();
let _gcRan = false;
function ensureDirsOnce() {
  const { TERMINALS_DIR, INBOX_DIR, RESULTS_DIR, SESSION_CACHE_DIR } = cfg();
  const TASKS_DIR = join(TERMINALS_DIR, "tasks");
  const TEAMS_DIR = join(TERMINALS_DIR, "teams");
  const CONTEXT_DIR = join(TERMINALS_DIR, "context");
  for (const dir of [
    TERMINALS_DIR,
    INBOX_DIR,
    RESULTS_DIR,
    SESSION_CACHE_DIR,
    TASKS_DIR,
    TEAMS_DIR,
    CONTEXT_DIR,
  ]) {
    if (!_initializedDirs.has(dir)) {
      ensureSecureDirectory(dir);
      _initializedDirs.add(dir);
    }
  }
  // Auto-GC once per server boot
  if (!_gcRan) {
    _gcRan = true;
    try {
      runGC();
    } catch {
      /* GC is best-effort */
    }
  }
}

function handleToolCall(name, args = {}) {
  ensureDirsOnce();
  const metricsEnabled = process.env.COORDINATOR_METRICS === "1";
  const callStart = metricsEnabled ? performance.now() : 0;

  try {
    let result;
    switch (name) {
      case "coord_session_health":
        result = handleSessionHealth(args);
        break;
      case "coord_list_sessions":
        result = handleListSessions(args);
        break;
      case "coord_get_session":
        result = handleGetSession(args);
        break;
      case "coord_check_inbox":
        result = handleCheckInbox(args);
        break;
      case "coord_detect_conflicts":
        result = handleDetectConflicts(args);
        break;
      case "coord_spawn_terminal":
        result = handleSpawnTerminal(args);
        break;
      case "coord_spawn_worker":
        result = handleSpawnWorker(args);
        break;
      case "coord_spawn_workers":
        result = handleSpawnWorkers(args);
        break;
      case "coord_get_result":
        result = handleGetResult(args);
        break;
      case "coord_watch_output":
        result = handleWatchOutput(args);
        break;
      case "coord_wake_session":
        result = handleWakeSession(args);
        break;
      case "coord_create_task":
        result = handleCreateTask(args);
        break;
      case "coord_update_task":
        result = handleUpdateTask(args);
        break;
      case "coord_list_tasks":
        result = handleListTasks(args);
        break;
      case "coord_get_task":
        result = handleGetTask(args);
        break;
      case "coord_reassign_task":
        result = handleReassignTask(args);
        break;
      case "coord_get_task_audit":
        result = handleGetTaskAudit(args);
        break;
      case "coord_check_quality_gates":
        result = handleCheckQualityGates(args);
        break;
      case "coord_create_team":
        result = handleCreateTeam(args);
        break;
      case "coord_get_team":
        result = handleGetTeam(args);
        break;
      case "coord_list_teams":
        result = handleListTeams(args);
        break;
      case "coord_delete_team":
        result = handleDeleteTeam(args);
        break;
      case "coord_update_team_policy":
        result = handleUpdateTeamPolicy(args);
        break;
      case "coord_team_status_compact":
        result = handleTeamStatusCompact(args);
        break;
      case "coord_team_queue_task":
        result = handleTeamQueueTask(args);
        break;
      case "coord_claim_next_task":
        result = handleClaimNextTask(args);
        break;
      case "coord_team_assign_next":
        result = handleTeamAssignNext(args);
        break;
      case "coord_team_rebalance":
        result = handleTeamRebalance(args);
        break;
      case "coord_sidecar_status":
        result = handleSidecarStatus(args);
        break;
      case "coord_cost_comparison":
        result = handleCostComparison(args);
        break;
      case "coord_approve_plan":
        result = handleApprovePlan(args);
        break;
      case "coord_reject_plan":
        result = handleRejectPlan(args);
        break;
      case "coord_shutdown_request":
        result = handleShutdownRequest(args);
        break;
      case "coord_shutdown_response":
        result = handleShutdownResponse(args);
        break;
      case "coord_write_context":
        result = handleWriteContext(args);
        break;
      case "coord_read_context":
        result = handleReadContext(args);
        break;
      case "coord_export_context":
        result = handleExportContext(args);
        break;
      case "coord_list_agents":
        result = handleListAgents(args);
        break;
      case "coord_get_agent":
        result = handleGetAgent(args);
        break;
      case "coord_create_agent":
        result = handleCreateAgent(args);
        break;
      case "coord_update_agent":
        result = handleUpdateAgent(args);
        break;
      case "coord_delete_agent":
        result = handleDeleteAgent(args);
        break;
      case "coord_sync_agent_manifest":
        result = handleSyncAgentManifest(args);
        break;
      case "coord_broadcast":
        result = handleBroadcast(args);
        break;
      case "coord_send_message":
        result = handleSendMessage(args);
        break;
      case "coord_send_directive":
        result = handleSendDirective(args);
        break;
      case "coord_send_to_worker_pane":
        result = handleSendToWorkerPane(args);
        break;
      case "coord_send_protocol":
        result = handleSendProtocol(args);
        break;
      case "coord_drain_native_queue":
        result = handleDrainNativeQueue(args);
        break;
      case "coord_discover_peers":
        result = handleDiscoverPeers(args);
        break;
      case "coord_boot_snapshot":
        result = handleBootSnapshot(args);
        break;
      case "coord_worker_report":
        result = handleWorkerReport(args);
        break;
      default:
        result = text(`Unknown tool: ${name}`);
        break;
    }
    if (metricsEnabled && result?.content?.[0]?.text) {
      const elapsed = performance.now() - callStart;
      result.content[0].text += `\n\n_timing: ${elapsed.toFixed(1)}ms_`;
    }
    return result;
  } catch (err) {
    return text(`Invalid arguments for ${name}: ${err.message}`);
  }
}

/* c8 ignore start — MCP server wiring, tested via __test__.handleToolCall */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return handleToolCall(name, args);
});

// ─────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────

/* c8 ignore start — server startup, not unit-testable */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Drain the native action queue every 30 s automatically.
  // .unref() prevents this timer from keeping the process alive after
  // Claude Code disconnects the stdio transport.
  setInterval(() => {
    try {
      handleDrainNativeQueue({});
    } catch {
      /* swallow — non-critical */
    }
  }, 30_000).unref();

  // Clean exit handlers
  const cleanExit = (code = 0) => {
    process.exit(code);
  };
  process.on("SIGTERM", () => cleanExit(0));
  process.on("SIGINT", () => cleanExit(0));
}

const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((err) => {
    console.error("Coordinator error:", err);
    process.exit(1);
  });
}
/* c8 ignore stop */

// ─────────────────────────────────────────────────────────
// TEST INTERFACE (backward-compatible re-exports)
// ─────────────────────────────────────────────────────────

export const __test__ = {
  get PLATFORM() {
    return cfg().PLATFORM;
  },
  get CLAUDE_BIN() {
    return cfg().CLAUDE_BIN;
  },
  ensureDirsOnce,
  handleToolCall,
  buildPlatformLaunchCommand,
  buildItermProfileCommandLaunchScript,
  isProcessAlive,
  killProcess,
  isSafeTTYPath,
  sanitizeId,
  sanitizeShortSessionId,
  sanitizeName,
  sanitizeModel,
  sanitizeAgent,
  requireDirectoryPath,
  normalizeFilePath,
  readJSONLLimited,
  batQuote,
  runGC,
  selectWakeText,
  applyLegacyDeprecationToOutput,
  LEGACY_COST_DEPRECATIONS,
  withEnvelope,
  sleepMs,
  getSessionStatus,
  acquireExclusiveFileLock,
  enforceMessageRateLimit,
  handleCreateTask,
  handleUpdateTask,
  handleListTasks,
  handleGetTask,
  handleReassignTask,
  handleGetTaskAudit,
  handleCheckQualityGates,
  handleCreateTeam,
  handleUpdateTeamPolicy,
  handleGetTeam,
  handleListTeams,
  handleTeamStatusCompact,
  handleTeamQueueTask,
  handleClaimNextTask,
  handleClaimNextTaskData,
  handleTeamAssignNext,
  handleTeamRebalance,
  handleSidecarStatus,
  handleCheckInbox,
  handleSendMessage,
  handleBroadcast,
  handleSendDirective,
  getActiveWorkerSummaries,
  handleApprovePlan,
  handleRejectPlan,
  handleShutdownRequest,
  handleShutdownResponse,
  handleWriteContext,
  handleReadContext,
  handleExportContext,
  handleListAgents,
  handleGetAgent,
  handleCreateAgent,
  handleUpdateAgent,
  handleDeleteAgent,
  handleSyncAgentManifest,
  handleBootSnapshot,
  handleWorkerReport,
  handleWatchOutput,
  handleSessionHealth,
  PROFILE,
  CORE_TOOLS,
  TEAMS_TOOLS,
  OPS_TOOLS,
  toolVisibleInProfile,
  ALL_TOOLS,
};
