/**
 * E2E tests for plan approval full lifecycle.
 *
 * Proves the complete protocol exchange between a worker running in plan mode
 * and the lead:
 *   1. Worker sends plan_approval_request → appears in lead's inbox
 *   2. Lead responds approve=true → [APPROVED] lands in worker's inbox
 *   3. Lead responds approve=false + feedback → [REVISION] + feedback in worker's inbox
 *   4. Full lifecycle: request → approve → revised request → revision
 *
 * Coverage:
 *   1. plan_approval_request written to lead inbox via coord_send_message
 *   2. plan_approval_response approve=true writes [APPROVED] to worker inbox
 *   3. plan_approval_response approve=false writes [REVISION] + feedback text
 *   4. Both approve and revision messages carry protocol_type field
 *   5. Full lifecycle round-trip across two plan iterations
 *   6. Recipient resolution by worker_name (not just session ID)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function contentText(result) {
  return result?.content?.[0]?.text || '';
}

async function loadCoord(home) {
  const prev = {
    HOME: process.env.HOME,
    COORDINATOR_TEST_MODE: process.env.COORDINATOR_TEST_MODE,
    COORDINATOR_PLATFORM: process.env.COORDINATOR_PLATFORM,
    COORDINATOR_CLAUDE_BIN: process.env.COORDINATOR_CLAUDE_BIN,
    TMUX: process.env.TMUX,
  };
  process.env.HOME = home;
  process.env.COORDINATOR_TEST_MODE = '1';
  process.env.COORDINATOR_PLATFORM = 'linux';
  process.env.COORDINATOR_CLAUDE_BIN = 'echo';
  delete process.env.TMUX;
  const mod = await import(`../index.js?e2e-plan=${Date.now()}-${Math.random()}`);
  return {
    api: mod.__test__,
    restore: () => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), 'coord-e2e-plan-'));
  const terminals = join(home, '.claude', 'terminals');
  mkdirSync(join(terminals, 'inbox'), { recursive: true });
  mkdirSync(join(terminals, 'results'), { recursive: true });
  mkdirSync(join(terminals, 'teams'), { recursive: true });
  mkdirSync(join(home, '.claude', 'session-cache'), { recursive: true });
  return {
    home,
    terminals,
    inbox: join(terminals, 'inbox'),
    results: join(terminals, 'results'),
  };
}

/** Register a session file so the coordinator can route messages to it. */
function registerSession(terminals, inbox, sessionId, workerName = null) {
  writeFileSync(
    join(terminals, `session-${sessionId}.json`),
    JSON.stringify({
      session: sessionId,
      worker_name: workerName,
      status: 'active',
      last_active: new Date().toISOString(),
    }),
  );
  writeFileSync(join(inbox, `${sessionId}.jsonl`), '');
}

