#!/usr/bin/env node

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const prevEnv = { ...process.env };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

try {
  const home = mkdtempSync(join(tmpdir(), "coord-spawn-smoke-"));
  const claudeDir = join(home, ".claude");
  const workDir = join(home, "work");
  const fakeBin = join(home, "fake-claude.sh");
  const resultsDir = join(claudeDir, "terminals", "results");
  mkdirSync(workDir, { recursive: true });
  mkdirSync(resultsDir, { recursive: true });
  mkdirSync(join(claudeDir, "terminals", "inbox"), { recursive: true });
  mkdirSync(join(claudeDir, "session-cache"), { recursive: true });

  writeFileSync(
    fakeBin,
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

  process.env.HOME = home;
  process.env.CLAUDE_RUNTIME_DIR = claudeDir;
  process.env.COORDINATOR_TEST_MODE = "1";
  process.env.COORDINATOR_PLATFORM = "darwin";
  process.env.COORDINATOR_CLAUDE_BIN = fakeBin;

  const { __test__ } = await import(`../index.js?spawn-smoke=${Date.now()}`);
  const spawn = __test__.handleToolCall("coord_spawn_worker", {
    directory: workDir,
    prompt: "Smoke test worker prompt",
    task_id: "W_SMOKE",
    layout: "split",
  });
  const spawnText =
    spawn?.content?.map((item) => item?.text || "").join("\n") || "";
  if (!/Requested Layout:\s+split/i.test(spawnText)) {
    fail("spawn smoke failed: spawn response missing requested layout");
  }
  if (!/Effective Backend:/i.test(spawnText)) {
    fail("spawn smoke failed: spawn response missing effective backend");
  }

  const metaFile = join(resultsDir, "W_SMOKE.meta.json");
  const doneFile = `${metaFile}.done`;
  for (let i = 0; i < 50; i += 1) {
    if (existsSync(doneFile)) break;
    await sleep(100);
  }

  if (!existsSync(metaFile)) fail("spawn smoke failed: meta file not created");
  if (!existsSync(doneFile)) fail("spawn smoke failed: worker never completed");

  const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
  for (const field of [
    "requested_layout",
    "effective_backend",
    "launch_method",
    "launch_status",
    "handshake_at",
  ]) {
    if (!meta[field]) fail(`spawn smoke failed: meta missing ${field}`);
  }

  const result = __test__.handleToolCall("coord_get_result", { task_id: "W_SMOKE" });
  const resultText =
    result?.content?.map((item) => item?.text || "").join("\n") || "";
  if (/Status:\s+unknown/i.test(resultText)) {
    fail("spawn smoke failed: get_result returned unknown status");
  }

  process.stdout.write("spawn smoke: PASS\n");
} catch (error) {
  fail(`spawn smoke failed: ${error.message}`);
} finally {
  for (const key of Object.keys(process.env)) {
    if (!(key in prevEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(prevEnv)) {
    process.env[key] = value;
  }
}
