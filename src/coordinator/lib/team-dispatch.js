/**
 * Team dispatch: one-call team task creation + worker spawn + team/member linkage.
 * @module team-dispatch
 */

import { text } from "./helpers.js";
import { sanitizeName, sanitizeId } from "./security.js";
import { readTeamConfig, handleCreateTeam } from "./teams.js";
import { handleCreateTask, handleUpdateTask } from "./tasks.js";
import { handleSpawnWorker } from "./workers.js";
import { findIdentityRecord } from "./identity-map.js";

function contentText(res) {
  return res?.content?.[0]?.text || "";
}

function pickAssignee(team, args) {
  if (args.assignee) return sanitizeName(args.assignee, "assignee");
  const members = Array.isArray(team?.members) ? team.members : [];
  if (members.length === 0) return null;
  const role = args.role ? String(args.role) : null;
  if (role) {
    const byRole = members.find(
      (m) => String(m.role || "").toLowerCase() === role.toLowerCase(),
    );
    if (byRole?.name) return byRole.name;
  }
  return members[0]?.name ? sanitizeName(members[0].name, "assignee") : null;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeContextSummary(summary, prompt) {
  const raw = String(summary || "").trim();
  if (!raw) return null;
  const promptNorm = normalizeText(prompt);
  const summaryNorm = normalizeText(raw);
  if (
    summaryNorm &&
    promptNorm &&
    (summaryNorm.includes(promptNorm) || promptNorm.includes(summaryNorm))
  ) {
    return null;
  }
  return raw;
}

function shouldUseLowOverheadDispatch(args, team) {
  const explicitHeavy =
    args.mode ||
    args.context_level ||
    args.require_plan !== undefined ||
    (Array.isArray(args.files) && args.files.length > 0);
  if (explicitHeavy) return false;
  const teamMode = String(team?.low_overhead_mode || "").toLowerCase();
  if (["minimal", "compact", "aggressive"].includes(teamMode)) return true;
  const promptLength = String(args.prompt || "").trim().length;
  return promptLength > 0 && promptLength <= 800;
}

/**
 * Handle coord_team_dispatch tool call.
 * Creates a team-scoped task, dispatches a worker using team policy, and links task/member state.
 */
export function handleTeamDispatch(args) {
  const team_name = sanitizeName(args.team_name, "team_name");
  const team = readTeamConfig(team_name);
  if (!team)
    return text(
      `Team ${team_name} not found. Create it first with coord_create_team.`,
    );

  const subject = String(args.subject || "").trim();
  const prompt = String(args.prompt || "").trim();
  if (!subject) return text("subject is required.");
  if (!prompt) return text("prompt is required.");
  if (!args.directory) return text("directory is required.");

  const createTask = args.create_task !== false;
  const assignee = pickAssignee(team, args);
  const workerName = args.worker_name
    ? String(args.worker_name).trim()
    : assignee || null;

  const taskId = args.task_id
    ? sanitizeId(args.task_id, "task_id")
    : `T${Date.now()}`;
  const workerTaskId = args.worker_task_id
    ? sanitizeId(args.worker_task_id, "worker_task_id")
    : `W${Date.now()}`;
  const lowOverheadDispatch = shouldUseLowOverheadDispatch(args, team);
  const dispatchContextSummary = sanitizeContextSummary(
    args.context_summary,
    prompt,
  );

  let createTaskRes = null;
  if (createTask) {
    createTaskRes = handleCreateTask({
      task_id: taskId,
      subject,
      description: args.description || "",
      assignee,
      team_name,
      priority: args.priority,
      files: args.files || [],
      blocked_by: args.blocked_by || [],
      metadata: {
        ...(args.metadata &&
        typeof args.metadata === "object" &&
        !Array.isArray(args.metadata)
          ? args.metadata
          : {}),
        dispatch: {
          via: "coord_team_dispatch",
          worker_task_id: workerTaskId,
          profile: lowOverheadDispatch ? "low-overhead" : "standard",
        },
      },
    });
    const createTxt = contentText(createTaskRes);
    if (!/Task created:/i.test(createTxt)) {
      return text(`Team dispatch failed during task creation.\n\n${createTxt}`);
    }
  }

  // Prefer native resume-by-agentId whenever a native identity exists.
  const existingMember = team.members?.find((m) => m.name === workerName);
  const teamUsesNativeEngine =
    team.execution_path === "native" || team.execution_path === "hybrid";
  const identityFromTask = existingMember?.task_id
    ? findIdentityRecord({
        team_name,
        task_id: String(existingMember.task_id),
      })
    : null;
  const identityFromSession = existingMember?.session_id
    ? findIdentityRecord({
        team_name,
        session_id: String(existingMember.session_id),
      })
    : null;
  const resolvedAgentId =
    existingMember?.agentId ||
    identityFromTask?.agent_id ||
    identityFromSession?.agent_id ||
    null;
  const canNativeResume = Boolean(resolvedAgentId) && teamUsesNativeEngine;
  if (canNativeResume && assignee && !existingMember?.agentId) {
    handleCreateTeam({
      team_name,
      members: [{ name: assignee, agentId: resolvedAgentId }],
    });
  }

  const spawnRes = handleSpawnWorker({
    directory: args.directory,
    prompt,
    model: args.model,
    agent: args.agent,
    task_id: workerTaskId,
    mode: args.mode ?? (lowOverheadDispatch ? "pipe" : undefined),
    runtime: args.runtime,
    notify_session_id: args.notify_session_id,
    parent_session_id: args.parent_session_id,
    files: args.files || [],
    layout: args.layout,
    isolate: args.isolate,
    role: args.role,
    require_plan:
      args.require_plan ?? (lowOverheadDispatch ? false : undefined),
    permission_mode: args.permission_mode,
    context_level:
      args.context_level ?? (lowOverheadDispatch ? "minimal" : undefined),
    budget_policy: args.budget_policy,
    budget_tokens: args.budget_tokens,
    global_budget_policy: args.global_budget_policy,
    global_budget_tokens: args.global_budget_tokens,
    max_active_workers: args.max_active_workers,
    team_name,
    worker_name: workerName,
    max_turns: args.max_turns,
    context_summary: dispatchContextSummary,
    // Pass resume hint for native agent resume (Step 6)
    ...(canNativeResume && { resume_agent_id: resolvedAgentId }),
  });
  const spawnTxt = contentText(spawnRes);
  const spawned = /Worker (spawned|resumed)/i.test(spawnTxt);
  const resumedAgentId =
    spawnTxt.match(/Resumed agentId:\s*([^\n]+)/i)?.[1]?.trim() ||
    resolvedAgentId ||
    null;

  if (createTask) {
    if (spawned) {
      handleUpdateTask({
        task_id: taskId,
        status: "in_progress",
        assignee,
        metadata: {
          worker_task_id: workerTaskId,
          dispatch_status: "spawned",
          dispatch_profile: lowOverheadDispatch ? "low-overhead" : "standard",
        },
      });
    } else {
      handleUpdateTask({
        task_id: taskId,
        assignee,
        metadata: {
          worker_task_id: workerTaskId,
          dispatch_status: "spawn_failed",
          dispatch_profile: lowOverheadDispatch ? "low-overhead" : "standard",
          dispatch_error: spawnTxt.slice(0, 500),
        },
      });
    }
  }

  if (assignee && spawned) {
    // Link current worker task to the team member for live `coord_get_team` UX.
    handleCreateTeam({
      team_name,
      members: [
        {
          name: assignee,
          task_id: workerTaskId,
          ...(resumedAgentId ? { agentId: resumedAgentId } : {}),
        },
      ],
    });
  }

  return text(
    `## Team Dispatch (${team_name})\n\n` +
      `- Subject: ${subject}\n` +
      `- Team Task: ${createTask ? taskId : "skipped"}\n` +
      `- Worker Task: ${workerTaskId}\n` +
      `- Dispatch Profile: ${lowOverheadDispatch ? "low-overhead" : "standard"}\n` +
      `- Assignee: ${assignee || "auto:none"}\n` +
      `- Worker Name: ${workerName || "none"}\n` +
      `- Status: ${spawned ? "dispatched" : "worker spawn failed"}\n\n` +
      (createTaskRes ? `### Task\n${contentText(createTaskRes)}\n\n` : "") +
      `### Worker\n${spawnTxt}`,
  );
}
