import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = new URL("../..", import.meta.url).pathname;
const leadToolsDir = join(repoRoot, "lead-tools");
const mcpRoot = new URL("..", import.meta.url).pathname;

function makeFakeClaude(home) {
  const fake = join(home, "fake-claude.sh");
  writeFileSync(
    fake,
    [
      "#!/usr/bin/env bash",
      'if [ "${1:-}" = "--help" ]; then',
      '  echo "fake claude help"',
      "  exit 0",
      "fi",
      "while [ $# -gt 0 ]; do shift; done",
      'echo "fake claude ready"',
      "cat",
    ].join("\n"),
    { mode: 0o755 },
  );
  return fake;
}

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), "coord-worker-launch-"));
  const claudeDir = join(home, ".claude");
  mkdirSync(join(claudeDir, "terminals", "results"), { recursive: true });
  mkdirSync(join(claudeDir, "terminals", "inbox"), { recursive: true });
  mkdirSync(join(claudeDir, "session-cache"), { recursive: true });
  return { home, claudeDir };
}

async function loadApi(tag) {
  const mod = await import(`../index.js?worker-launch=${tag}-${Date.now()}`);
  return mod.__test__;
}

async function waitForFile(file, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test("visible spawn records requested/effective launch metadata on success", async () => {
  const prevEnv = { ...process.env };
  const { home } = setupHome();
  const workDir = join(home, "work");
  mkdirSync(workDir, { recursive: true });
  process.env.HOME = home;
  process.env.COORDINATOR_TEST_MODE = "1";
  process.env.COORDINATOR_PLATFORM = "darwin";
  process.env.COORDINATOR_CLAUDE_BIN = makeFakeClaude(home);
  delete process.env.COORDINATOR_FAKE_VISIBLE_LAUNCH_NOOP;
  delete process.env.COORDINATOR_DISABLE_LAUNCH_FALLBACK;

  try {
    const api = await loadApi("success");
    const response = api.handleToolCall("coord_spawn_worker", {
      directory: workDir,
      prompt: "Smoke task",
      task_id: "W_SUCCESS",
      layout: "split",
    });
    const text = response.content[0].text;
    assert.match(text, /Requested Layout: split/);
    assert.match(text, /Effective Backend: iTerm2/);
    assert.match(text, /Launch Method: iterm_profile_command_bootstrap/);
    assert.match(text, /Launch Status: launched/);

    const metaFile = join(home, ".claude", "terminals", "results", "W_SUCCESS.meta.json");
    const launcherFile = join(home, ".claude", "terminals", "results", "W_SUCCESS.launcher.sh");
    const bootstrapFile = join(home, ".claude", "terminals", "results", "W_SUCCESS.bootstrap.sh");
    const visibleStartFile = join(home, ".claude", "terminals", "results", "W_SUCCESS.visible.started");
    const doneFile = `${metaFile}.done`;
    assert.equal(await waitForFile(doneFile), true, "worker should complete");
    const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
    assert.equal(meta.requested_layout, "split");
    assert.equal(meta.effective_backend, "iTerm2");
    assert.equal(meta.launch_method, "iterm_profile_command_bootstrap");
    assert.equal(meta.launch_status, "launched");
    assert.ok(meta.handshake_at);
    assert.ok(meta.visible_started_at);
    assert.equal(existsSync(launcherFile), true, "launcher file should exist");
    assert.ok((statSync(launcherFile).mode & 0o111) !== 0, "launcher file should be executable");
    assert.equal(existsSync(bootstrapFile), true, "bootstrap file should exist");
    assert.ok((statSync(bootstrapFile).mode & 0o111) !== 0, "bootstrap file should be executable");
    assert.equal(existsSync(visibleStartFile), true, "visible start marker should exist");
    assert.match(readFileSync(bootstrapFile, "utf-8"), /\/bin\/sh '.*W_SUCCESS\.launcher\.sh'/);
  } finally {
    Object.keys(process.env).forEach((key) => {
      if (!(key in prevEnv)) delete process.env[key];
    });
    Object.assign(process.env, prevEnv);
  }
});

test("visible session creation can degrade immediately when bootstrap launch fails", async () => {
  const prevEnv = { ...process.env };
  const { home } = setupHome();
  const workDir = join(home, "work");
  mkdirSync(workDir, { recursive: true });
  process.env.HOME = home;
  process.env.COORDINATOR_TEST_MODE = "1";
  process.env.COORDINATOR_PLATFORM = "darwin";
  process.env.COORDINATOR_CLAUDE_BIN = makeFakeClaude(home);
  process.env.COORDINATOR_FORCE_ITERM_BOOTSTRAP_FAIL = "1";
  delete process.env.COORDINATOR_FAKE_VISIBLE_LAUNCH_NOOP;
  delete process.env.COORDINATOR_DISABLE_LAUNCH_FALLBACK;

  try {
    const api = await loadApi("visible-bootstrap-fail");
    const response = api.handleToolCall("coord_spawn_worker", {
      directory: workDir,
      prompt: "Visible write failure task",
      task_id: "W_WRITE_FAIL",
      layout: "split",
    });
    const text = response.content[0].text;
    assert.match(text, /Effective Backend: background/);
    assert.match(text, /Launch Method: background_launcher/);
    assert.match(text, /Launch Status: fallback_background/);
    assert.match(text, /forced iTerm bootstrap failure/i);

    const metaFile = join(
      home,
      ".claude",
      "terminals",
      "results",
      "W_WRITE_FAIL.meta.json",
    );
    const doneFile = `${metaFile}.done`;
    assert.equal(await waitForFile(doneFile), true, "fallback worker should complete");
    const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
    assert.equal(meta.launch_status, "fallback_background");
    assert.equal(meta.effective_backend, "background");
    assert.equal(meta.launch_method, "background_launcher");
    assert.match(String(meta.launch_error || ""), /forced iTerm bootstrap failure/i);
  } finally {
    Object.keys(process.env).forEach((key) => {
      if (!(key in prevEnv)) delete process.env[key];
    });
    Object.assign(process.env, prevEnv);
  }
});

test("visible launch handshake timeout falls back to background and stays observable", async () => {
  const prevEnv = { ...process.env };
  const { home } = setupHome();
  const workDir = join(home, "work");
  mkdirSync(workDir, { recursive: true });
  process.env.HOME = home;
  process.env.COORDINATOR_TEST_MODE = "1";
  process.env.COORDINATOR_PLATFORM = "darwin";
  process.env.COORDINATOR_CLAUDE_BIN = makeFakeClaude(home);
  process.env.COORDINATOR_FAKE_VISIBLE_LAUNCH_NOOP = "1";
  delete process.env.COORDINATOR_DISABLE_LAUNCH_FALLBACK;

  try {
    const api = await loadApi("fallback");
    const response = api.handleToolCall("coord_spawn_worker", {
      directory: workDir,
      prompt: "Fallback task",
      task_id: "W_FALLBACK",
      layout: "split",
    });
    const text = response.content[0].text;
    assert.match(text, /Requested Layout: split/);
    assert.match(text, /Effective Backend: background/);
    assert.match(text, /Launch Status: fallback_background/);

    const metaFile = join(home, ".claude", "terminals", "results", "W_FALLBACK.meta.json");
    const doneFile = `${metaFile}.done`;
    assert.equal(await waitForFile(doneFile), true, "fallback worker should complete");
    const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
    assert.equal(meta.launch_status, "fallback_background");
    assert.equal(meta.effective_backend, "background");
    assert.match(String(meta.fallback_reason || ""), /fell back to background/i);
  } finally {
    Object.keys(process.env).forEach((key) => {
      if (!(key in prevEnv)) delete process.env[key];
    });
    Object.assign(process.env, prevEnv);
  }
});

test("bootstrap-start failure is surfaced through get_result when fallback is disabled", async () => {
  const prevEnv = { ...process.env };
  const { home } = setupHome();
  const workDir = join(home, "work");
  mkdirSync(workDir, { recursive: true });
  process.env.HOME = home;
  process.env.COORDINATOR_TEST_MODE = "1";
  process.env.COORDINATOR_PLATFORM = "darwin";
  process.env.COORDINATOR_CLAUDE_BIN = makeFakeClaude(home);
  process.env.COORDINATOR_FAKE_VISIBLE_LAUNCH_NOOP = "1";
  process.env.COORDINATOR_DISABLE_LAUNCH_FALLBACK = "1";

  try {
    const api = await loadApi("failure");
    const spawn = api.handleToolCall("coord_spawn_worker", {
      directory: workDir,
      prompt: "Failure task",
      task_id: "W_FAIL",
      layout: "split",
    });
    assert.match(spawn.content[0].text, /Failed to spawn worker/i);

    const metaFile = join(home, ".claude", "terminals", "results", "W_FAIL.meta.json");
    assert.equal(await waitForFile(metaFile), true, "failed launch should still write meta");
    const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
    assert.equal(meta.status, "launch_failed");
    assert.equal(meta.launch_status, "launch_failed");
    assert.equal(existsSync(join(home, ".claude", "terminals", "results", "W_FAIL.pid")), false);

    const result = api.handleToolCall("coord_get_result", { task_id: "W_FAIL" });
    const resultText = result.content[0].text;
    assert.match(resultText, /Status:\*\* launch_failed|Status:\s+launch_failed/i);
    assert.match(resultText, /visible bootstrap never started/i);
  } finally {
    Object.keys(process.env).forEach((key) => {
      if (!(key in prevEnv)) delete process.env[key];
    });
    Object.assign(process.env, prevEnv);
  }
});

test("shell fallback wrappers delegate to the shared worker CLI contract", async () => {
  const prevEnv = { ...process.env };
  const { home, claudeDir } = setupHome();
  const workDir = join(home, "work");
  mkdirSync(workDir, { recursive: true });
  process.env.HOME = home;
  process.env.COORDINATOR_TEST_MODE = "1";
  process.env.COORDINATOR_PLATFORM = "darwin";
  process.env.COORDINATOR_CLAUDE_BIN = makeFakeClaude(home);
  delete process.env.COORDINATOR_FAKE_VISIBLE_LAUNCH_NOOP;
  delete process.env.COORDINATOR_DISABLE_LAUNCH_FALLBACK;

  try {
    symlinkSync(mcpRoot, join(claudeDir, "mcp-coordinator"));
    symlinkSync(leadToolsDir, join(claudeDir, "lead-tools"));

    const spawnText = execFileSync(
      "bash",
      [join(leadToolsDir, "spawn_worker.sh"), workDir, "Shell smoke task", "sonnet", "W_SHELL", "split"],
      { encoding: "utf-8", env: process.env },
    );
    assert.match(spawnText, /Requested Layout: split/);
    assert.match(spawnText, /Effective Backend:/);

    const metaFile = join(home, ".claude", "terminals", "results", "W_SHELL.meta.json");
    const launcherFile = join(home, ".claude", "terminals", "results", "W_SHELL.launcher.sh");
    const doneFile = `${metaFile}.done`;
    assert.equal(await waitForFile(doneFile), true, "shell wrapper worker should complete");
    const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
    assert.ok(meta.requested_layout);
    assert.ok(meta.effective_backend);
    assert.ok(meta.launch_status);
    assert.ok(meta.launch_method);
    assert.equal(existsSync(launcherFile), true, "shell wrapper should create launcher artifact");
    assert.match(readFileSync(launcherFile, "utf-8"), /^#!\/usr\/bin\/env sh/m);

    const resultText = execFileSync(
      "bash",
      [join(leadToolsDir, "get_result.sh"), "W_SHELL", "20"],
      { encoding: "utf-8", env: process.env },
    );
    assert.doesNotMatch(resultText, /Status:\s+unknown/i);
    assert.match(resultText, /Effective Backend:/i);
    assert.match(resultText, /Launch Method:/i);
  } finally {
    Object.keys(process.env).forEach((key) => {
      if (!(key in prevEnv)) delete process.env[key];
    });
    Object.assign(process.env, prevEnv);
  }
});
