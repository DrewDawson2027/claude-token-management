/**
 * Cross-platform utilities: terminal detection, process management, launch commands.
 * @module platform/common
 */

import {
  existsSync,
  openSync,
  writeFileSync,
  closeSync,
  readFileSync,
} from "fs";
import { spawn, spawnSync, execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { cfg } from "../constants.js";
import { shellQuote } from "../helpers.js";

const AUTOCLAIM_SCRIPT = fileURLToPath(
  new URL("../../scripts/claim-next-task.mjs", import.meta.url),
);
const OUTPUT_FORWARDER = fileURLToPath(
  new URL("./output-forwarder.js", import.meta.url),
);
const AUTOCLAIM_NODE = process.execPath || "node";

function buildAutoClaimPayload(opts = {}) {
  const teamName = String(opts.teamName || "").trim();
  const assignee = String(opts.workerName || "").trim();
  if (!teamName || !assignee) return null;
  const payload = {
    team_name: teamName,
    assignee,
    completed_worker_task_id: opts.taskId,
    directory: opts.defaultDirectory || opts.workDir,
    mode: opts.mode,
    runtime: opts.runtime,
    layout: opts.layout,
    notify_session_id: opts.leadSessionId,
    parent_session_id: opts.parentSessionId,
    model: opts.model,
    agent: opts.agent,
    role: opts.role,
    permission_mode: opts.permissionMode,
    context_level: opts.contextLevel,
    budget_policy: opts.budgetPolicy,
    budget_tokens: opts.budgetTokens,
    global_budget_policy: opts.globalBudgetPolicy,
    global_budget_tokens: opts.globalBudgetTokens,
    max_active_workers: opts.maxActiveWorkers,
    require_plan: opts.requirePlan,
    max_turns: opts.maxTurns,
    context_summary: opts.contextSummary,
  };
  if (typeof opts.isolate === "boolean") payload.isolate = opts.isolate;
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => {
      if (value === undefined || value === null) return false;
      if (typeof value === "string") return value.trim() !== "";
      return true;
    }),
  );
}

function buildAutoClaimEnvExports(opts = {}) {
  const payload = buildAutoClaimPayload(opts);
  if (!payload) return [];
  return [
    `export CLAUDE_AUTOCLAIM_NODE=${shellQuote(AUTOCLAIM_NODE)}`,
    `export CLAUDE_AUTOCLAIM_SCRIPT=${shellQuote(AUTOCLAIM_SCRIPT)}`,
    `export CLAUDE_AUTOCLAIM_ARGS_B64=${shellQuote(Buffer.from(JSON.stringify(payload), "utf8").toString("base64"))}`,
  ];
}

function autoClaimShellCommand() {
  return '([ -n "${CLAUDE_AUTOCLAIM_ARGS_B64:-}" ] && "$CLAUDE_AUTOCLAIM_NODE" "$CLAUDE_AUTOCLAIM_SCRIPT" >/dev/null 2>&1) || true';
}

function buildParentSessionEnvExports(parentSessionId = "") {
  const normalized = String(parentSessionId || "").trim();
  if (!normalized) return [];
  return [`export CLAUDE_PARENT_SESSION_ID=${shellQuote(normalized)}`];
}

function buildParentSessionSetup(qClaudeBin) {
  return [
    'CLAUDE_PARENT_ARG=""',
    `if [ -n "\${CLAUDE_PARENT_SESSION_ID:-}" ]; then _CLAUDE_HELP=$(${qClaudeBin} --help 2>&1 || true); case "$_CLAUDE_HELP" in *--parent-session-id*) CLAUDE_PARENT_ARG="--parent-session-id $CLAUDE_PARENT_SESSION_ID" ;; esac; fi`,
  ].join(" && ");
}

/**
 * Detect if we're running inside a tmux session.
 * @returns {boolean}
 */
export function isInsideTmux() {
  return Boolean(process.env.TMUX);
}

/**
 * Get the current tmux pane ID.
 * @returns {string|null} e.g. "%5"
 */
export function getCurrentTmuxPane() {
  if (!isInsideTmux()) return null;
  try {
    const result = spawnSync("tmux", ["display-message", "-p", "#{pane_id}"], {
      encoding: "utf-8",
      timeout: 3000,
    });
    const paneId = (result.stdout || "").trim();
    if (result.status === 0 && paneId.startsWith("%")) return paneId;
  } catch {
    // Fall back to env var if tmux command is unavailable.
  }
  const envPane = String(process.env.TMUX_PANE || "").trim();
  return envPane.startsWith("%") ? envPane : null;
}

/**
 * Spawn a worker in a new tmux pane (split from current window).
 * Returns the new pane's ID for message injection via send-keys.
 * @param {string} script - Shell command to run in the pane
 * @returns {{ paneId: string, app: string }} Pane ID and app name
 */
export function spawnTmuxPaneWorker(script) {
  // split-window prints the new pane's ID via -P/-F
  const result = spawnSync(
    "tmux",
    [
      "split-window",
      "-h", // horizontal split (side-by-side) — matches native Agent Teams layout
      "-d", // don't switch focus to new pane
      "-P",
      "-F",
      "#{pane_id}", // print new pane ID
      script,
    ],
    { encoding: "utf-8", timeout: 10000 },
  );

  if (result.status !== 0) {
    throw new Error(
      `tmux split-window failed: ${(result.stderr || "").trim()}`,
    );
  }

  const paneId = (result.stdout || "").trim();
  if (!paneId.startsWith("%")) {
    throw new Error(`tmux split-window returned unexpected pane ID: ${paneId}`);
  }

  return { paneId, app: "tmux" };
}

/**
 * Send keys to a tmux pane — push-delivers a message as user input.
 * This is how native Agent Teams delivers messages: injecting text into the
 * teammate's terminal so Claude sees it as a new conversation turn.
 * @param {string} paneId - tmux pane ID (e.g. "%5")
 * @param {string} text - Text to inject
 * @returns {boolean} Whether send succeeded
 */
