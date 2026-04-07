/**
 * Structured shutdown protocol: request → approve/reject → clean termination.
 * Matches Claude's agent system shutdown_request/shutdown_response pattern.
 * @module shutdown
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { cfg } from "./constants.js";
import {
  sanitizeId,
  sanitizeShortSessionId,
  appendJSONLineSecure,
  writeFileSecure,
} from "./security.js";
import { readJSON, text } from "./helpers.js";
import { getAllSessions, getSessionStatus } from "./sessions.js";
import { isProcessAlive, killProcess } from "./platform/common.js";

/**
 * Handle coord_shutdown_request tool call.
 * Sends a shutdown request to a worker. Worker can approve or reject.
 * If worker doesn't respond within timeout, force kills.
 * @param {object} args - { task_id, target_name, target_session, message, force_timeout_seconds }
 * @returns {object} MCP text response
 */
export function handleShutdownRequest(args) {
  const { INBOX_DIR, RESULTS_DIR } = cfg();
  const message = String(
    args.message || "Task complete, wrapping up the session.",
  ).trim();
  const forceTimeout = Math.max(
    10,
    Math.min(300, parseInt(args.force_timeout_seconds, 10) || 60),
  );

  // Resolve target — by task_id, target_name, or target_session
  let targetSid = null;
  let taskId = null;

  if (args.task_id) {
    taskId = sanitizeId(args.task_id, "task_id");
    const metaFile = join(RESULTS_DIR, `${taskId}.meta.json`);
    const meta = readJSON(metaFile);
    if (!meta) return text(`Task ${taskId} not found.`);

    // Find the worker's session
    const sessions = getAllSessions();
    for (const s of sessions) {
      if (s.current_task === taskId && getSessionStatus(s) !== "closed") {
        targetSid = s.session;
        break;
      }
    }
  } else if (args.target_name) {
    const name = String(args.target_name).trim();
    const sessions = getAllSessions();
    for (const s of sessions) {
      if (s.worker_name === name && getSessionStatus(s) !== "closed") {
        targetSid = s.session;
        taskId = s.current_task || null;
        break;
      }
    }
    if (!targetSid) return text(`Worker "${name}" not found.`);
  } else if (args.target_session) {
    targetSid = sanitizeShortSessionId(args.target_session);
  } else {
    return text("One of task_id, target_name, or target_session is required.");
  }

  if (!targetSid) return text("Could not resolve worker session ID.");

  // Generate request ID
  const requestId = `shutdown-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Write shutdown request to worker's inbox
  appendJSONLineSecure(join(INBOX_DIR, `${targetSid}.jsonl`), {
    ts: new Date().toISOString(),
    from: "lead",
    priority: "urgent",
    content: `[SHUTDOWN_REQUEST:${requestId}] ${message}`,
    request_id: requestId,
    type: "shutdown_request",
  });

  // Write shutdown tracking file
  const shutdownFile = join(RESULTS_DIR, `${requestId}.shutdown`);
  writeFileSecure(
    shutdownFile,
    JSON.stringify(
      {
        request_id: requestId,
        task_id: taskId,
        target_session: targetSid,
        message,
        force_timeout_seconds: forceTimeout,
        requested_at: new Date().toISOString(),
        status: "pending",
      },
      null,
      2,
    ),
  );

  // Schedule force kill after timeout (non-blocking)
  if (taskId) {
    const pidFile = join(RESULTS_DIR, `${taskId}.pid`);
    setTimeout(() => {
      try {
        const tracking = readJSON(shutdownFile);
        if (tracking?.status === "pending") {
          // Worker didn't respond — force kill
          if (existsSync(pidFile)) {
            const pid = readFileSync(pidFile, "utf-8").trim();
            if (isProcessAlive(pid)) {
              killProcess(pid);
            }
          }
          tracking.status = "force_killed";
          tracking.force_killed_at = new Date().toISOString();
          writeFileSecure(shutdownFile, JSON.stringify(tracking, null, 2));
        }
      } catch {}
    }, forceTimeout * 1000);
  }

  return text(
    `Shutdown requested: **${targetSid}**\n` +
      `- Request ID: ${requestId}\n` +
      `- Task: ${taskId || "none"}\n` +
      `- Message: ${message}\n` +
      `- Force timeout: ${forceTimeout}s\n` +
      `- Worker will receive the request on their next tool call.\n` +
      `- If no response in ${forceTimeout}s, worker will be force-killed.`,
  );
}

/**
 * Handle coord_shutdown_response tool call.
 * Worker approves or rejects a shutdown request.
 * @param {object} args - { request_id, approve, reason }
 * @returns {object} MCP text response
 */
export function handleShutdownResponse(args) {
  const { INBOX_DIR, RESULTS_DIR } = cfg();
  const requestId = String(args.request_id || "").trim();
  if (!requestId) return text("request_id is required.");
  const approve = Boolean(args.approve);
  const reason = String(args.reason || "").trim();

  const shutdownFile = join(RESULTS_DIR, `${requestId}.shutdown`);
  const tracking = readJSON(shutdownFile);
  if (!tracking) return text(`Shutdown request ${requestId} not found.`);

  if (approve) {
    tracking.status = "approved";
    tracking.approved_at = new Date().toISOString();
    writeFileSecure(shutdownFile, JSON.stringify(tracking, null, 2));

    // Notify lead
    if (tracking.task_id) {
      const metaFile = join(RESULTS_DIR, `${tracking.task_id}.meta.json`);
      const meta = readJSON(metaFile);
      if (meta?.notify_session_id) {
        appendJSONLineSecure(
          join(INBOX_DIR, `${meta.notify_session_id}.jsonl`),
          {
            ts: new Date().toISOString(),
            from: "worker",
            priority: "normal",
            content: `[SHUTDOWN_APPROVED] ${tracking.task_id} — Worker approved shutdown.`,
          },
        );
      }
    }

    return text(
      `Shutdown approved: ${requestId}\n` + `Worker will terminate gracefully.`,
    );
  } else {
    tracking.status = "rejected";
    tracking.rejected_at = new Date().toISOString();
    tracking.reason = reason;
    writeFileSecure(shutdownFile, JSON.stringify(tracking, null, 2));

    // Notify lead
    if (tracking.task_id) {
      const metaFile = join(RESULTS_DIR, `${tracking.task_id}.meta.json`);
      const meta = readJSON(metaFile);
      if (meta?.notify_session_id) {
        appendJSONLineSecure(
          join(INBOX_DIR, `${meta.notify_session_id}.jsonl`),
          {
            ts: new Date().toISOString(),
            from: "worker",
            priority: "normal",
            content: `[SHUTDOWN_REJECTED] ${tracking.task_id} — ${reason || "Worker rejected shutdown (no reason given)."}`,
          },
        );
      }
    }

    return text(
      `Shutdown rejected: ${requestId}\n` +
        `- Reason: ${reason || "none"}\n` +
        `Lead has been notified.`,
    );
  }
}
