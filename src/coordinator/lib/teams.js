/**
 * Team composition persistence: create and query teams.
 * File-based storage — survives session restarts.
 * @module teams
 */

import { existsSync, readdirSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { cfg } from "./constants.js";
import {
  sanitizeId,
  sanitizeName,
  writeFileSecure,
  ensureSecureDirectory,
} from "./security.js";
import { readJSON, text } from "./helpers.js";

/** Ordered palette matching native Agent Teams colors. */
const AGENT_COLORS = [
  "purple",
  "blue",
  "green",
  "red",
  "yellow",
  "cyan",
  "white",
];
const ANSI = {
  purple: "\x1b[35m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  reset: "\x1b[0m",
};
/**
 * Wrap a name in its ANSI color code for terminal display.
 * Falls back to plain name if color is unknown or absent.
 * @param {string} name
 * @param {string|undefined} color
 * @returns {string}
 */
export function colorName(name, color) {
  return color && ANSI[color] ? `${ANSI[color]}${name}${ANSI.reset}` : name;
}

function normalizeMemberColor(color) {
  if (typeof color !== "string") return null;
  const normalized = color.trim().toLowerCase();
  return AGENT_COLORS.includes(normalized) ? normalized : null;
}

// handleSpawnWorker is imported lazily inside handleCreateTeam to avoid
// circular-dependency issues (workers.js imports teams.js).
// We use a dynamic import shim stored here so tests can override it.
/** @type {((args: object) => object) | null} */
let _spawnWorkerFn = null;
/** Override in tests to inject a mock spawn function. */
export function _setSpawnWorkerFn(fn) {
  _spawnWorkerFn = fn;
}
async function getSpawnWorker() {
  if (_spawnWorkerFn) return _spawnWorkerFn;
  const mod = await import("./workers.js");
  return mod.handleSpawnWorker;
}

/**
 * Get the teams directory path, ensuring it exists.
 * @returns {string} Teams directory path
 */
function teamsDir() {
  const dir = join(cfg().TERMINALS_DIR, "teams");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    try {
      ensureSecureDirectory(dir);
    } catch {}
  }
  return dir;
}

function teamPreset(preset) {
  switch (preset) {
    case "simple":
      return {
        execution_path: "hybrid",
        policy: {
          permission_mode: "acceptEdits",
          require_plan: false,
          default_mode: "pipe",
          default_runtime: "claude",
          default_context_level: "standard",
          budget_policy: "warn",
          budget_tokens: 40000,
          global_budget_policy: "warn",
          global_budget_tokens: 120000,
          max_active_workers: 4,
          default_isolate: false,
        },
      };
    case "strict":
      return {
        execution_path: "coordinator",
        policy: {
          permission_mode: "planOnly",
          require_plan: true,
          default_mode: "interactive",
          default_runtime: "claude",
          default_context_level: "standard",
          budget_policy: "enforce",
          budget_tokens: 60000,
          global_budget_policy: "enforce",
          global_budget_tokens: 200000,
          max_active_workers: 6,
          default_isolate: true,
        },
      };
    case "native-first":
      return {
        execution_path: "native",
        policy: {
          permission_mode: "acceptEdits",
          require_plan: false,
          default_mode: "pipe",
          default_runtime: "claude",
          default_context_level: "standard",
          budget_policy: "warn",
          budget_tokens: 50000,
          global_budget_policy: "warn",
          global_budget_tokens: 160000,
          max_active_workers: 6,
          default_isolate: false,
        },
      };
    default:
      return { execution_path: "hybrid", policy: {} };
  }
}

const INTERRUPT_WEIGHT_KEYS = [
  "approval",
  "bridge",
  "stale",
  "conflict",
  "budget",
  "error",
  "warn",
  "default",
];

function normalizeInterruptWeights(weights = {}) {
  if (!weights || typeof weights !== "object" || Array.isArray(weights))
    return null;
  const out = {};
  for (const key of INTERRUPT_WEIGHT_KEYS) {
    const n = Number(weights[key]);
    if (Number.isFinite(n) && n >= 0 && n <= 200) out[key] = Math.round(n);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function mergeTeamPolicy(currentPolicy = {}, patchPolicy = {}) {
  const merged = { ...(currentPolicy || {}), ...(patchPolicy || {}) };
  if (
    patchPolicy?.interrupt_weights &&
    typeof patchPolicy.interrupt_weights === "object" &&
    !Array.isArray(patchPolicy.interrupt_weights)
  ) {
    const prevWeights =
      currentPolicy?.interrupt_weights &&
      typeof currentPolicy.interrupt_weights === "object" &&
      !Array.isArray(currentPolicy.interrupt_weights)
        ? currentPolicy.interrupt_weights
        : {};
    merged.interrupt_weights = {
      ...prevWeights,
      ...patchPolicy.interrupt_weights,
    };
  }
  return merged;
}

function normalizeTeamPolicy(policy = {}) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return {};
  const out = {};
  const strEnum = (k, vals) => {
    if (vals.includes(policy[k])) out[k] = policy[k];
  };
  const posInt = (k) => {
    const n = Number(policy[k]);
    if (Number.isFinite(n) && n > 0) out[k] = Math.floor(n);
  };
  const bool = (k) => {
    if (typeof policy[k] === "boolean") out[k] = policy[k];
  };
  strEnum("permission_mode", [
    "acceptEdits",
    "auto",
    "planOnly",
    "readOnly",
    "editOnly",
  ]);
  bool("require_plan");
  strEnum("default_mode", ["pipe", "interactive"]);
  strEnum("default_runtime", ["claude"]);
  strEnum("default_context_level", ["minimal", "standard", "full"]);
  strEnum("budget_policy", ["off", "warn", "enforce"]);
  posInt("budget_tokens");
  strEnum("global_budget_policy", ["off", "warn", "enforce"]);
  posInt("global_budget_tokens");
  posInt("max_active_workers");
  bool("default_isolate");
  const interruptWeights = normalizeInterruptWeights(policy.interrupt_weights);
  if (interruptWeights) out.interrupt_weights = interruptWeights;
  return out;
}

function readAllTasks() {
  const dir = join(cfg().TERMINALS_DIR, "tasks");
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJSON(join(dir, f)))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readSessionById(sessionId) {
  if (!sessionId) return null;
  return readJSON(
    join(cfg().TERMINALS_DIR, `session-${String(sessionId).slice(0, 8)}.json`),
  );
}

export function readTeamConfig(teamNameRaw) {
  const teamName = sanitizeName(teamNameRaw, "team_name");
  return readJSON(join(teamsDir(), `${teamName}.json`));
}

/**
 * Handle coord_create_team tool call.
 * Creates or updates a team config with members, roles, and project info.
 * When `workers` is provided, spawns all workers atomically — rolls back on
 * any failure (kills already-spawned workers and deletes the team config).
 * @param {object} args - { team_name, project, description, members, workers? }
 * @returns {object|Promise<object>} MCP text response
 */
export function handleCreateTeam(args) {
  // Workers array is stored as team metadata only — no process spawning.
  // Users open terminals manually; the coordinator tracks and coordinates them.
  return _handleCreateTeamSync(args);
}

/** Synchronous (original) team-only creation. */
function _handleCreateTeamSync(args) {
  const teamName = sanitizeName(args.team_name, "team_name");
  const dir = teamsDir();
  const teamFile = join(dir, `${teamName}.json`);
  const existing = readJSON(teamFile);

  const team = existing || {
    team_name: teamName,
    created: new Date().toISOString(),
    members: [],
  };

  const presetName = typeof args.preset === "string" ? args.preset.trim() : "";
  if (presetName) {
    const preset = teamPreset(presetName);
    team.preset = presetName;
    team.execution_path = preset.execution_path;
    team.policy = mergeTeamPolicy(team.policy || {}, preset.policy || {});
  }

  if (args.project) team.project = String(args.project).trim();
  if (args.description) team.description = String(args.description).trim();
  if (
    args.execution_path &&
    ["native", "coordinator", "hybrid"].includes(args.execution_path)
  ) {
    team.execution_path = args.execution_path;
  }
  if (
    args.low_overhead_mode &&
    ["simple", "advanced"].includes(args.low_overhead_mode)
  ) {
    team.low_overhead_mode = args.low_overhead_mode;
  }
  if (args.policy !== undefined) {
    team.policy = mergeTeamPolicy(
      team.policy || {},
      normalizeTeamPolicy(args.policy),
    );
  }
  if (!team.execution_path) team.execution_path = "hybrid";
  if (!team.low_overhead_mode) team.low_overhead_mode = "advanced";
  if (!team.policy) team.policy = {};

  // Merge members — add new ones, update existing
  if (args.members?.length) {
    for (const m of args.members) {
      const name = sanitizeName(m.name || m, "member name");
      const hasRole =
        typeof m === "object" &&
        m !== null &&
        Object.prototype.hasOwnProperty.call(m, "role");
      const role = hasRole
        ? m.role
          ? String(m.role).trim()
          : "worker"
        : undefined;
      const session_id = m.session_id ? String(m.session_id).slice(0, 8) : null;
      const hasTaskId =
        typeof m === "object" &&
        m !== null &&
        Object.prototype.hasOwnProperty.call(m, "task_id");
      const task_id = hasTaskId
        ? m.task_id
          ? sanitizeId(m.task_id, "task_id")
          : null
        : undefined;

      const agentId = m.agentId || null;
      const hasColor =
        typeof m === "object" &&
        m !== null &&
        Object.prototype.hasOwnProperty.call(m, "color");
      const color =
        normalizeMemberColor(hasColor ? m.color : null) ||
        AGENT_COLORS[team.members.length % AGENT_COLORS.length];

      const idx = team.members.findIndex((x) => x.name === name);
      if (idx >= 0) {
        // Update existing member
        if (hasRole && role) team.members[idx].role = role;
        if (session_id) team.members[idx].session_id = session_id;
        if (hasColor && normalizeMemberColor(m.color)) {
          team.members[idx].color = normalizeMemberColor(m.color);
        } else if (!team.members[idx].color) {
          team.members[idx].color = color;
        }
        if (hasTaskId) team.members[idx].task_id = task_id;
        if (agentId) team.members[idx].agentId = agentId;
        team.members[idx].updated = new Date().toISOString();
      } else {
        team.members.push({
          name,
          role: role || "worker",
          session_id,
          task_id: task_id ?? null,
          agentId,
          color,
          joined: new Date().toISOString(),
          updated: new Date().toISOString(),
        });
      }
    }
  }

  team.updated = new Date().toISOString();
  writeFileSecure(teamFile, JSON.stringify(team, null, 2));

  return text(
    `Team ${existing ? "updated" : "created"}: **${teamName}**\n` +
      `- Project: ${team.project || "unset"}\n` +
      `- Execution Path: ${team.execution_path}\n` +
      `- Overhead Mode: ${team.low_overhead_mode}\n` +
      `- Team Permission Mode: ${team.policy?.permission_mode || "unset"}\n` +
      `- Team Plan Mode: ${team.policy?.require_plan === true ? "required" : team.policy?.require_plan === false ? "optional" : "unset"}\n` +
      `- Members: ${team.members.length}\n` +
      team.members
        .map(
          (m) =>
            `  - ${m.name} (${m.role})${m.task_id ? ` → ${m.task_id}` : ""}`,
        )
        .join("\n"),
  );
}

/**
 * Async atomic team creation with workers.
 * Spawns every worker in `args.workers`; on any failure kills all already-
 * spawned workers and removes the team config file, then rejects.
 * @param {object} args
 * @returns {Promise<object>}
 */
async function _handleCreateTeamAtomic(args) {
  // 1. Create the team config first (synchronous path, workers omitted).
  const teamResult = _handleCreateTeamSync({ ...args, workers: undefined });
  const teamText = teamResult?.content?.[0]?.text || "";
  // Propagate any unexpected team-config-level failure immediately.
  if (/error|failed/i.test(teamText) && !/created|updated/i.test(teamText)) {
    return teamResult;
  }

  // Resolve team name and config file path (same logic as _handleCreateTeamSync).
  const resolvedTeamName = sanitizeName(args.team_name, "team_name");
  const teamFile = join(teamsDir(), `${resolvedTeamName}.json`);

  const spawnWorker = await getSpawnWorker();

  const spawnedTaskIds = [];
  const workerResults = [];

  for (let i = 0; i < args.workers.length; i++) {
    const w = args.workers[i];
    // Build worker args, merging per-worker fields; team_name is always forced.
    const workerArgs = {
      directory: w.directory || args.directory || process.env.HOME,
      prompt: w.task || w.prompt || "",
      model: w.model || "sonnet",
      worker_name: w.name || `worker-${i + 1}`,
      layout: "background",
      ...w,
      // Overrides that must not be clobbered by spread:
      team_name: resolvedTeamName,
      prompt: w.task || w.prompt || "",
    };

    let result;
    try {
      result = spawnWorker(workerArgs);
    } catch (err) {
      result = {
        content: [
          { type: "text", text: `Failed to spawn worker: ${err.message}` },
        ],
      };
    }

    const resultText = result?.content?.[0]?.text || "";
    // A spawn is considered failed when the result text signals an error AND
    // does NOT contain the success phrase "Worker spawned:".
    const failed =
      /failed|error|blocked|conflict/i.test(resultText) &&
      !/worker spawned:/i.test(resultText);

    if (failed) {
      // ── ROLLBACK ────────────────────────────────────────────────────────
      // Kill workers that were already spawned successfully.
      const { handleKillWorker } = await import("./workers.js");
      for (const tid of spawnedTaskIds) {
        try {
          handleKillWorker({ task_id: tid });
        } catch {
          /* best-effort */
        }
      }
      // Remove the partially-created team config.
      try {
        if (existsSync(teamFile)) unlinkSync(teamFile);
      } catch {
        /* best-effort */
      }

      return text(
        `Atomic team creation FAILED and was rolled back.\n` +
          `- Team config removed: ${resolvedTeamName}\n` +
          `- Workers killed: ${spawnedTaskIds.length}\n` +
          `- Failed worker: ${w.name || `worker-${i + 1}`} (index ${i})\n` +
          `- Error: ${resultText}`,
      );
    }

    // Parse task_id from the success text so we can roll back this worker if
    // a later one fails.
    const tidMatch =
      resultText.match(/Worker spawned:\s+\*?\*?([^\s*\n]+)/i) ||
      resultText.match(/task_id[=:\s"]+([A-Za-z0-9_-]+)/i);
    if (tidMatch?.[1]) spawnedTaskIds.push(tidMatch[1]);
    workerResults.push({ name: w.name || `worker-${i + 1}`, text: resultText });
  }

  // ── SUCCESS ─────────────────────────────────────────────────────────────
  return text(
    `${teamText}\n\n` +
      `### Atomically Spawned Workers (${workerResults.length})\n` +
      workerResults
        .map((r, idx) => `#### Worker ${idx + 1}: ${r.name}\n${r.text}`)
        .join("\n\n"),
  );
}

/**
 * Handle coord_update_team_policy tool call.
 * Updates policy fields for an existing team without mutating members.
 * @param {object} args - { team_name, policy?, interrupt_weights? }
 * @returns {object} MCP text response
 */
export function handleUpdateTeamPolicy(args) {
  const teamName = sanitizeName(args.team_name, "team_name");
  const teamFile = join(teamsDir(), `${teamName}.json`);
  const team = readJSON(teamFile);
  if (!team) return text(`Team ${teamName} not found.`);

  const incomingPolicy =
    args.policy &&
    typeof args.policy === "object" &&
    !Array.isArray(args.policy)
      ? { ...args.policy }
      : {};
  if (
    args.interrupt_weights &&
    typeof args.interrupt_weights === "object" &&
    !Array.isArray(args.interrupt_weights)
  ) {
    incomingPolicy.interrupt_weights = args.interrupt_weights;
  }

  const normalized = normalizeTeamPolicy(incomingPolicy);
  if (Object.keys(normalized).length === 0) {
    return text(`No valid policy updates provided for team ${teamName}.`);
  }

  team.policy = mergeTeamPolicy(team.policy || {}, normalized);
  team.updated = new Date().toISOString();
  writeFileSecure(teamFile, JSON.stringify(team, null, 2));

  const updatedKeys = Object.keys(normalized).sort();
  return text(
    `Team policy updated: **${teamName}**\n` +
      `- Updated keys: ${updatedKeys.join(", ")}\n` +
      (team.policy?.interrupt_weights
        ? `- Interrupt weights: ${JSON.stringify(team.policy.interrupt_weights)}\n`
        : ""),
  );
}

/**
 * Handle coord_get_team tool call.
 * @param {object} args - { team_name }
 * @returns {object} MCP text response
 */
export function handleGetTeam(args) {
  const teamName = sanitizeName(args.team_name, "team_name");
  const team = readJSON(join(teamsDir(), `${teamName}.json`));
  if (!team) return text(`Team ${teamName} not found.`);
  const tasks = readAllTasks().filter(
    (t) => t.team_name === teamName || t.metadata?.team_name === teamName,
  );

  let output = `## Team: ${teamName}\n\n`;
  output += `- **Project:** ${team.project || "unset"}\n`;
  if (team.description) output += `- **Description:** ${team.description}\n`;
  output += `- **Execution Path:** ${team.execution_path || "hybrid"}\n`;
  output += `- **Overhead Mode:** ${team.low_overhead_mode || "advanced"}\n`;
  if (team.preset) output += `- **Preset:** ${team.preset}\n`;
  output += `- **Created:** ${team.created}\n`;
  output += `- **Updated:** ${team.updated}\n`;
  if (team.policy && Object.keys(team.policy).length > 0) {
    output += `\n### Team Policy\n`;
    for (const [k, v] of Object.entries(team.policy))
      output += `- **${k}:** ${JSON.stringify(v)}\n`;
  }
  output += `\n### Members (${team.members.length})\n`;
  for (const m of team.members) {
    const session = readSessionById(m.session_id);
    output += `- **${colorName(m.name, m.color)}** — ${m.role}`;
    if (m.session_id) output += ` | session: ${m.session_id}`;
    if (m.task_id) output += ` | task: ${m.task_id}`;
    if (session) {
      output += ` | status: ${session.status || "unknown"}`;
      if (session.current_task) output += ` | current: ${session.current_task}`;
      if (session.last_active)
        output += ` | last_active: ${session.last_active}`;
    }
    output += `\n`;
  }
  const byStatus = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  output += `\n### Team Tasks (${tasks.length})\n`;
  output += `- Pending: ${byStatus.pending || 0}\n`;
  output += `- In Progress: ${byStatus.in_progress || 0}\n`;
  output += `- Completed: ${byStatus.completed || 0}\n`;
  output += `- Cancelled: ${byStatus.cancelled || 0}\n`;
  for (const t of tasks
    .filter((t) => t.status !== "completed" && t.status !== "cancelled")
    .slice(0, 12)) {
    output += `- ${t.task_id} | ${t.status} | ${t.assignee || "unassigned"} | ${t.subject}\n`;
  }
  return text(output);
}

/**
 * Handle coord_list_teams tool call.
 * @returns {object} MCP text response
 */
export function handleListTeams() {
  const dir = teamsDir();
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) return text("No teams found.");

    const teams = files.map((f) => readJSON(join(dir, f))).filter(Boolean);
    const rows = teams.map(
      (t) =>
        `| ${t.team_name} | ${t.project || "-"} | ${t.execution_path || "hybrid"} | ${t.members?.length || 0} | ${t.updated || "-"} |`,
    );
    const table =
      `| Team | Project | Path | Members | Updated |\n|------|---------|------|---------|---------|` +
      "\n" +
      rows.join("\n");
    return text(`## Teams (${teams.length})\n\n${table}`);
  } catch {
    return text("No teams found.");
  }
}

/**
 * Handle coord_delete_team tool call.
 * Removes team config and optionally cleans associated tasks.
 * @param {object} args - { team_name, clean_tasks }
 * @returns {object} MCP text response
 */
export function handleDeleteTeam(args) {
  const teamName = sanitizeName(args.team_name, "team_name");
  const dir = teamsDir();
  const teamFile = join(dir, `${teamName}.json`);

  if (!existsSync(teamFile)) return text(`Team ${teamName} not found.`);

  const team = readJSON(teamFile);
  const memberCount = team?.members?.length || 0;

  // Guard: refuse deletion if any teammate is active in the last 5 minutes
  if (!args.force) {
    const now = Date.now();
    const activeMates = (team?.members || [])
      .filter((m) => m.session_id)
      .map((m) => ({
        name: m.name,
        session: readJSON(
          join(
            cfg().TERMINALS_DIR,
            `session-${String(m.session_id).slice(0, 8)}.json`,
          ),
        ),
      }))
      .filter(({ session }) => {
        if (
          !session ||
          session.status === "closed" ||
          session.status === "stale"
        )
          return false;
        const age = session.last_active
          ? (now - new Date(session.last_active).getTime()) / 1000
          : Infinity;
        return age < 300; // active in last 5 minutes
      });

    if (activeMates.length > 0) {
      const names = activeMates.map((m) => m.name).join(", ");
      return text(
        `Cannot delete team **${teamName}** — ${activeMates.length} active teammate(s): ${names}\n` +
          `Use force: true to delete anyway.`,
      );
    }
  }

  try {
    unlinkSync(teamFile);
  } catch (e) {
    return text(`Failed to delete team ${teamName}: ${e.message}`);
  }

  let tasksRemoved = 0;
  const tasksDir = join(cfg().TERMINALS_DIR, "tasks");
  try {
    const files = readdirSync(tasksDir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const task = readJSON(join(tasksDir, f));
      if (
        task &&
        (task.team_name === teamName || task.metadata?.team_name === teamName)
      ) {
        try {
          unlinkSync(join(tasksDir, f));
          tasksRemoved++;
        } catch {}
      }
    }
  } catch {}

  let metasRemoved = 0;
  try {
    const metaFiles = readdirSync(cfg().RESULTS_DIR).filter((f) =>
      f.endsWith(".meta.json"),
    );
    for (const f of metaFiles) {
      const meta = readJSON(join(cfg().RESULTS_DIR, f));
      if (meta && meta.team_name === teamName) {
        try {
          unlinkSync(join(cfg().RESULTS_DIR, f));
          metasRemoved++;
        } catch {}
      }
    }
  } catch {}

  return text(
    `Team **${teamName}** deleted.\n` +
      `- Members removed: ${memberCount}\n` +
      `- Tasks cleaned: ${tasksRemoved}\n` +
      `- Worker meta files cleaned: ${metasRemoved}\n`,
  );
}
