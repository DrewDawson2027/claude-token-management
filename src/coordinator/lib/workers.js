/**
 * Worker lifecycle: spawn, get result, kill.
 * @module workers
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  mkdirSync,
  chmodSync,
  unlinkSync,
} from "fs";
import { join, basename } from "path";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { cfg } from "./constants.js";
import { formatL2WMessage } from "./bidir-messaging.js";
import {
  sanitizeId,
  sanitizeShortSessionId,
  sanitizeName,
  sanitizeModel,
  sanitizeAgent,
  requireDirectoryPath,
  normalizeFilePath,
  writeFileSecure,
} from "./security.js";
import { readJSON, shellQuote, text } from "./helpers.js";
import { readTeamConfig, handleCreateTeam } from "./teams.js";
import { enforceWorkerPolicy } from "./worker-policy.js";
import {
  isProcessAlive,
  killProcess,
  buildWorkerScript,
  buildInteractiveWorkerScript,
  buildResumeWorkerScript,
  buildCodexWorkerScript,
  buildCodexInteractiveWorkerScript,
  openTerminalWithCommand,
  openVisibleWorkerTerminalDetailed,
  spawnBackgroundLauncher,
  isInsideTmux,
  getCurrentTmuxPane,
  spawnTmuxPaneWorker,
  tmuxSendKeys,
} from "./platform/common.js";
import {
  findIdentityByToken,
  findIdentityRecord,
  upsertIdentityRecord,
} from "./identity-map.js";

const ROLE_PRESETS = {
  researcher: {
    model: "haiku",
    agent: "scout",
    permissionMode: "readOnly",
    contextLevel: "standard",
    isolate: false,
    requirePlan: false,
  },
  implementer: {
    model: "sonnet",
    agent: null,
    permissionMode: "acceptEdits",
    contextLevel: "standard",
    isolate: true,
    requirePlan: false,
  },
  reviewer: {
    model: "sonnet",
    agent: "reviewer",
    permissionMode: "readOnly",
    contextLevel: "standard",
    isolate: true,
    requirePlan: true,
  },
  planner: {
    model: "sonnet",
    agent: "code-architect",
    permissionMode: "planOnly",
    contextLevel: "standard",
    isolate: false,
    requirePlan: true,
  },
};

const LAUNCH_HANDSHAKE_TIMEOUT_MS = Number(
  process.env.COORDINATOR_LAUNCH_HANDSHAKE_TIMEOUT_MS || 4000,
);
const VISIBLE_LAUNCH_HANDSHAKE_TIMEOUT_MS = Number(
  process.env.COORDINATOR_VISIBLE_LAUNCH_HANDSHAKE_TIMEOUT_MS ||
    Math.max(LAUNCH_HANDSHAKE_TIMEOUT_MS * 2, 8000),
);
const VISIBLE_BOOTSTRAP_START_TIMEOUT_MS = Number(
  process.env.COORDINATOR_VISIBLE_BOOTSTRAP_START_TIMEOUT_MS || 4000,
);
const LAUNCH_HANDSHAKE_POLL_MS = 100;
const STATUS_TRANSITION_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleepBlocking(ms) {
  const timeout = Math.max(0, Math.floor(ms));
  if (timeout > 0) {
    Atomics.wait(STATUS_TRANSITION_BUFFER, 0, 0, timeout);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function readPid(pidFile) {
  if (!existsSync(pidFile)) return "";
  try {
    return readFileSync(pidFile, "utf-8").trim();
  } catch {
    return "";
  }
}

function hasWorkerOutput(resultFile) {
  if (!existsSync(resultFile)) return false;
  try {
    return readFileSync(resultFile, "utf-8").length > 0;
  } catch {
    return false;
  }
}

function writeMetaFile(metaFile, meta) {
  writeFileSecure(metaFile, JSON.stringify(meta, null, 2));
  return meta;
}

function writeLauncherFile(launcherFile, scriptBody) {
  const content = ["#!/usr/bin/env sh", scriptBody, ""].join("\n");
  writeFileSecure(launcherFile, content);
  chmodSync(launcherFile, 0o700);
  return launcherFile;
}

function writeVisibleBootstrapFile({
  bootstrapFile,
  launcherFile,
  visibleStartFile,
  taskId,
  platformName,
}) {
  const qLauncher = shellQuote(launcherFile);
  const qVisibleStart = shellQuote(visibleStartFile);
  const cleanShellCmd =
    platformName === "darwin"
      ? [
          'export PATH="${PATH:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"',
          'if [ -x /bin/zsh ]; then export SHELL=/bin/zsh; exec /bin/zsh -f -i; fi',
          "exec /bin/sh -i",
        ].join("; ")
      : "exec /bin/sh -i";
  const script = [
    "#!/usr/bin/env sh",
    "set -u",
    `printf '%s\\n' \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\" > ${qVisibleStart} 2>/dev/null || true`,
    "export CLAUDE_WORKER_VISIBLE=1",
    `/bin/sh ${qLauncher}`,
    `printf '[worker %s finished]\\n' ${shellQuote(taskId)}`,
    cleanShellCmd,
  ].join("\n");
  writeFileSecure(bootstrapFile, `${script}\n`);
  chmodSync(bootstrapFile, 0o700);
  return bootstrapFile;
}

function waitForVisibleBootstrapStart(startFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (existsSync(startFile)) {
      try {
        const stamp = readFileSync(startFile, "utf-8").trim();
        return { ok: true, at: stamp || nowIso() };
      } catch {
        return { ok: true, at: nowIso() };
      }
    }
    sleepBlocking(
      Math.min(LAUNCH_HANDSHAKE_POLL_MS, Math.max(0, deadline - Date.now())),
    );
  }
  return { ok: false, reason: "visible bootstrap never started" };
}

function waitForWorkerHandshake({ pidFile, resultFile, metaFile, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const meta = readJSON(metaFile) || {};
    const pid = readPid(pidFile);
    const isRunning = pid ? isProcessAlive(pid) : false;
    if (isRunning || hasWorkerOutput(resultFile) || meta.handshake_at) {
      return { ok: true, pid, isRunning, at: meta.handshake_at || nowIso() };
    }
    sleepBlocking(
      Math.min(LAUNCH_HANDSHAKE_POLL_MS, Math.max(0, deadline - Date.now())),
    );
  }
  return { ok: false, reason: "startup handshake timed out" };
}

function deriveWorkerState(metaFile, metaOverride = null) {
  const meta = metaOverride || readJSON(metaFile);
  if (!meta) return null;
  const taskId = meta.task_id;
  const doneFile = `${metaFile}.done`;
  const pidFile = join(cfg().RESULTS_DIR, `${taskId}.pid`);
  const resultFile = join(cfg().RESULTS_DIR, `${taskId}.txt`);
  const done = existsSync(doneFile) ? readJSON(doneFile) : null;
  const pid = readPid(pidFile);
  const isRunning = pid ? isProcessAlive(pid) : false;
  let status = done
    ? "completed"
    : meta.status || (meta.launch_status === "pending" ? "launching" : "unknown");
  let reason = meta.launch_error || meta.error || null;

  if (done) {
    status = done.status || "completed";
  } else if (status === "launching" && meta.launch_status === "pending") {
    status = "launching";
  } else if (status === "launch_failed" || meta.launch_status === "launch_failed") {
    status = "launch_failed";
  } else if (status === "failed" || meta.launch_status === "handshake_failed") {
    status = "failed";
  } else if (status === "killed") {
    status = "killed";
  } else if (isRunning) {
    status = "running";
  } else if (
    meta.launch_status &&
    !["pending", "launch_failed"].includes(meta.launch_status)
  ) {
    status = "failed";
    reason ||= "worker exited without completion marker";
  } else if (hasWorkerOutput(resultFile)) {
    status = "failed";
    reason ||= "worker produced output but never completed";
  } else if (meta.launch_status === "pending") {
    status = "launch_failed";
    reason ||= "worker never completed startup handshake";
  } else {
    status = "failed";
    reason ||= "worker is not running";
  }

  if (!done && !isRunning && status !== meta.status) {
    meta.status = status;
    meta.launch_error = reason;
    meta.failed_at = meta.failed_at || nowIso();
    writeMetaFile(metaFile, meta);
  }

  return {
    meta,
    taskId,
    done,
    doneFile,
    pidFile,
    resultFile,
    pid,
    isRunning,
    status,
    reason,
  };
}

function estimateWorkerTokens({ promptText, contextLevel, mode, requirePlan }) {
  const promptTokens = Math.ceil((promptText.length || 0) / 4);
  const contextOverhead =
    { minimal: 1200, standard: 4200, full: 12000 }[contextLevel] || 1200;
  const modeOverhead = mode === "interactive" ? 2500 : 700;
  const planOverhead = requirePlan ? 6000 : 0;
  return promptTokens + contextOverhead + modeOverhead + planOverhead;
}

function positiveIntOrFallback(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function pickPolicy(overrideValue, envValue, fallback = "warn") {
  const valid = ["off", "warn", "enforce"];
  if (valid.includes(overrideValue)) return overrideValue;
  if (valid.includes(envValue)) return envValue;
  return fallback;
}

const FULL_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeParentSessionId(value) {
  const raw = String(value || "").trim();
  return FULL_SESSION_ID_RE.test(raw) ? raw : null;
}

function readLeadSessionRecord(terminalsDir, notifySessionId) {
  if (!notifySessionId) return null;
  const leadSessionFile = join(terminalsDir, `session-${notifySessionId}.json`);
  if (!existsSync(leadSessionFile)) return null;
  try {
    return JSON.parse(readFileSync(leadSessionFile, "utf-8"));
  } catch {
    return null;
  }
}

function resolveLeadParentSessionId(explicitParentSessionId, leadSession) {
  const explicit = normalizeParentSessionId(explicitParentSessionId);
  if (explicit) return explicit;
  return normalizeParentSessionId(
    leadSession?.claude_session_id || leadSession?.full_session_id || "",
  );
}

function upsertWorkerIdentity(record, source) {
  try {
    upsertIdentityRecord({ ...record, source });
  } catch {
    // Identity map should never block worker control flow.
  }
}

function getActiveWorkerUsage(resultsDir) {
  let activeWorkers = 0;
  let activeEstimatedTokens = 0;
  try {
    const metas = readdirSync(resultsDir).filter(
      (f) => f.endsWith(".meta.json") && !f.includes(".done"),
    );
    for (const mf of metas) {
      const meta = readJSON(join(resultsDir, mf));
      if (!meta) continue;
      if (meta.status && meta.status !== "running") continue;
      if (existsSync(join(resultsDir, `${meta.task_id}.meta.json.done`)))
        continue;
      const pidFile = join(resultsDir, `${meta.task_id}.pid`);
      if (existsSync(pidFile)) {
        const pid = readFileSync(pidFile, "utf-8").trim();
        if (!isProcessAlive(pid)) continue;
      }
      activeWorkers += 1;
      const est = Number(meta.estimated_tokens);
      if (Number.isFinite(est) && est > 0)
        activeEstimatedTokens += Math.floor(est);
    }
  } catch {
    return { activeWorkers: 0, activeEstimatedTokens: 0 };
  }
  return { activeWorkers, activeEstimatedTokens };
}

const CONTEXT_LIMITS = {
  minimal: 1200,
  standard: 5000,
  full: 12000,
};

function normalizePromptText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function maybePushContextSection(sections, title, body, priority = 50) {
  const normalizedBody = String(body || "").trim();
  if (!normalizedBody) return;
  sections.push({ title, body: normalizedBody, priority });
}

function composeContextPreamble({
  contextLevel,
  compactMode = false,
  sections,
}) {
  const level = ["minimal", "standard", "full"].includes(contextLevel)
    ? contextLevel
    : "minimal";
  const maxSections = compactMode
    ? level === "minimal"
      ? 2
      : 3
    : level === "full"
      ? 7
      : level === "standard"
        ? 5
        : 3;
  const deduped = [];
  let duplicateSectionsDropped = 0;
  let bytesBefore = 0;

  for (const section of sections || []) {
    bytesBefore += String(section?.body || "").length;
    const fp = normalizePromptText(section?.body || "");
    if (!fp) continue;
    const duplicate = deduped.some((existing) => {
      if (existing.fp === fp) return true;
      if (fp.length > 80 && existing.fp.includes(fp)) return true;
      if (existing.fp.length > 80 && fp.includes(existing.fp)) return true;
      return false;
    });
    if (duplicate) {
      duplicateSectionsDropped += 1;
      continue;
    }
    deduped.push({ ...section, fp });
  }

  let sectionsDroppedForBudget = 0;
  let selected = deduped;
  if (deduped.length > maxSections) {
    const ranked = deduped
      .map((item, index) => ({ ...item, index }))
      .sort(
        (a, b) => (b.priority || 0) - (a.priority || 0) || a.index - b.index,
      );
    selected = ranked.slice(0, maxSections).sort((a, b) => a.index - b.index);
    sectionsDroppedForBudget = deduped.length - selected.length;
  }

  const rendered = selected
    .map((section) => `## ${section.title}\n${section.body}\n\n---\n\n`)
    .join("");
  const bytesAfter = rendered.length;
  return {
    preamble: rendered,
    stats: {
      candidate_sections: sections.length,
      included_sections: selected.length,
      duplicate_sections_dropped: duplicateSectionsDropped,
      sections_dropped_for_budget: sectionsDroppedForBudget,
      compact_mode: compactMode,
      bytes_before: bytesBefore,
      bytes_after: bytesAfter,
      bytes_saved: Math.max(0, bytesBefore - bytesAfter),
    },
  };
}

function extractTaskPrompt(promptText) {
  const raw = String(promptText || "").trim();
  if (!raw) return "";
  const marker = "## Your Task";
  const idx = raw.indexOf(marker);
  if (idx >= 0) {
    return raw.slice(idx + marker.length).trim();
  }
  return raw;
}

/**
 * Handle coord_spawn_worker tool call.
 * @param {object} args - Worker arguments
 * @returns {object} MCP text response
 */
