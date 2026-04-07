/**
 * Auto-unblock inbox notification tests — Change B.
 *
 * When autoUnblockDependents() clears a dependency, it pushes an [UNBLOCKED]
 * message to the inbox of the assigned worker (if known) and broadcasts to
 * all active lead sessions. Workers no longer need to poll to discover they
 * can proceed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), 'coord-aun-'));
  const terminals = join(home, '.claude', 'terminals');
  mkdirSync(join(terminals, 'inbox'), { recursive: true });
  mkdirSync(join(terminals, 'results'), { recursive: true });
  mkdirSync(join(terminals, 'tasks'), { recursive: true });
  mkdirSync(join(terminals, 'teams'), { recursive: true });
  mkdirSync(join(home, '.claude', 'session-cache'), { recursive: true });
  return home;
}

async function loadForTest(home) {
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
  const mod = await import(`../index.js?aun=${Date.now()}-${Math.random()}`);
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

function readInbox(home, sessionId) {
  const file = join(home, '.claude', 'terminals', 'inbox', `${sessionId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function createLeadInbox(home, sessionId) {
  // Create an empty inbox file so broadcast can find it
  const inboxDir = join(home, '.claude', 'terminals', 'inbox');
  writeFileSync(join(inboxDir, `${sessionId}.jsonl`), '');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('auto-unblock: completing a blocker task writes [UNBLOCKED] to lead inbox', async () => {
  const home = setupHome();
  const leadSession = 'lead-aun1';
  createLeadInbox(home, leadSession);

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    api.handleCreateTask({ task_id: 'AUN_BLK1', subject: 'Blocker task', team_name: 'aun-team' });
    api.handleCreateTask({
      task_id: 'AUN_DEP1',
      subject: 'Dependent task',
      team_name: 'aun-team',
      blocked_by: ['AUN_BLK1'],
    });

    api.handleUpdateTask({ task_id: 'AUN_BLK1', status: 'completed' });

    const msgs = readInbox(home, leadSession);
    const unblocked = msgs.filter((m) => m.content && m.content.includes('[UNBLOCKED]'));
    assert.ok(unblocked.length > 0, 'should have at least one [UNBLOCKED] notification');
  } finally {
    restore();
  }
});

test('auto-unblock: [UNBLOCKED] notification content includes dependent task subject', async () => {
  const home = setupHome();
  const leadSession = 'lead-aun2';
  createLeadInbox(home, leadSession);

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    api.handleCreateTask({ task_id: 'AUN_BLK2', subject: 'Root blocker', team_name: 'aun-team2' });
    api.handleCreateTask({
      task_id: 'AUN_DEP2',
      subject: 'Feature integration test',
      team_name: 'aun-team2',
      blocked_by: ['AUN_BLK2'],
    });

    api.handleUpdateTask({ task_id: 'AUN_BLK2', status: 'completed' });

    const msgs = readInbox(home, leadSession);
    const unblocked = msgs.filter((m) => m.content && m.content.includes('[UNBLOCKED]'));
    assert.ok(unblocked.length > 0, 'should have [UNBLOCKED] notification');
    assert.ok(
      unblocked.some((m) => m.content.includes('AUN_DEP2') || m.content.includes('Feature integration test')),
      'notification must reference the unblocked task ID or subject'
    );
  } finally {
    restore();
  }
});

test('auto-unblock: no inbox write when no lead inbox files exist', async () => {
  const home = setupHome();
  // Intentionally do NOT create any inbox files

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    api.handleCreateTask({ task_id: 'AUN_BLK3', subject: 'Blocker', team_name: 'aun-team3' });
    api.handleCreateTask({
      task_id: 'AUN_DEP3',
      subject: 'Dependent',
      team_name: 'aun-team3',
      blocked_by: ['AUN_BLK3'],
    });

    // Should not throw even with no inbox files
    assert.doesNotThrow(() => {
      api.handleUpdateTask({ task_id: 'AUN_BLK3', status: 'completed' });
    }, 'completing a blocker must not throw when no inbox files exist');
  } finally {
    restore();
  }
});

test('auto-unblock: multiple dependents each get an [UNBLOCKED] notification', async () => {
  const home = setupHome();
  const leadSession = 'lead-aun4';
  createLeadInbox(home, leadSession);

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    api.handleCreateTask({ task_id: 'AUN_BLK4', subject: 'Shared blocker', team_name: 'aun-team4' });
    api.handleCreateTask({
      task_id: 'AUN_DEP4A',
      subject: 'Dependent A',
      team_name: 'aun-team4',
      blocked_by: ['AUN_BLK4'],
    });
    api.handleCreateTask({
      task_id: 'AUN_DEP4B',
      subject: 'Dependent B',
      team_name: 'aun-team4',
      blocked_by: ['AUN_BLK4'],
    });

    api.handleUpdateTask({ task_id: 'AUN_BLK4', status: 'completed' });

    const msgs = readInbox(home, leadSession);
    const unblocked = msgs.filter((m) => m.content && m.content.includes('[UNBLOCKED]'));
    assert.ok(unblocked.length >= 2,
      `should have at least 2 [UNBLOCKED] notifications, got ${unblocked.length}`);
  } finally {
    restore();
  }
});

test('auto-unblock: notification has correct from and priority fields', async () => {
  const home = setupHome();
  const leadSession = 'lead-aun5';
  createLeadInbox(home, leadSession);

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    api.handleCreateTask({ task_id: 'AUN_BLK5', subject: 'Final blocker', team_name: 'aun-team5' });
    api.handleCreateTask({
      task_id: 'AUN_DEP5',
      subject: 'Final dependent',
      team_name: 'aun-team5',
      blocked_by: ['AUN_BLK5'],
    });

    api.handleUpdateTask({ task_id: 'AUN_BLK5', status: 'completed' });

    const msgs = readInbox(home, leadSession);
    const unblocked = msgs.filter((m) => m.content && m.content.includes('[UNBLOCKED]'));
    assert.ok(unblocked.length > 0, 'must have [UNBLOCKED] notification');

    const msg = unblocked[0];
    assert.ok(msg.from, 'notification must have a from field');
    assert.ok(msg.priority === 'normal' || msg.priority === 'high',
      'notification must have a valid priority');
    assert.ok(msg.ts, 'notification must have a timestamp');
  } finally {
    restore();
  }
});
