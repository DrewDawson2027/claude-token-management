/**
 * Plan approval workflow: approve/reject worker plans.
 * Writes approval status to results dir and broadcasts via inbox channels.
 * @module approval
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { cfg } from "./constants.js";
import {
  sanitizeId,
  writeFileSecure,
  appendJSONLineSecure,
} from "./security.js";
import { readJSON, text } from "./helpers.js";

/**
 * Find a worker's session ID by scanning session files for matching task metadata.
 * @param {string} taskId - Task ID to search for
 * @returns {string|null} Session ID or null
 */
function findWorkerSessionId(taskId) {
  const { TERMINALS_DIR } = cfg();
  try {
    const files = readdirSync(TERMINALS_DIR).filter(
      (f) => f.startsWith("session-") && f.endsWith(".json"),
    );
    for (const f of files) {
      const session = readJSON(join(TERMINALS_DIR, f));
      if (!session) continue;
      // Check if session's current_task matches or if its prompt references this task
      if (session.current_task === taskId) return session.session;
    }
  } catch (e) {
    process.stderr.write(
      `[approval] findSessionForTask error: ${e?.message ?? e}\n`,
    );
  }
  return null;
}

/**
 * Handle coord_approve_plan tool call.
 * @param {object} args - { task_id, message }
 * @returns {object} MCP text response
 */
export function handleApprovePlan(args) {
  const { INBOX_DIR, RESULTS_DIR } = cfg();
  const taskId = sanitizeId(args.task_id, "task_id");
  const message = String(
    args.message || "Plan approved. Proceed with implementation.",
  ).trim();

  const metaFile = join(RESULTS_DIR, `${taskId}.meta.json`);
  const meta = readJSON(metaFile);
  if (!meta) return text(`Task ${taskId} not found.`);

  // Write approval status file
  const approvalFile = join(RESULTS_DIR, `${taskId}.approval`);
  writeFileSecure(
    approvalFile,
    JSON.stringify(
      {
        status: "approved",
        ts: new Date().toISOString(),
        message,
      },
      null,
      2,
    ),
  );

  // Try to deliver via worker's inbox directly
  const workerSid = findWorkerSessionId(taskId);
  if (workerSid) {
    appendJSONLineSecure(join(INBOX_DIR, `${workerSid}.jsonl`), {
      ts: new Date().toISOString(),
      from: "lead",
      priority: "urgent",
      content: `[APPROVED] ${taskId} — ${message}`,
    });
  }

  return text(
    `Plan approved: **${taskId}**\n` +
      `- Approval file: results/${taskId}.approval\n` +
      (workerSid
        ? `- Inbox message sent to session ${workerSid}\n`
        : `- Worker session not found — approval file will be checked by worker\n`) +
      `- Note: ${message}`,
  );
}

/**
 * Handle coord_reject_plan tool call.
 * @param {object} args - { task_id, feedback }
 * @returns {object} MCP text response
 */
export function handleRejectPlan(args) {
  const { INBOX_DIR, RESULTS_DIR } = cfg();
  const taskId = sanitizeId(args.task_id, "task_id");
  const feedback = String(args.feedback || "").trim();
  if (!feedback) return text("Feedback is required when rejecting a plan.");

  const metaFile = join(RESULTS_DIR, `${taskId}.meta.json`);
  const meta = readJSON(metaFile);
  if (!meta) return text(`Task ${taskId} not found.`);

  const approvalFile = join(RESULTS_DIR, `${taskId}.approval`);
  writeFileSecure(
    approvalFile,
    JSON.stringify(
      {
        status: "revision_requested",
        ts: new Date().toISOString(),
        feedback,
      },
      null,
      2,
    ),
  );

  const workerSid = findWorkerSessionId(taskId);
  if (workerSid) {
    appendJSONLineSecure(join(INBOX_DIR, `${workerSid}.jsonl`), {
      ts: new Date().toISOString(),
      from: "lead",
      priority: "urgent",
      content: `[REVISION] ${taskId} — ${feedback}`,
    });
  }

  return text(
    `Plan revision requested: **${taskId}**\n` +
      `- Feedback: ${feedback}\n` +
      (workerSid
        ? `- Revision request sent to session ${workerSid}\n`
        : `- Worker session not found — revision file will be checked by worker\n`) +
      `Worker will revise plan and re-submit.`,
  );
}