export function handleSpawnWorker(args) {
  const {
    RESULTS_DIR,
    SESSION_CACHE_DIR,
    TERMINALS_DIR,
    SETTINGS_FILE,
    PLATFORM,
    CLAUDE_BIN,
    TEST_MODE,
  } = cfg();
  const directory = requireDirectoryPath(args.directory);
  const prompt = String(args.prompt || "").trim();
  const role = ["researcher", "implementer", "reviewer", "planner"].includes(
    args.role,
  )
    ? args.role
    : null;
  const rolePreset = role ? ROLE_PRESETS[role] : null;
  const requestedTeamName = args.team_name
    ? String(args.team_name).trim()
    : null;
  const teamConfig = requestedTeamName
    ? readTeamConfig(requestedTeamName)
    : null;
  const teamPolicy = teamConfig?.policy || {};
  const model = sanitizeModel(args.model ?? rolePreset?.model ?? "sonnet");
  const agent = sanitizeAgent(args.agent ?? rolePreset?.agent ?? "");
  const task_id = args.task_id;
  const notifySessionRaw = args.notify_session_id ?? args.session_id ?? null;
  const notify_session_id = notifySessionRaw
    ? sanitizeShortSessionId(notifySessionRaw)
    : null;
  const parentSessionRaw =
    args.parent_session_id === undefined || args.parent_session_id === null
      ? ""
      : String(args.parent_session_id).trim();
  if (parentSessionRaw && !normalizeParentSessionId(parentSessionRaw)) {
    return text(
      "parent_session_id must be a full Claude session UUID (36 chars, with hyphens).",
    );
  }
  const files = (args.files || []).map((f) => String(f).trim()).filter(Boolean);
  let layout = isInsideTmux()
    ? "tmux" // Inside tmux: ALWAYS use tmux split pane — tabs/splits don't work here
    : ["split", "background", "tab"].includes(args.layout)
      ? args.layout
      : "split";
  // Inside tmux → forced to tmux panes (native Agent Teams behavior: split next to lead).
  // Removed team requirement — tmux is the right default for any spawn inside tmux.
  const mode =
    args.mode === "interactive"
      ? "interactive"
      : teamPolicy.default_mode === "interactive"
        ? "interactive"
        : "pipe";
  const runtime =
    args.runtime === "codex"
      ? "codex"
      : teamPolicy.default_runtime === "codex"
        ? "codex"
        : "claude";
  const contextLevel = ["minimal", "standard", "full"].includes(
    args.context_level,
  )
    ? args.context_level
    : ["minimal", "standard", "full"].includes(teamPolicy.default_context_level)
      ? teamPolicy.default_context_level
      : rolePreset?.contextLevel || "minimal";
  const teamName = requestedTeamName;
  const workerName = args.worker_name
    ? String(args.worker_name)
        .trim()
        .replace(/[^A-Za-z0-9._-]/g, "")
    : null;
  const maxTurns = args.max_turns
    ? Math.max(1, Math.min(10000, parseInt(args.max_turns, 10) || 0))
    : null;
  const contextSummary = args.context_summary
    ? String(args.context_summary).trim()
    : null;
  const resumeAgentId = args.resume_agent_id
    ? String(args.resume_agent_id).trim()
    : null;
  const policySubagentType = agent || role || "unknown";
  const policyDescription = String(
    args.description ||
      contextSummary ||
      prompt.split(/\r?\n/).find((line) => line.trim()) ||
      prompt,
  )
    .trim()
    .slice(0, 500);
  // All 5 native modes + 2 coordinator extras + auto. planOnly maps to plan for CLI.
  const validModes = [
    "acceptEdits",
    "bypassPermissions",
    "default",
    "dontAsk",
    "auto",
    "plan",
    "planOnly",
    "readOnly",
    "editOnly",
  ];
  const rawPermMode = validModes.includes(teamPolicy.permission_mode)
    ? teamPolicy.permission_mode
    : validModes.includes(args.permission_mode)
      ? args.permission_mode
      : rolePreset?.permissionMode || "acceptEdits";
  // Map coordinator permission modes → valid CLI modes (keep original in metadata)
  // Valid CLI modes: acceptEdits, bypassPermissions, default, dontAsk, plan, auto
  // Coordinator extras: planOnly→plan, readOnly→default, editOnly→default
  const CLI_PERMISSION_MAP = {
    planOnly: "plan",
    readOnly: "default",
    editOnly: "default",
  };
  const cliPermissionMode = CLI_PERMISSION_MAP[rawPermMode] || rawPermMode;
  const budgetPolicy = ["off", "warn", "enforce"].includes(
    teamPolicy.budget_policy,
  )
    ? teamPolicy.budget_policy
    : ["off", "warn", "enforce"].includes(args.budget_policy)
      ? args.budget_policy
      : "warn";
  const defaultBudget = positiveIntOrFallback(
    teamPolicy.budget_tokens,
    positiveIntOrFallback(process.env.COORDINATOR_WORKER_BUDGET_TOKENS, 60000),
  );
  const budgetTokens = positiveIntOrFallback(args.budget_tokens, defaultBudget);
  const globalBudgetPolicy = pickPolicy(
    teamPolicy.global_budget_policy || args.global_budget_policy,
    process.env.COORDINATOR_GLOBAL_BUDGET_POLICY,
    "warn",
  );
  const defaultGlobalBudget = positiveIntOrFallback(
    teamPolicy.global_budget_tokens,
    positiveIntOrFallback(process.env.COORDINATOR_GLOBAL_BUDGET_TOKENS, 240000),
  );
  const globalBudgetTokens = positiveIntOrFallback(
    args.global_budget_tokens,
    defaultGlobalBudget,
  );
  const defaultMaxWorkers = positiveIntOrFallback(
    teamPolicy.max_active_workers,
    positiveIntOrFallback(process.env.COORDINATOR_MAX_ACTIVE_WORKERS, 8),
  );
  const maxActiveWorkers = positiveIntOrFallback(
    args.max_active_workers,
    defaultMaxWorkers,
  );
  const requirePlanRequested =
    typeof teamPolicy.require_plan === "boolean"
      ? teamPolicy.require_plan || cliPermissionMode === "plan"
      : Boolean(
          args.require_plan ||
          rolePreset?.requirePlan ||
          cliPermissionMode === "plan",
        );
  if (!prompt) return text("Prompt is required.");
  if (!existsSync(directory)) return text(`Directory not found: ${directory}`);

  // Resolve lead session linkage before policy enforcement so coordinator and native
  // Task spawns share the same session-level caps when parent_session_id is known.
  let leadPaneId = null;
  const leadSession = readLeadSessionRecord(TERMINALS_DIR, notify_session_id);
  const leadParentSessionId = resolveLeadParentSessionId(
    parentSessionRaw,
    leadSession,
  );
  if (leadSession) {
    const pane = String(leadSession?.tmux_pane_id || "").trim();
    if (pane.startsWith("%")) leadPaneId = pane;
  }
  if (!leadPaneId && isInsideTmux()) {
    leadPaneId = getCurrentTmuxPane();
  }

  const policy = enforceWorkerPolicy({
    sessionId:
      leadParentSessionId || notify_session_id || task_id || workerName,
    subagentType: policySubagentType,
    description: policyDescription,
    prompt,
    model,
    maxTurns,
  });
  if (!policy.ok) return text(policy.blockMessage);

  const estimatedTokens = estimateWorkerTokens({
    promptText: prompt + (contextSummary || ""),
    contextLevel,
    mode,
    requirePlan: requirePlanRequested,
  });
  if (budgetPolicy === "enforce" && estimatedTokens > budgetTokens) {
    return text(
      `Budget policy blocked spawn.\n` +
        `- Estimated tokens: ${estimatedTokens}\n` +
        `- Budget tokens: ${budgetTokens}\n` +
        `- Policy: enforce\n` +
        `Reduce context_level, disable plan mode, or increase budget_tokens.`,
    );
  }
  const { activeWorkers, activeEstimatedTokens } =
    getActiveWorkerUsage(RESULTS_DIR);
  const projectedGlobalTokens = activeEstimatedTokens + estimatedTokens;
  const globalWarnings = [];
  if (globalBudgetPolicy !== "off") {
    if (activeWorkers >= maxActiveWorkers) {
      if (globalBudgetPolicy === "enforce") {
        return text(
          `Global concurrency policy blocked spawn.\n` +
            `- Active workers: ${activeWorkers}\n` +
            `- Max active workers: ${maxActiveWorkers}\n` +
            `- Policy: enforce\n` +
            `Wait for workers to finish or increase max_active_workers.`,
        );
      }
      globalWarnings.push(
        `Active worker count ${activeWorkers} is at/above max ${maxActiveWorkers}.`,
      );
    }
    if (projectedGlobalTokens > globalBudgetTokens) {
      if (globalBudgetPolicy === "enforce") {
        return text(
          `Global budget policy blocked spawn.\n` +
            `- Active estimated tokens: ${activeEstimatedTokens}\n` +
            `- New worker estimate: ${estimatedTokens}\n` +
            `- Projected total: ${projectedGlobalTokens}\n` +
            `- Global budget tokens: ${globalBudgetTokens}\n` +
            `- Policy: enforce\n` +
            `Wait for active workers to complete or increase global_budget_tokens.`,
        );
      }
      globalWarnings.push(
        `Projected global token usage ${projectedGlobalTokens} exceeds budget ${globalBudgetTokens}.`,
      );
    }
  }
  const requirePlan = requirePlanRequested;

  // Conflict check against running workers
  if (files?.length) {
    const normalizedRequested = new Map(
      files.map((f) => [f, normalizeFilePath(f, directory)]),
    );
    const running = readdirSync(RESULTS_DIR)
      .filter((f) => f.endsWith(".meta.json") && !f.includes(".done"))
      .map((f) => readJSON(join(RESULTS_DIR, f)))
      .filter((m) => m?.status === "running" && m.files?.length);
    for (const w of running) {
      const pidFile = join(RESULTS_DIR, `${w.task_id}.pid`);
      if (!existsSync(pidFile)) continue;
      const pid = readFileSync(pidFile, "utf-8").trim();
      if (!isProcessAlive(pid)) continue;
      const normalizedWorker = new Set(
        w.files.map((f) => normalizeFilePath(f, w.directory)).filter(Boolean),
      );
      const overlap = files.filter((f) => {
        const normalized = normalizedRequested.get(f);
        return normalized && normalizedWorker.has(normalized);
      });
      if (overlap.length > 0)
        return text(
          `CONFLICT: Worker ${w.task_id} editing: ${overlap.join(", ")}. Kill it first or wait.`,
        );
    }
  }

  const taskId = task_id ? sanitizeId(task_id, "task_id") : `W${Date.now()}`;
  const resultFile = join(RESULTS_DIR, `${taskId}.txt`);
  const pidFile = join(RESULTS_DIR, `${taskId}.pid`);
  const metaFile = join(RESULTS_DIR, `${taskId}.meta.json`);
  if (existsSync(metaFile) || existsSync(resultFile)) {
    return text(
      `Task ID ${taskId} already exists. Use a new task_id or omit it for auto-generation.`,
    );
  }

  // Worktree isolation: create a git worktree so worker operates on an isolated copy
  const isolate =
    args.isolate !== undefined
      ? Boolean(args.isolate)
      : typeof teamPolicy.default_isolate === "boolean"
        ? teamPolicy.default_isolate
        : Boolean(rolePreset?.isolate);
  let workerDir = directory;
  let worktreeBranch = null;
  if (isolate) {
    try {
      const worktreeBase = join(directory, ".claude", "worktrees");
      mkdirSync(worktreeBase, { recursive: true });
      const worktreePath = join(worktreeBase, taskId);
      worktreeBranch = `worker/${taskId}`;
      execFileSync(
        "git",
        ["worktree", "add", worktreePath, "-b", worktreeBranch],
        {
          cwd: directory,
          stdio: "pipe",
          timeout: 15000,
        },
      );
      workerDir = worktreePath;
    } catch (err) {
      return text(
        `Worktree creation failed: ${err.message}\nFalling back to non-isolated mode is not safe. Fix the git state or omit isolate.`,
      );
    }
  }

  // Generate session ID for --session-id + --resume support (Gap 2)
  const claudeSessionId = mode === "interactive" ? randomUUID() : null;

  const meta = {
    task_id: taskId,
    directory: workerDir,
    original_directory: directory,
    prompt: prompt.slice(0, 500),
    model,
    agent: agent || null,
    notify_session_id,
    isolated: isolate,
    worktree_branch: worktreeBranch,
    mode,
    runtime,
    files,
    role,
    context_level: contextLevel,
    team_name: teamName,
    team_execution_path: teamConfig?.execution_path || null,
    team_low_overhead_mode: teamConfig?.low_overhead_mode || null,
    worker_name: workerName,
    max_turns: maxTurns,
    permission_mode: rawPermMode,
    require_plan: requirePlan || cliPermissionMode === "plan",
    claude_session_id: claudeSessionId,
    claude_parent_session_id: leadParentSessionId,
    requested_layout: layout,
    effective_backend: null,
    backend_type: null,
    launch_method: null,
    launch_status: "pending",
    launch_error: null,
    fallback_reason: null,
    handshake_at: null,
    launch_target_tty: null,
    launcher_file: null,
    bootstrap_file: null,
    visible_start_file: null,
    visible_started_at: null,
    budget_policy: budgetPolicy,
    budget_tokens: budgetTokens,
    estimated_tokens: estimatedTokens,
    global_budget_policy: globalBudgetPolicy,
    global_budget_tokens: globalBudgetTokens,
    max_active_workers: maxActiveWorkers,
    active_estimated_tokens_at_spawn: activeEstimatedTokens,
    spawned: new Date().toISOString(),
    status: "launching",
  };
  if (resumeAgentId) {
    meta.resumed_from_agent = resumeAgentId;
    meta.agent_id = resumeAgentId;
  }
  writeFileSecure(metaFile, JSON.stringify(meta, null, 2));
  upsertWorkerIdentity(
    {
      team_name: teamName,
      agent_id: resumeAgentId,
      agent_name: agent || null,
      worker_name: workerName || null,
      session_id: claudeSessionId ? claudeSessionId.slice(0, 8) : null,
      task_id: taskId,
      pane_id: null,
      claude_session_id: claudeSessionId,
    },
    "coord_spawn_worker",
  );

  try {
    const cacheFile = join(SESSION_CACHE_DIR, "coder-context.md");
    const ctxLimit = CONTEXT_LIMITS[contextLevel] || CONTEXT_LIMITS.minimal;
    const lowOverheadMode = String(
      teamConfig?.low_overhead_mode || "",
    ).toLowerCase();
    const compactMode =
      contextLevel === "minimal" ||
      lowOverheadMode === "compact" ||
      lowOverheadMode === "minimal" ||
      lowOverheadMode === "aggressive";
    const contextSections = [];
    if (existsSync(cacheFile)) {
      maybePushContextSection(
        contextSections,
        "Prior Context",
        readFileSync(cacheFile, "utf-8").slice(0, ctxLimit),
        60,
      );
    }
    maybePushContextSection(
      contextSections,
      "Lead's Conversation Context",
      contextSummary ? contextSummary.slice(0, ctxLimit) : "",
      100,
    );
    if (notify_session_id) {
      const delegationContext = [
        `Lead coordinator session: ${notify_session_id}`,
        leadParentSessionId
          ? `Lead Claude session ID: ${leadParentSessionId}`
          : `Native Claude parent-session linkage is unavailable for this spawn; treat this task as a delegated sub-agent request from the lead and preserve that relationship explicitly.`,
      ]
        .filter(Boolean)
        .join("\n");
      maybePushContextSection(
        contextSections,
        "Lead Delegation Context",
        delegationContext,
        95,
      );
    }
    // Enhanced context: include lead's session data at standard/full levels
    if (!compactMode && contextLevel !== "minimal" && leadSession) {
      const extras = [];
      if (leadSession.files_touched?.length) {
        extras.push(
          `## Lead's Recent Files\n${leadSession.files_touched.join("\n")}`,
        );
      }
      if (leadSession.recent_ops?.length) {
        extras.push(
          `## Lead's Recent Operations\n${leadSession.recent_ops.map((op) => `- ${op.t} ${op.tool} ${op.file || ""}`).join("\n")}`,
        );
      }
      if (
        contextLevel === "full" &&
        leadSession.plan_file &&
        existsSync(leadSession.plan_file)
      ) {
        const planContent = readFileSync(leadSession.plan_file, "utf-8").slice(
          0,
          5000,
        );
        extras.push(`## Lead's Active Plan\n${planContent}`);
      }
      maybePushContextSection(
        contextSections,
        "Lead Session Extras",
        extras.join("\n\n"),
        50,
      );
    }
    // Lead's persistent exported context (auto-inject from coord_export_context)
    if (notify_session_id) {
      const leadContextFile = join(
        TERMINALS_DIR,
        "context",
        `lead-context-${notify_session_id}.json`,
      );
      if (existsSync(leadContextFile)) {
        try {
          const leadCtx = JSON.parse(readFileSync(leadContextFile, "utf-8"));
          maybePushContextSection(
            contextSections,
            "Lead's Exported Context",
            leadCtx.summary ? String(leadCtx.summary).slice(0, ctxLimit) : "",
            90,
          );
        } catch {
          /* ignore */
        }
      }
    }
    // Shared context store
    if (teamName) {
      const contextStoreFile = join(
        TERMINALS_DIR,
        "context",
        `${teamName}.json`,
      );
      if (existsSync(contextStoreFile)) {
        try {
          const ctx = JSON.parse(readFileSync(contextStoreFile, "utf-8"));
          if (ctx.entries?.length) {
            const sharedCtx = ctx.entries
              .map((e) => `### ${e.key}\n${e.value}`)
              .join("\n\n");
            maybePushContextSection(
              contextSections,
              "Shared Team Context",
              sharedCtx.slice(0, ctxLimit),
              70,
            );
          }
        } catch {
          /* ignore */
        }
      }
    }
    const contextBuild = composeContextPreamble({
      contextLevel,
      compactMode,
      sections: contextSections,
    });
    const contextPreamble = contextBuild.preamble;
    meta.prompt_compaction = {
      ...(meta.prompt_compaction || {}),
      context: contextBuild.stats,
    };
    writeFileSecure(metaFile, JSON.stringify(meta, null, 2));
    const contextSuffix =
      "\n\nWhen done, write key findings to ~/.claude/session-cache/coder-context.md.";
    const promptFile = join(RESULTS_DIR, `${taskId}.prompt`);
    let fullPrompt = contextPreamble + prompt + contextSuffix;
    if (mode === "interactive") {
      const instructionLines = [
        `## Worker Instructions (from lead)`,
        `You are an autonomous worker spawned by the project lead. Your task ID is ${taskId}.` +
          (workerName
            ? ` Your name is "${workerName}" — others can message you by name.`
            : ``),
        ``,
        `### Communication`,
        `- Your plain text output is NOT visible to the team lead or other teammates.`,
        `- To communicate with anyone on your team, you MUST use messaging tools.`,
        notify_session_id
          ? `- Message the lead: \`coord_send_message from="${workerName || taskId}" to="${notify_session_id}" content="..." summary="<5-10 word preview>"\``
          : `- No lead session — write findings to ~/.claude/session-cache/coder-context.md`,
        `- Messages from the lead appear as "--- INCOMING MESSAGES FROM COORDINATOR ---" before your tool calls`,
        `- If you receive instructions from the lead, prioritize them immediately`,
        `- If told to stop, pivot, or change direction — do so without question`,
        ``,
        `### Task Board Self-Service`,
        `After completing your assigned task:`,
        `1. Mark it completed: \`coord_update_task task_id=${taskId} status=completed\``,
        `2. Check for more work: \`coord_list_tasks status=pending\``,
        `3. Claim unassigned, unblocked tasks: \`coord_update_task task_id=<ID> assignee=${taskId} status=in_progress\``,
        `4. If no tasks available, notify lead and idle.`,
        ``,
        `### Completion Protocol`,
        `When your task is complete:`,
        notify_session_id
          ? `1. Notify lead: \`coord_send_message from="${taskId}" to="${notify_session_id}" content="[COMPLETED] ${taskId} — <summary>"\``
          : `1. Write key findings to ~/.claude/session-cache/coder-context.md`,
        ``,
        `### Delegation`,
        notify_session_id
          ? leadParentSessionId
            ? `Claude parent-session link requested with lead session ${leadParentSessionId}. Treat yourself as a delegated sub-agent of that lead conversation.`
            : `Native Claude parent-session linkage is unavailable for this spawn. Treat yourself as a delegated sub-agent of lead session ${notify_session_id} and preserve that relationship explicitly.`
          : ``,
      ];

      // Team context for peer messaging (Gap 3 + Gap 4)
      if (teamName) {
        instructionLines.push(
          `### Team: ${teamName}`,
          `You are part of a team. Your output is NOT visible to teammates — use these tools:`,
          `- Discover teammates: \`coord_discover_peers team_name=${teamName}\``,
          `- Message a peer by name: \`coord_send_message from="${workerName || taskId}" target_name="<name>" content="..." summary="<5-10 word preview>"\``,
          `- Message by session ID: \`coord_send_message from="${workerName || taskId}" to="<session_id>" content="..."\``,
          `- Broadcast to all: \`coord_broadcast from="${workerName || taskId}" content="..."\``,
          `- Shutdown request: \`coord_send_protocol type="shutdown_request" recipient="<name>"\``,
          ``,
        );
      }

      // Plan-first mode
      if (requirePlan) {
        instructionLines.push(
          `### PLAN-FIRST MODE (MANDATORY)`,
          `Before making ANY file edits:`,
          `1. Analyze the codebase and draft a plan`,
          `2. Write your plan to ~/.claude/terminals/results/${taskId}.plan.md`,
          `3. Notify lead: \`coord_send_message from="${taskId}" to="${notify_session_id || "lead"}" content="[PLAN READY] ${taskId}"\``,
          `4. WAIT for lead approval — check inbox for "[APPROVED]" or "[REVISION]"`,
          `5. If revision requested, update plan and re-submit`,
          `6. Only begin editing files AFTER receiving "[APPROVED]"`,
          ``,
        );
      }

      instructionLines.push(`---`, ``, `## Your Task`, ``);

      fullPrompt = instructionLines.join("\n") + contextPreamble + prompt;
    }
    writeFileSecure(promptFile, fullPrompt);

    const workerPs1File = join(RESULTS_DIR, `${taskId}.worker.ps1`);
    if (PLATFORM === "win32") {
      const ps1 = `
param(
  [Parameter(Mandatory=$true)][string]$WorkingDir,
  [Parameter(Mandatory=$true)][string]$ClaudeBin,
  [Parameter(Mandatory=$true)][string]$PromptFile,
  [Parameter(Mandatory=$true)][string]$ResultFile,
  [Parameter(Mandatory=$true)][string]$PidFile,
  [Parameter(Mandatory=$true)][string]$MetaDoneFile,
  [Parameter(Mandatory=$true)][string]$Model,
  [string]$Agent = "",
  [string]$SettingsFile = ""
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $WorkingDir
[System.IO.File]::WriteAllText($PidFile, [string]$PID)
[System.IO.File]::WriteAllText($ResultFile, "Worker ${taskId} starting at $((Get-Date).ToString('o'))" + [Environment]::NewLine)
$claudeArgs = @('-p', '--model', $Model)
if ($Agent) { $claudeArgs += @('--agent', $Agent) }
if ($SettingsFile) { $claudeArgs += @('--settings', $SettingsFile) }
Get-Content -Path $PromptFile | & $ClaudeBin @claudeArgs *>> $ResultFile
$done = @{ status = 'completed'; finished = (Get-Date).ToUniversalTime().ToString('o'); task_id = '${taskId}' } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($MetaDoneFile, $done)
Remove-Item -Path $PidFile -ErrorAction SilentlyContinue
`.trim();
      writeFileSecure(workerPs1File, ps1);
    }

    // Native agent resume: resume full conversation via --resume instead of fresh spawn
    if (resumeAgentId) {
      meta.resumed_from_agent = resumeAgentId;
      meta.agent_id = resumeAgentId;
      writeFileSecure(metaFile, JSON.stringify(meta, null, 2));
      const resumeScript = buildResumeWorkerScript({
        sessionId: resumeAgentId,
        workDir: workerDir,
        pidFile,
        metaFile,
        taskId,
        workerName,
        leadSessionId: notify_session_id,
        leadPaneId,
        parentSessionId: leadParentSessionId,
      });
      const launcherFile = writeLauncherFile(
        join(RESULTS_DIR, `${taskId}.launcher.sh`),
        resumeScript,
      );
      meta.launcher_file = launcherFile;
      let usedApp;
      if (layout === "tmux" && isInsideTmux()) {
        const tmuxResult = spawnTmuxPaneWorker(
          `/bin/sh ${shellQuote(launcherFile)}`,
        );
        usedApp = tmuxResult.app;
        meta.tmux_pane_id = tmuxResult.paneId;
        meta.requested_layout = "tmux";
        meta.effective_backend = "tmux";
        meta.backend_type = "tmux";
        meta.launch_method = "tmux_pane";
        meta.launch_status = "launched";
        meta.handshake_at = nowIso();
        meta.status = "running";
        writeFileSecure(metaFile, JSON.stringify(meta, null, 2));
        upsertWorkerIdentity(
          {
            team_name: teamName,
            agent_id: resumeAgentId,
            agent_name: agent || null,
            worker_name: workerName || null,
            session_id: claudeSessionId ? claudeSessionId.slice(0, 8) : null,
            task_id: taskId,
            pane_id: tmuxResult.paneId,
            claude_session_id: claudeSessionId,
          },
          "coord_spawn_worker_resume_agent",
        );
      } else {
        spawnBackgroundLauncher(launcherFile, resultFile, pidFile);
        usedApp = "background";
        meta.effective_backend = "background";
        meta.backend_type = "background";
        meta.launch_method = "background_launcher";
        meta.launch_status = "launched";
        meta.handshake_at = nowIso();
        meta.status = "running";
        writeFileSecure(metaFile, JSON.stringify(meta, null, 2));
      }
      return text(
        `Worker resumed (native agent): **${taskId}**\n` +
          `- Resumed agentId: ${resumeAgentId}\n` +
          `- Full conversation history preserved via --resume\n` +
          `- Requested Layout: ${meta.requested_layout}\n` +
          `- Effective Backend: ${usedApp}\n` +
          `- Notify Session: ${notify_session_id || "none"}\n` +
          `- Parent Session: ${leadParentSessionId || "prompt-emulated only"}\n\n` +
          `Send new task via \`coord_send_message\` to deliver work without re-spawning.`,
      );
    }

    const scriptOpts = {
      taskId,
      workDir: workerDir,
      defaultDirectory: directory,
      resultFile,
      pidFile,
      metaFile,
      model,
      agent,
      promptFile,
      workerPs1File,
      platformName: PLATFORM,
      workerName,
      maxTurns,
      permissionMode: cliPermissionMode,
      mode,
      runtime,
      layout,
      role,
      contextLevel,
      budgetPolicy,
      budgetTokens,
      globalBudgetPolicy,
      globalBudgetTokens,
      maxActiveWorkers,
      requirePlan,
      contextSummary,
      isolate,
      sessionId: claudeSessionId,
      leadSessionId: notify_session_id,
      leadPaneId,
      parentSessionId: leadParentSessionId,
      teamName,
    };
    let workerScript;
    if (runtime === "codex") {
      workerScript =
        mode === "interactive"
          ? buildCodexInteractiveWorkerScript(scriptOpts)
          : buildCodexWorkerScript(scriptOpts);
    } else {
      workerScript =
        mode === "interactive"
          ? buildInteractiveWorkerScript(scriptOpts)
          : buildWorkerScript(scriptOpts);
    }
    const launcherFile = writeLauncherFile(
      join(RESULTS_DIR, `${taskId}.launcher.sh`),
      workerScript,
    );
    meta.launcher_file = launcherFile;
    const visibleStartFile =
      layout === "split" || layout === "tab"
        ? join(RESULTS_DIR, `${taskId}.visible.started`)
        : null;
    const bootstrapFile =
      visibleStartFile &&
      writeVisibleBootstrapFile({
        bootstrapFile: join(RESULTS_DIR, `${taskId}.bootstrap.sh`),
        launcherFile,
        visibleStartFile,
        taskId,
        platformName: PLATFORM,
      });
    meta.bootstrap_file = bootstrapFile || null;
    meta.visible_start_file = visibleStartFile || null;
    let usedApp;
    let launchError = null;
    let fallbackReason = null;
    let launchMethod = null;
    let launchTargetTTY = null;
    if (layout === "tmux") {
      // Tmux pane spawn: visible split pane with tracked ID (Gap 6)
      const tmuxResult = spawnTmuxPaneWorker(`/bin/sh ${shellQuote(launcherFile)}`);
      usedApp = tmuxResult.app;
      meta.tmux_pane_id = tmuxResult.paneId;
      meta.effective_backend = "tmux";
      meta.backend_type = "tmux";
      meta.launch_method = "tmux_pane";
      meta.launch_status = "launched";
      upsertWorkerIdentity(
        {
          team_name: teamName,
          agent_id: resumeAgentId,
          agent_name: agent || null,
          worker_name: workerName || null,
          session_id: claudeSessionId ? claudeSessionId.slice(0, 8) : null,
          task_id: taskId,
          pane_id: tmuxResult.paneId,
          claude_session_id: claudeSessionId,
        },
        "coord_spawn_worker_tmux",
      );
      const handshake = waitForWorkerHandshake({
        pidFile,
        resultFile,
        metaFile,
        timeoutMs: LAUNCH_HANDSHAKE_TIMEOUT_MS,
      });
      if (!handshake.ok) {
        meta.launch_status = "launch_failed";
        meta.launch_error = handshake.reason;
        meta.status = "launch_failed";
        writeMetaFile(metaFile, meta);
        throw new Error(`tmux worker failed startup handshake: ${handshake.reason}`);
      }
      meta.handshake_at = handshake.at;
      meta.status = "running";
      writeMetaFile(metaFile, meta);
    } else if (layout === "background") {
      // Background spawn: no terminal, fastest possible.
      spawnBackgroundLauncher(launcherFile, resultFile, pidFile);
      usedApp = "background";
      meta.effective_backend = "background";
      meta.backend_type = "background";
      meta.launch_method = "background_launcher";
      meta.launch_status = "launched";
      const handshake = waitForWorkerHandshake({
        pidFile,
        resultFile,
        metaFile,
        timeoutMs: LAUNCH_HANDSHAKE_TIMEOUT_MS,
      });
      if (!handshake.ok) {
        meta.launch_status = "launch_failed";
        meta.launch_error = handshake.reason;
        meta.status = "launch_failed";
        writeMetaFile(metaFile, meta);
        throw new Error(`background worker failed startup handshake: ${handshake.reason}`);
      }
      meta.handshake_at = handshake.at;
      meta.status = "running";
      writeMetaFile(metaFile, meta);
    } else {
      const launchOutcome = openVisibleWorkerTerminalDetailed(
        `/bin/sh ${shellQuote(bootstrapFile)}`,
        layout,
      );
      usedApp = launchOutcome.app;
      launchError = launchOutcome.launchError;
      fallbackReason = launchOutcome.fallbackReason;
      launchMethod = launchOutcome.launchMethod;
      launchTargetTTY = launchOutcome.targetTTY;
      meta.effective_backend = usedApp;
      meta.backend_type = usedApp;
      meta.launch_method = launchMethod;
      meta.launch_error = launchError;
      meta.fallback_reason = fallbackReason;
      meta.launch_target_tty = launchTargetTTY;
      meta.launch_status = launchError ? "launch_degraded" : "launched";
      writeMetaFile(metaFile, meta);

      const disableFallback = process.env.COORDINATOR_DISABLE_LAUNCH_FALLBACK === "1";
      const fakeVisibleReady =
        TEST_MODE &&
        process.env.COORDINATOR_FAKE_VISIBLE_LAUNCH_READY === "1";
      if (launchError) {
        if (!disableFallback) {
          spawnBackgroundLauncher(launcherFile, resultFile, pidFile);
          usedApp = "background";
          meta.effective_backend = "background";
          meta.backend_type = "background";
          meta.launch_method = "background_launcher";
          meta.launch_status = "fallback_background";
          meta.fallback_reason =
            fallbackReason || "visible launch failed before startup handshake";
          writeMetaFile(metaFile, meta);
          const fallbackHandshake = waitForWorkerHandshake({
            pidFile,
            resultFile,
            metaFile,
            timeoutMs: LAUNCH_HANDSHAKE_TIMEOUT_MS,
          });
          if (!fallbackHandshake.ok) {
            meta.launch_status = "launch_failed";
            meta.launch_error = fallbackHandshake.reason;
            meta.status = "launch_failed";
            writeMetaFile(metaFile, meta);
            throw new Error(
              `visible launch fallback failed startup handshake: ${fallbackHandshake.reason}`,
            );
          }
          meta.handshake_at = fallbackHandshake.at;
          meta.status = "running";
          writeMetaFile(metaFile, meta);
        } else {
          meta.launch_status = "launch_failed";
          meta.status = "launch_failed";
          writeMetaFile(metaFile, meta);
          throw new Error(`visible worker launch failed before startup handshake: ${launchError}`);
        }
      } else {
        if (fakeVisibleReady) {
          const readyAt = nowIso();
          meta.visible_started_at = readyAt;
          meta.handshake_at = readyAt;
          meta.status = "running";
          writeMetaFile(metaFile, meta);
        } else {
        const bootstrapStart = waitForVisibleBootstrapStart(
          visibleStartFile,
          VISIBLE_BOOTSTRAP_START_TIMEOUT_MS,
        );
        if (!bootstrapStart.ok) {
          if (!disableFallback) {
            fallbackReason =
              fallbackReason ||
              `${usedApp} visible bootstrap did not start; fell back to background`;
            spawnBackgroundLauncher(launcherFile, resultFile, pidFile);
            usedApp = "background";
            meta.effective_backend = "background";
            meta.backend_type = "background";
            meta.launch_method = "background_launcher";
            meta.launch_status = "fallback_background";
            meta.launch_error = bootstrapStart.reason;
            meta.fallback_reason = fallbackReason;
            writeMetaFile(metaFile, meta);
            const fallbackHandshake = waitForWorkerHandshake({
              pidFile,
              resultFile,
              metaFile,
              timeoutMs: LAUNCH_HANDSHAKE_TIMEOUT_MS,
            });
            if (!fallbackHandshake.ok) {
              meta.launch_status = "launch_failed";
              meta.launch_error = fallbackHandshake.reason;
              meta.status = "launch_failed";
              writeMetaFile(metaFile, meta);
              throw new Error(
                `visible launch fallback failed startup handshake: ${fallbackHandshake.reason}`,
              );
            }
            meta.handshake_at = fallbackHandshake.at;
            meta.status = "running";
            writeMetaFile(metaFile, meta);
          } else {
            meta.launch_status = "launch_failed";
            meta.launch_error = bootstrapStart.reason;
            meta.status = "launch_failed";
            writeMetaFile(metaFile, meta);
            throw new Error(
              `visible worker bootstrap failed to start: ${bootstrapStart.reason}`,
            );
          }
        } else {
          meta.visible_started_at = bootstrapStart.at;
          writeMetaFile(metaFile, meta);
        }
        const handshake = waitForWorkerHandshake({
          pidFile,
          resultFile,
          metaFile,
          timeoutMs: VISIBLE_LAUNCH_HANDSHAKE_TIMEOUT_MS,
        });
        if (!handshake.ok) {
          if (!disableFallback) {
            fallbackReason =
              fallbackReason ||
              `${usedApp} launch did not start the worker; fell back to background`;
            spawnBackgroundLauncher(launcherFile, resultFile, pidFile);
            usedApp = "background";
            meta.effective_backend = "background";
            meta.backend_type = "background";
            meta.launch_method = "background_launcher";
            meta.launch_status = "fallback_background";
            meta.launch_error = launchError || handshake.reason;
            meta.fallback_reason = fallbackReason;
            writeMetaFile(metaFile, meta);
            const fallbackHandshake = waitForWorkerHandshake({
              pidFile,
              resultFile,
              metaFile,
              timeoutMs: LAUNCH_HANDSHAKE_TIMEOUT_MS,
            });
            if (!fallbackHandshake.ok) {
              meta.launch_status = "launch_failed";
              meta.launch_error = fallbackHandshake.reason;
              meta.status = "launch_failed";
              writeMetaFile(metaFile, meta);
              throw new Error(
                `visible launch fallback failed startup handshake: ${fallbackHandshake.reason}`,
              );
            }
            meta.handshake_at = fallbackHandshake.at;
            meta.status = "running";
            writeMetaFile(metaFile, meta);
          } else {
            meta.launch_status = "launch_failed";
            meta.launch_error = handshake.reason;
            meta.status = "launch_failed";
            writeMetaFile(metaFile, meta);
            throw new Error(`visible worker failed startup handshake: ${handshake.reason}`);
          }
        } else {
          meta.handshake_at = handshake.at;
          meta.status = "running";
          writeMetaFile(metaFile, meta);
        }
        }
      }
    }

    // Auto-focus the lead on the newly spawned worker
    if (workerName) {
      const focusFile = join(TERMINALS_DIR, ".focus-state");
      try {
        writeFileSync(focusFile, workerName, { mode: 0o600 });
      } catch {
        /* non-fatal — focus is a convenience feature */
      }
    }

    return text(
      `Worker spawned: **${taskId}**\n` +
        `- Directory: ${workerDir}\n- Model: ${model}\n- Agent: ${agent || "default"}\n` +
        `- Notify Session: ${notify_session_id || "none"}\n` +
        `- Parent Session: ${leadParentSessionId || "prompt-emulated only"}\n` +
        `- Runtime: ${runtime}\n` +
        `- Mode: ${mode}${mode === "interactive" ? " (lead can message mid-execution)" : " (fire-and-forget)"}\n` +
        `- Role: ${role || "custom"}\n` +
        `- Team: ${teamName || "none"}${teamName ? ` (path=${teamConfig?.execution_path || "hybrid"}, overhead=${teamConfig?.low_overhead_mode || "advanced"})` : ""}\n` +
        `- Requested Layout: ${layout}\n- Effective Backend: ${usedApp}\n- Launch Method: ${meta.launch_method || "unknown"}\n- Launch Status: ${meta.launch_status}\n` +
        (meta.fallback_reason
          ? `- Fallback Reason: ${meta.fallback_reason}\n`
          : "") +
        (meta.launch_error ? `- Launch Error: ${meta.launch_error}\n` : "") +
        `- Platform: ${PLATFORM}\n` +
        `- Isolated: ${isolate ? `yes (branch: ${worktreeBranch})` : "no"}\n` +
        `- Permission Mode: ${rawPermMode}${rawPermMode !== cliPermissionMode ? ` (CLI: ${cliPermissionMode})` : ""}\n` +
        `- Plan Mode: ${requirePlan ? "enabled" : "disabled"}\n` +
        `- Files: ${files.join(", ") || "none"}\n- Results: ${resultFile}\n\n` +
        (meta.prompt_compaction?.context
          ? `- Prompt Compaction: ${meta.prompt_compaction.context.included_sections}/${meta.prompt_compaction.context.candidate_sections} context sections kept; duplicates dropped=${meta.prompt_compaction.context.duplicate_sections_dropped}; bytes saved≈${meta.prompt_compaction.context.bytes_saved}\n`
          : "") +
        `- Budget: ${budgetPolicy} (${estimatedTokens}/${budgetTokens} est tokens)\n` +
        `- Global Budget: ${globalBudgetPolicy} (${activeEstimatedTokens}+${estimatedTokens}=${projectedGlobalTokens}/${globalBudgetTokens} est tokens)\n` +
        `- Active Workers: ${activeWorkers}/${maxActiveWorkers}\n` +
        (teamPolicy && Object.keys(teamPolicy).length > 0
          ? `- Team Policy Applied: yes\n`
          : "") +
        (policy.notes.length
          ? `${policy.notes.map((note) => `- Policy: ${note}\n`).join("")}`
          : "") +
        (budgetPolicy === "warn" && estimatedTokens > budgetTokens
          ? `- WARNING: Estimated token budget exceeded. Consider mode=pipe, context_level=minimal, or higher budget_tokens.\n\n`
          : "") +
        (globalWarnings.length
          ? `${globalWarnings.map((w) => `- WARNING: ${w}`).join("\n")}\n\n`
          : "\n") +
        `Check: \`coord_get_result task_id="${taskId}"\``,
    );
  } catch (err) {
    meta.status =
      meta.launch_status === "launch_failed" ? "launch_failed" : "failed";
    meta.error = err.message;
    meta.launch_error ||= err.message;
    if (meta.launch_status === "pending") meta.launch_status = "launch_failed";
    writeMetaFile(metaFile, meta);
    return text(`Failed to spawn worker: ${err.message}`);
  }
}

