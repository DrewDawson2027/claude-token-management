/**
 * Tests for the bidirectional tmux messaging protocol.
 *
 * Coverage:
 *   1. formatW2LMessage produces correct [W2L:taskId]: prefix
 *   2. formatL2WMessage produces correct [L2W]: prefix
 *   3. parseW2LMessage correctly parses valid messages and rejects invalid ones
 *   4. parseL2WMessage correctly parses valid messages and rejects invalid ones
 *   5. buildBidirProtocol bakes leadPaneId and taskId into the instructions
 *   6. buildInteractiveWorkerScript embeds bidir note when leadPaneId is set
 *   7. buildInteractiveWorkerScript omits bidir note when leadPaneId is absent
 *   8. handleSendToWorkerPane returns error when not inside tmux (safe path)
 *   9. handleSendToWorkerPane returns error when worker pane not found
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Import bidir-messaging primitives ───────────────────────────────────────

const bidirPath = new URL("../lib/bidir-messaging.js", import.meta.url).pathname;
const {
  formatW2LMessage,
  formatL2WMessage,
  parseW2LMessage,
  parseL2WMessage,
  buildBidirProtocol,
  W2L_PREFIX,
  L2W_PREFIX,
} = await import(`${bidirPath}?bidir-test=${Date.now()}`);

// ─── Import common.js builders ────────────────────────────────────────────────

const commonPath = new URL("../lib/platform/common.js", import.meta.url).pathname;
const { buildInteractiveWorkerScript } = await import(
  `${commonPath}?bidir-common-test=${Date.now()}`
);

// ─── Format tests ─────────────────────────────────────────────────────────────

test("formatW2LMessage: produces correct [W2L:taskId]: prefix", () => {
  const msg = formatW2LMessage("task-abc123", "I need clarification on scope");
  assert.ok(msg.startsWith("[W2L:task-abc123]:"), "must start with W2L prefix + taskId");
  assert.ok(msg.includes("I need clarification on scope"), "must include message content");
});

test("formatW2LMessage: trims whitespace from taskId and message", () => {
  const msg = formatW2LMessage("  task-x  ", "  hello  ");
  assert.ok(msg.includes("[W2L:task-x]:"), "taskId must be trimmed");
  assert.ok(msg.endsWith("hello"), "message must be trimmed");
});

test("formatL2WMessage: produces correct [L2W]: prefix", () => {
  const msg = formatL2WMessage("Here is your answer — continue");
  assert.ok(msg.startsWith("[L2W]:"), "must start with L2W prefix");
  assert.ok(msg.includes("Here is your answer"), "must include message content");
});

// ─── Parse tests ──────────────────────────────────────────────────────────────

test("parseW2LMessage: correctly parses a valid W2L message", () => {
  const raw = "[W2L:task-abc123]: I need clarification on X";
  const result = parseW2LMessage(raw);
  assert.ok(result !== null, "must parse successfully");
  assert.equal(result.taskId, "task-abc123");
  assert.equal(result.content, "I need clarification on X");
});

test("parseW2LMessage: returns null for non-W2L text", () => {
  assert.equal(parseW2LMessage("just a normal message"), null);
  assert.equal(parseW2LMessage("[L2W]: wrong direction"), null);
  assert.equal(parseW2LMessage(""), null);
  assert.equal(parseW2LMessage(null), null);
});

test("parseW2LMessage: returns null for malformed W2L (no closing bracket)", () => {
  assert.equal(parseW2LMessage("[W2L:task-abc no closing bracket"), null);
});

test("parseW2LMessage: returns null when content is empty", () => {
  assert.equal(parseW2LMessage("[W2L:task-abc]:"), null);
  assert.equal(parseW2LMessage("[W2L:task-abc]:   "), null);
});

test("parseL2WMessage: correctly parses a valid L2W message", () => {
  const raw = "[L2W]: Here is the answer — continue with the task";
  const result = parseL2WMessage(raw);
  assert.ok(result !== null, "must parse successfully");
  assert.equal(result.content, "Here is the answer — continue with the task");
});

test("parseL2WMessage: returns null for non-L2W text", () => {
  assert.equal(parseL2WMessage("normal message"), null);
  assert.equal(parseL2WMessage("[W2L:x]: wrong direction"), null);
  assert.equal(parseL2WMessage(""), null);
});

test("parseL2WMessage: returns null when content is empty", () => {
  assert.equal(parseL2WMessage("[L2W]:"), null);
  assert.equal(parseL2WMessage("[L2W]:   "), null);
});

// ─── buildBidirProtocol ───────────────────────────────────────────────────────

test("buildBidirProtocol: bakes leadPaneId and taskId into output", () => {
  const protocol = buildBidirProtocol("%7", "task-xyz");
  assert.ok(protocol.includes("%7"), "must include the lead pane ID");
  assert.ok(protocol.includes("task-xyz"), "must include the task ID");
  assert.ok(protocol.includes("[W2L:task-xyz]"), "must show the exact send format");
  assert.ok(protocol.includes("[L2W]:"), "must explain how replies arrive");
});

// ─── buildInteractiveWorkerScript bidir injection ─────────────────────────────

test("buildInteractiveWorkerScript: embeds BIDIR note when leadPaneId is set", () => {
  const prevHome = process.env.HOME;
  const prevMode = process.env.COORDINATOR_TEST_MODE;
  const prevPlat = process.env.COORDINATOR_PLATFORM;
  process.env.COORDINATOR_TEST_MODE = "1";
  process.env.COORDINATOR_PLATFORM = "linux";

  try {
    const home = mkdtempSync(join(tmpdir(), "coord-bidir-script-"));
    process.env.HOME = home;

    const script = buildInteractiveWorkerScript({
      taskId: "task-bidir-test",
      workDir: "/tmp/work",
      resultFile: "/tmp/work/result.txt",
      pidFile: "/tmp/work/task.pid",
      metaFile: "/tmp/work/task.meta.json",
      model: "claude-sonnet-4-6",
      promptFile: "/tmp/work/task.prompt",
      platformName: "linux",
      workerName: "bidir-worker",
      leadSessionId: "lead-session-bidir",
      leadPaneId: "%7",
    });

    assert.ok(
      script.includes("BIDIR"),
      "script must contain bidir protocol note when leadPaneId is set",
    );
    assert.ok(
      script.includes("[W2L:task-bidir-test]"),
      "bidir note must embed the task ID for the W2L send command",
    );
    assert.ok(
      script.includes("[L2W]"),
      "bidir note must explain the [L2W]: reply format",
    );
  } finally {
    process.env.HOME = prevHome;
    process.env.COORDINATOR_TEST_MODE = prevMode;
    process.env.COORDINATOR_PLATFORM = prevPlat;
  }
});

test("buildInteractiveWorkerScript: omits BIDIR note when leadPaneId is absent", () => {
  const prevHome = process.env.HOME;
  const prevMode = process.env.COORDINATOR_TEST_MODE;
  const prevPlat = process.env.COORDINATOR_PLATFORM;
  process.env.COORDINATOR_TEST_MODE = "1";
  process.env.COORDINATOR_PLATFORM = "linux";

  try {
    const home = mkdtempSync(join(tmpdir(), "coord-no-bidir-"));
    process.env.HOME = home;

    const script = buildInteractiveWorkerScript({
      taskId: "task-no-bidir",
      workDir: "/tmp/work",
      resultFile: "/tmp/work/result.txt",
      pidFile: "/tmp/work/task.pid",
      metaFile: "/tmp/work/task.meta.json",
      model: "claude-sonnet-4-6",
      promptFile: "/tmp/work/task.prompt",
      platformName: "linux",
      workerName: "regular-worker",
      // no leadPaneId
    });

    assert.ok(
      !script.includes("BIDIR:"),
      "script must NOT contain bidir note when leadPaneId is absent",
    );
  } finally {
    process.env.HOME = prevHome;
    process.env.COORDINATOR_TEST_MODE = prevMode;
    process.env.COORDINATOR_PLATFORM = prevPlat;
  }
});

// ─── handleSendToWorkerPane safe paths ───────────────────────────────────────

test("handleSendToWorkerPane: returns error when not inside tmux", async () => {
  const workersPath = new URL("../lib/workers.js", import.meta.url).pathname;
  const { handleSendToWorkerPane } = await import(
    `${workersPath}?bidir-workers-test=${Date.now()}`
  );

  const prevTmux = process.env.TMUX;
  delete process.env.TMUX;

  try {
    const result = handleSendToWorkerPane({
      worker_name: "some-worker",
      message: "hello",
    });
    const body = typeof result === "string" ? result : JSON.stringify(result);
    assert.ok(
      body.includes("tmux") || body.includes("Not inside"),
      "must return tmux-unavailable error",
    );
  } finally {
    if (prevTmux !== undefined) process.env.TMUX = prevTmux;
  }
});

test("handleSendToWorkerPane: returns error when message is empty", async () => {
  const workersPath = new URL("../lib/workers.js", import.meta.url).pathname;
  const { handleSendToWorkerPane } = await import(
    `${workersPath}?bidir-workers-empty-test=${Date.now()}`
  );

  const prevTmux = process.env.TMUX;
  delete process.env.TMUX;

  try {
    const result = handleSendToWorkerPane({ worker_name: "w", message: "" });
    const body = typeof result === "string" ? result : JSON.stringify(result);
    assert.ok(body.includes("required"), "must require a non-empty message");
  } finally {
    if (prevTmux !== undefined) process.env.TMUX = prevTmux;
  }
});
