/**
 * Security utilities: file hardening, input validation, rate limiting.
 * @module security
 */

import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  lstatSync,
  chmodSync,
  statSync,
  openSync,
  closeSync,
  realpathSync,
  renameSync,
  fsyncSync,
} from "fs";
import { join, basename, resolve, isAbsolute } from "path";
import { execFileSync } from "child_process";
import {
  cfg,
  SAFE_ID_RE,
  SAFE_NAME_RE,
  SAFE_MODEL_RE,
  SAFE_AGENT_RE,
} from "./constants.js";

/**
 * Ensure a directory exists with owner-only permissions.
 * Validates against symlinks and ownership mismatches.
 * @param {string} pathValue - Directory path to secure
 */
export function ensureSecureDirectory(pathValue) {
  const { PLATFORM, TEST_MODE } = cfg();
  mkdirSync(pathValue, { recursive: true, mode: 0o700 });
  try {
    const lst = lstatSync(pathValue);
    if (lst.isSymbolicLink())
      throw new Error(`${pathValue} must not be a symlink.`);
    if (typeof process.getuid === "function") {
      const uid = process.getuid();
      if (Number.isInteger(uid) && lst.uid !== uid)
        throw new Error(`${pathValue} is not owned by current user.`);
    }
    if (PLATFORM !== "win32") chmodSync(pathValue, 0o700);
    else enforceWindowsAcl(pathValue, true);
  } catch (err) {
    if (!TEST_MODE) throw err;
  }
}

/**
 * Write file with owner-only permissions (0o600).
 * @param {string} pathValue - File path
 * @param {string} data - Content to write
 */