/**
 * Handle coord_get_result tool call.
 * @param {object} args - { task_id, tail_lines }
 * @returns {object} MCP text response
 */
export function handleGetResult(args) {
  const { RESULTS_DIR } = cfg();
  const task_id = sanitizeId(args.task_id, "task_id");
  const tail_lines = Number(args.tail_lines);
  const resultFile = join(RESULTS_DIR, `${task_id}.txt`);
  const metaFile = join(RESULTS_DIR, `${task_id}.meta.json`);
  const state = deriveWorkerState(metaFile);
  if (!state) return text(`Task ${task_id} not found.`);
  const { meta, done, status, reason } = state;

  let output = "";
  if (existsSync(resultFile)) {
    const full = readFileSync(resultFile, "utf-8");
    const lines = full.split("\n");
    const limit =
      Number.isFinite(tail_lines) && tail_lines > 0
        ? Math.min(Math.floor(tail_lines), 500)
        : 100;
    output =
      lines.length > limit
        ? `[...truncated ${lines.length - limit} lines...]\n` +
          lines.slice(-limit).join("\n")
        : full;
  }

  let result = `## Worker ${task_id}\n\n`;
  result += `- **Status:** ${status}\n`;
  result += `- **Directory:** ${meta.directory}\n- **Model:** ${meta.model}\n- **Spawned:** ${meta.spawned}\n`;
  result += `- **Requested Layout:** ${meta.requested_layout || meta.backend_type || "unknown"}\n`;
  result += `- **Effective Backend:** ${meta.effective_backend || meta.backend_type || "unknown"}\n`;
  result += `- **Launch Method:** ${meta.launch_method || "unknown"}\n`;
  result += `- **Launch Status:** ${meta.launch_status || "unknown"}\n`;
  if (meta.handshake_at) {
    result += `- **Handshake:** ${meta.handshake_at}\n`;
  }
  if (reason) result += `- **Reason:** ${reason}\n`;
  if (done) result += `- **Finished:** ${done?.finished || "unknown"}\n`;
  result += `\n### Output\n\`\`\`\n${output || "(no output yet)"}\n\`\`\`\n`;
  return text(result);
}

