import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function loadForTest(home, platform = 'linux') {
  const prev = { HOME: process.env.HOME, COORDINATOR_TEST_MODE: process.env.COORDINATOR_TEST_MODE, COORDINATOR_PLATFORM: process.env.COORDINATOR_PLATFORM };
  process.env.HOME = home;
  process.env.COORDINATOR_TEST_MODE = '1';
  process.env.COORDINATOR_PLATFORM = platform;
  const mod = await import(`../index.js?wake=${Date.now()}-${Math.random()}`);
  return {
    api: mod.__test__,
    restore: () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } },
  };
}

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), 'coord-wake-'));
  const terminals = join(home, '.claude', 'terminals');
  const inbox = join(terminals, 'inbox');
  const results = join(terminals, 'results');
  const sessionCache = join(home, '.claude', 'session-cache');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(results, { recursive: true });
  mkdirSync(sessionCache, { recursive: true });
  return { home, terminals, inbox };
}

test('selectWakeText always returns empty (no injection)', async () => {
  const { selectWakeText } = (await import('../lib/platform/wake.js'));
  assert.equal(selectWakeText('dangerous command'), '');
  assert.equal(selectWakeText(''), '');
});

test('isSafeTTYPath rejects traversal and special paths', async () => {
  const { isSafeTTYPath } = (await import('../lib/platform/common.js'));
  assert.equal(isSafeTTYPath('/dev/ttys003'), true);
  assert.equal(isSafeTTYPath('/dev/pts/0'), true);
  assert.equal(isSafeTTYPath('/dev/../etc/passwd'), false);
  assert.equal(isSafeTTYPath('/tmp/fake-tty'), false);
  assert.equal(isSafeTTYPath(''), false);
  assert.equal(isSafeTTYPath(null), false);
});

test('wake_session returns not found for missing session', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_wake_session', {
      session_id: 'zzzz9999',
      message: 'hello',
    });
    assert.match(result?.content?.[0]?.text || '', /not found/);
  } finally {
    restore();
  }
});

test('wake_session requires message', async () => {
  const { home, terminals } = setupHome();
  writeFileSync(join(terminals, 'session-abcd1234.json'), JSON.stringify({
    session: 'abcd1234', status: 'active', cwd: '/tmp',
    last_active: new Date().toISOString(),
  }));
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_wake_session', {
      session_id: 'abcd1234',
      message: '',
    });
    assert.match(result?.content?.[0]?.text || '', /required/i);
  } finally {
    restore();
  }
});

test('wake_session falls back to inbox on non-macOS', async () => {
  const { home, terminals, inbox } = setupHome();
  writeFileSync(join(terminals, 'session-abcd1234.json'), JSON.stringify({
    session: 'abcd1234', status: 'active', cwd: '/tmp',
    last_active: new Date().toISOString(),
  }));

  const { api, restore } = await loadForTest(home, 'linux');
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_wake_session', {
      session_id: 'abcd1234',
      message: 'check status please',
    });
    const text = result?.content?.[0]?.text || '';
    assert.match(text, /inbox message/i);
  } finally {
    restore();
  }
});
