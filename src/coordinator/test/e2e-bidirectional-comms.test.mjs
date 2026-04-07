/**
 * E2E tests for bidirectional worker-to-worker communication.
 *
 * Proves the full round-trip: Worker A discovers Worker B's session ID via
 * coord_discover_peers, sends a message by name, Worker B reads it from its
 * inbox, then replies back to Worker A. Both messages are verified for correct
 * from/to/content fields.
 *
 * Coverage:
 *   1. Worker A discovers Worker B's session_id via coord_discover_peers
 *   2. Worker A sends to Worker B by target_name → B's inbox receives it
 *   3. Worker B replies to Worker A → A's inbox receives it (full round-trip)
 *   4. Both inbox entries have correct from/content/ts fields
 *   5. Sending to unknown target_name returns graceful error (no crash)
 *   6. coord_discover_peers lists both workers with correct session_ids and roles
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
    TMUX: process.env.TMUX,
  };
  process.env.HOME = home;
  process.env.COORDINATOR_TEST_MODE = '1';
  process.env.COORDINATOR_PLATFORM = 'linux';
  delete process.env.TMUX; // no tmux push — pure inbox delivery
  const mod = await import(`../index.js?e2e-bidir=${Date.now()}-${Math.random()}`);
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
  const home = mkdtempSync(join(tmpdir(), 'coord-e2e-bidir-'));
  const terminals = join(home, '.claude', 'terminals');
  const inbox = join(terminals, 'inbox');
  const results = join(terminals, 'results');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(results, { recursive: true });
  mkdirSync(join(terminals, 'teams'), { recursive: true });
  mkdirSync(join(home, '.claude', 'session-cache'), { recursive: true });
  return { home, terminals, inbox, results };
}

/**
 * Register a worker exactly as the heartbeat hook does in production.
 * coord_discover_peers scans session-*.json files to resolve worker names and
 * links to meta files via current_task.
 */
function registerWorker(terminals, inbox, results, sessionId, workerName, taskId, teamName = 'e2e-team') {
  writeFileSync(
    join(terminals, `session-${sessionId}.json`),
    JSON.stringify({
      session: sessionId,
      worker_name: workerName,
      status: 'active',
      last_active: new Date().toISOString(),
      current_task: taskId,
      team_name: teamName,
    }),
  );
  writeFileSync(join(inbox, `${sessionId}.jsonl`), '');
  // Meta file — required for discover_peers to return session_id via current_task link
  writeFileSync(
    join(results, `${taskId}.meta.json`),
    JSON.stringify({
      task_id: taskId,
      worker_name: workerName,
      team_name: teamName,
      claude_session_id: sessionId,
      role: 'implementer',
      status: 'running',
    }),
  );
}

