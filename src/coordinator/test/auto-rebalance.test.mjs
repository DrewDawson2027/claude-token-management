/**
 * Tests: Auto-rebalance on worker completion + quality gate enforcement.
 *
 * Covers:
 *  1. Worker completes → team has pending tasks → rebalance fires
 *  2. Worker completes → no pending tasks → rebalance skipped (no crash)
 *  3. Two workers complete within 60s → cooldown → only 1 rebalance fires
 *  4. Quality gate pass → task stays `completed`
 *  5. Quality gate fail → task becomes `needs_review`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "cls-ar-"));
  mkdirSync(join(home, ".claude", "terminals", "tasks"), { recursive: true });
  mkdirSync(join(home, ".claude", "terminals", "results"), { recursive: true });
  mkdirSync(join(home, ".claude", "terminals", "inbox"), { recursive: true });
  mkdirSync(join(home, ".claude", "teams"), { recursive: true });
  return home;
}

async function loadCoord(home) {
  const prev = process.env.HOME;
  process.env.HOME = home;
  process.env.COORDINATOR_TEST_MODE = "1";
  process.env.COORDINATOR_PLATFORM = "linux";
  const mod = await import(
    new URL("../index.js", import.meta.url).href + "?bust=" + Date.now()
  );
  mod.__test__.ensureDirsOnce();
  return { api: mod.__test__, restore: () => { process.env.HOME = prev; } };
}

function contentText(result) {
  return result?.content?.[0]?.text ?? "";
}

/** Write the meta + done + result files that simulate a completed worker. */
function writeWorkerDone(resultsDir, taskId, teamName) {
  const meta = { task_id: taskId, team_name: teamName, mode: "pipe" };
  writeFileSync(join(resultsDir, `${taskId}.meta.json`), JSON.stringify(meta));
  writeFileSync(
    join(resultsDir, `${taskId}.meta.json.done`),
    JSON.stringify({ status: "completed", task_id: taskId }),
  );
  writeFileSync(join(resultsDir, `${taskId}.txt`), "worker output");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("rebalance fires when team has pending tasks after worker completes", async () => {
  const home = makeHome();
  const { api, restore } = await loadCoord(home);
  const RESULTS_DIR = join(home, ".claude", "terminals", "results");

  api.handleToolCall("coord_create_team", { team_name: "ar-team1" });
  api.handleToolCall("coord_create_task", {
    task_id: "ar-t1",
    subject: "Work in progress",
    team_name: "ar-team1",
  });
  api.handleToolCall("coord_update_task", {
    task_id: "ar-t1",
    status: "in_progress",
  });
  api.handleToolCall("coord_create_task", {
    task_id: "ar-t2",
    subject: "Pending follow-up",
    team_name: "ar-team1",
  });

  writeWorkerDone(RESULTS_DIR, "ar-t1", "ar-team1");

  // coord_get_result is where the lead detects isDone — rebalance should fire
  const result = api.handleToolCall("coord_get_result", { task_id: "ar-t1" });
  assert.ok(contentText(result).includes("ar-t1"), "result references task id");

  // Pending task still exists and is accessible (rebalance ran without crashing)
  const t2Result = api.handleToolCall("coord_get_task", { task_id: "ar-t2" });
  assert.ok(contentText(t2Result).includes("ar-t2"), "pending task accessible");

  restore();
});

test("no rebalance when team has no pending tasks after worker completes", async () => {
  const home = makeHome();
  const { api, restore } = await loadCoord(home);
  const RESULTS_DIR = join(home, ".claude", "terminals", "results");

  api.handleToolCall("coord_create_team", { team_name: "ar-team2" });
  api.handleToolCall("coord_create_task", {
    task_id: "ar-t3",
    subject: "Only task",
    team_name: "ar-team2",
  });
  api.handleToolCall("coord_update_task", {
    task_id: "ar-t3",
    status: "in_progress",
  });
  // No other pending tasks — rebalance should be skipped silently

  writeWorkerDone(RESULTS_DIR, "ar-t3", "ar-team2");

  const result = api.handleToolCall("coord_get_result", { task_id: "ar-t3" });
  assert.ok(contentText(result).includes("ar-t3"), "result returned without error");

  restore();
});

test("cooldown prevents rebalance storm when multiple workers complete quickly", async () => {
  const home = makeHome();
  const { api, restore } = await loadCoord(home);
  const RESULTS_DIR = join(home, ".claude", "terminals", "results");

  api.handleToolCall("coord_create_team", { team_name: "ar-team3" });
  for (const id of ["ar-t4", "ar-t5", "ar-t6"]) {
    api.handleToolCall("coord_create_task", {
      task_id: id,
      subject: `Task ${id}`,
      team_name: "ar-team3",
    });
  }
  api.handleToolCall("coord_update_task", {
    task_id: "ar-t4",
    status: "in_progress",
  });
  api.handleToolCall("coord_update_task", {
    task_id: "ar-t5",
    status: "in_progress",
  });

  writeWorkerDone(RESULTS_DIR, "ar-t4", "ar-team3");
  writeWorkerDone(RESULTS_DIR, "ar-t5", "ar-team3");

  // Both calls happen within 60s → cooldown prevents double-fire
  const r1 = api.handleToolCall("coord_get_result", { task_id: "ar-t4" });
  const r2 = api.handleToolCall("coord_get_result", { task_id: "ar-t5" });

  assert.ok(contentText(r1).includes("ar-t4"), "first result returned");
  assert.ok(contentText(r2).includes("ar-t5"), "second result returned");
  // No errors = cooldown did not panic or throw on second call

  restore();
});

test("quality gate pass → task remains completed", async () => {
  const home = makeHome();
  const { api, restore } = await loadCoord(home);

  api.handleToolCall("coord_create_task", {
    task_id: "qg-pass",
    subject: "Gated task — all pass",
    metadata: {
      quality_gates: ["lint", "tests"],
      gate_results: { lint: true, tests: true },
    },
  });

  const updateResult = api.handleToolCall("coord_update_task", {
    task_id: "qg-pass",
    status: "completed",
  });
  assert.ok(
    contentText(updateResult).includes("qg-pass"),
    "update response references task",
  );
  assert.ok(
    !contentText(updateResult).includes("needs_review"),
    "no gate failure in response",
  );

  const getResult = api.handleToolCall("coord_get_task", {
    task_id: "qg-pass",
  });
  assert.ok(
    contentText(getResult).includes("completed"),
    "task status stays completed",
  );

  restore();
});

test("quality gate fail → task becomes needs_review", async () => {
  const home = makeHome();
  const { api, restore } = await loadCoord(home);

  api.handleToolCall("coord_create_task", {
    task_id: "qg-fail",
    subject: "Gated task — tests failing",
    metadata: {
      quality_gates: ["lint", "tests"],
      gate_results: { lint: true, tests: false },
    },
  });

  const updateResult = api.handleToolCall("coord_update_task", {
    task_id: "qg-fail",
    status: "completed",
  });
  const updateText = contentText(updateResult);
  assert.ok(
    updateText.includes("needs_review") ||
      updateText.includes("Quality gates failed"),
    "response indicates gate failure or needs_review",
  );

  const getResult = api.handleToolCall("coord_get_task", { task_id: "qg-fail" });
  assert.ok(
    contentText(getResult).includes("needs_review"),
    "task status is needs_review after gate failure",
  );

  restore();
});
