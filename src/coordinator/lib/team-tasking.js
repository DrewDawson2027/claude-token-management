/**
 * Team tasking and operational status tools (queue, assign, rebalance, compact status).
 * @module team-tasking
 */

import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { cfg } from "./constants.js";
import { readJSON, readJSONL, text } from "./helpers.js";
import {
  sanitizeId,
  sanitizeName,
  writeFileSecure,
  acquireExclusiveFileLock,
} from "./security.js";
import { getAllSessions, getSessionStatus } from "./sessions.js";
import { readTeamConfig, handleCreateTeam } from "./teams.js";
import { handleCreateTask, handleUpdateTask } from "./tasks.js";
import { handleTeamDispatch } from "./team-dispatch.js";
import { handleSendDirective } from "./messaging.js";

function contentText(res) {
  return res?.content?.[0]?.text || "";
}

function tasksDir() {
  return join(cfg().TERMINALS_DIR, "tasks");
}

function withTaskBoardLock(fn) {
  const lockPath = join(tasksDir(), ".tasks.lock");
  const releaseLock = acquireExclusiveFileLock(lockPath, 5000, 15000, 25);
  try {
    return fn();
  } finally {
    releaseLock();
  }
}

function readAllTasks() {
  try {
    return readdirSync(tasksDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJSON(join(tasksDir(), f)))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readAllWorkerMeta() {
  const { RESULTS_DIR } = cfg();
  try {
    return readdirSync(RESULTS_DIR)
      .filter((f) => f.endsWith(".meta.json") && !f.includes(".done"))
      .map((f) => readJSON(join(RESULTS_DIR, f)))
      .filter(Boolean)
      .map((m) => {
        const pidFile = join(RESULTS_DIR, `${m.task_id}.pid`);
        const doneFile = join(RESULTS_DIR, `${m.task_id}.meta.json.done`);
        return {
          ...m,
          has_pid: existsSync(pidFile),
          is_done: existsSync(doneFile),
        };
      });
  } catch {
    return [];
  }
}

function activeWorkerMetas() {
  return readAllWorkerMeta().filter(
    (m) => (m.status || "running") === "running" && !m.is_done,
  );
}

function taskDispatchMeta(task) {
  const d = task?.metadata?.dispatch;
  return d && typeof d === "object" ? d : {};
}

function getTeamTasks(teamName) {
  return readAllTasks()
    .filter(
      (t) => t.team_name === teamName || t.metadata?.team_name === teamName,
    )
    .sort((a, b) =>
      String(a.created || "").localeCompare(String(b.created || "")),
    );
}

function getQueuedTeamTasks(teamName) {
  return getTeamTasks(teamName).filter((t) => {
    if (t.status !== "pending") return false;
    const d = taskDispatchMeta(t);
    return (d.status || "queued") === "queued";
  });
}

function mapTeamMembers(teamName) {
  const team = readTeamConfig(teamName);
  if (!team) return null;
  const sessions = getAllSessions();
  const sessionById = new Map(
    sessions.map((s) => [String(s.session || ""), s]),
  );
  const members = (team.members || []).map((m) => {
    const sid = m.session_id ? String(m.session_id).slice(0, 8) : null;
    const session = sid ? sessionById.get(sid) || null : null;
    const sessionStatus = session ? getSessionStatus(session) : "offline";
    const tc = session?.tool_counts || {};
    const recentOps = Array.isArray(session?.recent_ops)
      ? session.recent_ops
      : [];
    const loadScore = Math.max(
      0,
      Math.min(
        100,
        (sessionStatus === "active"
          ? 70
          : sessionStatus === "idle"
            ? 40
            : sessionStatus === "stale"
              ? 20
              : 5) +
          Math.min(20, recentOps.length * 2) +
          Math.min(
            10,
            (tc.Bash || 0) + (tc.Edit || 0) + (tc.Write || 0) > 0 ? 10 : 0,
          ),
      ),
    );
    const interruptibility = Math.max(
      0,
      Math.min(
        100,
        sessionStatus === "idle"
          ? 90
          : sessionStatus === "stale"
            ? 85
            : sessionStatus === "active"
              ? 45
              : 30,
      ),
    );
    return {
      ...m,
      session_id: sid,
      session,
      session_status: sessionStatus,
      load_score: loadScore,
      interruptibility_score: interruptibility,
      dispatch_readiness: Math.max(
        0,
        Math.min(100, interruptibility - Math.round(loadScore / 2)),
      ),
    };
  });
  return { team, members };
}

function taskBlocked(task, allTasks) {
  const statusById = new Map(allTasks.map((t) => [t.task_id, t.status]));
  const blockers = (task.blocked_by || []).filter((id) => {
    const s = statusById.get(id);
    return s && s !== "completed" && s !== "cancelled";
  });
  return blockers;
}

function workerForTask(taskId) {
  return activeWorkerMetas().find((w) => w.task_id === taskId) || null;
}

function filesOverlap(a, b) {
  const aa = new Set((a || []).map(String));
  for (const f of b || []) if (aa.has(String(f))) return true;
  return false;
}

function buildPresence(member, allTasks) {
  const session = member.session;
  if (!session) return { presence: "offline", risk_flags: [] };
  const base = member.session_status;
  const risk = [];
  let presence = base;

  const task = member.task_id
    ? allTasks.find((t) => t.task_id === member.task_id)
    : null;
  const worker = member.task_id ? workerForTask(member.task_id) : null;
  if (task) {
    const blockers = taskBlocked(task, allTasks);
    if (blockers.length) presence = "blocked_by_dependency";
    const dispatch = taskDispatchMeta(task);
    if (dispatch.status === "failed") risk.push("dispatch_failed");
  }
  if (worker) {
    presence =
      worker.mode === "interactive"
        ? "running_interactive_worker"
        : "running_pipe_worker";
    if (worker.permission_mode === "planOnly" || worker.require_plan) {
      const approvalFile = join(
        cfg().RESULTS_DIR,
        `${worker.task_id}.approval`,
      );
      if (!existsSync(approvalFile)) presence = "waiting_for_plan_approval";
    }
    if (
      Array.isArray(worker.files) &&
      session?.files_touched &&
      filesOverlap(worker.files, session.files_touched)
    ) {
      risk.push("conflict_risk");
    }
    const est = Number(worker.estimated_tokens || 0);
    const budget = Number(worker.budget_tokens || 0);
    if (
      Number.isFinite(est) &&
      Number.isFinite(budget) &&
      budget > 0 &&
      est > budget
    )
      risk.push("over_budget_risk");
  }
  if (base === "stale" && !worker) presence = "stale";
  if (base === "idle" && !worker) presence = "idle";
  if (base === "active" && !worker) presence = "active";

  return { presence, risk_flags: Array.from(new Set(risk)) };
}

export function buildTeamOperationalSnapshot(teamNameRaw) {
  const teamName = sanitizeName(teamNameRaw, "team_name");
  const mapped = mapTeamMembers(teamName);
  if (!mapped) throw new Error(`Team ${teamName} not found.`);
  const { team } = mapped;
  const allTasks = getTeamTasks(teamName);
  const workers = activeWorkerMetas().filter((w) => w.team_name === teamName);
  const activity = readJSONL(cfg().ACTIVITY_FILE).slice(-200);
  const memberByTaskId = new Map(
    (team.members || [])
      .filter((m) => m.task_id)
      .map((m) => [m.task_id, m.name]),
  );

  const workerByTaskId = new Map(workers.map((w) => [w.task_id, w]));
  const members = mapped.members.map((m) => {
    const { presence, risk_flags } = buildPresence(m, allTasks);
    const worker = m.task_id ? workerByTaskId.get(m.task_id) || null : null;
    return {
      ...m,
      presence,
      risk_flags,
      tmux_pane_id: worker?.tmux_pane_id || null,
      current_task_ref: m.task_id || m.session?.current_task || null,
      policy_state: {
        permission_mode: team.policy?.permission_mode || null,
        require_plan: team.policy?.require_plan ?? null,
      },
      last_active: m.session?.last_active || null,
      last_tool: m.session?.last_tool || null,
      recent_ops: (m.session?.recent_ops || []).slice(-5),
      files_touched: (m.session?.files_touched || []).slice(-10),
    };
  });

  const mapTask = (t) => {
    const dispatch = taskDispatchMeta(t);
    return {
      task_id: t.task_id,
      subject: t.subject,
      priority: t.priority || "normal",
      assignee: t.assignee || null,
      status: t.status,
      dispatch_status: dispatch.status || "queued",
      role_hint: dispatch.role_hint || dispatch.load_affinity || null,
      worker_task_id:
        dispatch.worker_task_id || t.metadata?.worker_task_id || null,
      files: t.files || [],
      blocked_by: t.blocked_by || [],
      created: t.created,
    };
  };
  const fullBoard = allTasks.map(mapTask);
  const queue = fullBoard.filter((t) => t.status === "pending");

  const timeline = activity
    .filter((e) => {
      const sid = String(e.session || "");
      return (
        members.some((m) => m.session_id && m.session_id === sid) ||
        (e.task_id && memberByTaskId.has(e.task_id))
      );
    })
    .slice(-50);

  const summary = {
    active: members.filter(
      (m) => m.presence === "active" || m.presence.startsWith("running_"),
    ).length,
    idle: members.filter((m) => m.presence === "idle").length,
    stale: members.filter((m) => m.presence === "stale").length,
    blocked: members.filter(
      (m) =>
        m.presence === "blocked_by_dependency" ||
        m.presence === "waiting_for_plan_approval",
    ).length,
    overloaded: members.filter((m) => m.load_score >= 75).length,
    queued_tasks: queue.filter((t) => t.dispatch_status === "queued").length,
    in_progress_tasks: allTasks.filter((t) => t.status === "in_progress")
      .length,
    completed_tasks: allTasks.filter((t) => t.status === "completed").length,
  };

  return {
    team_name: team.team_name,
    execution_path: team.execution_path || "hybrid",
    low_overhead_mode: team.low_overhead_mode || "advanced",
    policy: team.policy || {},
    members,
    task_queue: queue,
    workers,
    timeline,
    summary,
    generated_at: new Date().toISOString(),
  };
}

export function handleTeamStatusCompact(args) {
  const snap = buildTeamOperationalSnapshot(args.team_name);
  let out = `## Team Status (Compact): ${snap.team_name}\n\n`;
  out += `- Path: ${snap.execution_path}\n`;
  out += `- Overhead: ${snap.low_overhead_mode}\n`;
  out += `- Members: ${snap.members.length} | Active: ${snap.summary.active} | Idle: ${snap.summary.idle} | Stale: ${snap.summary.stale} | Blocked: ${snap.summary.blocked}\n`;
  out += `- Tasks: queued ${snap.summary.queued_tasks} | in_progress ${snap.summary.in_progress_tasks} | completed ${snap.summary.completed_tasks}\n`;
  out += `\n### Members\n`;
  for (const m of snap.members) {
    out += `- ${m.name} (${m.role}) | ${m.presence} | load=${m.load_score} | ready=${m.dispatch_readiness}`;
    if (m.current_task_ref) out += ` | task=${m.current_task_ref}`;
    if (m.risk_flags.length) out += ` | risks=${m.risk_flags.join(",")}`;
    out += `\n`;
  }
  const queue = snap.task_queue
    .filter((t) => t.dispatch_status === "queued")
    .slice(0, 10);
  if (queue.length) {
    out += `\n### Queue\n`;
    for (const t of queue) {
      out += `- ${t.task_id} | ${t.priority} | ${t.assignee || "unassigned"} | ${t.subject}\n`;
    }
  }
  const blockers = snap.task_queue.filter((t) => (t.blocked_by || []).length);
  if (blockers.length) {
    out += `\n### Blockers\n`;
    for (const t of blockers.slice(0, 10))
      out += `- ${t.task_id} blocked by ${(t.blocked_by || []).join(", ")}\n`;
  }
  return text(out);
}

export function handleTeamQueueTask(args) {
  const team_name = sanitizeName(args.team_name, "team_name");
  const team = readTeamConfig(team_name);
  if (!team) return text(`Team ${team_name} not found.`);
  const subject = String(args.subject || "").trim();
  const prompt = String(args.prompt || "").trim();
  if (!subject) return text("subject is required.");
  if (!prompt) return text("prompt is required.");

  const metadata =
    args.metadata &&
    typeof args.metadata === "object" &&
    !Array.isArray(args.metadata)
      ? args.metadata
      : {};
  const dispatchMeta = {
    status: "queued",
    prompt,
    role_hint: args.role_hint ? String(args.role_hint).trim() : null,
    load_affinity: args.load_affinity
      ? String(args.load_affinity).trim()
      : null,
    queued_at: new Date().toISOString(),
    created_by: "coord_team_queue_task",
    notify_session_id: args.notify_session_id
      ? String(args.notify_session_id).trim()
      : null,
    parent_session_id: args.parent_session_id
      ? String(args.parent_session_id).trim()
      : null,
  };
  if (
    Array.isArray(args.acceptance_criteria) &&
    args.acceptance_criteria.length
  ) {
    dispatchMeta.acceptance_criteria = args.acceptance_criteria
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, 20);
  }

  const res = handleCreateTask({
    task_id: args.task_id,
    subject,
    description: args.description || "",
    assignee: args.assignee || null,
    priority: args.priority,
    files: args.files || [],
    blocked_by: args.blocked_by || [],
    team_name,
    metadata: {
      ...metadata,
      dispatch: dispatchMeta,
      team_name,
    },
  });
  return res;
}

function scoreMemberForTask(member, task, snap) {
  const dispatch = taskDispatchMeta(task);
  const roleHint = String(
    dispatch.role_hint || dispatch.load_affinity || "",
  ).toLowerCase();
  const memberRole = String(member.role || "").toLowerCase();
  const riskFlags = new Set(member.risk_flags || []);

  const policy = snap.policy || {};
  const perm = String(policy.permission_mode || "").trim();
  if (
    perm === "readOnly" &&
    (dispatch.load_affinity === "implement" || roleHint.includes("implement"))
  ) {
    return {
      valid: false,
      score: -Infinity,
      reasons: ["team policy readOnly incompatible with implement task"],
    };
  }

  let score = 0;
  const reasons = [];
  if (
    roleHint &&
    memberRole &&
    (memberRole.includes(roleHint) || roleHint.includes(memberRole))
  ) {
    score += 40;
    reasons.push("role match +40");
  }
  const loadBonus = Math.max(0, 25 - Math.round((member.load_score || 0) / 4));
  score += loadBonus;
  reasons.push(`load inverse +${loadBonus}`);
  const intr = Math.round(
    Math.max(0, Math.min(15, (member.interruptibility_score || 0) / 6.7)),
  );
  score += intr;
  reasons.push(`interruptibility +${intr}`);

  const recentFiles = new Set((member.files_touched || []).map(String));
  const taskFiles = Array.isArray(task.files) ? task.files.map(String) : [];
  const overlap = taskFiles.filter((f) => recentFiles.has(f)).length;
  const fileCtx = Math.min(10, overlap * 5);
  score += fileCtx;
  if (fileCtx) reasons.push(`relevant files +${fileCtx}`);

  if (riskFlags.has("conflict_risk")) {
    score -= 20;
    reasons.push("conflict risk -20");
  }
  if (riskFlags.has("over_budget_risk")) {
    score -= 15;
    reasons.push("budget risk -15");
  }
  if (
    member.presence === "waiting_for_plan_approval" ||
    member.presence === "blocked_by_dependency"
  ) {
    score -= 25;
    reasons.push("blocked/waiting -25");
  }
  if (member.presence.startsWith("running_")) {
    score -= 10;
    reasons.push("already running task -10");
  }

  const idleAgeScore = member.last_active
    ? Math.floor((Date.now() - new Date(member.last_active).getTime()) / 60000)
    : 9999;
  return { valid: true, score, idleAgeScore, reasons };
}

function chooseBestMember(task, snap, preferredAssignee) {
  const candidates = snap.members.filter((m) => m.name);
  if (preferredAssignee) {
    const pref = candidates.find((m) => m.name === preferredAssignee);
    if (pref)
      return {
        member: pref,
        scored: { valid: true, score: 10_000, reasons: ["explicit assignee"] },
      };
  }
  const scored = candidates
    .map((m) => ({ member: m, scored: scoreMemberForTask(m, task, snap) }))
    .filter((x) => x.scored.valid)
    .sort((a, b) => {
      if (b.scored.score !== a.scored.score)
        return b.scored.score - a.scored.score;
      const aIdle = Number.isFinite(a.scored.idleAgeScore)
        ? a.scored.idleAgeScore
        : -1;
      const bIdle = Number.isFinite(b.scored.idleAgeScore)
        ? b.scored.idleAgeScore
        : -1;
      if (bIdle !== aIdle) return bIdle - aIdle;
      return String(a.member.name).localeCompare(String(b.member.name));
    });
  return scored[0] || null;
}

function rankMembersForTask(task, snap, preferredAssignee = null) {
  const preferred = preferredAssignee
    ? sanitizeName(preferredAssignee, "assignee")
    : null;
  const ranked = snap.members
    .filter((m) => m.name)
    .map((m) => {
      if (preferred && m.name === preferred) {
        return {
          member: m,
          scored: {
            valid: true,
            score: 10_000,
            idleAgeScore: null,
            reasons: ["explicit assignee"],
          },
        };
      }
      return { member: m, scored: scoreMemberForTask(m, task, snap) };
    })
    .sort((a, b) => {
      const av = a.scored.valid === false ? -Infinity : a.scored.score;
      const bv = b.scored.valid === false ? -Infinity : b.scored.score;
      if (bv !== av) return bv - av;
      const aIdle = Number.isFinite(a.scored.idleAgeScore)
        ? a.scored.idleAgeScore
        : -1;
      const bIdle = Number.isFinite(b.scored.idleAgeScore)
        ? b.scored.idleAgeScore
        : -1;
      if (bIdle !== aIdle) return bIdle - aIdle;
      return String(a.member.name).localeCompare(String(b.member.name));
    });
  return ranked;
}

export function buildTeamRebalanceExplainData(args) {
  const team_name = sanitizeName(args.team_name, "team_name");
  const snap = buildTeamOperationalSnapshot(team_name);
  const all = getTeamTasks(team_name);
  const queued = all
    .filter(
      (t) =>
        t.status === "pending" &&
        (taskDispatchMeta(t).status || "queued") === "queued",
    )
    .sort((a, b) => {
      const pri = { high: 0, normal: 1, low: 2 };
      const ap = pri[a.priority] ?? 1;
      const bp = pri[b.priority] ?? 1;
      if (ap !== bp) return ap - bp;
      return String(a.created || "").localeCompare(String(b.created || ""));
    });
  const limit = Math.max(
    1,
    Math.min(50, Number(args.limit || queued.length || 10)),
  );

  const tasks = queued.slice(0, limit).map((task) => {
    const ranked = rankMembersForTask(task, snap, args.assignee || null);
    const topValid = ranked.find((x) => x.scored.valid);
    const dispatch = taskDispatchMeta(task);
    return {
      task_id: task.task_id,
      subject: task.subject,
      priority: task.priority || "normal",
      status: task.status,
      dispatch_status: dispatch.status || "queued",
      current_assignee: task.assignee || null,
      recommended_assignee: topValid?.member?.name || null,
      recommended_score: topValid?.scored?.score ?? null,
      role_hint: dispatch.role_hint || dispatch.load_affinity || null,
      blocked_by: task.blocked_by || [],
      files: task.files || [],
      candidates: ranked.map((x, idx) => ({
        rank: idx + 1,
        name: x.member.name,
        role: x.member.role,
        presence: x.member.presence,
        load_score: x.member.load_score,
        interruptibility_score: x.member.interruptibility_score,
        dispatch_readiness: x.member.dispatch_readiness,
        risk_flags: x.member.risk_flags || [],
        current_task_ref: x.member.current_task_ref || null,
        valid: x.scored.valid !== false,
        score: x.scored.valid === false ? null : x.scored.score,
        idle_age_score: Number.isFinite(x.scored.idleAgeScore)
          ? x.scored.idleAgeScore
          : null,
        reasons: x.scored.reasons || [],
      })),
      generated_at: new Date().toISOString(),
    };
  });

  return {
    ok: true,
    team_name,
    generated_at: new Date().toISOString(),
    summary: {
      queued_tasks: queued.length,
      evaluated_tasks: tasks.length,
      members: snap.members.length,
      execution_path: snap.execution_path,
      low_overhead_mode: snap.low_overhead_mode,
      policy: snap.policy || {},
    },
    tasks,
  };
}

function patchTaskMetadata(taskId, mutateFn) {
  return withTaskBoardLock(() => {
    const path = join(tasksDir(), `${taskId}.json`);
    const task = readJSON(path);
    if (!task) return false;
    mutateFn(task);
    task.updated = new Date().toISOString();
    writeFileSecure(path, JSON.stringify(task, null, 2));
    return true;
  });
}

function sortQueuedTasks(a, b) {
  const pri = { high: 0, normal: 1, low: 2 };
  const ap = pri[a.priority] ?? 1;
  const bp = pri[b.priority] ?? 1;
  if (ap !== bp) return ap - bp;
  return String(a.created || "").localeCompare(String(b.created || ""));
}

function teamTaskForWorker(teamTasks, workerTaskId) {
  return (
    teamTasks.find((task) => {
      const dispatch = taskDispatchMeta(task);
      return (
        dispatch.worker_task_id === workerTaskId ||
        task.metadata?.worker_task_id === workerTaskId
      );
    }) || null
  );
}

export function handleClaimNextTask(args) {
  const team_name = sanitizeName(args.team_name, "team_name");
  const completedWorkerTaskId = args.completed_worker_task_id
    ? sanitizeId(args.completed_worker_task_id, "completed_worker_task_id")
    : null;
  let teamTasks = getTeamTasks(team_name);
  let completedTask = null;
  let assignee = args.assignee ? sanitizeName(args.assignee, "assignee") : null;

  if (completedWorkerTaskId) {
    completedTask = teamTaskForWorker(teamTasks, completedWorkerTaskId);
    if (completedTask) {
      assignee = assignee || completedTask.assignee || null;
      if (
        completedTask.status !== "completed" &&
        completedTask.status !== "cancelled"
      ) {
        const dispatch = taskDispatchMeta(completedTask);
        handleUpdateTask({
          task_id: completedTask.task_id,
          status: "completed",
          metadata: {
            dispatch: {
              ...dispatch,
              status: "completed",
              completed_at: new Date().toISOString(),
              completed_worker_task_id: completedWorkerTaskId,
            },
            worker_task_id: completedWorkerTaskId,
          },
        });
        completedTask.status = "completed";
        if (!completedTask.metadata) completedTask.metadata = {};
        completedTask.metadata.dispatch = {
          ...dispatch,
          status: "completed",
          completed_at: new Date().toISOString(),
          completed_worker_task_id: completedWorkerTaskId,
        };
        completedTask.metadata.worker_task_id = completedWorkerTaskId;
      }
    }
  }

  if (!assignee) {
    return text(
      `No assignee available to claim the next task for team ${team_name}.`,
    );
  }

  handleCreateTeam({
    team_name,
    members: [{ name: assignee, task_id: null }],
  });

  const unresolvedBlockersByTaskId = new Map(
    teamTasks.map((t) => [t.task_id, taskBlocked(t, teamTasks)]),
  );
  const nextTask = teamTasks
    .filter((t) => t.status === "pending")
    .filter((t) => (taskDispatchMeta(t).status || "queued") === "queued")
    .filter(
      (t) => (unresolvedBlockersByTaskId.get(t.task_id) || []).length === 0,
    )
    .filter((t) => !t.assignee || t.assignee === assignee)
    .sort(sortQueuedTasks)[0];

  if (!nextTask) {
    let out = `## Claim Next Task (${team_name})\n\n`;
    out += `- Assignee: ${assignee}\n`;
    if (completedTask) {
      out += `- Completed: ${completedTask.task_id}\n`;
    } else if (completedWorkerTaskId) {
      out += `- Completed Worker Task: ${completedWorkerTaskId}\n`;
    }
    out += `- Result: no claimable queued tasks\n`;
    return text(out);
  }

  const snap = buildTeamOperationalSnapshot(team_name);
  const dispatchRes = dispatchExistingQueuedTask(nextTask, snap, assignee, {
    ...args,
    assignee,
    default_directory: args.directory,
    worker_task_id: args.worker_task_id,
    parent_session_id: args.parent_session_id,
  });
  // Record which worker claimed this task (native schema parity)
  handleUpdateTask({ task_id: nextTask.task_id, claimed_by: assignee });
  const dTxt = contentText(dispatchRes);
  let out = `## Claim Next Task (${team_name})\n\n`;
  out += `- Assignee: ${assignee}\n`;
  if (completedTask) {
    out += `- Completed: ${completedTask.task_id}\n`;
  } else if (completedWorkerTaskId) {
    out += `- Completed Worker Task: ${completedWorkerTaskId}\n`;
  }
  out += `- Claimed: ${nextTask.task_id} (${nextTask.subject})\n\n`;
  out += dTxt;
  return text(out);
}

/**
 * Claim-only mode: find next task for a worker and return its data without
 * dispatching a new process. Used by claim-next-task.mjs --claim-only so the
 * existing worker shell can loop inline and re-invoke claude with the new prompt.
 * @param {object} args - Same shape as handleClaimNextTask args
 * @returns {{ found: boolean, task_id?: string, subject?: string, prompt?: string }}
 */
export function handleClaimNextTaskData(args) {
  const team_name = sanitizeName(args.team_name, "team_name");
  const completedWorkerTaskId = args.completed_worker_task_id
    ? sanitizeId(args.completed_worker_task_id, "completed_worker_task_id")
    : null;
  let teamTasks = getTeamTasks(team_name);
  let assignee = args.assignee ? sanitizeName(args.assignee, "assignee") : null;

  if (completedWorkerTaskId) {
    const completedTask = teamTaskForWorker(teamTasks, completedWorkerTaskId);
    if (completedTask) {
      assignee = assignee || completedTask.assignee || null;
      if (
        completedTask.status !== "completed" &&
        completedTask.status !== "cancelled"
      ) {
        handleUpdateTask({
          task_id: completedTask.task_id,
          status: "completed",
          metadata: {
            dispatch: {
              ...taskDispatchMeta(completedTask),
              status: "completed",
              completed_at: new Date().toISOString(),
              completed_worker_task_id: completedWorkerTaskId,
            },
            worker_task_id: completedWorkerTaskId,
          },
        });
        teamTasks = getTeamTasks(team_name);
      }
    }
  }

  if (!assignee) return { found: false };

  const unresolvedBlockersByTaskId = new Map(
    teamTasks.map((t) => [t.task_id, taskBlocked(t, teamTasks)]),
  );
  const nextTask = teamTasks
    .filter((t) => t.status === "pending")
    .filter((t) => (taskDispatchMeta(t).status || "queued") === "queued")
    .filter(
      (t) => (unresolvedBlockersByTaskId.get(t.task_id) || []).length === 0,
    )
    .filter((t) => !t.assignee || t.assignee === assignee)
    .sort(sortQueuedTasks)[0];

  if (!nextTask) return { found: false };

  const dispatch = taskDispatchMeta(nextTask);
  const prompt = String(dispatch.prompt || "").trim();
  if (!prompt) return { found: false };

  patchTaskMetadata(nextTask.task_id, (t) => {
    if (!t.metadata) t.metadata = {};
    t.metadata.dispatch = {
      ...taskDispatchMeta(t),
      status: "dispatched",
      dispatched_at: new Date().toISOString(),
      assignee,
    };
    if (assignee) t.assignee = assignee;
  });

  return {
    found: true,
    task_id: nextTask.task_id,
    subject: nextTask.subject,
    prompt,
    assignee,
  };
}

function dispatchExistingQueuedTask(task, snap, assignee, args = {}) {
  const dispatch = taskDispatchMeta(task);
  const prompt = String(dispatch.prompt || "").trim();
  if (!prompt)
    return text(
      `Task ${task.task_id} is missing dispatch.prompt. Queue it with coord_team_queue_task or update metadata.`,
    );

  const workerTaskId =
    args.worker_task_id || dispatch.worker_task_id || `W${Date.now()}`;
  const res = handleTeamDispatch({
    team_name: snap.team_name,
    subject: task.subject,
    prompt,
    directory:
      args.directory ||
      dispatch.directory ||
      task.metadata?.dispatch_directory ||
      args.default_directory,
    assignee,
    priority: task.priority,
    files: task.files || [],
    create_task: false,
    worker_task_id: workerTaskId,
    role:
      args.role || dispatch.role_hint || dispatch.load_affinity || undefined,
    mode: args.mode,
    runtime: args.runtime,
    notify_session_id: args.notify_session_id || dispatch.notify_session_id,
    parent_session_id: args.parent_session_id || dispatch.parent_session_id,
    model: args.model,
    agent: args.agent,
    layout: args.layout,
    isolate: args.isolate,
    context_summary: args.context_summary,
  });
  const ok = /Status: dispatched/i.test(contentText(res));
  patchTaskMetadata(task.task_id, (t) => {
    if (!t.metadata) t.metadata = {};
    const d =
      t.metadata.dispatch && typeof t.metadata.dispatch === "object"
        ? t.metadata.dispatch
        : {};
    d.status = ok ? "spawned" : "failed";
    d.worker_task_id = workerTaskId;
    d.last_dispatch_at = new Date().toISOString();
    d.last_dispatch_result = contentText(res).slice(0, 1000);
    t.metadata.dispatch = d;
    t.status = ok ? "in_progress" : t.status;
    if (assignee) t.assignee = assignee;
  });
  return res;
}

export function handleTeamAssignNext(args) {
  const team_name = sanitizeName(args.team_name, "team_name");
  const snap = buildTeamOperationalSnapshot(team_name);
  const teamTasks = getTeamTasks(team_name);
  const unresolvedBlockersByTaskId = new Map(
    teamTasks.map((t) => [t.task_id, taskBlocked(t, teamTasks)]),
  );
  const queued = snap.task_queue
    .filter((t) => t.dispatch_status === "queued")
    .filter(
      (t) => (unresolvedBlockersByTaskId.get(t.task_id) || []).length === 0,
    )
    .sort(sortQueuedTasks);
  if (queued.length === 0) {
    const blockedQueuedCount = snap.task_queue
      .filter((t) => t.dispatch_status === "queued")
      .filter(
        (t) => (unresolvedBlockersByTaskId.get(t.task_id) || []).length > 0,
      ).length;
    if (blockedQueuedCount > 0) {
      return text(
        `No dispatchable queued tasks for team ${team_name}. ${blockedQueuedCount} queued task(s) are dependency-blocked.`,
      );
    }
    return text(`No queued tasks for team ${team_name}.`);
  }

  const all = teamTasks;
  const task = all.find((t) => t.task_id === queued[0].task_id);
  if (!task) return text(`Queued task ${queued[0].task_id} not found.`);
  const explicitAssignee = args.assignee
    ? sanitizeName(args.assignee, "assignee")
    : null;
  const choice = chooseBestMember(task, snap, explicitAssignee);
  if (!choice) {
    // C6: No-candidate explainability
    const ranked = rankMembersForTask(task, snap, explicitAssignee);
    const rejections = ranked.map((x) => {
      const reasons = x.scored.reasons || [];
      let reason = "unknown";
      let detail = reasons.join("; ");
      if (x.member.presence === "stale") {
        reason = "stale";
        detail = `last active ${x.member.last_active || "unknown"}`;
      } else if (x.member.load_score >= 75) {
        reason = "overloaded";
        detail = `load_score=${x.member.load_score}`;
      } else if (
        x.member.presence === "blocked_by_dependency" ||
        x.member.presence === "waiting_for_plan_approval"
      ) {
        reason = "blocked";
        detail = `presence=${x.member.presence}`;
      } else if (x.scored.valid === false) {
        reason = "policy_mismatch";
        detail = reasons[0] || "incompatible";
      } else if (x.member.presence === "offline") {
        reason = "offline";
        detail = "session not found";
      } else {
        reason = "low_score";
      }
      return {
        name: x.member.name,
        role: x.member.role,
        reason,
        detail,
        score: x.scored.score,
        reasons,
      };
    });
    const suggestions = [];
    if (rejections.some((r) => r.reason === "stale"))
      suggestions.push("wake stale workers");
    if (rejections.some((r) => r.reason === "overloaded"))
      suggestions.push("reduce load on overloaded members");
    if (rejections.some((r) => r.reason === "blocked"))
      suggestions.push(
        "resolve blocking dependencies or approve pending plans",
      );
    if (rejections.some((r) => r.reason === "offline"))
      suggestions.push("add more team members");
    if (rejections.some((r) => r.reason === "policy_mismatch"))
      suggestions.push("adjust team policy or task role requirements");
    if (suggestions.length === 0) suggestions.push("add more team members");
    const explanation = {
      members_considered: ranked.length,
      rejections,
      suggestions,
    };
    return text(
      `## No Eligible Candidate for ${task.task_id}\n\n` +
        `**Members considered:** ${explanation.members_considered}\n\n` +
        `### Rejections\n` +
        rejections
          .map(
            (r) =>
              `- **${r.name}** (${r.role || "no role"}): ${r.reason} — ${r.detail}`,
          )
          .join("\n") +
        `\n\n### Suggestions\n` +
        suggestions.map((s) => `- ${s}`).join("\n") +
        `\n\n\`\`\`json\n${JSON.stringify(explanation, null, 2)}\n\`\`\``,
    );
  }

  const dispatchRes = dispatchExistingQueuedTask(
    task,
    snap,
    choice.member.name,
    {
      ...args,
      default_directory: args.directory,
      worker_task_id: args.worker_task_id,
    },
  );
  const dTxt = contentText(dispatchRes);
  return text(
    `## Team Assign Next (${team_name})\n\n` +
      `- Task: ${task.task_id} (${task.subject})\n` +
      `- Assignee: ${choice.member.name}\n` +
      `- Score: ${choice.scored.score}\n` +
      `- Reasons: ${choice.scored.reasons.join("; ")}\n\n` +
      dTxt,
  );
}

export function handleTeamRebalance(args) {
  const team_name = sanitizeName(args.team_name, "team_name");
  const snap = buildTeamOperationalSnapshot(team_name);
  const all = getTeamTasks(team_name);
  const queued = all.filter(
    (t) =>
      t.status === "pending" &&
      (taskDispatchMeta(t).status || "queued") === "queued",
  );
  if (queued.length === 0)
    return text(`No queued tasks to rebalance for team ${team_name}.`);

  const limit = Math.max(1, Math.min(50, Number(args.limit || queued.length)));
  const apply = args.apply !== false;
  const autoDispatch = Boolean(args.dispatch_next || false);
  const changes = [];

  for (const task of queued.slice(0, limit)) {
    const choice = chooseBestMember(task, snap, null);
    if (!choice) continue;
    const current = task.assignee || null;
    const next = choice.member.name;
    if (current !== next) {
      if (apply) {
        handleUpdateTask({
          task_id: task.task_id,
          assignee: next,
          metadata: {
            dispatch: {
              ...taskDispatchMeta(task),
              rebalance_last: {
                at: new Date().toISOString(),
                assignee_from: current,
                assignee_to: next,
                score: choice.scored.score,
                reasons: choice.scored.reasons,
              },
            },
          },
        });
      }
      changes.push({
        task_id: task.task_id,
        from: current,
        to: next,
        score: choice.scored.score,
        reasons: choice.scored.reasons,
      });
    }
  }

  let dispatchInfo = "";
  if (autoDispatch && apply) {
    const res = handleTeamAssignNext({ team_name, ...args });
    dispatchInfo = `\n\n### Dispatch Next\n${contentText(res)}`;
  }

  let out = `## Team Rebalance (${team_name})\n\n`;
  out += `- Mode: ${apply ? "apply" : "dry-run"}\n`;
  out += `- Evaluated: ${Math.min(limit, queued.length)} queued task(s)\n`;
  out += `- Changes: ${changes.length}\n`;
  if (changes.length) {
    out += `\n### Reassignments\n`;
    for (const c of changes)
      out += `- ${c.task_id}: ${c.from || "unassigned"} -> ${c.to} (score ${c.score})\n`;
  }
  if (args.include_in_progress) {
    out += `\n### In-Progress Tasks\n`;
    out += `- Controlled reassign for in-progress tasks is not automatic in v1. Use coord_send_directive + coord_update_task after handoff confirmation.\n`;
  }
  out += dispatchInfo;
  return text(out);
}

export function handleSidecarStatus() {
  const root = join(cfg().CLAUDE_DIR, "lead-sidecar");
  const runtimeDir = join(root, "runtime");
  const stateDir = join(root, "state");
  const portFile = join(runtimeDir, "sidecar.port");
  const lockFile = join(runtimeDir, "sidecar.lock");
  const snapshotFile = join(stateDir, "latest.json");
  const nativeDir = join(runtimeDir, "native");
  const nativeCapsFile = join(nativeDir, "capabilities.json");
  const nativeBridgeStatusFile = join(nativeDir, "bridge.status.json");
  const nativeBridgeHeartbeatFile = join(nativeDir, "bridge.heartbeat.json");
  const actionsDir = join(runtimeDir, "actions");
  const actionsPendingDir = join(actionsDir, "pending");
  const actionsInflightDir = join(actionsDir, "inflight");
  const actionsFailedDir = join(actionsDir, "failed");
  const port = existsSync(portFile)
    ? String(readJSON(portFile)?.port || "").trim()
    : "";
  const lock = readJSON(lockFile);
  const snapshot = readJSON(snapshotFile);
  const nativeCaps = readJSON(nativeCapsFile);
  const nativeBridge = readJSON(nativeBridgeStatusFile);
  const nativeHeartbeat = readJSON(nativeBridgeHeartbeatFile);

  const countJson = (dir) => {
    try {
      return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
    } catch {
      return 0;
    }
  };

  let out = "## Sidecar Status\n\n";
  out += `- Installed: ${existsSync(root) ? "yes" : "no"}\n`;
  out += `- Runtime lock: ${existsSync(lockFile) ? "present" : "missing"}\n`;
  if (lock?.pid) out += `- PID: ${lock.pid}\n`;
  if (port) out += `- Port: ${port}\n`;
  if (snapshot) {
    out += `- Last Snapshot: ${snapshot.generated_at || snapshot.updated_at || "unknown"}\n`;
    out += `- Teams: ${Array.isArray(snapshot.teams) ? snapshot.teams.length : 0}\n`;
  } else {
    out += `- Last Snapshot: none\n`;
  }
  out += `\n### Native\n`;
  out += `- Native Runtime Dir: ${existsSync(nativeDir) ? "present" : "missing"}\n`;
  out += `- Native Available: ${nativeCaps?.available === true ? "yes" : nativeCaps?.available === false ? "no" : "unknown"}\n`;
  out += `- Native Mode: ${nativeCaps?.mode || "unknown"}\n`;
  out += `- Last Probe: ${nativeCaps?.last_probe_at || "none"}\n`;
  if (nativeCaps?.last_probe_error)
    out += `- Last Probe Error: ${nativeCaps.last_probe_error}\n`;
  out += `- Bridge Status: ${nativeBridge?.bridge_status || nativeCaps?.bridge_status || "down"}\n`;
  if (nativeBridge?.session_id)
    out += `- Bridge Session: ${nativeBridge.session_id}\n`;
  if (nativeBridge?.task_id) out += `- Bridge Task: ${nativeBridge.task_id}\n`;
  if (nativeHeartbeat?.ts) out += `- Bridge Heartbeat: ${nativeHeartbeat.ts}\n`;
  out += `\n### Action Queue\n`;
  out += `- Pending: ${countJson(actionsPendingDir)}\n`;
  out += `- Inflight: ${countJson(actionsInflightDir)}\n`;
  out += `- Failed: ${countJson(actionsFailedDir)}\n`;
  return text(out);
}