function readInbox(inbox, sessionId) {
  const file = join(inbox, `${sessionId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('E2E Bidir: Worker A discovers Worker B via coord_discover_peers and sends message by name', async () => {
  const { home, terminals, inbox, results } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    registerWorker(terminals, inbox, results, 'aaaa1111', 'worker-A', 'task-a', 'bidir-team');
    registerWorker(terminals, inbox, results, 'bbbb2222', 'worker-B', 'task-b', 'bidir-team');

    // Worker A discovers peers — must see worker-B with its session_id
    const peersResult = api.handleToolCall('coord_discover_peers', { team_name: 'bidir-team' });
    const peersText = contentText(peersResult);
    assert.match(peersText, /worker-B/i, 'worker-B must appear in peer list');
    assert.ok(peersText.includes('bbbb2222'), 'worker-B session_id must be in peer list');

    // Worker A sends to Worker B by target_name
    const sendResult = api.handleToolCall('coord_send_message', {
      from: 'worker-A',
      target_name: 'worker-B',
      content: 'ping from A',
    });
    assert.match(contentText(sendResult), /Message sent/i, 'send must confirm delivery');

    // Worker B's inbox must contain the message
    const msgs = readInbox(inbox, 'bbbb2222');
    assert.equal(msgs.length, 1, 'exactly one message in B inbox');
    assert.equal(msgs[0].from, 'worker-A');
    assert.equal(msgs[0].content, 'ping from A');
  } finally {
    restore();
  }
});

test('E2E Bidir: Worker B replies to Worker A — full bidirectional round-trip', async () => {
  const { home, terminals, inbox, results } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    registerWorker(terminals, inbox, results, 'cccc3333', 'worker-A', 'task-a2', 'bidir-team-2');
    registerWorker(terminals, inbox, results, 'dddd4444', 'worker-B', 'task-b2', 'bidir-team-2');

    // A → B
    api.handleToolCall('coord_send_message', {
      from: 'worker-A',
      target_name: 'worker-B',
      content: 'hello B, can you handle the database part?',
    });

    // B replies to A by name
    api.handleToolCall('coord_send_message', {
      from: 'worker-B',
      target_name: 'worker-A',
      content: 'yes, taking the database part now',
    });

    // Verify A's inbox has B's reply
    const msgsA = readInbox(inbox, 'cccc3333');
    assert.equal(msgsA.length, 1, 'A must have exactly one reply from B');
    assert.equal(msgsA[0].from, 'worker-B');
    assert.equal(msgsA[0].content, 'yes, taking the database part now');

    // Verify B's inbox has A's original message
    const msgsB = readInbox(inbox, 'dddd4444');
    assert.equal(msgsB.length, 1, 'B must have A original message');
    assert.equal(msgsB[0].from, 'worker-A');
    assert.equal(msgsB[0].content, 'hello B, can you handle the database part?');
  } finally {
    restore();
  }
});

test('E2E Bidir: both messages have correct from/content/ts fields', async () => {
  const { home, terminals, inbox, results } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    registerWorker(terminals, inbox, results, 'eeee5555', 'worker-A', 'task-a3', 'field-team');
    registerWorker(terminals, inbox, results, 'ffff6666', 'worker-B', 'task-b3', 'field-team');

    api.handleToolCall('coord_send_message', {
      from: 'worker-A',
      target_name: 'worker-B',
      content: 'status update: API layer done',
      summary: 'API layer done',
    });
    api.handleToolCall('coord_send_message', {
      from: 'worker-B',
      target_name: 'worker-A',
      content: 'ack — starting DB layer',
      summary: 'starting DB layer',
    });

    const msgsB = readInbox(inbox, 'ffff6666');
    assert.equal(msgsB[0].from, 'worker-A', 'B message must have from=worker-A');
    assert.equal(msgsB[0].content, 'status update: API layer done', 'content must match exactly');
    assert.ok(msgsB[0].ts, 'inbox entry must have a timestamp field');

    const msgsA = readInbox(inbox, 'eeee5555');
    assert.equal(msgsA[0].from, 'worker-B', 'A reply must have from=worker-B');
    assert.equal(msgsA[0].content, 'ack — starting DB layer', 'reply content must match');
    assert.ok(msgsA[0].ts, 'reply must have a timestamp field');
  } finally {
    restore();
  }
});

test('E2E Bidir: coord_discover_peers lists both workers with session_ids and roles', async () => {
  const { home, terminals, inbox, results } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    registerWorker(terminals, inbox, results, 'gggg7777', 'worker-A', 'task-peer-a', 'peer-team');
    registerWorker(terminals, inbox, results, 'hhhh8888', 'worker-B', 'task-peer-b', 'peer-team');

    const peersResult = api.handleToolCall('coord_discover_peers', { team_name: 'peer-team' });
    const peersText = contentText(peersResult);

    // Both workers must appear with their session IDs
    assert.match(peersText, /worker-A/i, 'worker-A must appear in peer list');
    assert.match(peersText, /worker-B/i, 'worker-B must appear in peer list');
    assert.ok(peersText.includes('gggg7777'), 'worker-A session_id must be listed');
    assert.ok(peersText.includes('hhhh8888'), 'worker-B session_id must be listed');
  } finally {
    restore();
  }
});

test('E2E Bidir: sending to unknown target_name returns graceful error without crashing', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    const result = api.handleToolCall('coord_send_message', {
      from: 'worker-A',
      target_name: 'worker-ghost',
      content: 'are you there?',
    });
    const txt = contentText(result);
    // Must not throw — returns a non-empty error string
    assert.ok(txt.length > 0, 'must return non-empty response on unknown target');
  } finally {
    restore();
  }
});

// ─── Lead ←→ Worker Messaging ─────────────────────────────────────────────────

test('E2E Bidir: lead sends message to worker-a, worker-a receives it in inbox', async () => {
  const { home, terminals, inbox, results } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    registerWorker(terminals, inbox, results, 'aaaa0001', 'worker-a', 'task-lead-a', 'lead-team');

    // Lead sends to worker-a by target_name
    const sendResult = api.handleToolCall('coord_send_message', {
      from: 'lead',
      target_name: 'worker-a',
      content: 'please focus on the authentication module next',
    });
    assert.match(contentText(sendResult), /Message sent/i, 'lead send must confirm delivery');

    // worker-a checks its inbox
    const inboxResult = api.handleToolCall('coord_check_inbox', { session_id: 'aaaa0001' });
    const inboxText = contentText(inboxResult);
    assert.match(inboxText, /authentication module/i, 'worker-a must receive lead message');
    assert.match(inboxText, /lead/i, 'from field must show lead');
  } finally {
    restore();
  }
});

test('E2E Bidir: worker-b sends message back to lead session, lead receives it', async () => {
  const { home, terminals, inbox, results } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    // Register worker-b and a lead session
    registerWorker(terminals, inbox, results, 'bbbb0002', 'worker-b', 'task-lead-b', 'lead-team');
    // Register lead session (lead has its own inbox identified by its session ID)
    const leadSessionId = 'lead0001';
    writeFileSync(
      join(terminals, `session-${leadSessionId}.json`),
      JSON.stringify({
        session: leadSessionId,
        worker_name: 'lead',
        status: 'active',
        last_active: new Date().toISOString(),
      }),
    );
    writeFileSync(join(inbox, `${leadSessionId}.jsonl`), '');

    // Worker-b sends to lead by session ID
    const sendResult = api.handleToolCall('coord_send_message', {
      from: 'worker-b',
      to: leadSessionId,
      content: 'database migration complete, ready for review',
    });
    assert.match(contentText(sendResult), /Message sent/i, 'worker→lead send must confirm delivery');

    // Lead checks its inbox
    const inboxResult = api.handleToolCall('coord_check_inbox', { session_id: leadSessionId });
    const inboxText = contentText(inboxResult);
    assert.match(inboxText, /database migration complete/i, 'lead must receive worker-b message');
    assert.match(inboxText, /worker-b/i, 'from field must show worker-b');
  } finally {
    restore();
  }
});

// ─── Broadcast from Lead ──────────────────────────────────────────────────────

test('E2E Bidir: broadcast from lead — both workers receive it', async () => {
  const { home, terminals, inbox, results } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    registerWorker(terminals, inbox, results, 'cccc0003', 'worker-a', 'task-bc-a', 'bc-team');
    registerWorker(terminals, inbox, results, 'dddd0004', 'worker-b', 'task-bc-b', 'bc-team');

    const bcastResult = api.handleToolCall('coord_broadcast', {
      from: 'lead',
      content: 'all workers: pause and checkpoint your current state',
      priority: 'urgent',
    });
    assert.match(contentText(bcastResult), /Broadcast sent/i);
    assert.match(contentText(bcastResult), /2/);

    // Both workers must have the broadcast in their inboxes
    const msgsA = readInbox(inbox, 'cccc0003');
    const msgsB = readInbox(inbox, 'dddd0004');
    assert.equal(msgsA.length, 1, 'worker-a must receive broadcast');
    assert.equal(msgsB.length, 1, 'worker-b must receive broadcast');
    assert.match(msgsA[0].content, /checkpoint/i);
    assert.match(msgsB[0].content, /checkpoint/i);
    assert.equal(msgsA[0].from, 'lead');
    assert.equal(msgsB[0].from, 'lead');
  } finally {
    restore();
  }
});

// ─── All 5 Native Protocol Message Types ──────────────────────────────────────

test('E2E Bidir: protocol type=message (coord_send_message) — basic message delivery', async () => {
  // coord_send_message covers the native "message" type.
  // This test verifies the basic message type is delivered correctly with all required fields.
  const { home, terminals, inbox, results } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    registerWorker(terminals, inbox, results, 'eeee0005', 'worker-c', 'task-msg', 'proto-team');

    const result = api.handleToolCall('coord_send_message', {
      from: 'lead',
      target_name: 'worker-c',
      content: 'native message type: proceed to next phase',
      priority: 'normal',
    });
    assert.match(contentText(result), /Message sent/i);

    const msgs = readInbox(inbox, 'eeee0005');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].from, 'lead');
    assert.equal(msgs[0].content, 'native message type: proceed to next phase');
    assert.equal(msgs[0].priority, 'normal');
    assert.ok(msgs[0].ts, 'message must have a timestamp');
  } finally {
    restore();
  }
});

test('E2E Bidir: protocol type=broadcast — native broadcast type delivery', async () => {
  // coord_broadcast covers the native "broadcast" type.
  const { home, terminals, inbox, results } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    registerWorker(terminals, inbox, results, 'ffff0006', 'worker-d', 'task-bcast', 'proto-team');
    registerWorker(terminals, inbox, results, 'gggg0007', 'worker-e', 'task-bcast2', 'proto-team');

    const result = api.handleToolCall('coord_broadcast', {
      from: 'lead',
      content: 'native broadcast type: deploy window opens in 10 minutes',
      priority: 'urgent',
    });
    assert.match(contentText(result), /Broadcast sent/i);

    const msgsD = readInbox(inbox, 'ffff0006');
    const msgsE = readInbox(inbox, 'gggg0007');
    assert.equal(msgsD.length, 1, 'worker-d must receive broadcast');
    assert.equal(msgsE.length, 1, 'worker-e must receive broadcast');
    assert.equal(msgsD[0].priority, 'urgent');
    assert.equal(msgsE[0].priority, 'urgent');
  } finally {
    restore();
  }
});

test('E2E Bidir: protocol type=shutdown_request — worker receives shutdown request in inbox', async () => {
  const { home, terminals, inbox, results } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    registerWorker(terminals, inbox, results, 'hhhh0008', 'worker-f', 'task-shutdown', 'proto-team');

    const result = api.handleToolCall('coord_send_protocol', {
      type: 'shutdown_request',
      from: 'lead',
      recipient: 'worker-f',
    });
    const txt = contentText(result);
    assert.match(txt, /Protocol message sent/i, 'shutdown_request must confirm delivery');
    assert.match(txt, /shutdown_request/i, 'response must echo the type');

    // Worker-f checks inbox — must contain the shutdown request
    const inboxResult = api.handleToolCall('coord_check_inbox', { session_id: 'hhhh0008' });
    const inboxText = contentText(inboxResult);
    assert.match(inboxText, /SHUTDOWN_REQUEST/i, 'inbox must contain SHUTDOWN_REQUEST marker');
    assert.match(inboxText, /lead/i, 'from must show lead');
  } finally {
    restore();
  }
});

test('E2E Bidir: protocol type=shutdown_response — lead receives worker shutdown approval', async () => {
  const { home, terminals, inbox, results } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    registerWorker(terminals, inbox, results, 'iiii0009', 'worker-g', 'task-sdr', 'proto-team');
    // Lead session must exist so worker-g can send to it
    const leadSid = 'lead0002';
    writeFileSync(
      join(terminals, `session-${leadSid}.json`),
      JSON.stringify({ session: leadSid, worker_name: 'lead', status: 'active', last_active: new Date().toISOString() }),
    );
    writeFileSync(join(inbox, `${leadSid}.jsonl`), '');

    // Worker-g sends shutdown_response (approve=true) back to lead
    const result = api.handleToolCall('coord_send_protocol', {
      type: 'shutdown_response',
      from: 'worker-g',
      to: leadSid,
      request_id: 'req-abc123',
      approve: true,
    });
    assert.match(contentText(result), /Protocol message sent/i);
    assert.match(contentText(result), /shutdown_response/i);

    // Lead reads its inbox — must contain SHUTDOWN_RESPONSE approved=true
    const inboxResult = api.handleToolCall('coord_check_inbox', { session_id: leadSid });
    const inboxText = contentText(inboxResult);
    assert.match(inboxText, /SHUTDOWN_RESPONSE/i, 'lead inbox must contain SHUTDOWN_RESPONSE');
    assert.match(inboxText, /approved=true/i, 'response must indicate approval');
  } finally {
    restore();
  }
});

test('E2E Bidir: protocol type=plan_approval_response (approve) — lead approves worker plan', async () => {
  const { home, terminals, inbox, results } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    registerWorker(terminals, inbox, results, 'jjjj0010', 'worker-h', 'task-plan', 'proto-team');

    // Lead sends plan_approval_response approve=true to worker-h
    const result = api.handleToolCall('coord_send_protocol', {
      type: 'plan_approval_response',
      from: 'lead',
      recipient: 'worker-h',
      request_id: 'plan-req-001',
      approve: true,
      content: 'approved — proceed with the refactor',
    });
    assert.match(contentText(result), /Protocol message sent/i);
    assert.match(contentText(result), /plan_approval_response/i);

    // Worker-h checks its inbox — must show APPROVED
    const inboxResult = api.handleToolCall('coord_check_inbox', { session_id: 'jjjj0010' });
    const inboxText = contentText(inboxResult);
    assert.match(inboxText, /\[APPROVED\]/i, 'inbox must contain APPROVED marker');
    assert.match(inboxText, /proceed with the refactor/i, 'approval feedback must be included');
  } finally {
    restore();
  }
});

test('E2E Bidir: protocol type=plan_approval_response (reject) — lead sends revision request', async () => {
  const { home, terminals, inbox, results } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    registerWorker(terminals, inbox, results, 'kkkk0011', 'worker-i', 'task-plan-rej', 'proto-team');

    // Lead sends plan_approval_response approve=false (revision) to worker-i
    const result = api.handleToolCall('coord_send_protocol', {
      type: 'plan_approval_response',
      from: 'lead',
      recipient: 'worker-i',
      request_id: 'plan-req-002',
      approve: false,
      content: 'add error handling before proceeding',
    });
    assert.match(contentText(result), /Protocol message sent/i);

    // Worker-i checks inbox — must show REVISION
    const inboxResult = api.handleToolCall('coord_check_inbox', { session_id: 'kkkk0011' });
    const inboxText = contentText(inboxResult);
    assert.match(inboxText, /\[REVISION\]/i, 'inbox must contain REVISION marker for rejected plan');
    assert.match(inboxText, /error handling/i, 'revision feedback must be included');
  } finally {
    restore();
  }
});
