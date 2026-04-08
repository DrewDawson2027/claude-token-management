import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildInteractiveWorkerScript } from "../lib/platform/common.js";

const workerSettingsTemplate = readFileSync(
  new URL("../lib/platform/worker-settings.json", import.meta.url),
  "utf-8",
);

test("worker settings render coordinator path for the active runtime root", () => {
  const prevEnv = { ...process.env };
  const home = mkdtempSync(join(tmpdir(), "coord-worker-settings-"));
  const claudeDir = join(home, ".claude");
  const platformDir = join(claudeDir, "mcp-coordinator", "lib", "platform");
  const terminalsDir = join(claudeDir, "terminals", "results");

  mkdirSync(platformDir, { recursive: true });
  mkdirSync(terminalsDir, { recursive: true });
  mkdirSync(join(claudeDir, "session-cache"), { recursive: true });
  mkdirSync(join(home, "work"), { recursive: true });

  const runtimeTemplate = join(platformDir, "worker-settings.json");
  writeFileSync(runtimeTemplate, workerSettingsTemplate);

  process.env.HOME = home;
  process.env.CLAUDE_RUNTIME_DIR = claudeDir;
  process.env.COORDINATOR_PLATFORM = "darwin";
  process.env.COORDINATOR_TEST_MODE = "1";
  process.env.COORDINATOR_CLAUDE_BIN = "/bin/echo";

  try {
    const script = buildInteractiveWorkerScript({
      taskId: "W_SETTINGS",
      workDir: join(home, "work"),
      resultFile: join(terminalsDir, "W_SETTINGS.txt"),
      pidFile: join(terminalsDir, "W_SETTINGS.pid"),
      metaFile: join(terminalsDir, "W_SETTINGS.meta.json"),
      model: "sonnet",
      agent: "",
      promptFile: join(terminalsDir, "W_SETTINGS.prompt"),
    });

    const renderedSettings = join(platformDir, "worker-settings.runtime.json");
    const rendered = JSON.parse(readFileSync(renderedSettings, "utf-8"));

    assert.match(script, /worker-settings\.runtime\.json/);
    assert.equal(
      rendered.mcpServers.coordinator.args[0],
      join(claudeDir, "mcp-coordinator", "index.js"),
    );
  } finally {
    Object.keys(process.env).forEach((key) => {
      if (!(key in prevEnv)) delete process.env[key];
    });
    Object.assign(process.env, prevEnv);
  }
});
