/**
 * E2E: Self-Claim Loop
 *
 * Verifies the full loop: worker completes task → claim-next-task.mjs --claim-only
 * returns the next pending task as JSON → loop reads it → re-runs claude inline.
 * Empty stdout = no more tasks = loop terminates.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "cls-selfclaim-"));
  mkdirSync(join(home, ".claude", "terminals", "tasks"), { recursive: true });
  mkdirSync(join(home, ".claude", "terminals", "results"), { recursive: true });
  mkdirSync(join(home, ".claude", "teams"), { recursive: true });
  return home;
}

async function loadApi(home) {
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

const SCRIPT = fileURLToPath(new URL("../scripts/claim-next-task.mjs", import.meta.url));

function runClaimOnly(home, payload) {
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return execFileSync(process.execPath, [SCRIPT, "--claim-only"], {
    env: { ...process.env, HOME: home, CLAUDE_AUTOCLAIM_ARGS_B64: b64 },
    encoding: "utf-8",
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("--claim-only: returns empty when no pending tasks exist", async () => {
  const home = makeHome();
  const { api, restore } = await loadApi(home);

  api.handleToolCall("coord_create_team", { team_name: "sc-empty" });
  // No tasks created — nothing to claim

  const stdout = runClaimOnly(home, { team_name: "sc-empty", assignee: "worker-a" });
  assert.equal(stdout.trim(), "", "empty output → loop would break");
  restore();
});

test("--claim-only: returns JSON with found=true when a pending task exists", async () => {
  const home = makeHome();
  const { api, restore } = await loadApi(home);

  api.handleToolCall("coord_create_team", { team_name: "sc-basic" });
  api.handleToolCall("coord_create_task", {
    team_name: "sc-basic",
    task_id: "SC_TASK_1",
    subject: "Do something useful",
    assignee: "worker-a",
    metadata: { dispatch: { prompt: "Do something useful now." } },
  });

  const stdout = runClaimOnly(home, { team_name: "sc-basic", assignee: "worker-a" });

  assert.ok(stdout.trim().length > 0, "non-empty output when task is claimable");
  const data = JSON.parse(stdout);
  assert.equal(data.found, true);
  assert.equal(data.task_id, "SC_TASK_1");
  assert.equal(data.assignee, "worker-a");
  restore();
});

test("--claim-only: marks completed_worker_task_id team task as done and returns next", async () => {
  const home = makeHome();
  const { api, restore } = await loadApi(home);

  api.handleToolCall("coord_create_team", { team_name: "sc-chain" });

  // Task 1: create + stamp metadata.worker_task_id so teamTaskForWorker can match it
  api.handleToolCall("coord_create_task", {
    team_name: "sc-chain",
    task_id: "SC_CHAIN_1",
    subject: "Task one",
    assignee: "worker-b",
  });
  api.handleToolCall("coord_update_task", {
    task_id: "SC_CHAIN_1",
    status: "in_progress",
    metadata: { worker_task_id: "wt_chain_1" },
  });

  // Task 2: pending, same assignee
  api.handleToolCall("coord_create_task", {
    team_name: "sc-chain",
    task_id: "SC_CHAIN_2",
    subject: "Task two",
    assignee: "worker-b",
    metadata: { dispatch: { prompt: "Do task two now." } },
  });

  const stdout = runClaimOnly(home, {
    team_name: "sc-chain",
    assignee: "worker-b",
    completed_worker_task_id: "wt_chain_1",
  });

  assert.ok(stdout.trim().length > 0, "should return SC_CHAIN_2");
  const data = JSON.parse(stdout);
  assert.equal(data.found, true);
  assert.equal(data.task_id, "SC_CHAIN_2");

  // SC_CHAIN_1 should now be marked completed
  const taskFile = join(home, ".claude", "terminals", "tasks", "SC_CHAIN_1.json");
  if (existsSync(taskFile)) {
    const t = JSON.parse(readFileSync(taskFile, "utf-8"));
    assert.equal(t.status, "completed", "previously in_progress task marked completed");
  }
  restore();
});

test("--claim-only: returns empty after last task is completed (loop terminates)", async () => {
  const home = makeHome();
  const { api, restore } = await loadApi(home);

  api.handleToolCall("coord_create_team", { team_name: "sc-last" });
  api.handleToolCall("coord_create_task", {
    team_name: "sc-last",
    task_id: "SC_LAST_1",
    subject: "Final task",
    assignee: "worker-c",
  });
  api.handleToolCall("coord_update_task", {
    task_id: "SC_LAST_1",
    status: "in_progress",
    metadata: { worker_task_id: "wt_last_1" },
  });

  // No other pending tasks after this one completes
  const stdout = runClaimOnly(home, {
    team_name: "sc-last",
    assignee: "worker-c",
    completed_worker_task_id: "wt_last_1",
  });

  assert.equal(stdout.trim(), "", "no remaining tasks → empty → loop breaks cleanly");
  restore();
});

test("--claim-only: respects blocked_by — skips blocked tasks", async () => {
  const home = makeHome();
  const { api, restore } = await loadApi(home);

  api.handleToolCall("coord_create_team", { team_name: "sc-blocked" });
  api.handleToolCall("coord_create_task", {
    team_name: "sc-blocked",
    task_id: "SC_BLK_A",
    subject: "Dependency",
    assignee: "worker-d",
    metadata: { dispatch: { prompt: "Complete the dependency task." } },
  });
  api.handleToolCall("coord_create_task", {
    team_name: "sc-blocked",
    task_id: "SC_BLK_B",
    subject: "Blocked task",
    assignee: "worker-d",
    blocked_by: ["SC_BLK_A"],
    metadata: { dispatch: { prompt: "Complete the blocked task after SC_BLK_A." } },
  });

  // SC_BLK_A has no blockers — should be returned
  // SC_BLK_B is blocked by SC_BLK_A — should be skipped
  const stdout = runClaimOnly(home, {
    team_name: "sc-blocked",
    assignee: "worker-d",
  });

  const data = JSON.parse(stdout);
  assert.equal(data.found, true);
  assert.equal(data.task_id, "SC_BLK_A", "returns unblocked task, not blocked one");
  restore();
});

test("--claim-only: loops through a full queued chain and terminates cleanly", async () => {
  const home = makeHome();
  const { api, restore } = await loadApi(home);

  api.handleToolCall("coord_create_team", { team_name: "sc-loop" });

  api.handleToolCall("coord_create_task", {
    team_name: "sc-loop",
    task_id: "SC_LOOP_1",
    subject: "Task one",
    assignee: "worker-loop",
  });
  api.handleToolCall("coord_update_task", {
    task_id: "SC_LOOP_1",
    status: "in_progress",
    metadata: { worker_task_id: "wt_loop_1" },
  });

  api.handleToolCall("coord_create_task", {
    team_name: "sc-loop",
    task_id: "SC_LOOP_2",
    subject: "Task two",
    assignee: "worker-loop",
    metadata: { dispatch: { prompt: "Handle task two." } },
  });
  api.handleToolCall("coord_create_task", {
    team_name: "sc-loop",
    task_id: "SC_LOOP_3",
    subject: "Task three",
    assignee: "worker-loop",
    metadata: { dispatch: { prompt: "Handle task three." } },
  });

  const hop1 = JSON.parse(
    runClaimOnly(home, {
      team_name: "sc-loop",
      assignee: "worker-loop",
      completed_worker_task_id: "wt_loop_1",
    }),
  );
  assert.equal(hop1.found, true);
  assert.equal(hop1.task_id, "SC_LOOP_2");
  assert.equal(hop1.prompt, "Handle task two.");

  api.handleToolCall("coord_update_task", {
    task_id: "SC_LOOP_2",
    status: "in_progress",
    metadata: { worker_task_id: "wt_loop_2", dispatch: { prompt: "Handle task two." } },
  });

  const hop2 = JSON.parse(
    runClaimOnly(home, {
      team_name: "sc-loop",
      assignee: "worker-loop",
      completed_worker_task_id: "wt_loop_2",
    }),
  );
  assert.equal(hop2.found, true);
  assert.equal(hop2.task_id, "SC_LOOP_3");
  assert.equal(hop2.prompt, "Handle task three.");

  api.handleToolCall("coord_update_task", {
    task_id: "SC_LOOP_3",
    status: "in_progress",
    metadata: { worker_task_id: "wt_loop_3", dispatch: { prompt: "Handle task three." } },
  });

  const hop3 = runClaimOnly(home, {
    team_name: "sc-loop",
    assignee: "worker-loop",
    completed_worker_task_id: "wt_loop_3",
  });
  assert.equal(hop3.trim(), "", "loop must stop after the last queued task");

  const task1 = JSON.parse(readFileSync(join(home, ".claude", "terminals", "tasks", "SC_LOOP_1.json"), "utf-8"));
  const task2 = JSON.parse(readFileSync(join(home, ".claude", "terminals", "tasks", "SC_LOOP_2.json"), "utf-8"));
  const task3 = JSON.parse(readFileSync(join(home, ".claude", "terminals", "tasks", "SC_LOOP_3.json"), "utf-8"));
  assert.equal(task1.status, "completed");
  assert.equal(task2.status, "completed");
  assert.equal(task3.status, "completed");
  restore();
});