export function writeFileSecure(pathValue, data) {
  const { PLATFORM } = cfg();
  const tempPath = `${pathValue}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  let renamed = false;
  try {
    writeFileSync(tempPath, data, { mode: 0o600 });
    try {
      const fd = openSync(tempPath, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {}
    renameSync(tempPath, pathValue);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        unlinkSync(tempPath);
      } catch {}
    }
  }
  if (PLATFORM !== "win32") {
    try {
      chmodSync(pathValue, 0o600);
    } catch {}
  } else {
    enforceWindowsAcl(pathValue, false);
  }
}

/**
 * Append a JSON line with owner-only permissions.
 * @param {string} pathValue - File path
 * @param {object} value - Object to serialize and append
 */
export function appendJSONLineSecure(pathValue, value) {
  const { PLATFORM } = cfg();
  appendFileSync(pathValue, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  if (PLATFORM !== "win32") {
    try {
      chmodSync(pathValue, 0o600);
    } catch {}
  } else {
    enforceWindowsAcl(pathValue, false);
  }
}

/**
 * Enforce Windows ACL: strip inherited/broad ACEs, grant only current user.
 * @param {string} pathValue - Path to harden
 * @param {boolean} isDirectory - Whether path is a directory
 */
export function enforceWindowsAcl(pathValue, isDirectory = false) {
  const { PLATFORM } = cfg();
  if (PLATFORM !== "win32") return;
  let username = String(process.env.USERNAME || "").trim();
  if (!username) {
    try {
      const who = execFileSync("whoami", { encoding: "utf-8" }).trim();
      username = who.split("\\").pop() || who;
    } catch (e) {
      process.stderr.write(`coord: whoami failed: ${e.message}\n`);
    }
  }
  if (!username)
    throw new Error("USERNAME is required for Windows ACL hardening.");
  const grant = isDirectory ? `${username}:(OI)(CI)F` : `${username}:F`;
  execFileSync(
    "icacls",
    [
      pathValue,
      "/inheritance:r",
      "/remove:g",
      "Everyone",
      "/remove:g",
      "Users",
      "/remove:g",
      "Authenticated Users",
      "/grant:r",
      grant,
    ],
    { stdio: "ignore" },
  );
  const aclOutput = execFileSync("icacls", [pathValue], { encoding: "utf-8" });
  const lower = aclOutput.toLowerCase();
  if (!lower.includes(`${username.toLowerCase()}:`))
    throw new Error(`ACL hardening failed for ${pathValue}: missing user ACE.`);
  if (/\(I\)/.test(aclOutput))
    throw new Error(
      `ACL hardening failed for ${pathValue}: inherited ACE detected.`,
    );
  if (
    /\\everyone:/i.test(aclOutput) ||
    /\\users:/i.test(aclOutput) ||
    /authenticated users:/i.test(aclOutput)
  ) {
    throw new Error(
      `ACL hardening failed for ${pathValue}: broad principals still present.`,
    );
  }
}

/**
 * Assert message content does not exceed the size budget.
 * @param {string} content - Message content
 * @throws {Error} If content exceeds MAX_MESSAGE_BYTES
 */
export function assertMessageBudget(content) {
  const { MAX_MESSAGE_BYTES } = cfg();
  const size = Buffer.byteLength(content, "utf-8");
  if (size > MAX_MESSAGE_BYTES)
    throw new Error(`Message exceeds ${MAX_MESSAGE_BYTES} bytes.`);
}

/**
 * Sleep for the given number of milliseconds (sync, non-blocking to other threads).
 * @param {number} ms - Milliseconds to sleep
 */
export function sleepMs(ms) {
  const clamped = Math.max(0, Number(ms) || 0);
  const buf = new SharedArrayBuffer(4);
  const arr = new Int32Array(buf);
  Atomics.wait(arr, 0, 0, clamped);
}

/**
 * Acquire an exclusive file lock using O_EXCL create.
 * Returns a release function.
 * @param {string} lockPath - Lock file path
 * @param {number} timeoutMs - Max wait time
 * @param {number} staleMs - Max lock age before considering it stale
 * @param {number} retryDelayMs - Delay between retries
 * @returns {Function} Release function to call when done
 */
export function acquireExclusiveFileLock(
  lockPath,
  timeoutMs = 2000,
  staleMs = 15000,
  retryDelayMs = 25,
) {
  const started = Date.now();
  let lockFd;

  while (true) {
    try {
      lockFd = openSync(lockPath, "wx", 0o600);
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) unlinkSync(lockPath);
      } catch (e) {
        process.stderr.write(`coord: stale lock check failed: ${e.message}\n`);
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Could not acquire lock for ${basename(lockPath)}.`);
      }
      sleepMs(retryDelayMs);
    }
  }

  return () => {
    try {
      if (lockFd !== undefined) closeSync(lockFd);
    } catch {}
    try {
      unlinkSync(lockPath);
    } catch {}
  };
}

/**
 * Enforce per-session message rate limit.
 * @param {string} sessionId - Target session ID
 * @throws {Error} If rate limit exceeded
 */
export function enforceMessageRateLimit(sessionId) {
  const { TERMINALS_DIR, MAX_MESSAGES_PER_MINUTE } = cfg();
  const rateFile = join(TERMINALS_DIR, `rate-${sessionId}.json`);
  const releaseLock = acquireExclusiveFileLock(`${rateFile}.lock`);
  try {
    const now = Date.now();
    const cutoff = now - 60_000;
    let events = [];
    try {
      if (existsSync(rateFile)) {
        const parsed = JSON.parse(readFileSync(rateFile, "utf-8"));
        events = Array.isArray(parsed.events)
          ? parsed.events.filter((ts) => Number(ts) >= cutoff)
          : [];
      }
    } catch (e) {
      process.stderr.write(`coord: rate file parse failed: ${e.message}\n`);
    }
    if (events.length >= MAX_MESSAGES_PER_MINUTE) {
      throw new Error(
        `Rate limit exceeded for ${sessionId} (${MAX_MESSAGES_PER_MINUTE}/minute).`,
      );
    }
    events.push(now);
    writeFileSecure(rateFile, JSON.stringify({ events }));
  } finally {
    releaseLock();
  }
}

