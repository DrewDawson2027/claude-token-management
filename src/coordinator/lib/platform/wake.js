/**
 * Cross-platform session wake mechanisms.
 * @module platform/wake
 */

import { existsSync, writeFileSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { execFileSync, spawnSync } from "child_process";
import { cfg } from "../constants.js";
import {
  sanitizeShortSessionId,
  assertMessageBudget,
  enforceMessageRateLimit,
  writeFileSecure,
  appendJSONLineSecure,
} from "../security.js";
import { readJSON, text } from "../helpers.js";
import { getTerminalApp, isSafeTTYPath } from "./common.js";

/**
 * Determine what text to send for a terminal wake.
 * Always sends only Enter (empty string). Message content goes through inbox.
 * The allowUnsafe parameter was removed for security — keystroke injection
 * into arbitrary terminal sessions is an injection vector.
 * @param {string} _message - User message (ignored for terminal text)
 * @returns {string} Empty string (Enter keystroke only)
 */
export function selectWakeText(_message) {
  return "";
}

/**
 * Wake a session via direct TTY write (Linux).
 * @param {string} ttyPath - TTY device path
 * @param {string} message - Text to write
 * @returns {boolean} Whether wake succeeded
 */
/* c8 ignore start — requires real TTY device, tested manually */
export function wakeViaTTY(ttyPath, message) {
  if (!isSafeTTYPath(ttyPath)) return false;
  try {
    const st = statSync(ttyPath);
    if (!st.isCharacterDevice()) return false;
    writeFileSync(ttyPath, `${message}\n`, { flag: "a" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wake a session via Windows AppActivate + SendKeys.
 * @param {string} sessionId - Session ID
 * @param {string} message - Text to send
 * @returns {boolean} Whether wake succeeded
 */
/* c8 ignore stop */

/* c8 ignore start — requires Windows, tested manually */
export function wakeViaWindowsAppActivate(sessionId, message) {
  const { PLATFORM, RESULTS_DIR } = cfg();
  if (PLATFORM !== "win32") return false;
  const scriptPath = join(RESULTS_DIR, `wake-${sessionId}-${Date.now()}.ps1`);
  const ps1 = `
param(
  [Parameter(Mandatory=$true)][string]$WindowHint,
  [Parameter(Mandatory=$true)][string]$Message
)
$ErrorActionPreference = 'Stop'
$wshell = New-Object -ComObject WScript.Shell
if (-not $wshell.AppActivate($WindowHint)) { exit 1 }
Start-Sleep -Milliseconds 200
$Message = $Message -replace '[\\r\\n]', ' '
$escaped = New-Object System.Text.StringBuilder
foreach ($ch in $Message.ToCharArray()) {
  switch ($ch) {
    '{' { [void]$escaped.Append('{{}'); continue }
    '}' { [void]$escaped.Append('{}}'); continue }
    '+' { [void]$escaped.Append('{+}'); continue }
    '^' { [void]$escaped.Append('{^}'); continue }
    '%' { [void]$escaped.Append('{%}'); continue }
    '~' { [void]$escaped.Append('{~}'); continue }
    '(' { [void]$escaped.Append('{(}'); continue }
    ')' { [void]$escaped.Append('{)}'); continue }
    '[' { [void]$escaped.Append('{[}'); continue }
    ']' { [void]$escaped.Append('{]}'); continue }
    default { [void]$escaped.Append($ch) }
  }
}
$wshell.SendKeys($escaped.ToString())
$wshell.SendKeys('{ENTER}')
exit 0
`.trim();
  try {
    writeFileSecure(scriptPath, ps1);
    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-WindowHint",
        `claude-${sessionId}`,
        "-Message",
        message,
      ],
      { stdio: "ignore", timeout: 8000 },
    );
    return result.status === 0;
  } catch {
    return false;
  } finally {
    try {
      if (existsSync(scriptPath)) unlinkSync(scriptPath);
    } catch {}
  }
}

/* c8 ignore stop */

/**
 * Handle coord_wake_session tool call. Cross-platform with fallback chain.
 * Terminal wake always sends Enter only; message content goes via inbox.
 * @param {object} args - { session_id, message }
 * @returns {object} MCP text response
 */
export function handleWakeSession(args) {
  const { PLATFORM, TERMINALS_DIR, INBOX_DIR } = cfg();
  const session_id = sanitizeShortSessionId(args.session_id);
  const message = String(args.message || "").trim();
  if (!message) return text("Message is required.");
  const wakeText = selectWakeText(message);
  const wakeModeNote = " (safe mode: sent Enter only)";
  assertMessageBudget(message);
  enforceMessageRateLimit(session_id);
  const sessionFile = join(TERMINALS_DIR, `session-${session_id}.json`);
  if (!existsSync(sessionFile)) return text(`Session ${session_id} not found.`);
  const sessionData = readJSON(sessionFile);
  const targetTTY = sessionData?.tty;

  // Linux: TTY write
  if (PLATFORM === "linux" && targetTTY && wakeViaTTY(targetTTY, wakeText)) {
    return text(
      `Woke ${session_id} via TTY write (${targetTTY})${wakeModeNote}.\nMessage: "${message}"`,
    );
  }
  // Windows: AppActivate
  if (PLATFORM === "win32" && wakeViaWindowsAppActivate(session_id, wakeText)) {
    return text(
      `Woke ${session_id} via Windows AppActivate${wakeModeNote}.\nMessage: "${message}"`,
    );
  }

  // Non-macOS fallback
  if (PLATFORM !== "darwin") {
    const inboxFile = join(INBOX_DIR, `${session_id}.jsonl`);
    appendJSONLineSecure(inboxFile, {
      ts: new Date().toISOString(),
      from: "lead",
      priority: "urgent",
      content: `[WAKE] ${message}`,
    });
    return text(
      `Platform: ${PLATFORM} \u2014 AppleScript not available.\n` +
        `Sent URGENT inbox message instead. Session will receive it on next tool call.\n` +
        `Message: "${message}"\n\n` +
        `If the session is idle (not making tool calls), send a message via coord_send_message instead.`,
    );
  }

  /* c8 ignore start — macOS AppleScript, requires osascript */
  // macOS: AppleScript
  try {
    const escapedMessage = wakeText
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n");
    const termApp = getTerminalApp();
    let appleScript;

    if (termApp === "iTerm2" && targetTTY) {
      appleScript = `
tell application "iTerm2"
  set found to false
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${targetTTY}" then
          select t
          tell s to write text "${escapedMessage}" newline NO
          delay 0.3
          tell s to write text ""
          set found to true
          exit repeat
        end if
      end repeat
      if found then exit repeat
    end repeat
    if found then exit repeat
  end repeat
  return found
end tell`.trim();
    } else if (termApp === "iTerm2") {
      appleScript = `
tell application "iTerm2"
  set found to false
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if name of s contains "claude-${session_id}" then
          select t
          tell s to write text "${escapedMessage}" newline NO
          delay 0.3
          tell s to write text ""
          set found to true
          exit repeat
        end if
      end repeat
      if found then exit repeat
    end repeat
    if found then exit repeat
  end repeat
  return found
end tell`.trim();
    } else {
      appleScript = `
tell application "Terminal"
  set found to false
  repeat with w in windows
    repeat with t in tabs of w
      if name of t contains "claude-${session_id}" then
        set selected of t to true
        set frontmost of w to true
        set found to true
        exit repeat
      end if
    end repeat
    if found then exit repeat
  end repeat
end tell
delay 0.5
if found then
  tell application "System Events"
    keystroke "${escapedMessage}"
    keystroke return
  end tell
end if
return found`.trim();
    }

    const result = execFileSync("osascript", ["-e", appleScript], {
      timeout: 10000,
      encoding: "utf-8",
    }).trim();

    if (result === "true") {
      return text(
        `Woke ${session_id} via ${termApp}${targetTTY ? ` (${targetTTY})` : ""}${wakeModeNote}.\nMessage: "${message}"`,
      );
    }

    // Fallback to inbox
    const inboxFile = join(INBOX_DIR, `${session_id}.jsonl`);
    appendJSONLineSecure(inboxFile, {
      ts: new Date().toISOString(),
      from: "lead",
      priority: "urgent",
      content: `[WAKE] ${message}`,
    });
    return text(
      `Could not find session in ${termApp}. Sent inbox message as fallback.\nSend a message via coord_send_message instead.`,
    );
  } catch (err) {
    const inboxFile = join(INBOX_DIR, `${session_id}.jsonl`);
    appendJSONLineSecure(inboxFile, {
      ts: new Date().toISOString(),
      from: "lead",
      priority: "urgent",
      content: `[WAKE] ${message}`,
    });
    return text(
      `AppleScript failed: ${err.message}\nSent inbox message as fallback.`,
    );
  }
  /* c8 ignore stop */
}
