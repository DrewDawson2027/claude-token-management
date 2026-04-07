#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const prevEnv = { ...process.env };
let targetTTY = "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractText(response) {
  return response?.content?.map((item) => item?.text || "").join("\n") || "";
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function runOsa(lines, failureLabel) {
  const args = lines.flatMap((line) => ["-e", line]);
  const res = spawnSync("osascript", args, {
    encoding: "utf-8",
    timeout: 8000,
  });
  if (res.status !== 0) {
    fail(
      `${failureLabel}: ${String(res.stderr || res.stdout || "").trim() || "osascript failed"}`,
    );
  }
  return String(res.stdout || "").trim();
}

async function waitForPaneContents(tty, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const contents = runOsa(
      [
        'set targetTty to ' + JSON.stringify(tty),
        'tell application "iTerm2"',
        "repeat with w in windows",
        "repeat with t in tabs of w",
        "repeat with s in sessions of t",
        "try",
        "if (tty of s) is targetTty then return contents of s",
        "end try",
        "end repeat",
        "end repeat",
        "end repeat",
        'error "target tty not found"',
        "end tell",
      ],
      "visible spawn smoke failed while reading pane contents",
    );
    if (contents.includes("visible-smoke-complete")) {
      return contents;
    }
    await sleep(150);
  }
  fail(`visible spawn smoke failed: pane ${tty} never showed completion output`);
}

function closeWindowForTTY(tty) {
  if (!tty) return;
  try {
    runOsa(
      [
        'set targetTty to ' + JSON.stringify(tty),
        'tell application "iTerm2"',
        "repeat with w in windows",
        "repeat with t in tabs of w",
        "repeat with s in sessions of t",
        "try",
        "if (tty of s) is targetTty then",
        "close w",
        'return "closed"',
        "end if",
        "end try",
        "end repeat",
        "end repeat",
        "end repeat",
        'return "missing"',
        "end tell",
      ],
      "visible spawn smoke failed while closing dedicated window",
    );
  } catch {}
}

