/**
 * End-to-end integration tests for P2P worker messaging.
 *
 * These tests prove that two workers can exchange messages by name — the core
 * capability that makes the lead system equivalent to Claude Code's native
 * Agent Teams. No real Claude process is needed: we set up session files
 * directly (the same files a real worker would write via heartbeat) and call
 * the coordinator tools as workers would.
 *
 * Coverage:
 *   1. worker-A sends to worker-B by target_name → B's inbox receives it
 *   2. Unknown target_name → graceful error, no crash
 *   3. coord_broadcast → all active workers receive the message
 *   4. coord_discover_peers → lists workers with correct session IDs and roles
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
  };
  process.env.HOME = home;
  process.env.COORDINATOR_TEST_MODE = '1';
  process.env.COORDINATOR_PLATFORM = 'linux';
  const mod = await import(`../index.js?p2p=${Date.now()}-${Math.random()}`);
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

/**
 * Build a minimal temp HOME with the directory layout the coordinator expects.
 * Returns paths to the key directories.
 */
function setupHome() {
  const home = mkdtempSync(join(tmpdir(), 'coord-p2p-'));
  const terminals = join(home, '.claude', 'terminals');
  const inbox = join(terminals, 'inbox');
  const results = join(terminals, 'results');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(results, { recursive: true });
  mkdirSync(join(home, '.claude', 'session-cache'), { recursive: true });
  return { home, terminals, inbox, results };
}

/**
 * Register a worker by writing a session file — exactly what a worker's
 * heartbeat hook writes in production. resolveWorkerName() reads these files.
 */
function registerWorker(terminals, inbox, sessionId, workerName, role = 'implementer', teamName = null, taskId = null) {
  writeFileSync(
    join(terminals, `session-${sessionId}.json`),
    JSON.stringify({
      session: sessionId,
      worker_name: workerName,
      status: 'active',
      last_active: new Date().toISOString(),
      cwd: '/tmp/project',
      project: 'test-project',
      // current_task links this session to a meta file — required for discover_peers to resolve session IDs
      ...(taskId && { current_task: taskId }),
      ...(teamName && { team_name: teamName }),
    }),
  );
  // Create inbox file so messages can be appended immediately
  writeFileSync(join(inbox, `${sessionId}.jsonl`), '');
}

/**
 * Register a worker's meta file so coord_discover_peers can find it.
 * (discovers via RESULTS_DIR/*.meta.json, not session files)
 */
function registerWorkerMeta(results, taskId, workerName, sessionId, role, teamName) {
  writeFileSync(
    join(results, `${taskId}.meta.json`),
    JSON.stringify({
      task_id: taskId,
      worker_name: workerName,
      claude_session_id: sessionId.padEnd(36, '0'), // mock UUID
      role,
      team_name: teamName,
      model: 'haiku',
      permission_mode: 'acceptEdits',
      spawned: new Date().toISOString(),
      status: 'running',
    }),
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('P2P: worker-A sends to worker-B by name → message arrives in B\'s inbox', async () => {
  const { home, terminals, inbox } = setupHome();

  const aId = 'aaaa1111';
  const bId = 'bbbb2222';
  registerWorker(terminals, inbox, aId, 'researcher', 'researcher');
  registerWorker(terminals, inbox, bId, 'implementer', 'implementer');

  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    // Worker A sends a message to Worker B using only the name — no session ID needed
    const send = api.handleToolCall('coord_send_message', {
      from: 'researcher',
      target_name: 'implementer',
      content: 'Auth bug confirmed at src/auth.ts:42 — token not expiring on logout',
      priority: 'urgent',
    });
    const sendTxt = contentText(send);

    // Confirm delivery was acknowledged and routed to the right session
    assert.match(sendTxt, /Message sent/i);
    assert.match(sendTxt, new RegExp(bId), 'response should confirm B\'s session ID as target');
    assert.match(sendTxt, /urgent/i);

    // Worker B reads its inbox and sees the message
    const inbox_ = api.handleToolCall('coord_check_inbox', { session_id: bId });
    const inboxTxt = contentText(inbox_);

    assert.match(inboxTxt, /auth bug/i);
    assert.match(inboxTxt, /src\/auth\.ts:42/i);
    assert.match(inboxTxt, /researcher/i,   'from field should show sender name');
    assert.match(inboxTxt, /\*\*\[URGENT\]\*\*/i);

    // Worker A's inbox should be untouched — message went TO B, not A
    const aInbox = api.handleToolCall('coord_check_inbox', { session_id: aId });
    assert.match(contentText(aInbox), /No pending messages/i);
  } finally {
    restore();
  }
});

test('P2P: unknown target_name returns clear error, does not crash', async () => {
  const { home, terminals, inbox } = setupHome();
  registerWorker(terminals, inbox, 'cccc3333', 'researcher');

  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    const send = api.handleToolCall('coord_send_message', {
      from: 'researcher',
      target_name: 'ghost-worker-that-doesnt-exist',
      content: 'This should fail gracefully',
    });
    const txt = contentText(send);

    assert.match(txt, /not found/i);
    assert.match(txt, /ghost-worker-that-doesnt-exist/i, 'error should echo back the bad name');
    // No throw — coordinator stays alive
  } finally {
    restore();
  }
});