/**
 * Returns a compact summary of all active/recently-done workers.
 * Extracted from handleWatchOutput (no-arg case) so it can be shared with
 * handleBootSnapshot and the worker-status-push hook.
 * @returns {Array<{name: string, status: string, lastLine: string, task_id: string}>}
 */
export function getActiveWorkerSummaries() {
  const { RESULTS_DIR } = cfg();
  const summary = [];
  try {
    const metas = readdirSync(RESULTS_DIR).filter((f) =>
      f.endsWith(".meta.json"),
    );
    for (const mf of metas) {
      const metaFile = join(RESULTS_DIR, mf);
      const state = deriveWorkerState(metaFile);
      if (!state) continue;
      const { meta, status, resultFile } = state;
      if (!["running", "completed", "failed", "launch_failed"].includes(status))
        continue;
      let lastLine = "(no output)";
      if (existsSync(resultFile)) {
        const content = readFileSync(resultFile, "utf-8").trimEnd();
        const allLines = content.split("\n");
        lastLine = allLines[allLines.length - 1] || "(empty)";
        if (lastLine.length > 120) lastLine = lastLine.slice(0, 117) + "...";
      }
      const name = meta.worker_name || state.taskId;
      const summaryStatus = status === "completed" ? "done" : status;
      summary.push({
        name,
        status: summaryStatus,
        lastLine,
        task_id: state.taskId,
      });
    }
  } catch {
    /* empty results dir */
  }
  return summary;
}

