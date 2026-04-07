/**
 * Tests for recipient validation on coord_send_message and coord_send_protocol.
 *
 * Verifies parity fix for native Claude Code bug #25135:
 * messages to unknown recipients must return a clear error, not silently succeed.
 *
 * 12 test cases covering:
 *  - handleSendMessage: valid, unknown, exited, meta-file-found sessions
 *  - handleSendProtocol: valid, unknown, exited sessions
 *  - handleBroadcast: best-effort (no per-recipient validation)
 *  - target_name resolution: unknown worker name
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
import { upsertIdentityRecord } from '../lib/identity-map.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), 'coord-rv-'));
  const terminals = join(home, '.claude', 'terminals');
  mkdirSync(join(terminals, 'inbox'), { recursive: true });
  mkdirSync(join(terminals, 'results'), { recursive: true });
  mkdirSync(join(terminals, 'tasks'), { recursive: true });
  mkdirSync(join(terminals, 'teams'), { recursive: true });
  mkdirSync(join(home, '.claude', 'session-cache'), { recursive: true });
  return {
    home,
    terminals,
    inbox: join(terminals, 'inbox'),
    results: join(terminals, 'results'),
  };
}

async function loadForTest(home) {
  const prev = {
    HOME: process.env.HOME,
    COORDINATOR_TEST_MODE: process.env.COORDINATOR_TEST_MODE,
    COORDINATOR_PLATFORM: process.env.COORDINATOR_PLATFORM,
    TMUX: process.env.TMUX,
  };
  process.env.HOME = home;
  process.env.COORDINATOR_TEST_MODE = '1';
  process.env.COORDINATOR_PLATFORM = 'linux';
  delete process.env.TMUX;
  const mod = await import(`../index.js?rv=${Date.now()}-${Math.random()}`);
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

function textOf(result) {
  return result?.content?.[0]?.text || '';
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

/** Create a session file so checkRecipientExists() finds it. */
function createSession(home, sessionId, status = 'active') {
  writeFileSync(
    join(home, '.claude', 'terminals', `session-${sessionId}.json`),
    JSON.stringify({
      session: sessionId,
      status,
      last_active: new Date().toISOString(),
    }),
  );
}

/** Create a worker meta file so checkRecipientExists() finds via meta fallback. */
function createMeta(home, metaObj) {
  const name = `${metaObj.task_id || 'task'}.meta.json`;
  writeFileSync(
    join(home, '.claude', 'terminals', 'results', name),
    JSON.stringify(metaObj),
  );
}

// ─── Test 1: valid active session → Message sent ──────────────────────────────

test('recipient-validation: handleSendMessage succeeds for active session', async () => {
  const { home, inbox } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    createSession(home, 'live1234');
    const result = api.handleToolCall('coord_send_message', {
      from: 'lead',
      to: 'live1234',
      content: 'ping',
    });
    assert.match(textOf(result), /Message sent/i);
    const msgs = readInbox(inbox, 'live1234');
    assert.equal(msgs.length, 1, 'message must be written to inbox');
    assert.equal(msgs[0].content, 'ping');
  } finally {
    restore();
  }
});

// ─── Test 2: unknown session ID → error ───────────────────────────────────────

test('recipient-validation: handleSendMessage returns error for unknown session ID', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    // No session file created — dead1234 does not exist
    const result = api.handleToolCall('coord_send_message', {
      from: 'lead',
      to: 'dead1234',
      content: 'ping',
    });
    assert.match(textOf(result), /not found/i, 'must report recipient not found');
    assert.doesNotMatch(textOf(result), /Message sent/i, 'must not silently succeed');
  } finally {
    restore();
  }
});

// ─── Test 3: error includes "Available sessions:" phrase ──────────────────────

test('recipient-validation: error message includes "Available sessions:" phrase', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_send_message', {
      from: 'lead',
      to: 'dead1234',
      content: 'ping',
    });
    assert.match(
      textOf(result),
      /Available sessions:/i,
      'error must list available sessions to help the caller',
    );
  } finally {
    restore();
  }
});

// ─── Test 4: available sessions list includes known session IDs ───────────────

test('recipient-validation: available sessions list includes known session IDs', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    createSession(home, 'knwn5678'); // a known, active session
    const result = api.handleToolCall('coord_send_message', {
      from: 'lead',
      to: 'dead1234',
      content: 'ping',
    });
    assert.match(
      textOf(result),
      /knwn5678/,
      'error must list the known session ID so the caller can correct their target',
    );
  } finally {
    restore();
  }
});

// ─── Test 5: exited session → delivers with warning ───────────────────────────

test('recipient-validation: handleSendMessage delivers with warning for exited session', async () => {
  const { home, inbox } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    createSession(home, 'exit1234', 'exited');
    const result = api.handleToolCall('coord_send_message', {
      from: 'lead',
      to: 'exit1234',
      content: 'last call',
    });
    assert.match(textOf(result), /Message sent/i, 'exited session must still receive message');
    assert.match(
      textOf(result),
      /Warning.*exited|exited.*Warning/i,
      'must warn that the session has exited',
    );
    const msgs = readInbox(inbox, 'exit1234');
    assert.equal(msgs.length, 1, 'message must be written to inbox despite exited status');
  } finally {
    restore();
  }
});

// ─── Test 6: session found via meta file (notify_session_id match) ────────────

test('recipient-validation: handleSendMessage succeeds when session found via meta file', async () => {
  const { home, inbox } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    // No session-meta1234.json file — but a meta file references this session as notify_session_id
    createMeta(home, {
      task_id: 'task-meta-01',
      notify_session_id: 'meta1234',
      worker_name: 'meta-worker',
    });
    const result = api.handleToolCall('coord_send_message', {
      from: 'lead',
      to: 'meta1234',
      content: 'via meta fallback',
    });
    assert.match(
      textOf(result),
      /Message sent/i,
      'session found via meta file must still receive message',
    );
  } finally {
    restore();
  }
});