test('broadcast: lead sends to all active workers, both inboxes receive it', async () => {
  const { home, terminals, inbox } = setupHome();

  const aId = 'dddd4444';
  const bId = 'eeee5555';
  registerWorker(terminals, inbox, aId, 'frontend-dev');
  registerWorker(terminals, inbox, bId, 'backend-dev');

  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    const bcast = api.handleToolCall('coord_broadcast', {
      from: 'lead',
      content: 'Standup in 5 min — wrap up current tasks and summarize progress',
      priority: 'urgent',
    });
    const bcastTxt = contentText(bcast);

    // Broadcast should confirm it reached multiple workers
    assert.match(bcastTxt, /Broadcast sent/i);
    assert.match(bcastTxt, /2\s*(session|recipient|worker)/i);

    // Both workers' inboxes should have the message
    const aInbox = api.handleToolCall('coord_check_inbox', { session_id: aId });
    const bInbox = api.handleToolCall('coord_check_inbox', { session_id: bId });

    assert.match(contentText(aInbox), /standup/i);
    assert.match(contentText(bInbox), /standup/i);
    assert.match(contentText(aInbox), /lead/i);
    assert.match(contentText(bInbox), /lead/i);
  } finally {
    restore();
  }
});

test('coord_discover_peers: returns both workers with session IDs and roles', async () => {
  const { home, terminals, inbox, results } = setupHome();

  const aId = 'ffff6666';
  const bId = 'gggg7777';
  const team = 'alpha';

  // current_task links session → meta file so discover_peers can resolve session IDs
  registerWorker(terminals, inbox, aId, 'researcher', 'researcher', team, 'W_RESEARCHER');
  registerWorker(terminals, inbox, bId, 'implementer', 'implementer', team, 'W_IMPLEMENTER');

  // Peer discovery reads meta files — register those too
  registerWorkerMeta(results, 'W_RESEARCHER', 'researcher', aId, 'researcher', team);
  registerWorkerMeta(results, 'W_IMPLEMENTER', 'implementer', bId, 'implementer', team);

  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();

    const peers = api.handleToolCall('coord_discover_peers', { team_name: team });
    const txt = contentText(peers);

    // Should list both peers with name, role, and session
    assert.match(txt, /researcher/i);
    assert.match(txt, /implementer/i);
    assert.match(txt, /researcher.*researcher|implementer.*implementer/i);

    // Session IDs should appear (first 8 chars of the padded mock UUID)
    assert.match(txt, new RegExp(aId.slice(0, 8)), 'researcher session ID should appear');
    assert.match(txt, new RegExp(bId.slice(0, 8)), 'implementer session ID should appear');

    // Both roles should be listed
    assert.match(txt, /2\s*peer/i);
  } finally {
    restore();
  }
});
