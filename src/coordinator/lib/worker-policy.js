import { existsSync, appendFileSync, readdirSync } from "fs";
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { cfg } from "./constants.js";

const POLICY_TIMEOUT_MS = 10_000;
const BUNDLED_HOOKS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "hooks",
);

function resolvePolicyScript(
  filename,
  overrideEnv,
  { allowBundled = false } = {},
) {
  const { CLAUDE_DIR } = cfg();
  const override = String(process.env[overrideEnv] || "").trim();
  if (override) return override;
  const externalPath = join(CLAUDE_DIR, "hooks", filename);
  if (existsSync(externalPath)) return externalPath;
  if (allowBundled) return join(BUNDLED_HOOKS_DIR, filename);
  return externalPath;
}

function normalizeHookLine(line) {
  const text = String(line || "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.reason === "string" && parsed.reason.trim()) {
      return parsed.reason.trim();
    }
  } catch {}
  return text;
}

function collectHookMessages(result) {
  const lines = [];
  for (const chunk of [result.stdout, result.stderr]) {
    for (const rawLine of String(chunk || "").split(/\r?\n/)) {
      const line = normalizeHookLine(rawLine);
      if (line) lines.push(line);
    }
  }
  return Array.from(new Set(lines));
}

function runPolicyHook(name, scriptPath, payload, { required = true } = {}) {
  const { TEST_MODE } = cfg();
  if (!existsSync(scriptPath)) {
    if (TEST_MODE || !required) return { ok: true, skipped: true, notes: [] };
    return {
      ok: false,
      blockMessage: `Worker policy enforcement unavailable: missing ${name} hook at ${scriptPath}.`,
      notes: [],
    };
  }

  const result = spawnSync("python3", [scriptPath], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    timeout: POLICY_TIMEOUT_MS,
    env: process.env,
  });
  if (result.error) {
    return {
      ok: false,
      blockMessage: `Worker policy enforcement failed while running ${name}: ${result.error.message}`,
      notes: collectHookMessages(result),
    };
  }

  const notes = collectHookMessages(result).map((msg) => `${name}: ${msg}`);
  if (result.status === 0) return { ok: true, notes };
  if (result.status === 2) {
    return {
      ok: false,
      blockMessage:
        notes[0] || `${name} blocked worker spawn without a message.`,
      notes,
    };
  }

  return {
    ok: false,
    blockMessage:
      notes[0] ||
      `Worker policy enforcement failed: ${name} exited ${result.status}.`,
    notes,
  };
}

function writeAuditLine(decision, reason, toolInput) {
  try {
    const { TERMINALS_DIR } = cfg();
    const resultsDir = join(TERMINALS_DIR, "results");
    let activeCount = 0;
    if (existsSync(resultsDir)) {
      const files = readdirSync(resultsDir);
      activeCount = files.filter(
        (f) => f.endsWith(".meta.json") && !files.includes(f + ".done"),
      ).length;
    }
    appendFileSync(
      join(TERMINALS_DIR, "budget-audit.jsonl"),
      JSON.stringify({
        ts: new Date().toISOString(),
        worker_name: toolInput.worker_name || "unknown",
        model: toolInput.model || "sonnet",
        decision,
        reason,
        active_workers: activeCount,
      }) + "\n",
    );
  } catch {}
}

export function enforceWorkerPolicy({
  sessionId,
  subagentType,
  description,
  prompt,
  model,
  maxTurns,
  resume,
}) {
  if (process.env.COORDINATOR_SKIP_WORKER_POLICY === "1") {
    return { ok: true, skipped: true, notes: ["policy skipped: COORDINATOR_SKIP_WORKER_POLICY=1"] };
  }
  const toolInput = {
    subagent_type: String(subagentType || "unknown"),
    description: String(description || "").trim(),
    prompt: String(prompt || ""),
    run_in_background: true,
  };
  if (model) toolInput.model = String(model);
  if (maxTurns !== null && maxTurns !== undefined)
    toolInput.max_turns = maxTurns;
  if (resume) toolInput.resume = String(resume);

  const payload = {
    tool_name: "Task",
    session_id: String(sessionId || "coordinator-unknown"),
    tool_input: toolInput,
    coordinator_spawn: true,
  };

  const scripts = [
    {
      name: "token-guard",
      scriptPath: resolvePolicyScript(
        "token-guard.py",
        "COORDINATOR_TOKEN_GUARD_PATH",
      ),
      required: false,
    },
    {
      name: "model-router",
      scriptPath: resolvePolicyScript(
        "model-router.py",
        "COORDINATOR_MODEL_ROUTER_PATH",
        { allowBundled: true },
      ),
      required: true,
    },
  ];

  const notes = [];
  for (const script of scripts) {
    const outcome = runPolicyHook(script.name, script.scriptPath, payload, {
      required: script.required,
    });
    if (outcome.notes?.length) notes.push(...outcome.notes);
    if (!outcome.ok) {
      writeAuditLine("block", outcome.blockMessage, toolInput);
      return {
        ok: false,
        blockMessage: outcome.blockMessage,
        notes: Array.from(new Set(notes)),
      };
    }
  }

  writeAuditLine("allow", "policy passed", toolInput);
  return { ok: true, notes: Array.from(new Set(notes)) };
}