try {
  if (process.env.TMUX) {
    fail("visible spawn smoke failed: run this script outside tmux");
  }

  const home = process.env.HOME;
  if (!home) fail("visible spawn smoke failed: HOME is not set");

  const workDir = process.cwd();
  const fakeDir = mkdtempSync(join(tmpdir(), "coord-visible-spawn-"));
  const fakeBin = join(fakeDir, "fake-claude.sh");
  const taskId = `W_VISIBLE_SMOKE_${Date.now()}`;

  writeFileSync(
    fakeBin,
    [
      "#!/usr/bin/env bash",
      'if [ "${1:-}" = "--help" ]; then',
      '  echo "fake claude help"',
      "  exit 0",
      "fi",
      "while [ $# -gt 0 ]; do shift; done",
      `echo "visible-smoke-start ${taskId}"`,
      "sleep 0.5",
      `echo "visible-smoke-middle ${taskId}"`,
      "sleep 0.5",
      `echo "visible-smoke-complete ${taskId}"`,
    ].join("\n"),
    { mode: 0o755 },
  );

  process.env.COORDINATOR_CLAUDE_BIN = fakeBin;
  process.env.COORDINATOR_SKIP_WORKER_POLICY = "1";
  process.env.COORDINATOR_VISIBLE_SMOKE_WINDOW = "1";
  delete process.env.COORDINATOR_TEST_MODE;
  delete process.env.COORDINATOR_FAKE_VISIBLE_LAUNCH_NOOP;
  delete process.env.COORDINATOR_FORCE_ITERM_BOOTSTRAP_FAIL;
  delete process.env.COORDINATOR_FORCE_ITERM_WRITE_TEXT_FAIL;

  const { __test__ } = await import(`../index.js?visible-spawn-smoke=${Date.now()}`);
  const spawn = __test__.handleToolCall("coord_spawn_worker", {
    directory: workDir,
    prompt: "Visible spawn smoke test",
    task_id: taskId,
    layout: "split",
  });
  const spawnText = extractText(spawn);
  if (!/Requested Layout:\s+split/i.test(spawnText)) {
    fail("visible spawn smoke failed: spawn response missing requested layout");
  }
  if (!/Effective Backend:\s+iTerm2/i.test(spawnText)) {
    fail(`visible spawn smoke failed: expected effective backend iTerm2\n${spawnText}`);
  }
  if (!/Launch Method:\s+iterm_profile_command_bootstrap/i.test(spawnText)) {
    fail(
      `visible spawn smoke failed: expected launch method iterm_profile_command_bootstrap\n${spawnText}`,
    );
  }
  if (!/Launch Status:\s+launched/i.test(spawnText)) {
    fail(`visible spawn smoke failed: expected launch status launched\n${spawnText}`);
  }

  const metaFile = join(home, ".claude", "terminals", "results", `${taskId}.meta.json`);
  const resultFile = join(home, ".claude", "terminals", "results", `${taskId}.txt`);
  const doneFile = `${metaFile}.done`;
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(doneFile)) break;
    await sleep(100);
  }

  if (!existsSync(metaFile)) fail("visible spawn smoke failed: meta file not created");
  if (!existsSync(doneFile)) fail("visible spawn smoke failed: worker never completed");
  if (!existsSync(resultFile)) fail("visible spawn smoke failed: result file not created");

  const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
  if (meta.effective_backend !== "iTerm2") {
    fail(`visible spawn smoke failed: expected effective_backend=iTerm2, got ${meta.effective_backend}`);
  }
  if (meta.launch_method !== "iterm_profile_command_bootstrap") {
    fail(
      `visible spawn smoke failed: expected launch_method=iterm_profile_command_bootstrap, got ${meta.launch_method}`,
    );
  }
  if (meta.launch_status !== "launched") {
    fail(`visible spawn smoke failed: expected launch_status=launched, got ${meta.launch_status}`);
  }
  if (!meta.handshake_at) {
    fail("visible spawn smoke failed: handshake_at missing");
  }
  if (!meta.visible_started_at) {
    fail("visible spawn smoke failed: visible_started_at missing");
  }
  if (!meta.launch_target_tty) {
    fail("visible spawn smoke failed: launch_target_tty missing");
  }
  targetTTY = meta.launch_target_tty;

  const resultText = readFileSync(resultFile, "utf-8");
  if (!resultText.includes(`visible-smoke-start ${taskId}`)) {
    fail("visible spawn smoke failed: worker start banner missing from output");
  }
  if (!resultText.includes(`visible-smoke-middle ${taskId}`)) {
    fail("visible spawn smoke failed: worker mid output missing from result");
  }

  const getResult = extractText(
    __test__.handleToolCall("coord_get_result", { task_id: taskId, tail_lines: 40 }),
  );
  if (!/Effective Backend:\*\* iTerm2/i.test(getResult)) {
    fail(`visible spawn smoke failed: get_result did not report iTerm2\n${getResult}`);
  }
  if (!/Launch Method:\*\* iterm_profile_command_bootstrap/i.test(getResult)) {
    fail(`visible spawn smoke failed: get_result did not report launch method\n${getResult}`);
  }
  const paneContents = await waitForPaneContents(meta.launch_target_tty);
  if (!paneContents.includes(`Worker '${taskId}' starting`)) {
    fail(`visible spawn smoke failed: pane ${meta.launch_target_tty} never showed the worker banner`);
  }
  if (!paneContents.includes(`visible-smoke-start ${taskId}`)) {
    fail(`visible spawn smoke failed: pane ${meta.launch_target_tty} never showed worker output`);
  }
  if (!paneContents.includes(`visible-smoke-middle ${taskId}`)) {
    fail(`visible spawn smoke failed: pane ${meta.launch_target_tty} missed middle worker output`);
  }
  if (paneContents.includes("CLAUDE_WORKER_VISIBLE=1")) {
    fail("visible spawn smoke failed: pane still echoed the injected visible shell command");
  }
  if (paneContents.includes(".launcher.sh") || paneContents.includes(".bootstrap.sh")) {
    fail("visible spawn smoke failed: pane still exposed launcher/bootstrap commands");
  }
  if (paneContents.includes("compinit") || paneContents.includes("_docker-compose")) {
    fail("visible spawn smoke failed: pane still showed user shell startup noise before worker output");
  }

  process.stdout.write(`visible spawn smoke: PASS (${taskId})\n`);
} catch (error) {
  fail(`visible spawn smoke failed: ${error.message}`);
} finally {
  closeWindowForTTY(targetTTY);
  for (const key of Object.keys(process.env)) {
    if (!(key in prevEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(prevEnv)) {
    process.env[key] = value;
  }
}