export function tmuxSendKeys(paneId, text) {
  if (!paneId || !isInsideTmux()) return false;
  try {
    const payload = String(text || "")
      .replace(/[\r\n]+/g, " ")
      .trim();
    if (!payload) return false;
    const result = spawnSync(
      "tmux",
      ["send-keys", "-t", paneId, payload, "Enter"],
      { stdio: "ignore", timeout: 5000 },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Check if a tmux pane still exists.
 * @param {string} paneId - tmux pane ID
 * @returns {boolean}
 */
export function isTmuxPaneAlive(paneId) {
  if (!paneId || !isInsideTmux()) return false;
  try {
    const result = spawnSync("tmux", ["list-panes", "-F", "#{pane_id}"], {
      encoding: "utf-8",
      timeout: 3000,
    });
    return (result.stdout || "").includes(paneId);
  } catch {
    return false;
  }
}

/**
 * Send a status-bar notification to the lead's tmux pane.
 * Uses display-message (no stdin injection) targeted at the lead's specific pane.
 * Safe no-op if tmux is unavailable, pane ID is missing or invalid.
 * @param {string} leadPaneId - Lead's tmux pane ID (e.g. "%5")
 * @param {string} message - Message to display (truncated to 200 chars)
 * @returns {boolean} Whether the notification was sent successfully
 */
export function sendMessageToLead(leadPaneId, message) {
  if (!leadPaneId || !String(leadPaneId).startsWith("%") || !isInsideTmux()) {
    return false;
  }
  try {
    const result = spawnSync(
      "tmux",
      [
        "display-message",
        "-t",
        leadPaneId,
        "-d",
        "4000",
        String(message || "").slice(0, 200),
      ],
      { stdio: "ignore", timeout: 3000 },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Detect which terminal emulator is running.
 * @returns {string} Terminal app name or "none"/"background"
 */
export function getTerminalApp() {
  const { PLATFORM } = cfg();
  if (PLATFORM === "darwin") {
    // cmux check first — detect by running process, not socket auth.
    // `cmux identify` requires socket auth (process lineage), which fails
    // when Claude is launched from iTerm2. pgrep bypasses this entirely.
    try {
      const cmuxRunning = spawnSync("pgrep", ["-f", "/Applications/cmux.app"], {
        stdio: "ignore",
        timeout: 1500,
      });
      if (cmuxRunning.status === 0) return "cmux";
    } catch {
      // cmux not installed or not running — fall through
    }
    // Env var check is more reliable than pgrep on macOS Sequoia (Darwin 25+)
    // where pgrep -x iTerm2 fails to match despite iTerm2 running.
    if (process.env.ITERM_SESSION_ID || process.env.TERM_PROGRAM === "iTerm.app") {
      return "iTerm2";
    }
    if (spawnSync("pgrep", ["-x", "iTerm2"], { stdio: "ignore" }).status === 0)
      return "iTerm2";
    if (
      spawnSync("pgrep", ["-x", "Terminal"], { stdio: "ignore" }).status === 0
    )
      return "Terminal";
    return "none";
  } else if (PLATFORM === "win32") {
    try {
      const wt = execFileSync(
        "tasklist",
        ["/FI", "IMAGENAME eq WindowsTerminal.exe", "/NH"],
        { encoding: "utf-8" },
      );
      if (wt.toLowerCase().includes("windowsterminal"))
        return "WindowsTerminal";
    } catch {}
    try {
      const ps = execFileSync(
        "tasklist",
        ["/FI", "IMAGENAME eq powershell.exe", "/NH"],
        { encoding: "utf-8" },
      );
      if (ps.toLowerCase().includes("powershell")) return "PowerShell";
    } catch {}
    return "cmd";
  } else {
    for (const app of [
      "gnome-terminal",
      "konsole",
      "alacritty",
      "kitty",
      "xterm",
    ]) {
      if (spawnSync("pgrep", ["-x", app], { stdio: "ignore" }).status === 0)
        return app;
    }
    return "none";
  }
}

/**
 * Build a platform-specific terminal launch command.
 * @param {string} platformName - OS platform
 * @param {string} termApp - Detected terminal app
 * @param {string} command - Shell command to run
 * @param {string} layout - "tab" or "split"
 * @returns {{ command: string, args: string[], app: string, detached?: boolean }}
 */
export function buildPlatformLaunchCommand(
  platformName,
  termApp,
  command,
  layout = "tab",
) {
  if (platformName === "darwin") {
    if (termApp === "iTerm2") {
      const splitScript = [
        'tell application "iTerm2"',
        'tell current session of current window',
        `set newSession to (split vertically with default profile command ${JSON.stringify(command)})`,
        "end tell",
        "end tell",
      ];
      const tabScript = [
        'tell application "iTerm2"',
        'tell current window',
        `set newTab to (create tab with default profile command ${JSON.stringify(command)})`,
        "end tell",
        "end tell",
      ];
      return {
        command: "osascript",
        args: (layout === "split" ? splitScript : tabScript).flatMap((line) => [
          "-e",
          line,
        ]),
        app: "iTerm2",
      };
    }
    if (termApp === "cmux") {
      // cmux socket auth blocks direct CLI calls from outside cmux.
      // `open -a cmux --args` uses macOS Launch Services, bypassing socket auth.
      const cmuxArgs =
        layout === "split"
          ? ["-a", "cmux", "--args", "new-split", "down", "--command", command]
          : ["-a", "cmux", "--args", "new-workspace", "--command", command];
      return { command: "open", args: cmuxArgs, app: "cmux" };
    }
    if (termApp === "Terminal") {
      return {
        command: "osascript",
        args: [
          "-e",
          `tell application "Terminal" to do script ${JSON.stringify(command)}`,
        ],
        app: "Terminal",
      };
    }
    return {
      command: "bash",
      args: ["-lc", command],
      detached: true,
      app: "background",
    };
  }

  if (platformName === "win32") {
    if (termApp === "WindowsTerminal") {
      const base =
        layout === "split"
          ? ["-w", "0", "sp", "-V", "cmd", "/c", command]
          : ["-w", "0", "nt", "cmd", "/c", command];
      return { command: "wt", args: base, app: "WindowsTerminal" };
    }
    return {
      command: "cmd",
      args: ["/c", "start", "", "cmd", "/c", command],
      app: "cmd",
    };
  }

  // Linux
  if (termApp === "gnome-terminal")
    return {
      command: "gnome-terminal",
      args: ["--", "bash", "-c", command],
      app: "gnome-terminal",
    };
  if (termApp === "konsole")
    return {
      command: "konsole",
      args: ["-e", "bash", "-c", command],
      app: "konsole",
    };
  if (termApp === "alacritty")
    return {
      command: "alacritty",
      args: ["-e", "bash", "-c", command],
      app: "alacritty",
    };
  if (termApp === "kitty") {
    return {
      command: "kitty",
      args:
        layout === "split"
          ? ["@", "launch", "--location=vsplit", "bash", "-c", command]
          : ["@", "launch", "--type=tab", "bash", "-c", command],
      app: "kitty",
    };
  }
  return {
    command: "bash",
    args: ["-lc", command],
    detached: true,
    app: "background",
  };
}

function renderAppleScriptArgs(lines) {
  return lines.flatMap((line) => ["-e", line]);
}

/**
 * Build an iTerm AppleScript that creates a visible worker session by launching a
 * short bootstrap command as the session's profile command.
 * @param {string} command - Bootstrap command to run as the session command
 * @param {string} layout - "tab" or "split"
 * @param {{ dedicatedWindow?: boolean }} [options]
 * @returns {string[]} AppleScript lines
 */
export function buildItermProfileCommandLaunchScript(
  command,
  layout = "tab",
  options = {},
) {
  const dedicatedWindow = options.dedicatedWindow === true;
  const createSessionLines = dedicatedWindow
    ? [
        `set newWindow to (create window with default profile command ${JSON.stringify(command)})`,
        "set newSession to current session of current tab of newWindow",
      ]
    : [
        'if (count of windows) is 0 then',
        'set bootstrapWindow to (create window with default profile)',
        "end if",
        'set targetWindow to current window',
        ...(layout === "split"
          ? [
              "tell current session of targetWindow",
              `set newSession to (split vertically with default profile command ${JSON.stringify(command)})`,
              "end tell",
            ]
          : [
              "tell targetWindow",
              `set newTab to (create tab with default profile command ${JSON.stringify(command)})`,
              "set newSession to current session of newTab",
              "end tell",
            ]),
      ];

  return [
    'tell application "iTerm2"',
    "activate",
    ...createSessionLines,
    "tell newSession to select",
    'set newTty to ""',
    "repeat 100 times",
    "try",
    "set newTty to tty of newSession",
    'if newTty is not "" then exit repeat',
    "end try",
    "delay 0.1",
    "end repeat",
    'if newTty is "" then error "new iTerm session never exposed a tty"',
    'return "OK\\t" & newTty',
    "end tell",
  ];
}

/**
 * Open a new terminal pane/tab with a command.
 * Falls back to headless background process if no terminal is detected.
 * @param {string} command - Shell command
 * @param {string} layout - "tab" or "split"
 * @returns {{ app: string, launchError: string|null, fallbackReason: string|null }}
 */
export function openTerminalWithCommandDetailed(command, layout = "tab") {
  const { TEST_MODE, PLATFORM } = cfg();
  if (
    process.env.COORDINATOR_FORCE_TERMINAL_LAUNCH_FAIL === "1" &&
    layout !== "background"
  ) {
    const shellCmd = PLATFORM === "win32" ? "cmd" : "bash";
    const shellFlag = PLATFORM === "win32" ? "/c" : "-lc";
    const child = spawn(shellCmd, [shellFlag, command], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return {
      app: "headless-background",
      launchError: "forced terminal launch failure",
      fallbackReason: "terminal launch failed before worker handshake",
    };
  }
  if (TEST_MODE) {
    if (
      process.env.COORDINATOR_FAKE_VISIBLE_LAUNCH_NOOP === "1" &&
      layout !== "background"
    ) {
      return {
        app: PLATFORM === "darwin" ? "iTerm2" : "test-visible-launch",
        launchError: null,
        fallbackReason: null,
      };
    }
    if (PLATFORM === "win32") {
      return {
        app: "test-background-win32",
        launchError: null,
        fallbackReason: null,
      };
    }
    const child = spawn("bash", ["-lc", command], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return {
      app: PLATFORM === "win32" ? "test-background-win32" : "test-background",
      launchError: null,
      fallbackReason: null,
    };
  }

  const termApp = getTerminalApp();
  const launch = buildPlatformLaunchCommand(PLATFORM, termApp, command, layout);
  if (launch.detached) {
    const child = spawn(launch.command, launch.args || [], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { app: launch.app, launchError: null, fallbackReason: null };
  } else {
    const res = spawnSync(launch.command, launch.args || [], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (res.status !== 0) {
      // Headless fallback: if terminal launch fails, run as background process
      const shellCmd = PLATFORM === "win32" ? "cmd" : "bash";
      const shellFlag = PLATFORM === "win32" ? "/c" : "-lc";
      const child = spawn(shellCmd, [shellFlag, command], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      const launchError =
        String(res.stderr || res.stdout || "").trim() ||
        `${launch.app} launch exited with status ${res.status}`;
      return {
        app: "headless-background",
        launchError,
        fallbackReason: `${launch.app} launch failed; fell back to background`,
      };
    }
  }
  return { app: launch.app, launchError: null, fallbackReason: null };
}

/**
 * Open a visible worker terminal using the session's profile command. The caller
 * owns any background fallback behavior.
 * @param {string} command - Bootstrap command to run in the visible session
 * @param {string} layout - "tab" or "split"
 * @returns {{ app: string, launchError: string|null, fallbackReason: string|null, launchMethod: string|null, targetTTY: string|null }}
 */
export function openVisibleWorkerTerminalDetailed(command, layout = "tab") {
  const { TEST_MODE, PLATFORM } = cfg();
  const termApp = PLATFORM === "darwin" ? getTerminalApp() : null;
  const forceBootstrapFail =
    process.env.COORDINATOR_FORCE_ITERM_BOOTSTRAP_FAIL === "1" ||
    process.env.COORDINATOR_FORCE_ITERM_WRITE_TEXT_FAIL === "1";
  const dedicatedWindow =
    process.env.COORDINATOR_VISIBLE_SMOKE_WINDOW === "1";

  if (TEST_MODE) {
    if (forceBootstrapFail && layout !== "background") {
      return {
        app: PLATFORM === "darwin" ? "iTerm2" : "test-visible-launch",
        launchError: "forced iTerm bootstrap failure",
        fallbackReason: "visible bootstrap launch failed",
        launchMethod:
          PLATFORM === "darwin"
            ? "iterm_profile_command_bootstrap"
            : "test-visible-launch",
        targetTTY: null,
      };
    }
    if (
      process.env.COORDINATOR_FAKE_VISIBLE_LAUNCH_NOOP === "1" &&
      layout !== "background"
    ) {
      return {
        app: PLATFORM === "darwin" ? "iTerm2" : "test-visible-launch",
        launchError: null,
        fallbackReason: null,
        launchMethod:
          PLATFORM === "darwin"
            ? "iterm_profile_command_bootstrap"
            : "test-visible-launch",
        targetTTY: null,
      };
    }
    if (PLATFORM !== "win32") {
      const child = spawn("bash", ["-lc", command], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }
    return {
      app: PLATFORM === "darwin" ? "iTerm2" : "test-visible-launch",
      launchError: null,
      fallbackReason: null,
      launchMethod:
        PLATFORM === "darwin"
          ? "iterm_profile_command_bootstrap"
          : "test-visible-launch",
      targetTTY: null,
    };
  }

  if (
    process.env.COORDINATOR_FORCE_TERMINAL_LAUNCH_FAIL === "1" &&
    layout !== "background"
  ) {
    return {
      app: termApp || "visible-terminal",
      launchError: "forced terminal launch failure",
      fallbackReason: "visible terminal launch failed before startup handshake",
      launchMethod:
        termApp === "iTerm2"
          ? "iterm_profile_command_bootstrap"
          : "terminal_command",
      targetTTY: null,
    };
  }

  if (
    PLATFORM === "darwin" &&
    termApp === "iTerm2" &&
    layout !== "background"
  ) {
    if (forceBootstrapFail) {
      return {
        app: "iTerm2",
        launchError: "forced iTerm bootstrap failure",
        fallbackReason: "visible bootstrap launch failed",
        launchMethod: "iterm_profile_command_bootstrap",
        targetTTY: null,
      };
    }
    const res = spawnSync(
      "osascript",
      renderAppleScriptArgs(
        buildItermProfileCommandLaunchScript(command, layout, {
          dedicatedWindow,
        }),
      ),
      { encoding: "utf-8", timeout: 12000 },
    );
    const stdout = String(res.stdout || "").trim();
    if (res.status !== 0) {
      return {
        app: "iTerm2",
        launchError:
          String(res.stderr || stdout).trim() ||
          `iTerm2 launch exited with status ${res.status}`,
        fallbackReason: "iTerm2 visible launch failed before startup handshake",
        launchMethod: "iterm_profile_command_bootstrap",
        targetTTY: null,
      };
    }
    const [, targetTTY = ""] = stdout.split("\t");
    if (!stdout.startsWith("OK\t")) {
      return {
        app: "iTerm2",
        launchError: stdout || "iTerm2 did not confirm visible session readiness",
        fallbackReason: "iTerm2 visible launch failed before startup handshake",
        launchMethod: "iterm_profile_command_bootstrap",
        targetTTY: null,
      };
    }
    return {
      app: "iTerm2",
      launchError: null,
      fallbackReason: null,
      launchMethod: "iterm_profile_command_bootstrap",
      targetTTY: targetTTY || null,
    };
  }

  if (
    PLATFORM === "darwin" &&
    termApp === "cmux" &&
    layout !== "background"
  ) {
    // cmux launch via `open -a cmux --args` to bypass socket auth.
    // Direct `cmux new-workspace` fails from iTerm2 (socket lineage check).
    // targetTTY is unavailable — worker runs visibly but without socket streaming.
    const res = spawnSync("open", ["-a", "cmux", "--args", "new-workspace", "--command", command], {
      encoding: "utf-8",
    });
    if (res.status !== 0) {
      return {
        app: "cmux",
        launchError:
          String(res.stderr || "").trim() ||
          `cmux launch exited with status ${res.status}`,
        fallbackReason: "cmux visible launch failed",
        launchMethod: "cmux_new_workspace",
        targetTTY: null,
      };
    }
    return {
      app: "cmux",
      launchError: null,
      fallbackReason: null,
      launchMethod: "cmux_new_workspace",
      targetTTY: null,
    };
  }

  if (PLATFORM === "darwin" && layout !== "background" && termApp === "none") {
    return {
      app: "none",
      launchError: "no visible terminal app detected",
      fallbackReason: "no visible terminal app available for split/tab launch",
      launchMethod: null,
      targetTTY: null,
    };
  }

  const fallbackLaunch = openTerminalWithCommandDetailed(command, layout);
  return {
    ...fallbackLaunch,
    launchMethod:
      fallbackLaunch.app === "Terminal"
        ? "terminal_do_script"
        : fallbackLaunch.app === "background" ||
            fallbackLaunch.app === "headless-background"
          ? "background_shell"
          : "terminal_command",
    targetTTY: null,
  };
}

/**
 * Backward-compatible wrapper for callers that only need the app/backend label.
 * @param {string} command - Shell command
 * @param {string} layout - "tab" or "split"
 * @returns {string}
 */
export function openTerminalWithCommand(command, layout = "tab") {
  return openTerminalWithCommandDetailed(command, layout).app;
}

/**
 * Spawn a worker as a background process (no terminal).
 * Fastest spawn mode — eliminates all terminal overhead.
 * @param {string} script - Shell script to execute
 * @param {string} resultFile - Path for stdout/stderr capture
 * @param {string} pidFile - Path to write child PID
 */
export function spawnBackgroundWorker(script, resultFile, pidFile) {
  const { PLATFORM } = cfg();
  const out = openSync(resultFile, "a");
  const child =
    PLATFORM === "win32"
      ? spawn("cmd", ["/c", script], {
          detached: true,
          stdio: ["ignore", out, out],
        })
      : spawn("sh", ["-c", script], {
          detached: true,
          stdio: ["ignore", out, out],
        });
  writeFileSync(pidFile, String(child.pid));
  child.unref();
  closeSync(out);
}

/**
 * Spawn a worker launcher file as a detached background process.
 * @param {string} launcherFile - Executable shell script to run
 * @param {string} resultFile - Path for stdout/stderr capture
 * @param {string} pidFile - Path to write child PID
 */
export function spawnBackgroundLauncher(launcherFile, resultFile, pidFile) {
  const { PLATFORM } = cfg();
  const out = openSync(resultFile, "a");
  const child =
    PLATFORM === "win32"
      ? spawn("cmd", ["/c", launcherFile], {
          detached: true,
          stdio: ["ignore", out, out],
        })
      : spawn("/bin/sh", [launcherFile], {
          detached: true,
          stdio: ["ignore", out, out],
        });
  writeFileSync(pidFile, String(child.pid));
  child.unref();
  closeSync(out);
}

/**
 * Check if a process is alive. Cross-platform.
 * @param {string|number} pid - Process ID
 * @returns {boolean} Whether the process is running
 */
export function isProcessAlive(pid) {
  const { PLATFORM } = cfg();
  const pidNum = Number(pid);
  if (!Number.isInteger(pidNum) || pidNum <= 0) return false;
  try {
    if (PLATFORM === "win32") {
      const output = execFileSync(
        "tasklist",
        ["/FI", `PID eq ${pidNum}`, "/NH"],
        { encoding: "utf-8" },
      );
      if (!output.includes(String(pidNum))) return false;
    } else {
      process.kill(pidNum, 0);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a process. Cross-platform.
 * @param {string|number} pid - Process ID
 */
export function killProcess(pid) {
  const { PLATFORM } = cfg();
  const pidNum = Number(pid);
  if (!Number.isInteger(pidNum) || pidNum <= 0) throw new Error("Invalid PID.");
  if (PLATFORM === "win32") {
    execFileSync("taskkill", ["/PID", String(pidNum), "/T", "/F"], {
      stdio: "ignore",
    });
  } else {
    try {
      process.kill(-pidNum, "SIGTERM");
    } catch {
      process.kill(pidNum, "SIGTERM");
    }
  }
}

/**
 * Validate a TTY path is safe (no path traversal).
 * @param {string} pathValue - TTY path
 * @returns {boolean} Whether the path is a valid TTY
 */
export function isSafeTTYPath(pathValue) {
  const tty = String(pathValue || "").trim();
  return /^\/dev\/(?:ttys?\d+|pts\/\d+)$/.test(tty);
}

export function buildInteractiveWorkerScript(opts) {
  const { PLATFORM, SETTINGS_FILE, WORKER_SETTINGS_FILE, CLAUDE_BIN } = cfg();
  const { taskId, workDir, pidFile, metaFile, model, agent, promptFile } = opts;
  const workerName = opts.workerName || "";
  const maxTurns = opts.maxTurns || "";
  const permissionMode = opts.permissionMode || "acceptEdits";
  const platformName = opts.platformName ?? PLATFORM;
  const teamName = opts.teamName || "";
  const mode = opts.mode || "interactive";
  const runtime = opts.runtime || "claude";
  const layout = opts.layout || "background";
  const defaultDirectory = opts.defaultDirectory || workDir;
  const role = opts.role || "";
  const contextLevel = opts.contextLevel || "";
  const budgetPolicy = opts.budgetPolicy || "";
  const budgetTokens = opts.budgetTokens;
  const globalBudgetPolicy = opts.globalBudgetPolicy || "";
  const globalBudgetTokens = opts.globalBudgetTokens;
  const maxActiveWorkers = opts.maxActiveWorkers;
  const requirePlan = opts.requirePlan;
  const contextSummary = opts.contextSummary || "";
  const sessionId = opts.sessionId || "";
  const leadSessionId = opts.leadSessionId || "";
  const leadPaneId = opts.leadPaneId || "";
  const parentSessionId = opts.parentSessionId || "";

  if (platformName === "win32") {
    return buildWorkerScript(opts);
  }

  const qDir = shellQuote(workDir);
  const qPid = shellQuote(pidFile);
  const qPrompt = shellQuote(promptFile);
  const qMetaDone = shellQuote(`${metaFile}.done`);
  const qModel = shellQuote(model);
  const qClaudeBin = shellQuote(CLAUDE_BIN);
  const agentArgs = agent ? `--agent ${shellQuote(agent)}` : "";
  const workerSettingsFile = existsSync(WORKER_SETTINGS_FILE)
    ? WORKER_SETTINGS_FILE
    : SETTINGS_FILE;
  const settingsArgs = existsSync(workerSettingsFile)
    ? `--settings ${shellQuote(workerSettingsFile)}`
    : "";

  const envExports = [
    ...buildAutoClaimEnvExports({
      taskId,
      workDir,
      defaultDirectory,
      teamName,
      workerName: workerName || taskId,
      mode,
      runtime,
      layout,
      leadSessionId,
      parentSessionId,
      model,
      agent,
      role,
      permissionMode,
      contextLevel,
      budgetPolicy,
      budgetTokens,
      globalBudgetPolicy,
      globalBudgetTokens,
      maxActiveWorkers,
      requirePlan,
      maxTurns,
      contextSummary,
      isolate: opts.isolate,
    }),
    ...buildParentSessionEnvExports(parentSessionId),
    `export CLAUDE_WORKER_TASK_ID=${shellQuote(taskId)}`,
    workerName ? `export CLAUDE_WORKER_NAME=${shellQuote(workerName)}` : "",
    maxTurns
      ? `export CLAUDE_WORKER_MAX_TURNS=${shellQuote(String(maxTurns))}`
      : "",
    permissionMode && permissionMode !== "acceptEdits"
      ? `export CLAUDE_WORKER_PERMISSION_MODE=${shellQuote(permissionMode)}`
      : "",
    leadSessionId
      ? `export CLAUDE_LEAD_SESSION_ID=${shellQuote(leadSessionId)}`
      : "",
    leadPaneId ? `export CLAUDE_LEAD_PANE_ID=${shellQuote(leadPaneId)}` : "",
  ]
    .filter(Boolean)
    .join(" && ");

  const transcriptFile = opts.resultFile.replace(/\.txt$/, ".transcript");
  const qTranscript = shellQuote(transcriptFile);
  const isLinux = platformName === "linux";
  const qPermMode = shellQuote(permissionMode);
  const sessionIdArg = sessionId ? `--session-id ${shellQuote(sessionId)}` : "";
  const parentSessionSetup = buildParentSessionSetup(qClaudeBin);
  const claudeCmd = `${qClaudeBin} --prompt "$WORKER_PROMPT" --permission-mode ${qPermMode} --model ${qModel} $CLAUDE_PARENT_ARG ${sessionIdArg} ${agentArgs} ${settingsArgs}`;
  const scriptWrapped = isLinux
    ? `script -q ${qTranscript} -c "${claudeCmd.replace(/"/g, '\\"')}"`
    : `script -q ${qTranscript} ${claudeCmd}`;

  const workerDisplay = workerName || taskId;
  // Completion commands run inside the loop body after each claude invocation exits.
  const completionCmds = [
    `printf '{"status":"completed","finished":"%s","task_id":"${taskId}"}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${qMetaDone}`,
    `rm -f ${qPid}`,
  ];
  // NOTE: tmux send-keys "[COMPLETED]" removed — it injects raw text as user input
  // into the lead's terminal, causing Claude to treat it as a user message and respond.
  // Inbox-only delivery (below) is the correct mechanism: controlled, session-scoped,
  // and surfaced by check-inbox.sh on the next tool call.
  if (leadSessionId) {
    completionCmds.push(
      `printf '{"ts":"%s","from":"coordinator","priority":"normal","content":"[COMPLETED] ${workerDisplay}"}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$HOME/.claude/terminals/inbox/$CLAUDE_LEAD_SESSION_ID.jsonl" 2>/dev/null || true`,
      // After writing to inbox, fire a targeted tmux status-bar notification to the
      // lead's specific pane. Uses CLAUDE_LEAD_PANE_ID (exported above) as the -t target
      // so the badge appears in the lead's window, not the worker's pane.
      `[ -n "$TMUX" ] && [ -n "$CLAUDE_LEAD_PANE_ID" ] && tmux display-message -t "$CLAUDE_LEAD_PANE_ID" -d 4000 "[${workerDisplay}] message waiting — check inbox" 2>/dev/null || true`,
    );
  }

  // Claim-next block: runs at end of each loop iteration.
  // Uses --claim-only to get JSON task data without spawning a new process.
  // Empty output signals no more tasks — breaks the loop.
  const claimNextCmds = [
    '[ -n "${CLAUDE_AUTOCLAIM_ARGS_B64:-}" ] || break',
    '_CLAIM=$("$CLAUDE_AUTOCLAIM_NODE" "$CLAUDE_AUTOCLAIM_SCRIPT" --claim-only 2>/dev/null) || true',
    '[ -z "$_CLAIM" ] && break',
    `_TID=$("$CLAUDE_AUTOCLAIM_NODE" --input-type=commonjs -e "try{process.stdout.write(JSON.parse(process.argv[1]).task_id||'')}catch{}" "$_CLAIM" 2>/dev/null)`,
    '[ -z "$_TID" ] && break',
    `_NP=$("$CLAUDE_AUTOCLAIM_NODE" --input-type=commonjs -e "try{process.stdout.write(JSON.parse(process.argv[1]).prompt||'')}catch{}" "$_CLAIM" 2>/dev/null)`,
    `printf '%s' "$_NP" > ${qPrompt}`,
    'CLAUDE_WORKER_TASK_ID="$_TID" && export CLAUDE_WORKER_TASK_ID',
    `echo $$ > ${qPid}`,
  ].join("; ");

  // When bidir mode is active, append the messaging protocol to the worker prompt
  // so it knows how to reach the lead and recognise [L2W]: replies.
  const bidirNote = leadPaneId
    ? `WORKER_PROMPT=$(printf '%s\\nBIDIR: To message lead run Bash: tmux send-keys -t ${shellQuote(leadPaneId)} "[W2L:${taskId}]: msg" Enter. Replies arrive prefixed "[L2W]:".' "$WORKER_PROMPT")`
    : "";

  const loopBody = [
    `WORKER_PROMPT=$(cat ${qPrompt})`,
    bidirNote,
    `unset CLAUDECODE && ${scriptWrapped}`,
    ...completionCmds,
    claimNextCmds,
  ].filter(Boolean).join("; ");

  const persistentLoop = `while true; do ${loopBody}; done`;

  // EXIT trap is now cleanup-only — completion and claim-next run inside the loop body
  const exitTrapCmd = `trap '[ -n "\${_IDLE_PID:-}" ] && kill "$_IDLE_PID" 2>/dev/null || true' EXIT`;

  let idleDetectorCmd = null;
  if (leadSessionId && sessionId) {
    const sid8 = sessionId.slice(0, 8);
    idleDetectorCmd = [
      `(IDLE_SENT=false`,
      `while kill -0 $$ 2>/dev/null`,
      `do sleep 1`,
      `SF="$HOME/.claude/terminals/session-${sid8}.json"`,
      `[ ! -f "$SF" ] && continue`,
      `AGE=$(( $(date +%s) - $(stat -f %m "$SF" 2>/dev/null || stat -c %Y "$SF" 2>/dev/null || echo $(date +%s)) ))`,
      `if [ "$AGE" -gt 30 ] && [ "$IDLE_SENT" = false ]`,
      `then printf '{"ts":"%s","from":"idle-detector","priority":"normal","content":"[IDLE] ${workerDisplay} — no activity for '\''\${AGE}'\''s"}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$HOME/.claude/terminals/inbox/$CLAUDE_LEAD_SESSION_ID.jsonl" 2>/dev/null || true`,
      `IDLE_SENT=true`,
      `elif [ "$AGE" -le 30 ]`,
      `then IDLE_SENT=false`,
      `fi`,
      `done) & _IDLE_PID=$!`,
    ].join("; ");
  }

  return [
    `cd ${qDir}`,
    `echo $$ > ${qPid}`,
    envExports,
    parentSessionSetup,
    exitTrapCmd,
    idleDetectorCmd,
    persistentLoop,
  ]
    .filter(Boolean)
    .join(" && ");
}

/**
 * Build a resume script that continues a prior session using --resume.
 * @param {object} opts - Resume options
 * @param {string} opts.sessionId - Claude session ID to resume
 * @param {string} opts.workDir - Working directory
 * @param {string} opts.pidFile - PID file path
 * @param {string} opts.metaFile - Meta file path
 * @param {string} opts.taskId - Task ID
 * @param {string} [opts.leadSessionId] - Lead session ID for notifications
 * @param {string} [opts.leadPaneId] - Lead tmux pane ID for push notifications
 * @returns {string} Shell script string
 */
export function buildResumeWorkerScript(opts) {
  const { CLAUDE_BIN, SETTINGS_FILE, WORKER_SETTINGS_FILE } = cfg();
  const { sessionId, workDir, pidFile, metaFile, taskId } = opts;
  const leadSessionId = opts.leadSessionId || "";
  const leadPaneId = opts.leadPaneId || "";
  const workerName = opts.workerName || taskId;
  const teamName = opts.teamName || "";
  const defaultDirectory = opts.defaultDirectory || workDir;

  const qDir = shellQuote(workDir);
  const qPid = shellQuote(pidFile);
  const qMetaDone = shellQuote(`${metaFile}.done`);
  const qClaudeBin = shellQuote(CLAUDE_BIN);
  const qSessionId = shellQuote(sessionId);
  const workerSettingsFile = existsSync(WORKER_SETTINGS_FILE)
    ? WORKER_SETTINGS_FILE
    : SETTINGS_FILE;
  const settingsArgs = existsSync(workerSettingsFile)
    ? `--settings ${shellQuote(workerSettingsFile)}`
    : "";
  const parentSessionSetup = buildParentSessionSetup(qClaudeBin);

  const envExports = [
    ...buildAutoClaimEnvExports({
      taskId,
      workDir,
      defaultDirectory,
      teamName,
      workerName,
      mode: opts.mode || "interactive",
      runtime: opts.runtime || "claude",
      layout: opts.layout || "background",
      leadSessionId,
      parentSessionId: opts.parentSessionId,
      model: opts.model,
      agent: opts.agent,
      role: opts.role,
      permissionMode: opts.permissionMode,
      contextLevel: opts.contextLevel,
      budgetPolicy: opts.budgetPolicy,
      budgetTokens: opts.budgetTokens,
      globalBudgetPolicy: opts.globalBudgetPolicy,
      globalBudgetTokens: opts.globalBudgetTokens,
      maxActiveWorkers: opts.maxActiveWorkers,
      requirePlan: opts.requirePlan,
      maxTurns: opts.maxTurns,
      contextSummary: opts.contextSummary,
      isolate: opts.isolate,
    }),
    ...buildParentSessionEnvExports(opts.parentSessionId),
    `export CLAUDE_WORKER_TASK_ID=${shellQuote(taskId)}`,
    workerName ? `export CLAUDE_WORKER_NAME=${shellQuote(workerName)}` : "",
    leadSessionId
      ? `export CLAUDE_LEAD_SESSION_ID=${shellQuote(leadSessionId)}`
      : "",
    leadPaneId ? `export CLAUDE_LEAD_PANE_ID=${shellQuote(leadPaneId)}` : "",
  ]
    .filter(Boolean)
    .join(" && ");

  const trapParts = [
    `printf '{"status":"completed","finished":"%s","task_id":"${taskId}"}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${qMetaDone}`,
    `rm -f ${qPid}`,
  ];
  // NOTE: tmux send-keys "[COMPLETED]" removed from resume script — same fix as
  // buildInteractiveWorkerScript. It injects raw text as user input into the lead's
  // terminal, causing Claude to treat it as a user message. Inbox-only delivery below.
  if (leadSessionId) {
    trapParts.push(
      `printf '{"ts":"%s","from":"coordinator","priority":"normal","content":"[COMPLETED] ${workerName} (resumed)"}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$HOME/.claude/terminals/inbox/$CLAUDE_LEAD_SESSION_ID.jsonl" 2>/dev/null || true`,
      `[ -n "$TMUX" ] && [ -n "$CLAUDE_LEAD_PANE_ID" ] && tmux display-message -t "$CLAUDE_LEAD_PANE_ID" -d 4000 "[${workerName} (resumed)] message waiting — check inbox" 2>/dev/null || true`,
    );
  }
  trapParts.push(autoClaimShellCommand());
  trapParts.push(
    '[ -n "${_IDLE_PID:-}" ] && kill "$_IDLE_PID" 2>/dev/null || true',
  );
  const exitTrapCmd = `trap '${trapParts.join("; ")}' EXIT`;

  // Idle detector for resumed workers (same as interactive workers)
  let idleDetectorCmd = null;
  if (leadSessionId && sessionId) {
    const sid8 = sessionId.slice(0, 8);
    idleDetectorCmd = [
      `(IDLE_SENT=false`,
      `while kill -0 $$ 2>/dev/null`,
      `do sleep 1`,
      `SF="$HOME/.claude/terminals/session-${sid8}.json"`,
      `[ ! -f "$SF" ] && continue`,
      `AGE=$(( $(date +%s) - $(stat -f %m "$SF" 2>/dev/null || stat -c %Y "$SF" 2>/dev/null || echo $(date +%s)) ))`,
      `if [ "$AGE" -gt 30 ] && [ "$IDLE_SENT" = false ]`,
      `then printf '{"ts":"%s","from":"idle-detector","priority":"normal","content":"[IDLE] ${workerName} (resumed) — no activity for '\''\${AGE}'\''s"}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$HOME/.claude/terminals/inbox/$CLAUDE_LEAD_SESSION_ID.jsonl" 2>/dev/null || true`,
      `IDLE_SENT=true`,
      `elif [ "$AGE" -le 30 ]`,
      `then IDLE_SENT=false`,
      `fi`,
      `done) & _IDLE_PID=$!`,
    ].join("; ");
  }

  return [
    `cd ${qDir}`,
    `echo $$ > ${qPid}`,
    envExports,
    parentSessionSetup,
    exitTrapCmd,
    idleDetectorCmd,
    `unset CLAUDECODE && ${qClaudeBin} $CLAUDE_PARENT_ARG --resume ${qSessionId} ${settingsArgs}`,
  ]
    .filter(Boolean)
    .join(" && ");
}

/**
 * Build a Codex CLI worker script (pipe mode).
 * Uses `codex exec` for non-interactive execution with stdout captured to result file.
 * @param {object} opts - Worker options
 * @returns {string} Shell script string
 */
export function buildCodexWorkerScript(opts) {
  const { taskId, workDir, resultFile, pidFile, metaFile, model, promptFile } =
    opts;
  const platformName = opts.platformName ?? cfg().PLATFORM;

  if (platformName === "win32") {
    return `echo "Codex workers not supported on Windows yet" && exit 1`;
  }

  const qDir = shellQuote(workDir);
  const qResult = shellQuote(resultFile);
  const qPid = shellQuote(pidFile);
  const qPrompt = shellQuote(promptFile);
  const qMetaDone = shellQuote(`${metaFile}.done`);
  const qTaskId = shellQuote(taskId);
  const autoClaimEnv = buildAutoClaimEnvExports({
    taskId,
    workDir,
    defaultDirectory: opts.defaultDirectory || workDir,
    teamName: opts.teamName,
    workerName: opts.workerName || taskId,
    mode: opts.mode || "pipe",
    runtime: opts.runtime || "codex",
    layout: opts.layout || "background",
    leadSessionId: opts.leadSessionId,
    parentSessionId: opts.parentSessionId,
    model,
    agent: opts.agent,
    role: opts.role,
    permissionMode: opts.permissionMode,
    contextLevel: opts.contextLevel,
    budgetPolicy: opts.budgetPolicy,
    budgetTokens: opts.budgetTokens,
    globalBudgetPolicy: opts.globalBudgetPolicy,
    globalBudgetTokens: opts.globalBudgetTokens,
    maxActiveWorkers: opts.maxActiveWorkers,
    requirePlan: opts.requirePlan,
    maxTurns: opts.maxTurns,
    contextSummary: opts.contextSummary,
    isolate: opts.isolate,
  })
    .filter(Boolean)
    .join(" && ");
  const modelArgs =
    model && model !== "sonnet" ? `-m ${shellQuote(model)}` : "";

  return [
    `cd ${qDir}`,
    `echo "Codex Worker ${qTaskId} starting at $(date)" > ${qResult}`,
    `echo $$ > ${qPid}`,
    autoClaimEnv,
    `WORKER_PROMPT=$(cat ${qPrompt})`,
    `codex exec "$WORKER_PROMPT" --full-auto -C ${qDir} ${modelArgs} >> ${qResult} 2>&1` +
      `; printf '{"status":"completed","finished":"%s","task_id":"%s"}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ${qTaskId} > ${qMetaDone}` +
      `; rm -f ${qPid}` +
      `; ${autoClaimShellCommand()}`,
  ]
    .filter(Boolean)
    .join(" && ");
}

/**
 * Build a Codex CLI interactive worker script.
 * Uses `codex` TUI mode with --full-auto for autonomous execution with live terminal.
 * @param {object} opts - Worker options
 * @returns {string} Shell script string
 */
export function buildCodexInteractiveWorkerScript(opts) {
  const { taskId, workDir, resultFile, pidFile, metaFile, model, promptFile } =
    opts;
  const platformName = opts.platformName ?? cfg().PLATFORM;

  if (platformName === "win32") {
    return `echo "Codex workers not supported on Windows yet" && exit 1`;
  }

  const qDir = shellQuote(workDir);
  const qPid = shellQuote(pidFile);
  const qPrompt = shellQuote(promptFile);
  const qMetaDone = shellQuote(`${metaFile}.done`);
  const qTaskId = shellQuote(taskId);
  const autoClaimEnv = buildAutoClaimEnvExports({
    taskId,
    workDir,
    defaultDirectory: opts.defaultDirectory || workDir,
    teamName: opts.teamName,
    workerName: opts.workerName || taskId,
    mode: opts.mode || "interactive",
    runtime: opts.runtime || "codex",
    layout: opts.layout || "background",
    leadSessionId: opts.leadSessionId,
    parentSessionId: opts.parentSessionId,
    model,
    agent: opts.agent,
    role: opts.role,
    permissionMode: opts.permissionMode,
    contextLevel: opts.contextLevel,
    budgetPolicy: opts.budgetPolicy,
    budgetTokens: opts.budgetTokens,
    globalBudgetPolicy: opts.globalBudgetPolicy,
    globalBudgetTokens: opts.globalBudgetTokens,
    maxActiveWorkers: opts.maxActiveWorkers,
    requirePlan: opts.requirePlan,
    maxTurns: opts.maxTurns,
    contextSummary: opts.contextSummary,
    isolate: opts.isolate,
  })
    .filter(Boolean)
    .join(" && ");
  const modelArgs =
    model && model !== "sonnet" ? `-m ${shellQuote(model)}` : "";

  return [
    `cd ${qDir}`,
    `echo $$ > ${qPid}`,
    autoClaimEnv,
    `WORKER_PROMPT=$(cat ${qPrompt})`,
    `codex "$WORKER_PROMPT" --full-auto -C ${qDir} ${modelArgs}` +
      `; printf '{"status":"completed","finished":"%s","task_id":"%s"}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ${qTaskId} > ${qMetaDone}` +
      `; rm -f ${qPid}` +
      `; ${autoClaimShellCommand()}`,
  ]
    .filter(Boolean)
    .join(" && ");
}

/**
 * Build a cross-platform worker script.
 * All dynamic values are shell-quoted to prevent injection.
 * @param {object} opts - Worker options
 * @param {string} opts.taskId - Worker task ID
 * @param {string} opts.workDir - Working directory
 * @param {string} opts.resultFile - Output file path
 * @param {string} opts.pidFile - PID file path
 * @param {string} opts.metaFile - Metadata file path
 * @param {string} opts.model - Model name (validated via sanitizeModel)
 * @param {string} opts.agent - Agent name (validated via sanitizeAgent, may be empty)
 * @param {string} opts.promptFile - Prompt file path
 * @param {string} opts.workerPs1File - Windows PS1 file path
 * @param {string} [opts.platformName] - Platform override
 * @returns {string} Shell script string
 */
export function buildWorkerScript(opts) {
  const { PLATFORM, SETTINGS_FILE, WORKER_SETTINGS_FILE, CLAUDE_BIN } = cfg();
  const {
    taskId,
    workDir,
    resultFile,
    pidFile,
    metaFile,
    model,
    agent,
    promptFile,
    workerPs1File = "",
  } = opts;
  const platformName = opts.platformName ?? PLATFORM;

  if (platformName === "win32") {
    const q = (value) => `"${String(value).replace(/"/g, '""')}"`;
    const winSettings = existsSync(SETTINGS_FILE) ? SETTINGS_FILE : "";
    return [
      `cd /d "${workDir}"`,
      `powershell -NoProfile -ExecutionPolicy Bypass -File ${q(workerPs1File)} -WorkingDir ${q(workDir)} -ClaudeBin ${q(CLAUDE_BIN)} -PromptFile ${q(promptFile)} -ResultFile ${q(resultFile)} -PidFile ${q(pidFile)} -MetaDoneFile ${q(`${metaFile}.done`)} -Model ${q(model)} -Agent ${q(agent || "")} -SettingsFile ${q(winSettings)}`,
    ]
      .filter(Boolean)
      .join(" && ");
  } else {
    const qDir = shellQuote(workDir);
    const qResult = shellQuote(resultFile);
    const qPid = shellQuote(pidFile);
    const qPrompt = shellQuote(promptFile);
    const qMetaDone = shellQuote(`${metaFile}.done`);
    const qModel = shellQuote(model);
    const qClaudeBin = shellQuote(CLAUDE_BIN);
    const agentArgs = agent ? `--agent ${shellQuote(agent)}` : "";
    const workerSettingsFile = existsSync(WORKER_SETTINGS_FILE)
      ? WORKER_SETTINGS_FILE
      : SETTINGS_FILE;
    const settingsArgs = existsSync(workerSettingsFile)
      ? `--settings ${shellQuote(workerSettingsFile)}`
      : "";
    const qTaskId = shellQuote(taskId);
    const autoClaimEnv = [
      ...buildAutoClaimEnvExports({
        taskId,
        workDir,
        defaultDirectory: opts.defaultDirectory || workDir,
        teamName: opts.teamName,
        workerName: opts.workerName || taskId,
        mode: opts.mode || "pipe",
        runtime: opts.runtime || "claude",
        layout: opts.layout || "background",
        leadSessionId: opts.leadSessionId,
        parentSessionId: opts.parentSessionId,
        model,
        agent,
        role: opts.role,
        permissionMode: opts.permissionMode,
        contextLevel: opts.contextLevel,
        budgetPolicy: opts.budgetPolicy,
        budgetTokens: opts.budgetTokens,
        globalBudgetPolicy: opts.globalBudgetPolicy,
        globalBudgetTokens: opts.globalBudgetTokens,
        maxActiveWorkers: opts.maxActiveWorkers,
        requirePlan: opts.requirePlan,
        maxTurns: opts.maxTurns,
        contextSummary: opts.contextSummary,
        isolate: opts.isolate,
      }),
      ...buildParentSessionEnvExports(opts.parentSessionId),
    ]
      .filter(Boolean)
      .join(" && ");
    const parentSessionSetup = buildParentSessionSetup(qClaudeBin);
    // Use the Node.js output-forwarder for pipe-mode workers.
    // The forwarder spawns claude as a child process, streams stdout/stderr to
    // BOTH the result file AND a Unix domain socket at /tmp/claude-worker-{taskId}.sock.
    // This enables sub-10ms streaming to the sidecar (vs ~50-200ms from fs.watch).
    // The forwarder also handles PID file, result file, and .done marker — so we only
    // need setup (cd, env) and post-exit autoclaim in the shell script.
    const qForwarder = shellQuote(OUTPUT_FORWARDER);
    const qNode = shellQuote(process.execPath || "node");
    const claudeArgs = [
      qClaudeBin,
      "-p",
      "--model",
      qModel,
      "$CLAUDE_PARENT_ARG",
      agentArgs,
      settingsArgs,
    ]
      .filter(Boolean)
      .join(" ");
    // The forwarder reads the prompt from stdin, so pipe the prompt file to the whole command.
    // Format: node forwarder.js <taskId> <resultFile> <metaDoneFile> <pidFile> -- claude -p ...
    const forwarderCmd = `${qNode} ${qForwarder} ${qTaskId} ${qResult} ${qMetaDone} ${qPid} -- ${claudeArgs} < ${qPrompt}`;
    const leadSessionId = opts.leadSessionId || "";
    const leadPaneId = opts.leadPaneId || "";
    const workerDisplay = opts.workerName || taskId;
    const leadExports = [
      leadSessionId
        ? `export CLAUDE_LEAD_SESSION_ID=${shellQuote(leadSessionId)}`
        : "",
      leadPaneId ? `export CLAUDE_LEAD_PANE_ID=${shellQuote(leadPaneId)}` : "",
    ]
      .filter(Boolean)
      .join(" && ");
    const setupCmds = [
      `cd ${qDir}`,
      autoClaimEnv,
      leadExports,
      parentSessionSetup,
    ]
      .filter(Boolean)
      .join(" && ");
    // Completion: inbox write + targeted tmux status-bar notification to lead pane.
    // Mirrors buildInteractiveWorkerScript — all worker types deliver the same signals.
    // Runs after forwarder exits regardless of exit code (forwarder owns .done + PID).
    const completionCmds = [
      leadSessionId
        ? `printf '{"ts":"%s","from":"coordinator","priority":"normal","content":"[COMPLETED] ${workerDisplay}"}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$HOME/.claude/terminals/inbox/$CLAUDE_LEAD_SESSION_ID.jsonl" 2>/dev/null || true`
        : "",
      leadPaneId
        ? `[ -n "$TMUX" ] && [ -n "$CLAUDE_LEAD_PANE_ID" ] && tmux display-message -t "$CLAUDE_LEAD_PANE_ID" -d 4000 "[${workerDisplay}] message waiting — check inbox" 2>/dev/null || true`
        : "",
    ]
      .filter(Boolean)
      .join("; ");
    const cleanupCmds = autoClaimShellCommand();
    // Use ; before completion/cleanup so they run regardless of forwarder's exit code
    return completionCmds
      ? `${setupCmds} && ${forwarderCmd}; ${completionCmds}; ${cleanupCmds}`
      : `${setupCmds} && ${forwarderCmd}; ${cleanupCmds}`;
  }
}
