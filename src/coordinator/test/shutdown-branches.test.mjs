/**
 * Shutdown branch coverage — targets uncovered lines 42-54, 67, 113-123
 * in shutdown.js (currently 53.57% branch coverage).
 *
 * Covers:
 *  - handleShutdownRequest: target_session path (line 67)
 *  - handleShutdownRequest: task_id with valid meta + session match (lines 42-54)
 *  - handleShutdownRequest: task_id with valid meta, no matching session (targetSid=null)
 *  - handleShutdownRequest: task_id not found (meta missing)
 *  - handleShutdownRequest: target_name not found
 *  - handleShutdownRequest: no identifier at all
 *  - handleShutdownResponse: missing request_id
 *  - handleShutdownResponse: tracking file not found
 *  - handleShutdownResponse: approve=true with notify_session_id (inbox delivery)
 *  - handleShutdownResponse: approve=false with notify_session_id (inbox delivery)
 *  - handleShutdownResponse: approve=true, no task_id in tracking
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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
  const mod = await import(`../index.js?shutdown-br=${Date.now()}-${Math.random()}`);
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
  const home = mkdtempSync(join(tmpdir(), 'coord-shutdown-br-'));
  const terminals = join(home, '.claude', 'terminals');
  mkdirSync(join(terminals, 'inbox'), { recursive: true });
  mkdirSync(join(terminals, 'results'), { recursive: true });
  mkdirSync(join(terminals, 'teams'), { recursive: true });
  mkdirSync(join(home, '.claude', 'session-cache'), { recursive: true });
  return { home, terminals };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('shutdown: target_session path resolves session directly (line 67)', async () => {
  const { home, terminals } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    // Line 67: args.target_session → sanitizeShortSessionId
    const result = api.handleShutdownRequest({
      target_session: 'a1b2c3d4',
      message: 'Wrap up please.',
    });
    const txt = contentText(result);
    assert.match(txt, /Shutdown requested/i);
    assert.match(txt, /a1b2c3d4/);
  } finally {
    restore();
  }
});

test('shutdown: task_id with missing meta returns not found', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    // Line 46: task_id provided, meta NOT found → early return
    const result = api.handleShutdownRequest({ task_id: 'T_NO_META' });
    assert.match(contentText(result), /not found/i);
  } finally {
    restore();
  }
});

test('shutdown: task_id with valid meta but no session match (targetSid stays null)', async () => {
  const { home, terminals } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    const results = join(terminals, 'results');
    // Write a meta file so readJSON succeeds (covers lines 43-45)
    writeFileSync(
      join(results, 'TASK001.meta.json'),
      JSON.stringify({ task_id: 'TASK001', role: 'reviewer', team_name: 'br-team' }),
    );
    // No session file that has current_task === TASK001, so targetSid stays null
    const result = api.handleShutdownRequest({ task_id: 'TASK001' });
    // targetSid is null → "Could not resolve worker session ID."
    assert.match(contentText(result), /Could not resolve/i);
  } finally {
    restore();
  }
});

test('shutdown: task_id with valid meta AND matching active session (lines 49-54)', async () => {
  const { home, terminals } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    const results = join(terminals, 'results');
    const sid = 'e1f2a3b4';
    // Write the task meta file
    writeFileSync(
      join(results, 'TASK002.meta.json'),
      JSON.stringify({ task_id: 'TASK002', role: 'coder', team_name: 'br-team' }),
    );
    // Write a session file with current_task = TASK002 and status != closed
    writeFileSync(
      join(terminals, `session-${sid}.json`),
      JSON.stringify({
        session: sid,
        status: 'active',
        current_task: 'TASK002',
        last_active: new Date().toISOString(),
      }),
    );
    const result = api.handleShutdownRequest({ task_id: 'TASK002', message: 'Done.' });
    const txt = contentText(result);
    // Should write shutdown request to inbox and return confirmation
    assert.match(txt, /Shutdown requested/i);
    assert.ok(txt.includes(sid), `Expected txt to include session id ${sid}`);
    // Inbox file should exist for the session
    const inboxFile = join(terminals, 'inbox', `${sid}.jsonl`);
    assert.ok(existsSync(inboxFile), 'inbox file created for session');
  } finally {
    restore();
  }
});

test('shutdown: target_name not found returns error', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleShutdownRequest({ target_name: 'nonexistent-worker' });
    assert.match(contentText(result), /not found/i);
  } finally {
    restore();
  }
});

test('shutdown: no identifier returns validation error', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    // No task_id, target_name, or target_session → line 68-69
    const result = api.handleShutdownRequest({});
    assert.match(contentText(result), /required/i);
  } finally {
    restore();
  }
});

test('shutdown response: missing request_id returns error (line 148)', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleShutdownResponse({ request_id: '', approve: true });
    assert.match(contentText(result), /required/i);
  } finally {
    restore();
  }
});

test('shutdown response: unknown request_id returns not found (line 154)', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleShutdownResponse({ request_id: 'shutdown-missing-abc', approve: true });
    assert.match(contentText(result), /not found/i);
  } finally {
    restore();
  }
});

test('shutdown response: approve=true with notify_session_id sends inbox message', async () => {
  const { home, terminals } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    const results = join(terminals, 'results');
    const notifySession = 'lead1111';
    const taskId = 'TASK_NOTIFY';
    const reqId = 'shutdown-test-001';

    // Write a meta file with notify_session_id
    writeFileSync(
      join(results, `${taskId}.meta.json`),
      JSON.stringify({ task_id: taskId, notify_session_id: notifySession }),
    );
    // Write the shutdown tracking file (status=pending)
    writeFileSync(
      join(results, `${reqId}.shutdown`),
      JSON.stringify({
        request_id: reqId,
        task_id: taskId,
        target_session: 'worker111',
        message: 'Done.',
        force_timeout_seconds: 60,
        status: 'pending',
      }),
    );

    const result = api.handleShutdownResponse({ request_id: reqId, approve: true });
    assert.match(contentText(result), /approved/i);

    // Notify inbox should have SHUTDOWN_APPROVED message
    const inboxFile = join(terminals, 'inbox', `${notifySession}.jsonl`);
    assert.ok(existsSync(inboxFile), 'lead inbox file created');
    const lines = readFileSync(inboxFile, 'utf-8').split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    assert.match(last.content, /SHUTDOWN_APPROVED/);
  } finally {
    restore();
  }
});

test('shutdown response: approve=false with notify_session_id sends rejection message', async () => {
  const { home, terminals } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    const results = join(terminals, 'results');
    const notifySession = 'lead2222';
    const taskId = 'TASK_REJ';
    const reqId = 'shutdown-test-reject';

    writeFileSync(
      join(results, `${taskId}.meta.json`),
      JSON.stringify({ task_id: taskId, notify_session_id: notifySession }),
    );
    writeFileSync(
      join(results, `${reqId}.shutdown`),
      JSON.stringify({
        request_id: reqId,
        task_id: taskId,
        target_session: 'worker222',
        status: 'pending',
      }),
    );

    const result = api.handleShutdownResponse({
      request_id: reqId,
      approve: false,
      reason: 'Still processing critical data',
    });
    assert.match(contentText(result), /rejected/i);

    const inboxFile = join(terminals, 'inbox', `${notifySession}.jsonl`);
    assert.ok(existsSync(inboxFile), 'lead inbox file created for rejection');
    const lines = readFileSync(inboxFile, 'utf-8').split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    assert.match(last.content, /SHUTDOWN_REJECTED/);
  } finally {
    restore();
  }
});

test('shutdown response: approve=true, no task_id in tracking (skips meta lookup)', async () => {
  const { home, terminals } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    const results = join(terminals, 'results');
    const reqId = 'shutdown-no-task';

    // Tracking file without task_id (covers the !tracking.task_id branch)
    writeFileSync(
      join(results, `${reqId}.shutdown`),
      JSON.stringify({
        request_id: reqId,
        target_session: 'worker333',
        status: 'pending',
      }),
    );

    const result = api.handleShutdownResponse({ request_id: reqId, approve: true });
    assert.match(contentText(result), /approved/i);
  } finally {
    restore();
  }
});