// ── Input validation ──

/**
 * Validate and return a safe ID string.
 * @param {string} input - Raw input
 * @param {string} label - Name for error messages
 * @returns {string} Validated ID
 */
export function sanitizeId(input, label = "id") {
  const value = String(input ?? "").trim();
  if (!SAFE_ID_RE.test(value))
    throw new Error(`Invalid ${label}. Use letters, numbers, _, - only.`);
  return value;
}

/**
 * Validate and truncate a session ID to 8 chars.
 * @param {string} input - Raw session ID
 * @returns {string} 8-char session ID
 */
export function sanitizeShortSessionId(input) {
  const value = sanitizeId(input, "session_id");
  if (value.length < 8)
    throw new Error("Invalid session_id. Provide at least 8 characters.");
  return value.slice(0, 8);
}

/**
 * Sanitize a name (file-safe, normalized).
 * @param {string} input - Raw name
 * @param {string} label - Name for error messages
 * @returns {string} Normalized name
 */
export function sanitizeName(input, label = "name") {
  const value = String(input ?? "").trim();
  if (!value) throw new Error(`Invalid ${label}.`);
  const normalized = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^\.+/, "")
    .replace(/^-+/, "")
    .replace(/-+/g, "-")
    .slice(0, 64)
    .replace(/[-.]+$/, "");
  if (!normalized || !SAFE_NAME_RE.test(normalized))
    throw new Error(`Invalid ${label}.`);
  return normalized;
}

/**
 * Sanitize a model name.
 * @param {string} input - Raw model name
 * @returns {string} Validated model name (defaults to "sonnet")
 */
export function sanitizeModel(input) {
  const model = String(input ?? "sonnet")
    .trim()
    .toLowerCase();
  if (!SAFE_MODEL_RE.test(model)) throw new Error("Invalid model name.");
  if (model === "sonnet" || model === "haiku") return model;
  if (model.startsWith("claude-sonnet-")) return "sonnet";
  if (model.startsWith("claude-haiku-")) return "haiku";
  throw new Error("Only sonnet and haiku models are allowed.");
}

/**
 * Sanitize an agent name (optional — empty string if not provided).
 * @param {string} input - Raw agent name
 * @returns {string} Validated agent name or empty string
 */
export function sanitizeAgent(input) {
  if (input === undefined || input === null || input === "") return "";
  const agent = String(input).trim();
  if (!SAFE_AGENT_RE.test(agent)) throw new Error("Invalid agent name.");
  return agent;
}

/**
 * Validate a directory path.
 * @param {string} pathValue - Raw path
 * @returns {string} Validated directory path
 */
export function requireDirectoryPath(pathValue) {
  const directory = String(pathValue ?? "").trim();
  if (!directory) throw new Error("Directory is required.");
  if (directory.includes("\n") || directory.includes("\r"))
    throw new Error("Invalid directory path.");
  if (directory.includes("\0")) throw new Error("Invalid directory path.");
  if (directory.includes('"'))
    throw new Error("Directory path cannot contain double quotes.");
  return directory;
}

/**
 * Normalize a file path to canonical form for comparison.
 * @param {string} filePath - Raw file path
 * @param {string} cwd - Working directory for relative paths
 * @returns {string|null} Normalized path or null
 */
export function normalizeFilePath(filePath, cwd = "") {
  const { PLATFORM } = cfg();
  const raw = String(filePath ?? "").trim();
  if (!raw) return null;
  let candidate = isAbsolute(raw) ? raw : resolve(cwd || process.cwd(), raw);
  try {
    if (existsSync(candidate)) {
      candidate = realpathSync(candidate);
    }
  } catch {}
  let normalized = candidate.replace(/\\/g, "/");
  if (PLATFORM === "win32") normalized = normalized.toLowerCase();
  return normalized;
}
