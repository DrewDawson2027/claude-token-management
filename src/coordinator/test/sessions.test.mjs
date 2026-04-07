import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function loadForTest(home) {
  const prev = { HOME: process.env.HOME, COORDINATOR_TEST_MODE: process.env.COORDINATOR_TEST_MODE, COORDINATOR_PLATFORM: process.env.COORDINATOR_PLATFORM };
  process.env.HOME = home;
  process.env.COORDINATOR_TEST_MODE = '1';
  process.env.COORDINATOR_PLATFORM = 'linux';
  const mod = await import(`../index.js?sessions=${Date.now()}-${Math.random()}`);
  return {
    api: mod.__test__,
    restore: () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } },
  };
}

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), 'coord-sessions-'));
  const terminals = join(home, '.claude', 'terminals');
  const inbox = join(terminals, 'inbox');
  const results = join(terminals, 'results');
  const sessionCache = join(home, '.claude', 'session-cache');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(results, { recursive: true });
  mkdirSync(sessionCache, { recursive: true });
  return { home, terminals, inbox };
}

test('list_sessions returns active sessions in table format', async () => {
  const { home, terminals } = setupHome();
  writeFileSync(join(terminals, 'session-abcd1234.json'), JSON.stringify({
    session: 'abcd1234', status: 'active', project: 'myapp', cwd: '/tmp',
    last_active: new Date().toISOString(), tool_counts: { Write: 5, Edit: 3 },
    files_touched: ['/tmp/src/a.ts'], recent_ops: [{ t: new Date().toISOString(), tool: 'Edit', file: 'a.ts' }],
  }));

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_list_sessions', {});
    const text = result?.content?.[0]?.text || '';
    assert.match(text, /Sessions \(1\)/);
    assert.match(text, /abcd1234/);
    assert.match(text, /myapp/);
  } finally {
    restore();
  }
});

test('list_sessions filters by project', async () => {
  const { home, terminals } = setupHome();
  writeFileSync(join(terminals, 'session-abcd1234.json'), JSON.stringify({
    session: 'abcd1234', status: 'active', project: 'frontend', cwd: '/tmp',
    last_active: new Date().toISOString(),
  }));
  writeFileSync(join(terminals, 'session-efgh5678.json'), JSON.stringify({
    session: 'efgh5678', status: 'active', project: 'backend', cwd: '/tmp',
    last_active: new Date().toISOString(),
  }));

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_list_sessions', { project: 'front' });
    const text = result?.content?.[0]?.text || '';
    assert.match(text, /abcd1234/);
    assert.doesNotMatch(text, /efgh5678/);
  } finally {
    restore();
  }
});

test('list_sessions excludes closed by default', async () => {
  const { home, terminals } = setupHome();
  writeFileSync(join(terminals, 'session-abcd1234.json'), JSON.stringify({
    session: 'abcd1234', status: 'closed', project: 'demo', cwd: '/tmp',
    last_active: new Date().toISOString(),
  }));

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const noResult = api.handleToolCall('coord_list_sessions', {});
    assert.match(noResult?.content?.[0]?.text || '', /No active sessions/);

    const withClosed = api.handleToolCall('coord_list_sessions', { include_closed: true });
    assert.match(withClosed?.content?.[0]?.text || '', /abcd1234/);
  } finally {
    restore();
  }
});

test('get_session returns detailed session info', async () => {
  const { home, terminals, inbox } = setupHome();
  writeFileSync(join(terminals, 'session-abcd1234.json'), JSON.stringify({
    session: 'abcd1234', status: 'active', project: 'demo', branch: 'main',
    cwd: '/tmp/demo', last_active: new Date().toISOString(), started: new Date().toISOString(),
    tty: '/dev/ttys003', tool_counts: { Write: 2, Edit: 1, Bash: 3, Read: 10 },
    files_touched: ['/tmp/demo/src/a.ts', '/tmp/demo/src/b.ts'],
    recent_ops: [{ t: new Date().toISOString(), tool: 'Edit', file: 'a.ts' }],
    current_task: 'fixing login bug',
  }));
  appendFileSync(join(inbox, 'abcd1234.jsonl'), JSON.stringify({ ts: new Date().toISOString(), from: 'lead', content: 'hello' }) + '\n');

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_get_session', { session_id: 'abcd1234' });
    const text = result?.content?.[0]?.text || '';
    assert.match(text, /Session abcd1234/);
    assert.match(text, /demo/);
    assert.match(text, /fixing login bug/);
    assert.match(text, /Tool Usage/);
    assert.match(text, /Files Touched/);
    assert.match(text, /Recent Operations/);
    assert.match(text, /1 pending message/);
  } finally {
    restore();
  }
});

test('get_session returns not found for missing session', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_get_session', { session_id: 'zzzz9999' });
    assert.match(result?.content?.[0]?.text || '', /not found/);
  } finally {
    restore();
  }
});
