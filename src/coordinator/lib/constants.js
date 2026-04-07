/**
 * Constants and configuration for the MCP Coordinator.
 *
 * Dynamic values (HOME-derived paths, env vars) are accessed via `cfg()`
 * which re-evaluates on every call. This is required for e2e tests that
 * override process.env.HOME mid-process.
 *
 * Static patterns are normal exports (they never change).
 *
 * @module constants
 */

import { join } from "path";
import { homedir, platform } from "os";

/** Input validation patterns (static, never change) */
export const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const SAFE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const SAFE_MODEL_RE = /^[A-Za-z0-9._:-]{1,64}$/;
export const SAFE_AGENT_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Get current runtime configuration.
 * Re-evaluates homedir() and process.env on every call.
 * @returns {object} Current config values
 */
export function cfg() {
  const home = process.env.HOME || homedir();
  const claudeDir = join(home, ".claude");
  const terminalsDir = join(claudeDir, "terminals");
  return {
    CLAUDE_DIR: claudeDir,
    TERMINALS_DIR: terminalsDir,
    INBOX_DIR: join(terminalsDir, "inbox"),
    RESULTS_DIR: join(terminalsDir, "results"),
    ACTIVITY_FILE: join(terminalsDir, "activity.jsonl"),
    QUEUE_FILE: join(terminalsDir, "queue.jsonl"),
    SESSION_CACHE_DIR: join(claudeDir, "session-cache"),
    SETTINGS_FILE: join(claudeDir, "settings.local.json"),
    WORKER_SETTINGS_FILE: join(
      claudeDir,
      "mcp-coordinator",
      "lib",
      "platform",
      "worker-settings.json",
    ),
    PLATFORM: process.env.COORDINATOR_PLATFORM || platform(),
    TEST_MODE: process.env.COORDINATOR_TEST_MODE === "1",
    CLAUDE_BIN: process.env.COORDINATOR_CLAUDE_BIN || "claude",
    MAX_MESSAGE_BYTES: Number(
      process.env.COORDINATOR_MAX_MESSAGE_BYTES || 8192,
    ),
    MAX_INBOX_LINES: Number(process.env.COORDINATOR_MAX_INBOX_LINES || 500),
    MAX_INBOX_BYTES: Number(
      process.env.COORDINATOR_MAX_INBOX_BYTES || 256 * 1024,
    ),
    MAX_MESSAGES_PER_MINUTE: Number(
      process.env.COORDINATOR_MAX_MESSAGES_PER_MINUTE || 120,
    ),
    SESSION_ACTIVE_SECONDS: Number(
      process.env.COORDINATOR_SESSION_ACTIVE_SECONDS || 30,
    ),
    SESSION_IDLE_SECONDS: Number(
      process.env.COORDINATOR_SESSION_IDLE_SECONDS || 60,
    ),
    GC_MAX_AGE_MS: Number(
      process.env.COORDINATOR_GC_MAX_AGE_MS || 24 * 60 * 60 * 1000,
    ), // 24h default
  };
}