function readInbox(inboxDir, sessionId) {
  const file = join(inboxDir, `${sessionId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('E2E Plan: worker sends plan_approval_request, appears in lead inbox', async () => {
  const { home, terminals, inbox } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    const leadSid = 'lead1111';
    const workerSid = 'wrkr2222';
    registerSession(terminals, inbox, leadSid);
    registerSession(terminals, inbox, workerSid, 'plan-worker');

    // Worker in plan mode signals lead via coord_send_message
    api.handleToolCall('coord_send_message', {
      from: workerSid,
      to: leadSid,
      content: '[PLAN READY] plan-task-01 — I have a 3-step plan ready for your approval',
      summary: 'plan ready for approval',
    });

    const leadMsgs = readInbox(inbox, leadSid);
    assert.equal(leadMsgs.length, 1, 'lead inbox must have the plan request');
    assert.match(leadMsgs[0].content, /PLAN READY/, 'must contain PLAN READY marker');
    assert.equal(leadMsgs[0].from, workerSid, 'message must be from the worker');
    assert.ok(leadMsgs[0].ts, 'message must have a timestamp');
  } finally {
    restore();
  }
});

test('E2E Plan: lead sends plan_approval_response approve=true → [APPROVED] in worker inbox', async () => {
  const { home, terminals, inbox } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    const workerSid = 'wrkr3333';
    registerSession(terminals, inbox, workerSid, 'plan-worker');

    const result = api.handleToolCall('coord_send_protocol', {
      type: 'plan_approval_response',
      from: 'lead',
      to: workerSid,
      approve: true,
    });
    assert.match(contentText(result), /Protocol message sent/i, 'must confirm send');

    const msgs = readInbox(inbox, workerSid);
    assert.equal(msgs.length, 1, 'exactly one protocol message in worker inbox');
    assert.match(msgs[0].content, /\[APPROVED\]/, 'content must be [APPROVED]');
    assert.equal(msgs[0].protocol_type, 'plan_approval_response', 'protocol_type must be set');
    assert.equal(msgs[0].from, 'lead', 'message must be from lead');
  } finally {
    restore();
  }
});

test('E2E Plan: lead responds approve=false with feedback → [REVISION] + feedback in worker inbox', async () => {
  const { home, terminals, inbox } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    const workerSid = 'wrkr4444';
    registerSession(terminals, inbox, workerSid, 'plan-worker-2');

    api.handleToolCall('coord_send_protocol', {
      type: 'plan_approval_response',
      from: 'lead',
      to: workerSid,
      approve: false,
      content: 'Step 2 needs to handle the edge case where the DB is unavailable',
    });

    const msgs = readInbox(inbox, workerSid);
    assert.equal(msgs.length, 1, 'one revision message in worker inbox');
    assert.match(msgs[0].content, /\[REVISION\]/, 'content must be [REVISION]');
    assert.match(
      msgs[0].content,
      /DB is unavailable/,
      'feedback text must appear verbatim in message content',
    );
    assert.equal(msgs[0].protocol_type, 'plan_approval_response');
  } finally {
    restore();
  }
});

test('E2E Plan: full lifecycle — request → approve → revised request → revision with feedback', async () => {
  const { home, terminals, inbox } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    const leadSid = 'lead5555';
    const workerSid = 'wrkr6666';
    registerSession(terminals, inbox, leadSid);
    registerSession(terminals, inbox, workerSid, 'plan-worker-3');

    // Phase 1: worker sends plan request
    api.handleToolCall('coord_send_message', {
      from: workerSid,
      to: leadSid,
      content: '[PLAN READY] plan-task-01',
    });
    assert.equal(readInbox(inbox, leadSid).length, 1, 'lead must receive initial plan request');

    // Phase 2: lead approves
    api.handleToolCall('coord_send_protocol', {
      type: 'plan_approval_response',
      from: 'lead',
      to: workerSid,
      approve: true,
    });
    const workerMsgs1 = readInbox(inbox, workerSid);
    assert.equal(workerMsgs1.length, 1, 'worker must have approval');
    assert.match(workerMsgs1[0].content, /\[APPROVED\]/);

    // Phase 3: worker submits revised plan
    api.handleToolCall('coord_send_message', {
      from: workerSid,
      to: leadSid,
      content: '[PLAN READY] plan-task-01 revised with rollback steps',
    });
    assert.equal(readInbox(inbox, leadSid).length, 2, 'lead must have both plan messages');

    // Phase 4: lead requests revision with specific feedback
    api.handleToolCall('coord_send_protocol', {
      type: 'plan_approval_response',
      from: 'lead',
      to: workerSid,
      approve: false,
      content: 'Please add rollback steps for the database migration',
    });
    const workerMsgs2 = readInbox(inbox, workerSid);
    assert.equal(workerMsgs2.length, 2, 'worker must have both approval and revision messages');
    const revisionMsg = workerMsgs2[1];
    assert.match(revisionMsg.content, /\[REVISION\]/, 'second message must be a revision request');
    assert.match(revisionMsg.content, /rollback/, 'revision must include feedback about rollback');
  } finally {
    restore();
  }
});

test('E2E Plan: coord_send_protocol resolves worker by name when recipient= is used', async () => {
  const { home, terminals, inbox } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    const workerSid = 'wrkr7777';
    registerSession(terminals, inbox, workerSid, 'plan-worker-named');

    // Use recipient= (worker name) instead of to= (session ID)
    const result = api.handleToolCall('coord_send_protocol', {
      type: 'plan_approval_response',
      from: 'lead',
      recipient: 'plan-worker-named',
      approve: true,
    });
    assert.match(contentText(result), /Protocol message sent/i, 'must confirm send by name');

    const msgs = readInbox(inbox, workerSid);
    assert.equal(msgs.length, 1, 'message must reach the worker inbox via name resolution');
    assert.match(msgs[0].content, /\[APPROVED\]/);
  } finally {
    restore();
  }
});

// ─── File-Based Approval Gate Tests (coord_approve_plan / coord_reject_plan) ──

test('Plan Approval Gate: coord_approve_plan writes approval file with status=approved', async () => {
  const { home, terminals, inbox, results } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    const taskId = 'task-appr-01';
    // Write meta file so coord_approve_plan can find the task
    writeFileSync(
      join(results, `${taskId}.meta.json`),
      JSON.stringify({ task_id: taskId, worker_name: 'plan-worker', team_name: 'test-team' }),
    );

    const result = api.handleToolCall('coord_approve_plan', {
      task_id: taskId,
      message: 'Looks great, proceed.',
    });
    assert.match(contentText(result), /Plan approved/i, 'must confirm approval');

    const approvalFile = join(results, `${taskId}.approval`);
    assert.ok(existsSync(approvalFile), 'approval file must exist after coord_approve_plan');
    const approval = JSON.parse(readFileSync(approvalFile, 'utf8'));
    assert.equal(approval.status, 'approved', 'approval file must record status=approved');
    assert.match(approval.message, /Looks great/, 'approval file must include the message');
    assert.ok(approval.ts, 'approval file must have a timestamp');
  } finally {
    restore();
  }
});

test('Plan Approval Gate: coord_approve_plan delivers [APPROVED] to worker inbox via current_task', async () => {
  const { home, terminals, inbox, results } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    const taskId = 'task-appr-02';
    const workerSid = 'wrkr8888';

    // Write meta and session files; session must have current_task set so findWorkerSessionId resolves it
    writeFileSync(
      join(results, `${taskId}.meta.json`),
      JSON.stringify({ task_id: taskId, worker_name: 'plan-worker-2' }),
    );
    writeFileSync(
      join(terminals, `session-${workerSid}.json`),
      JSON.stringify({
        session: workerSid,
        worker_name: 'plan-worker-2',
        current_task: taskId,
        status: 'active',
        last_active: new Date().toISOString(),
      }),
    );
    writeFileSync(join(inbox, `${workerSid}.jsonl`), '');

    api.handleToolCall('coord_approve_plan', { task_id: taskId });

    const msgs = readInbox(inbox, workerSid);
    assert.equal(msgs.length, 1, 'worker inbox must have the approval notification');
    assert.match(msgs[0].content, /\[APPROVED\]/, 'inbox message must contain [APPROVED]');
    assert.ok(msgs[0].content.includes(taskId), 'inbox message must reference the task ID');
  } finally {
    restore();
  }
});

test('Plan Approval Gate: coord_reject_plan writes revision file with feedback', async () => {
  const { home, terminals, inbox, results } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    const taskId = 'task-rej-01';
    writeFileSync(
      join(results, `${taskId}.meta.json`),
      JSON.stringify({ task_id: taskId, worker_name: 'plan-worker-3' }),
    );

    const result = api.handleToolCall('coord_reject_plan', {
      task_id: taskId,
      feedback: 'Add error handling for the network timeout case.',
    });
    assert.match(contentText(result), /revision requested/i, 'must confirm revision request');

    const revisionFile = join(results, `${taskId}.approval`);
    assert.ok(existsSync(revisionFile), 'revision file must exist after coord_reject_plan');
    const revision = JSON.parse(readFileSync(revisionFile, 'utf8'));
    assert.equal(revision.status, 'revision_requested');
    assert.match(revision.feedback, /network timeout/, 'feedback must appear verbatim in file');
    assert.ok(revision.ts, 'revision file must have a timestamp');
  } finally {
    restore();
  }
});

test('Plan Approval Gate: coord_reject_plan delivers [REVISION] to worker inbox', async () => {
  const { home, terminals, inbox, results } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    const taskId = 'task-rej-02';
    const workerSid = 'wrkr9999';

    writeFileSync(
      join(results, `${taskId}.meta.json`),
      JSON.stringify({ task_id: taskId, worker_name: 'plan-worker-4' }),
    );
    writeFileSync(
      join(terminals, `session-${workerSid}.json`),
      JSON.stringify({
        session: workerSid,
        current_task: taskId,
        status: 'active',
        last_active: new Date().toISOString(),
      }),
    );
    writeFileSync(join(inbox, `${workerSid}.jsonl`), '');

    api.handleToolCall('coord_reject_plan', {
      task_id: taskId,
      feedback: 'Must handle the rollback case.',
    });

    const msgs = readInbox(inbox, workerSid);
    assert.equal(msgs.length, 1, 'worker inbox must have the revision notification');
    assert.match(msgs[0].content, /\[REVISION\]/, 'inbox message must contain [REVISION]');
    assert.match(msgs[0].content, /rollback/, 'feedback text must appear in the inbox message');
  } finally {
    restore();
  }
});

test('Plan Approval Gate: no auto-approve — approval file absent before any lead action', async () => {
  const { home, terminals, inbox, results } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    const taskId = 'task-noauto-01';
    // Write meta file (simulating worker has written its plan) but take NO lead action
    writeFileSync(
      join(results, `${taskId}.meta.json`),
      JSON.stringify({ task_id: taskId, worker_name: 'plan-worker-5' }),
    );
    writeFileSync(
      join(results, `${taskId}.plan.md`),
      '# Plan\n\nStep 1: do stuff\nStep 2: do more stuff',
    );

    const approvalFile = join(results, `${taskId}.approval`);
    assert.ok(
      !existsSync(approvalFile),
      'approval file must NOT exist — no auto-approve should occur',
    );
  } finally {
    restore();
  }
});

test('Plan Approval Gate: coord_approve_plan returns error when task meta file not found', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    const result = api.handleToolCall('coord_approve_plan', {
      task_id: 'nonexistent-task',
    });
    assert.match(contentText(result), /not found/i, 'must report task not found');
    assert.doesNotMatch(contentText(result), /Plan approved/i, 'must not claim approval succeeded');
  } finally {
    restore();
  }
});
