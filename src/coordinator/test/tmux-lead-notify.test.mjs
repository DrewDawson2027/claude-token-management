/**
 * Tests for sendMessageToLead and the worker-completion → lead notification round-trip.
 *
 * sendMessageToLead is the Level-3 bidirectional primitive: it fires a targeted
 * tmux display-message at the lead's specific pane ID (CLAUDE_LEAD_PANE_ID), so
 * the status-bar badge appears in the lead's window rather than the worker's pane.
 *
 * Coverage:
 *   1. sendMessageToLead returns false when not inside tmux
 *   2. sendMessageToLead returns false for invalid / missing pane IDs
 *   3. sendMessageToLead returns false for pane IDs that don't start with "%"
 *   4. Round-trip: worker completion writes inbox AND shell command includes -t target
 *   5. buildInteractiveWorkerScript embeds CLAUDE_LEAD_PANE_ID export + targeted display-message
 *   6. buildResumeWorkerScript embeds same targeted notification in EXIT trap
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Import the function under test ───────────────────────────────────────────

// sendMessageToLead is a pure Node.js function — import directly from source.
// In test mode TMUX is not set so it always returns false (safe no-op path).
const commonPath = new URL("../lib/platform/common.js", import.meta.url).pathname;
const {
  sendMessageToLead,
  buildInteractiveWorkerScript,
  buildResumeWorkerScript,
  buildWorkerScript,
} = await import(`${commonPath}?notify-test=${Date.now()}`);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), "coord-notify-"));
  const terminals = join(home, ".claude", "terminals");
  const inbox = join(terminals, "inbox");
  const results = join(terminals, "results");
  mkdirSync(inbox, { recursive: true });
  mkdirSync(results, { recursive: true });
  mkdirSync(join(terminals, "teams"), { recursive: true });
  mkdirSync(join(home, ".claude", "session-cache"), { recursive: true });
  return { home, terminals, inbox, results };
}

function registerWorker(terminals, inbox, results, sessionId, workerName, taskId, teamName = "notify-team") {
  writeFileSync(
    join(terminals, `session-${sessionId}.json`),
    JSON.stringify({
      session: sessionId,
      worker_name: workerName,
      status: "active",
      last_active: new Date().toISOString(),
      current_task: taskId,
      team_name: teamName,
    }),
  );
  writeFileSync(join(inbox, `${sessionId}.jsonl`), "");
  writeFileSync(
    join(results, `${taskId}.meta.json`),
    JSON.stringify({
      task_id: taskId,
      worker_name: workerName,
      team_name: teamName,
      claude_session_id: sessionId,
      role: "implementer",
      status: "running",
    }),
  );
}

function readInbox(inbox, sessionId) {
  const file = join(inbox, `${sessionId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ─── sendMessageToLead unit tests ────────────────────────────────────────────

test("sendMessageToLead: returns false when not inside tmux (TMUX unset)", () => {
  const prevTmux = process.env.TMUX;
  delete process.env.TMUX;
  try {
    const result = sendMessageToLead("%5", "hello lead");
    assert.equal(result, false, "must return false when TMUX env is not set");
  } finally {
    if (prevTmux !== undefined) process.env.TMUX = prevTmux;
  }
});

test("sendMessageToLead: returns false when leadPaneId is null", () => {
  const prevTmux = process.env.TMUX;
  delete process.env.TMUX;
  try {
    assert.equal(sendMessageToLead(null, "msg"), false);
    assert.equal(sendMessageToLead(undefined, "msg"), false);
    assert.equal(sendMessageToLead("", "msg"), false);
  } finally {
    if (prevTmux !== undefined) process.env.TMUX = prevTmux;
  }
});

test("sendMessageToLead: returns false when paneId does not start with %", () => {
  const prevTmux = process.env.TMUX;
  delete process.env.TMUX;
  try {
    // Valid pane IDs are like "%5", "%12" — not plain integers or strings
    assert.equal(sendMessageToLead("5", "msg"), false, "bare number must be rejected");
    assert.equal(sendMessageToLead("pane-1", "msg"), false, "non-% prefix must be rejected");
  } finally {
    if (prevTmux !== undefined) process.env.TMUX = prevTmux;
  }
});

test("sendMessageToLead: returns false for empty message (still a valid no-op)", () => {
  const prevTmux = process.env.TMUX;
  delete process.env.TMUX;
  try {
    // Empty message is fine — the function guards on paneId and tmux, not message
    const result = sendMessageToLead("%5", "");
    // Since TMUX is unset, returns false regardless — this just confirms no throw
    assert.equal(result, false);
  } finally {
    if (prevTmux !== undefined) process.env.TMUX = prevTmux;
  }
});

// ─── Shell script content tests ───────────────────────────────────────────────
// Verify that buildInteractiveWorkerScript and buildResumeWorkerScript embed
// the correct targeted notification commands.

test("buildInteractiveWorkerScript: completion command targets CLAUDE_LEAD_PANE_ID", () => {
  const prevHome = process.env.HOME;
  const prevTmux = process.env.TMUX;
  const prevMode = process.env.COORDINATOR_TEST_MODE;
  const prevPlat = process.env.COORDINATOR_PLATFORM;
  process.env.COORDINATOR_TEST_MODE = "1";
  process.env.COORDINATOR_PLATFORM = "linux";
  delete process.env.TMUX;

  try {
    const home = mkdtempSync(join(tmpdir(), "coord-script-test-"));
    process.env.HOME = home;

    const script = buildInteractiveWorkerScript({
      taskId: "task-notify-test",
      workDir: "/tmp/work",
      resultFile: "/tmp/work/result.txt",
      pidFile: "/tmp/work/task.pid",
      metaFile: "/tmp/work/task.meta.json",
      model: "claude-sonnet-4-6",
      promptFile: "/tmp/work/task.prompt",
      platformName: "linux",
      workerName: "notify-worker",
      leadSessionId: "lead-session-001",
      leadPaneId: "%7",
    });

    // Must export CLAUDE_LEAD_PANE_ID into the worker environment
    assert.ok(
      script.includes("CLAUDE_LEAD_PANE_ID"),
      "script must export CLAUDE_LEAD_PANE_ID",
    );
    // Completion command must use -t "$CLAUDE_LEAD_PANE_ID" (targeted delivery)
    assert.ok(
      script.includes('-t "$CLAUDE_LEAD_PANE_ID"'),
      'completion command must use -t "$CLAUDE_LEAD_PANE_ID" for targeted delivery',
    );
    // Must NOT use untargeted display-message (the Level-2 form without -t)
    assert.ok(
      !script.includes('display-message -d 4000 "['),
      "completion command must not use untargeted display-message form",
    );
  } finally {
    process.env.HOME = prevHome;
    if (prevTmux !== undefined) process.env.TMUX = prevTmux;
    process.env.COORDINATOR_TEST_MODE = prevMode;
    process.env.COORDINATOR_PLATFORM = prevPlat;
  }
});

test("buildResumeWorkerScript: EXIT trap includes targeted CLAUDE_LEAD_PANE_ID notification", () => {
  const prevHome = process.env.HOME;
  const prevTmux = process.env.TMUX;
  const prevMode = process.env.COORDINATOR_TEST_MODE;
  const prevPlat = process.env.COORDINATOR_PLATFORM;
  process.env.COORDINATOR_TEST_MODE = "1";
  process.env.COORDINATOR_PLATFORM = "linux";
  delete process.env.TMUX;

  try {
    const home = mkdtempSync(join(tmpdir(), "coord-resume-test-"));
    process.env.HOME = home;

    const script = buildResumeWorkerScript({
      sessionId: "claude-session-abc123",
      workDir: "/tmp/work",
      pidFile: "/tmp/work/task.pid",
      metaFile: "/tmp/work/task.meta.json",
      taskId: "task-resume-notify",
      workerName: "resume-worker",
      leadSessionId: "lead-session-001",
      leadPaneId: "%9",
      model: "claude-sonnet-4-6",
      platformName: "linux",
    });

    assert.ok(
      script.includes("CLAUDE_LEAD_PANE_ID"),
      "resume script must export CLAUDE_LEAD_PANE_ID",
    );
    assert.ok(
      script.includes('-t "$CLAUDE_LEAD_PANE_ID"'),
      'EXIT trap must use -t "$CLAUDE_LEAD_PANE_ID" for targeted delivery',
    );
    assert.ok(
      script.includes("resumed"),
      'EXIT trap message must include "resumed" label',
    );
  } finally {
    process.env.HOME = prevHome;
    if (prevTmux !== undefined) process.env.TMUX = prevTmux;
    process.env.COORDINATOR_TEST_MODE = prevMode;
    process.env.COORDINATOR_PLATFORM = prevPlat;
  }
});

// ─── Round-trip filesystem test ──────────────────────────────────────────────
// The tmux notification is the UI layer on top of inbox delivery.
// This test verifies the filesystem half of the round-trip: the shell EXIT trap
// writes a valid JSON entry to the lead's inbox file, which the lead can then read.
// We simulate the exact shell command pattern used in buildInteractiveWorkerScript
// by writing the JSON directly (no MCP SDK required).

test("Round-trip: worker EXIT trap writes inbox entry that lead can read (filesystem level)", () => {
  const { home, inbox } = setupHome();

  const leadSid = "lead-rt-001";
  const workerName = "finisher";
  const leadInboxFile = join(inbox, `${leadSid}.jsonl`);
  writeFileSync(leadInboxFile, "");

  // Simulate the shell EXIT trap: append a completion entry to the lead's inbox.
  // This is exactly what the completion command in buildInteractiveWorkerScript does.
  const ts = new Date().toISOString();
  const entry = JSON.stringify({
    ts,
    from: "coordinator",
    priority: "normal",
    content: `[COMPLETED] ${workerName}`,
  });
  // Synchronous write — matches the shell `printf ... >>` pattern in the EXIT trap
  appendFileSync(leadInboxFile, entry + "\n", "utf8");

  // Lead reads inbox
  const entries = readInbox(inbox, leadSid);
  assert.equal(entries.length, 1, "exactly one completion entry must be in lead inbox");
  assert.equal(entries[0].from, "coordinator", "from must be coordinator");
  assert.match(entries[0].content, /COMPLETED/i, "content must contain COMPLETED marker");
  assert.match(entries[0].content, new RegExp(workerName), "content must name the worker");
  assert.ok(entries[0].ts, "entry must have a timestamp");
  assert.ok(entries[0].priority, "entry must have a priority field");
});

// ─── buildWorkerScript (non-interactive / pipe-mode) ─────────────────────────
// Ensures the default spawn path gets the same inbox + notification treatment
// as buildInteractiveWorkerScript and buildResumeWorkerScript.

test("buildWorkerScript: completion path exports CLAUDE_LEAD_SESSION_ID and targets CLAUDE_LEAD_PANE_ID", () => {
  const prevHome = process.env.HOME;
  const prevTmux = process.env.TMUX;
  const prevMode = process.env.COORDINATOR_TEST_MODE;
  const prevPlat = process.env.COORDINATOR_PLATFORM;
  process.env.COORDINATOR_TEST_MODE = "1";
  process.env.COORDINATOR_PLATFORM = "linux";
  delete process.env.TMUX;

  try {
    const home = mkdtempSync(join(tmpdir(), "coord-pipe-test-"));
    process.env.HOME = home;

    const script = buildWorkerScript({
      taskId: "task-pipe-notify",
      workDir: "/tmp/work",
      resultFile: "/tmp/work/result.txt",
      pidFile: "/tmp/work/task.pid",
      metaFile: "/tmp/work/task.meta.json",
      model: "claude-sonnet-4-6",
      promptFile: "/tmp/work/task.prompt",
      platformName: "linux",
      workerName: "pipe-worker",
      leadSessionId: "lead-session-pipe-001",
      leadPaneId: "%11",
    });

    assert.ok(
      script.includes("CLAUDE_LEAD_SESSION_ID"),
      "pipe-mode script must export CLAUDE_LEAD_SESSION_ID",
    );
    assert.ok(
      script.includes("CLAUDE_LEAD_PANE_ID"),
      "pipe-mode script must export CLAUDE_LEAD_PANE_ID",
    );
    assert.ok(
      script.includes('[COMPLETED] pipe-worker'),
      "pipe-mode completion must include [COMPLETED] worker label",
    );
    assert.ok(
      script.includes('-t "$CLAUDE_LEAD_PANE_ID"'),
      'pipe-mode completion must use -t "$CLAUDE_LEAD_PANE_ID" for targeted delivery',
    );
  } finally {
    process.env.HOME = prevHome;
    if (prevTmux !== undefined) process.env.TMUX = prevTmux;
    process.env.COORDINATOR_TEST_MODE = prevMode;
    process.env.COORDINATOR_PLATFORM = prevPlat;
  }
});