/**
 * Handle coord_quick_team — create a team and spawn multiple workers in one call.
 * Closes Gap 1: replaces 4+ separate tool calls with 1 natural-language-friendly call.
 * @param {object} args - { workers, name?, directory?, notify_session_id? }
 */
export function handleQuickTeam(args) {
  const workers = args.workers;
  if (!Array.isArray(workers) || workers.length === 0) {
    return text("'workers' array is required with at least one entry.");
  }
  if (workers.length > 10) {
    return text("Maximum 10 workers per coord_quick_team call.");
  }

  // Team name: use provided name or auto-generate
  const teamName = args.name
    ? String(args.name)
        .trim()
        .replace(/[^A-Za-z0-9._-]/g, "-")
    : `quick-${randomUUID().slice(0, 8)}`;

  // Top-level directory (per-worker can override)
  const topDir = args.directory || process.cwd();

  // Create the team
  const teamResult = handleCreateTeam({ team_name: teamName });
  const teamResultText = teamResult.content?.[0]?.text || "";
  const teamOk = !teamResultText.toLowerCase().startsWith("error");

  // Enrich each worker with team_name, directory, and auto-named worker_name
  const enrichedWorkers = workers.map((w, i) => ({
    directory: topDir,
    worker_name: `${teamName}-${i + 1}`,
    ...w,
    team_name: teamName,
    ...(args.notify_session_id && !w.notify_session_id
      ? { notify_session_id: args.notify_session_id }
      : {}),
  }));

  const spawnResult = handleSpawnWorkers({ workers: enrichedWorkers });
  const spawnText = spawnResult.content?.[0]?.text || "";

  return text(
    `## Quick Team: ${teamName}\n\n` +
      `**Team:** ${teamOk ? "created" : "error — " + teamResultText}\n` +
      `**Workers:** ${workers.length} spawned\n\n` +
      spawnText,
  );
}