test('recipient-validation: target_name resolves through identity map native agent identity', async () => {
  const { home, inbox } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    upsertIdentityRecord({
      team_name: 'alpha',
      agent_id: 'agent-native-77',
      agent_name: 'native-alpha',
      worker_name: 'worker-alpha',
      session_id: 'nativ777',
      task_id: 'W-native-77',
    });
    const result = api.handleToolCall('coord_send_message', {
      from: 'lead',
      target_name: 'agent-native-77',
      team_name: 'alpha',
      content: 'hello via identity map',
    });
    assert.match(textOf(result), /Message sent/i);
    const msgs = readInbox(inbox, 'nativ777');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, 'hello via identity map');
  } finally {
    restore();
  }
});

test('recipient-validation: target_name uses native identity before legacy worker-name session match', async () => {
  const { home, inbox } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    writeFileSync(
      join(home, '.claude', 'terminals', 'session-legacy88.json'),
      JSON.stringify({
        session: 'legacy88',
        worker_name: 'worker-alpha',
        status: 'active',
        last_active: new Date().toISOString(),
      }),
    );
    upsertIdentityRecord({
      team_name: 'alpha',
      agent_id: 'agent-native-alpha',
      agent_name: 'worker-alpha',
      worker_name: 'native-alpha',
      session_id: 'nativ888',
      task_id: 'W-native-alpha',
    });

    const result = api.handleToolCall('coord_send_message', {
      from: 'lead',
      target_name: 'worker-alpha',
      team_name: 'alpha',
      content: 'identity-first routing',
    });
    assert.match(textOf(result), /Message sent/i);
    assert.match(textOf(result), /nativ888/i);
    assert.doesNotMatch(textOf(result), /legacy88/i);

    const nativeMsgs = readInbox(inbox, 'nativ888');
    assert.equal(nativeMsgs.length, 1);
    assert.equal(nativeMsgs[0].content, 'identity-first routing');
    const legacyMsgs = readInbox(inbox, 'legacy88');
    assert.equal(legacyMsgs.length, 0);
  } finally {
    restore();
  }
});

// ─── Test 7: handleSendProtocol valid session → Protocol message sent ─────────

test('recipient-validation: handleSendProtocol succeeds for valid session', async () => {
  const { home, inbox } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    createSession(home, 'prot5678');
    const result = api.handleToolCall('coord_send_protocol', {
      type: 'shutdown_request',
      to: 'prot5678',
      from: 'lead',
    });
    assert.match(textOf(result), /Protocol message sent/i);
    const msgs = readInbox(inbox, 'prot5678');
    assert.equal(msgs.length, 1, 'protocol message must be written to inbox');
    assert.match(msgs[0].content, /\[SHUTDOWN_REQUEST\]/);
  } finally {
    restore();
  }
});

// ─── Test 8: handleSendProtocol unknown session → error ───────────────────────

test('recipient-validation: handleSendProtocol returns error for unknown session', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_send_protocol', {
      type: 'shutdown_request',
      to: 'gone5678',
      from: 'lead',
    });
    assert.match(textOf(result), /not found/i);
    assert.doesNotMatch(textOf(result), /Protocol message sent/i);
  } finally {
    restore();
  }
});

// ─── Test 9: handleSendProtocol exited session → still delivers ───────────────

test('recipient-validation: handleSendProtocol delivers to exited session', async () => {
  const { home, inbox } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    createSession(home, 'extp5678', 'exited');
    const result = api.handleToolCall('coord_send_protocol', {
      type: 'shutdown_request',
      to: 'extp5678',
      from: 'lead',
    });
    assert.match(
      textOf(result),
      /Protocol message sent/i,
      'exited session must not block protocol delivery',
    );
    const msgs = readInbox(inbox, 'extp5678');
    assert.equal(msgs.length, 1);
  } finally {
    restore();
  }
});

// ─── Test 10: handleBroadcast delivers to all active sessions (best-effort) ───

test('recipient-validation: handleBroadcast delivers to all active sessions without per-recipient validation', async () => {
  const { home, inbox } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    createSession(home, 'brd01111');
    createSession(home, 'brd02222');
    const result = api.handleToolCall('coord_broadcast', {
      from: 'lead',
      content: 'go team',
    });
    assert.match(textOf(result), /Broadcast sent to 2 session/i);
    assert.equal(readInbox(inbox, 'brd01111').length, 1, 'session 1 must receive broadcast');
    assert.equal(readInbox(inbox, 'brd02222').length, 1, 'session 2 must receive broadcast');
  } finally {
    restore();
  }
});

// ─── Test 11: handleBroadcast empty → "No active sessions", not recipient error

test('recipient-validation: handleBroadcast returns clean message when no sessions exist', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_broadcast', {
      from: 'lead',
      content: 'hello',
    });
    assert.match(textOf(result), /No active sessions/i);
    assert.doesNotMatch(
      textOf(result),
      /not found/i,
      'broadcast must never emit per-recipient not-found errors',
    );
  } finally {
    restore();
  }
});

// ─── Test 12: unknown target_name → worker-not-found error ───────────────────

test('recipient-validation: unknown target_name returns worker-not-found error before delivery', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_send_message', {
      from: 'lead',
      target_name: 'ghost-worker',
      content: 'ping',
    });
    assert.match(textOf(result), /not found/i);
    assert.doesNotMatch(textOf(result), /Message sent/i, 'must not silently succeed');
  } finally {
    restore();
  }
});