/**
 * Handle coord_watch_output tool call.
 * Live-monitoring equivalent to native Shift+Down — returns latest worker output
 * by name or task_id. Optimized for repeated calls during active work.
 * @param {object} args - { worker_name?, task_id?, lines? }
 * @returns {object} MCP text response
 */
export function handleWatchOutput(args) {
  const { RESULTS_DIR } = cfg();
  const lines = Math.min(Math.max(Number(args.lines) || 50, 1), 500);

  // Resolve worker_name to task_id if needed
  let task_id = args.task_id ? sanitizeId(args.task_id, "task_id") : null;
  const workerName = args.worker_name ? sanitizeName(args.worker_name) : null;

  if (!task_id && !workerName) {
    // No name/id given — show all active workers' latest line
    const summary = [];
    try {
      const metas = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".meta.json"));
      for (const mf of metas) {
        const state = deriveWorkerState(join(RESULTS_DIR, mf));
        if (!state) continue;
        const { meta, status, resultFile, reason } = state;
        if (
          !["running", "completed", "failed", "launch_failed"].includes(status)
        ) {
          continue;
        }
        let lastLine = "(no output)";
        if (existsSync(resultFile)) {
          const content = readFileSync(resultFile, "utf-8").trimEnd();
          const allLines = content.split("\n");
          lastLine = allLines[allLines.length - 1] || "(empty)";
          if (lastLine.length > 120) lastLine = lastLine.slice(0, 117) + "...";
        }
        const name = meta.worker_name || state.taskId;
        const displayStatus = status === "completed" ? "done" : status;
        summary.push(
          `[${displayStatus}] ${name}: ${lastLine}${
            reason && displayStatus !== "running" ? ` (${reason})` : ""
          }`,
        );
      }
    } catch {
      /* empty results dir */
    }
    if (summary.length === 0) return text("No active workers.");
    return text(
      `## Active Workers\n\`\`\`\n${summary.join("\n")}\n\`\`\`\nUse \`worker_name\` to focus on one.`,
    );
  }

  // Resolve name to task_id
  if (!task_id && workerName) {
    try {
      const metas = readdirSync(RESULTS_DIR).filter((f) =>
        f.endsWith(".meta.json"),
      );
      for (const mf of metas) {
        const meta = readJSON(join(RESULTS_DIR, mf));
        if (meta && meta.worker_name === workerName) {
          task_id = mf.replace(".meta.json", "");
          break;
        }
      }
    } catch {
      /* ignore */
    }
    if (!task_id) return text(`Worker "${workerName}" not found.`);
  }

  const resultFile = join(RESULTS_DIR, `${task_id}.txt`);
  const metaFile = join(RESULTS_DIR, `${task_id}.meta.json`);
  const state = deriveWorkerState(metaFile);
  if (!state) return text(`Worker "${workerName || task_id}" not found.`);
  const { meta, status, reason } = state;
  const name = meta?.worker_name || task_id;

  let output = "(no output yet)";
  if (existsSync(resultFile)) {
    const full = readFileSync(resultFile, "utf-8");
    const allLines = full.split("\n");
    output = allLines.length > lines ? allLines.slice(-lines).join("\n") : full;
  }

  const detail = [
    `## [${status}] ${name}`,
    meta?.effective_backend
      ? `Backend: ${meta.effective_backend} (requested ${meta.requested_layout || "unknown"})`
      : "",
    meta?.launch_method ? `Method: ${meta.launch_method}` : "",
    meta?.launch_status ? `Launch: ${meta.launch_status}` : "",
    reason ? `Reason: ${reason}` : "",
    "```",
    output,
    "```",
  ]
    .filter(Boolean)
    .join("\n");

  return text(detail);
}

/**
 * Handle coord_kill_worker tool call.
 * @param {object} args - { task_id }
 * @returns {object} MCP text response
 */
export function handleKillWorker(args) {
  const { RESULTS_DIR } = cfg();
  const task_id = sanitizeId(args.task_id, "task_id");
  const pidFile = join(RESULTS_DIR, `${task_id}.pid`);
  const metaFile = join(RESULTS_DIR, `${task_id}.meta.json`);

  if (!existsSync(pidFile)) {
    if (existsSync(`${metaFile}.done`))
      return text(`Worker ${task_id} already completed.`);
    return text(`Worker ${task_id} has no PID file.`);
  }

  const pid = readFileSync(pidFile, "utf-8").trim();
  try {
    killProcess(pid);
    writeFileSecure(
      `${metaFile}.done`,
      JSON.stringify({
        status: "cancelled",
        finished: new Date().toISOString(),
        task_id,
      }),
    );
    const existingMeta = readJSON(metaFile) || {};
    existingMeta.status = "cancelled";
    existingMeta.cancelled = new Date().toISOString();
    writeFileSecure(metaFile, JSON.stringify(existingMeta, null, 2));
    try {
      unlinkSync(pidFile);
    } catch (e) {
      process.stderr.write(
        `[workers] pid file cleanup failed: ${e?.message ?? e}\n`,
      );
    }
    return text(`Worker ${task_id} (PID ${pid}) killed.`);
  } catch (err) {
    return text(`Could not kill ${task_id} (PID ${pid}): ${err.message}`);
  }
}

/**
 * Handle coord_resume_worker tool call.
 * Reads the dead worker's result and original prompt, spawns a new worker with continuation context.
 * @param {object} args - { task_id, mode }
 * @returns {object} MCP text response
 */
export function handleResumeWorker(args) {
  const { RESULTS_DIR } = cfg();
  const task_id = sanitizeId(args.task_id, "task_id");
  const metaFile = join(RESULTS_DIR, `${task_id}.meta.json`);
  const resultFile = join(RESULTS_DIR, `${task_id}.txt`);
  const promptFile = join(RESULTS_DIR, `${task_id}.prompt`);
  const pidFile = join(RESULTS_DIR, `${task_id}.pid`);

  const meta = readJSON(metaFile);
  if (!meta) return text(`Task ${task_id} not found.`);

  // Check if worker is still running
  if (existsSync(pidFile)) {
    const pid = readFileSync(pidFile, "utf-8").trim();
    if (isProcessAlive(pid)) {
      return text(
        `Worker ${task_id} is still running (PID ${pid}). Kill it first or wait for completion.`,
      );
    }
  }

  const resumeCount = (meta.resume_count || 0) + 1;
  const newMode =
    args.mode === "interactive" ? "interactive" : meta.mode || "pipe";
  const originalPromptFile = existsSync(promptFile)
    ? readFileSync(promptFile, "utf-8")
    : "";
  const originalTaskPrompt = extractTaskPrompt(originalPromptFile);
  const explicitResumeAgentId = args.resume_agent_id
    ? String(args.resume_agent_id).trim()
    : null;

  const identityFromTask = findIdentityRecord({
    team_name: meta.team_name || null,
    task_id,
  });
  const identityFromSession = meta.claude_session_id
    ? findIdentityRecord({
        team_name: meta.team_name || null,
        claude_session_id: meta.claude_session_id,
      })
    : null;
  const identityFromWorkerName = meta.worker_name
    ? findIdentityByToken(meta.worker_name, {
        team_name: meta.team_name || null,
      })
    : null;
  const identityFromExplicitAgent = explicitResumeAgentId
    ? findIdentityByToken(explicitResumeAgentId, {
        team_name: meta.team_name || null,
      })
    : null;
  const identityFromMetaAgent = meta.agent_id
    ? findIdentityByToken(meta.agent_id, { team_name: meta.team_name || null })
    : null;
  const identityCandidates = [
    identityFromExplicitAgent,
    identityFromMetaAgent,
    identityFromTask,
    identityFromSession,
    identityFromWorkerName,
  ].filter(Boolean);
  const identityWithNativeAgent = identityCandidates.find(
    (rec) => rec.agent_id,
  );
  const identityWithClaudeSession = identityCandidates.find(
    (rec) => rec.claude_session_id,
  );
  const identity =
    identityWithNativeAgent ||
    identityWithClaudeSession ||
    identityCandidates[0] ||
    null;
  const nativeIdentitySource = explicitResumeAgentId
    ? "explicit-resume-agent-id"
    : identity?.agent_id
      ? "identity-map"
      : meta.agent_id
        ? "meta.agent_id"
        : meta.resumed_from_agent
          ? "meta.resumed_from_agent"
          : "none";
  const nativeAgentId =
    explicitResumeAgentId ||
    (identity?.agent_id ? String(identity.agent_id).trim() : "") ||
    (meta.agent_id ? String(meta.agent_id).trim() : "") ||
    (meta.resumed_from_agent ? String(meta.resumed_from_agent).trim() : "") ||
    null;

  if (nativeAgentId) {
    upsertWorkerIdentity(
      {
        team_name: meta.team_name || null,
        agent_id: nativeAgentId,
        agent_name: meta.agent || identity?.agent_name || null,
        worker_name: meta.worker_name || identity?.worker_name || null,
        session_id:
          meta.claude_session_id?.slice?.(0, 8) || identity?.session_id || null,
        task_id,
        pane_id: identity?.pane_id || meta.tmux_pane_id || null,
        claude_session_id:
          meta.claude_session_id || identity?.claude_session_id || null,
      },
      "coord_resume_worker_native_agent_lookup",
    );

    const resumed = handleSpawnWorker({
      directory: meta.original_directory || meta.directory,
      // Native resume preserves full history; avoid resending a large prompt blob.
      prompt:
        meta.prompt ||
        `Continue work for task ${task_id} using native agent identity.`,
      model: meta.model,
      agent: meta.agent || undefined,
      mode: newMode,
      runtime: meta.runtime || "claude",
      notify_session_id: meta.notify_session_id,
      parent_session_id: meta.claude_parent_session_id,
      files: meta.files,
      role: meta.role,
      permission_mode: meta.permission_mode,
      require_plan: meta.require_plan,
      budget_policy: meta.budget_policy || "warn",
      budget_tokens: meta.budget_tokens,
      global_budget_policy: meta.global_budget_policy || "warn",
      global_budget_tokens: meta.global_budget_tokens,
      max_active_workers: meta.max_active_workers,
      team_name: meta.team_name,
      context_level: meta.context_level || "standard",
      worker_name: meta.worker_name,
      resume_agent_id: nativeAgentId,
    });
    return text(
      `Worker resumed (native agentId): **${task_id}**\n` +
        `- route_mode: native-agent-resume\n` +
        `- route_reason: native identity available (agent_id=${nativeAgentId})\n` +
        `- probe_source: ${nativeIdentitySource}\n` +
        `- fallback_history: []\n\n` +
        `${resumed?.content?.[0]?.text || ""}`,
    );
  }

  // True resume: if we have a Claude session identity, use --resume.
  if (meta.claude_session_id) {
    const { RESULTS_DIR: rDir } = cfg();
    const newTaskId = `${task_id}-r${resumeCount}`;
    const newMetaFile = join(rDir, `${newTaskId}.meta.json`);
    const newPidFile = join(rDir, `${newTaskId}.pid`);
    const leadPaneId = isInsideTmux() ? getCurrentTmuxPane() : null;
    const policy = enforceWorkerPolicy({
      sessionId:
        meta.claude_parent_session_id ||
        meta.notify_session_id ||
        meta.claude_session_id ||
        newTaskId,
      subagentType: meta.agent || meta.role || "unknown",
      description: `Resume worker ${task_id}`,
      prompt: "",
      model: meta.model || "",
      maxTurns: meta.max_turns,
      resume: meta.claude_session_id,
    });
    if (!policy.ok) return text(policy.blockMessage);

    const resumeMeta = {
      ...meta,
      task_id: newTaskId,
      original_task_id: task_id,
      resume_count: resumeCount,
      resumed_from_session: meta.claude_session_id,
      status: "launching",
      launch_method: null,
      launch_status: "pending",
      launch_error: null,
      fallback_reason: null,
      handshake_at: null,
      launch_target_tty: null,
      spawned: new Date().toISOString(),
    };
    writeFileSecure(newMetaFile, JSON.stringify(resumeMeta, null, 2));

    const resumeScript = buildResumeWorkerScript({
      sessionId: meta.claude_session_id,
      workDir: meta.original_directory || meta.directory,
      defaultDirectory: meta.original_directory || meta.directory,
      pidFile: newPidFile,
      metaFile: newMetaFile,
      taskId: newTaskId,
      workerName: meta.worker_name || newTaskId,
      teamName: meta.team_name,
      mode: meta.mode || "interactive",
      runtime: meta.runtime || "claude",
      layout: meta.backend_type || "background",
      model: meta.model,
      agent: meta.agent,
      role: meta.role,
      permissionMode: meta.permission_mode,
      contextLevel: meta.context_level || "standard",
      budgetPolicy: meta.budget_policy || "warn",
      budgetTokens: meta.budget_tokens,
      globalBudgetPolicy: meta.global_budget_policy || "warn",
      globalBudgetTokens: meta.global_budget_tokens,
      maxActiveWorkers: meta.max_active_workers,
      requirePlan: meta.require_plan,
      maxTurns: meta.max_turns,
      leadSessionId: meta.notify_session_id,
      leadPaneId,
      parentSessionId: meta.claude_parent_session_id,
      isolate: meta.isolated,
    });
    const resumeLauncherFile = writeLauncherFile(
      join(rDir, `${newTaskId}.launcher.sh`),
      resumeScript,
    );
    resumeMeta.launcher_file = resumeLauncherFile;

    // Spawn in same layout as original
    let usedApp;
    if (meta.backend_type === "tmux" && isInsideTmux()) {
      const tmuxResult = spawnTmuxPaneWorker(
        `/bin/sh ${shellQuote(resumeLauncherFile)}`,
      );
      usedApp = tmuxResult.app;
      resumeMeta.tmux_pane_id = tmuxResult.paneId;
      resumeMeta.backend_type = "tmux";
      resumeMeta.effective_backend = "tmux";
      resumeMeta.launch_method = "tmux_pane";
      resumeMeta.launch_status = "launched";
      resumeMeta.handshake_at = nowIso();
      resumeMeta.status = "running";
      writeFileSecure(newMetaFile, JSON.stringify(resumeMeta, null, 2));
      upsertWorkerIdentity(
        {
          team_name: resumeMeta.team_name || null,
          agent_id: resumeMeta.agent_id || null,
          agent_name: resumeMeta.agent || null,
          worker_name: resumeMeta.worker_name || null,
          session_id: meta.claude_session_id.slice(0, 8),
          task_id: newTaskId,
          pane_id: tmuxResult.paneId,
          claude_session_id: meta.claude_session_id,
        },
        "coord_resume_worker_claude_session",
      );
    } else {
      spawnBackgroundLauncher(
        resumeLauncherFile,
        join(rDir, `${newTaskId}.txt`),
        newPidFile,
      );
      usedApp = "background";
      resumeMeta.effective_backend = "background";
      resumeMeta.launch_method = "background_launcher";
      resumeMeta.launch_status = "launched";
      resumeMeta.handshake_at = nowIso();
      resumeMeta.status = "running";
      writeFileSecure(newMetaFile, JSON.stringify(resumeMeta, null, 2));
      upsertWorkerIdentity(
        {
          team_name: resumeMeta.team_name || null,
          agent_id: resumeMeta.agent_id || null,
          agent_name: resumeMeta.agent || null,
          worker_name: resumeMeta.worker_name || null,
          session_id: meta.claude_session_id.slice(0, 8),
          task_id: newTaskId,
          pane_id: null,
          claude_session_id: meta.claude_session_id,
        },
        "coord_resume_worker_claude_session",
      );
    }

    return text(
      `Worker resumed (true resume): **${newTaskId}**\n` +
        `- route_mode: claude-session-resume\n` +
        `- route_reason: agent_id unavailable; using claude_session_id\n` +
        `- probe_source: worker-meta:claude_session_id\n` +
        `- fallback_history: native-agent-resume unavailable\n` +
        `- Resumed session: ${meta.claude_session_id}\n` +
        `- Full conversation history preserved\n` +
        `- Layout: ${usedApp}\n` +
        `- Launch Method: ${resumeMeta.launch_method || "unknown"}\n` +
        `- Original task: ${task_id}\n\n` +
        (policy.notes.length
          ? `${policy.notes.map((note) => `- Policy: ${note}\n`).join("")}`
          : "") +
        `Check: \`coord_get_result task_id="${newTaskId}"\``,
    );
  }

  // Summary fallback path: native identity unavailable.
  const transcriptFile = join(RESULTS_DIR, `${task_id}.transcript`);
  let priorOutput = "";
  let resumeSource = "none";
  if (existsSync(transcriptFile)) {
    const full = readFileSync(transcriptFile, "utf-8");
    priorOutput =
      full.length > 30000 ? `[...truncated...]\n${full.slice(-30000)}` : full;
    resumeSource = "transcript";
  } else if (existsSync(resultFile)) {
    const full = readFileSync(resultFile, "utf-8");
    priorOutput =
      full.length > 8000 ? `[...truncated...]\n${full.slice(-8000)}` : full;
    resumeSource = "result-file";
  }

  const continuationPrompt = [
    `CONTINUATION: A previous worker (task_id=${task_id}, attempt #${resumeCount}) was working on this task but stopped.`,
    `Resume source: ${resumeSource}${resumeSource === "transcript" ? " (full session transcript — you have complete visibility into what happened)" : ""}`,
    ``,
    `## What it accomplished so far:`,
    priorOutput ? `\`\`\`\n${priorOutput}\n\`\`\`` : "(no output captured)",
    ``,
    meta.files?.length ? `## Files it touched:\n${meta.files.join("\n")}` : "",
    ``,
    `## Original task:`,
    originalTaskPrompt || meta.prompt || "(original prompt not available)",
    ``,
    `Continue from where it left off. Do NOT redo already-completed work.`,
    `Check the state of the files before making changes — some edits may have been persisted.`,
  ]
    .filter(Boolean)
    .join("\n");

  const fallback = handleSpawnWorker({
    directory: meta.original_directory || meta.directory,
    prompt: continuationPrompt,
    model: meta.model,
    agent: meta.agent || undefined,
    mode: newMode,
    runtime: meta.runtime || "claude",
    notify_session_id: meta.notify_session_id,
    parent_session_id: meta.claude_parent_session_id,
    files: meta.files,
    role: meta.role,
    permission_mode: meta.permission_mode,
    require_plan: meta.require_plan,
    budget_policy: meta.budget_policy || "warn",
    budget_tokens: meta.budget_tokens,
    global_budget_policy: meta.global_budget_policy || "warn",
    global_budget_tokens: meta.global_budget_tokens,
    max_active_workers: meta.max_active_workers,
    team_name: meta.team_name,
    context_level: meta.context_level || "standard",
  });
  return text(
    `Worker resumed (summary fallback): **${task_id}**\n` +
      `- route_mode: summary-fallback\n` +
      `- route_reason: native identity unavailable (agent_id and claude_session_id missing)\n` +
      `- probe_source: ${resumeSource}\n` +
      `- fallback_history: native-agent-resume unavailable; claude-session-resume unavailable\n` +
      `- summary_source: ${resumeSource}\n\n` +
      `${fallback?.content?.[0]?.text || ""}`,
  );
}

/**
 * Handle coord_upgrade_worker tool call.
 * Kills a pipe worker and respawns as interactive, carrying over progress.
 * @param {object} args - { task_id }
 * @returns {object} MCP text response
 */
export function handleUpgradeWorker(args) {
  const { RESULTS_DIR } = cfg();
  const task_id = sanitizeId(args.task_id, "task_id");
  const metaFile = join(RESULTS_DIR, `${task_id}.meta.json`);

  const meta = readJSON(metaFile);
  if (!meta) return text(`Task ${task_id} not found.`);
  if (meta.mode === "interactive")
    return text(`Worker ${task_id} is already in interactive mode.`);

  // Kill the pipe worker first
  const killResult = handleKillWorker({ task_id });

  // Resume as interactive
  const resumeResult = handleResumeWorker({ task_id, mode: "interactive" });

  return text(
    `## Worker Upgraded: ${task_id}\n\n` +
      `**Kill:** ${killResult.content[0]?.text || "done"}\n` +
      `**Resume:** ${resumeResult.content[0]?.text || "spawned"}\n\n` +
      `Worker is now interactive — you can send directives via \`coord_send_directive\`.`,
  );
}

/**
 * Handle coord_spawn_terminal tool call.
 * @param {object} args - { directory, initial_prompt, layout }
 * @returns {object} MCP text response
 */
/**
 * Handle coord_spawn_workers (plural) tool call.
 * Spawns multiple workers from a single call for parallel execution.
 * @param {object} args - { workers: [{directory, prompt, model, ...}, ...] }
 * @returns {object} MCP text response
 */
export function handleSpawnWorkers(args) {
  const workers = args.workers;
  if (!Array.isArray(workers) || workers.length === 0) {
    return text("'workers' array is required with at least one entry.");
  }
  if (workers.length > 10) {
    return text("Maximum 10 workers per multi-spawn call.");
  }

  const results = [];
  for (const w of workers) {
    const result = handleSpawnWorker(w);
    const resultText = result.content?.[0]?.text || "spawned";
    results.push(resultText);
  }

  return text(
    `## Multi-Spawn: ${workers.length} workers\n\n` +
      results.map((r, i) => `### Worker ${i + 1}\n${r}`).join("\n\n"),
  );
}

export function handleSpawnTerminal(args) {
  const { PLATFORM, CLAUDE_BIN } = cfg();
  const directory = requireDirectoryPath(args.directory);
  const initial_prompt = args.initial_prompt ? String(args.initial_prompt) : "";
  const layout = args.layout === "split" ? "split" : "tab";
  if (!existsSync(directory)) return text(`Directory not found: ${directory}`);

  try {
    const dir = PLATFORM === "win32" ? directory : shellQuote(directory);
    const claudeCmd = initial_prompt
      ? `${CLAUDE_BIN} --prompt ${PLATFORM === "win32" ? `"${initial_prompt.replace(/"/g, '""')}"` : `'${initial_prompt.replace(/'/g, "'\\''")}'`}`
      : CLAUDE_BIN;
    const fullCmd =
      PLATFORM === "win32"
        ? `cd /d "${dir}" && ${claudeCmd}`
        : `cd ${dir} && ${claudeCmd}`;

    const usedApp = openTerminalWithCommand(fullCmd, layout);
    return text(
      `Terminal spawned in ${directory} via ${usedApp}${layout === "split" ? " (split)" : ""}.\nWill auto-register via hooks.`,
    );
  } catch (err) {
    return text(`Failed to spawn terminal: ${err.message}`);
  }
}

/**
 * Handle coord_worker_report — workers write progress; lead reads on demand.
 * Reports stored at ~/.claude/terminals/reports/{task_id}.jsonl
 * @param {object} args - { task_id, action, status, summary, files_changed, blockers }
 * @returns {object} MCP text response
 */
export function handleWorkerReport(args) {
  const taskId = sanitizeId(args.task_id);
  const { TERMINALS_DIR } = cfg();
  const reportsDir = join(TERMINALS_DIR, "reports");
  mkdirSync(reportsDir, { recursive: true });
  const reportFile = join(reportsDir, `${taskId}.jsonl`);

  const action = args.action || "read";

  if (action === "write") {
    if (!args.status || !args.summary) {
      return text("Error: status and summary are required for write action.");
    }
    const entry = {
      timestamp: new Date().toISOString(),
      status: args.status,
      summary: args.summary,
      files_changed: args.files_changed || [],
      blockers: args.blockers || null,
    };
    appendFileSync(reportFile, JSON.stringify(entry) + "\n");
    return text(`Report recorded for ${taskId}: ${args.status}`);
  }

  // action === "read"
  if (!existsSync(reportFile)) {
    return text(`No reports found for task ${taskId}.`);
  }
  const lines = readFileSync(reportFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean);
  if (lines.length === 0) return text(`No reports found for task ${taskId}.`);

  const latest = JSON.parse(lines[lines.length - 1]);
  let out = `## Worker Report: ${taskId}\n\n`;
  out += `**Status:** ${latest.status}\n`;
  out += `**Last Update:** ${latest.timestamp}\n`;
  out += `**Summary:** ${latest.summary}\n`;
  if (latest.blockers) out += `**Blockers:** ${latest.blockers}\n`;
  if (latest.files_changed?.length) {
    out += `**Files Changed:** ${latest.files_changed.map((f) => basename(f)).join(", ")}\n`;
  }
  out += `\n_${lines.length} total report(s)_\n`;
  return text(out);
}

/**
 * Kill every worker whose PID file is present and whose process is alive.
 * Called on coordinator exit to prevent orphaned worker processes.
 */
/**
 * Handle coord_focus_worker tool call.
 * @param {object} args - { worker_name: string }
 * @returns {object} MCP text response
 */
export function handleFocusWorker(args) {
  const { RESULTS_DIR, TERMINALS_DIR } = cfg();
  const workerName = sanitizeName(args.worker_name || "");
  if (!workerName) return text("worker_name is required.");

  // Verify worker exists
  let taskId = null;
  try {
    const metas = readdirSync(RESULTS_DIR).filter((f) =>
      f.endsWith(".meta.json"),
    );
    for (const mf of metas) {
      const meta = readJSON(join(RESULTS_DIR, mf));
      if (meta && meta.worker_name === workerName) {
        taskId = mf.replace(".meta.json", "");
        break;
      }
    }
  } catch {
    /* ignore */
  }
  if (!taskId) return text(`Worker "${workerName}" not found.`);

  const focusFile = join(TERMINALS_DIR, ".focus-state");
  try {
    writeFileSync(focusFile, workerName, { mode: 0o600 });
  } catch (err) {
    return text(`Failed to write focus state: ${err.message}`);
  }

  const resultFile = join(RESULTS_DIR, `${taskId}.txt`);
  const pidFile = join(RESULTS_DIR, `${taskId}.pid`);
  const metaFile = join(RESULTS_DIR, `${taskId}.meta.json`);
  const isRunning =
    existsSync(pidFile) &&
    isProcessAlive(readFileSync(pidFile, "utf-8").trim());
  const isDone = existsSync(`${metaFile}.done`);
  const status = isDone ? "done" : isRunning ? "running" : "idle";

  let output = "(no output yet)";
  if (existsSync(resultFile)) {
    const allLines = readFileSync(resultFile, "utf-8").split("\n");
    output = allLines.slice(-10).join("\n");
  }

  return text(
    `Focused on **${workerName}** [${status}]\n\`\`\`\n${output}\n\`\`\``,
  );
}

/**
 * Handle coord_focus_next tool call — cycle focus to next active worker.
 * @param {object} _args - (unused)
 * @returns {object} MCP text response
 */
export function handleFocusNext(_args) {
  const { RESULTS_DIR, TERMINALS_DIR } = cfg();

  // Collect active workers
  const active = [];
  try {
    const metas = readdirSync(RESULTS_DIR).filter((f) =>
      f.endsWith(".meta.json"),
    );
    for (const mf of metas) {
      const meta = readJSON(join(RESULTS_DIR, mf));
      if (!meta || !meta.worker_name) continue;
      const tid = mf.replace(".meta.json", "");
      const pidFile = join(RESULTS_DIR, `${tid}.pid`);
      const isRunning =
        existsSync(pidFile) &&
        isProcessAlive(readFileSync(pidFile, "utf-8").trim());
      const isDone = existsSync(join(RESULTS_DIR, `${tid}.meta.json.done`));
      if (isRunning || (!isDone && existsSync(join(RESULTS_DIR, mf)))) {
        active.push({ name: meta.worker_name, taskId: tid });
      }
    }
  } catch {
    /* empty dir */
  }

  if (active.length === 0) return text("No active workers to focus on.");

  // Sort alphabetically for deterministic cycle order
  active.sort((a, b) => a.name.localeCompare(b.name));

  const focusFile = join(TERMINALS_DIR, ".focus-state");
  let currentFocus = null;
  try {
    if (existsSync(focusFile)) {
      currentFocus = readFileSync(focusFile, "utf-8").trim();
    }
  } catch {
    /* ignore */
  }

  let nextIdx = 0;
  if (currentFocus) {
    const idx = active.findIndex((w) => w.name === currentFocus);
    if (idx !== -1) nextIdx = (idx + 1) % active.length;
  }

  const next = active[nextIdx];
  try {
    writeFileSync(focusFile, next.name, { mode: 0o600 });
  } catch (err) {
    return text(`Failed to write focus state: ${err.message}`);
  }

  const resultFile = join(RESULTS_DIR, `${next.taskId}.txt`);
  const pidFile = join(RESULTS_DIR, `${next.taskId}.pid`);
  const metaFile = join(RESULTS_DIR, `${next.taskId}.meta.json`);
  const isRunning =
    existsSync(pidFile) &&
    isProcessAlive(readFileSync(pidFile, "utf-8").trim());
  const isDone = existsSync(`${metaFile}.done`);
  const status = isDone ? "done" : isRunning ? "running" : "idle";

  let output = "(no output yet)";
  if (existsSync(resultFile)) {
    const allLines = readFileSync(resultFile, "utf-8").split("\n");
    output = allLines.slice(-10).join("\n");
  }

  return text(
    `Focused on **${next.name}** [${status}] (${nextIdx + 1}/${active.length})\n\`\`\`\n${output}\n\`\`\``,
  );
}

/**
 * Handle coord_unfocus tool call — clear focus state.
 * @param {object} _args - (unused)
 * @returns {object} MCP text response
 */
export function handleUnfocus(_args) {
  const { TERMINALS_DIR } = cfg();
  const focusFile = join(TERMINALS_DIR, ".focus-state");
  try {
    if (existsSync(focusFile)) unlinkSync(focusFile);
  } catch (err) {
    return text(`Failed to clear focus: ${err.message}`);
  }
  return text(
    "Focus cleared. Use coord_focus_worker or coord_focus_next to resume.",
  );
}

export function killAllWorkers() {
  try {
    const { RESULTS_DIR } = cfg();
    const pidFiles = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".pid"));
    for (const f of pidFiles) {
      try {
        const pid = readFileSync(join(RESULTS_DIR, f), "utf-8").trim();
        if (pid && isProcessAlive(pid)) {
          killProcess(pid);
        }
      } catch {
        /* ignore individual failures — best-effort cleanup */
      }
    }
  } catch {
    /* ignore if RESULTS_DIR doesn't exist yet */
  }
}

/**
 * Inject a lead-to-worker message into a worker's tmux pane via send-keys.
 * This is the lead's side of the bidirectional tmux messaging protocol.
 * The worker's Claude reads the injected "[L2W]: ..." as user input and responds.
 *
 * @param {{ session_id?: string, worker_name?: string, message: string }} args
 */
export function handleSendToWorkerPane({ session_id, worker_name, message }) {
  const { RESULTS_DIR } = cfg();

  const msg = String(message || "").trim();
  if (!msg) return text("message is required.");
  if (!isInsideTmux()) {
    return text("Not inside a tmux session — cannot inject to worker pane.");
  }

  let paneId = null;
  let resolvedName = worker_name || session_id || "unknown";

  try {
    const metas = readdirSync(RESULTS_DIR).filter((f) =>
      f.endsWith(".meta.json"),
    );
    for (const mf of metas) {
      const meta = readJSON(join(RESULTS_DIR, mf));
      if (!meta?.tmux_pane_id) continue;
      const matchSid =
        session_id &&
        String(meta.claude_session_id || "").startsWith(
          String(session_id).slice(0, 8),
        );
      const matchName = worker_name && meta.worker_name === worker_name;
      if (matchSid || matchName) {
        paneId = meta.tmux_pane_id;
        resolvedName = meta.worker_name || resolvedName;
        break;
      }
    }
  } catch {
    /* RESULTS_DIR may be empty */
  }

  if (!paneId) {
    return text(
      `No tmux pane found for "${resolvedName}". Worker must be running in tmux layout mode and still active.`,
    );
  }

  const formatted = formatL2WMessage(msg);
  const ok = tmuxSendKeys(paneId, formatted);

  return text(
    ok
      ? `→ ${resolvedName} (pane ${paneId}): ${formatted}`
      : `tmux inject failed for "${resolvedName}" (pane ${paneId}). Pane may have exited.`,
  );
}
