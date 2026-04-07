import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function loadForTest(home) {
  const prev = { HOME: process.env.HOME, COORDINATOR_TEST_MODE: process.env.COORDINATOR_TEST_MODE, COORDINATOR_PLATFORM: process.env.COORDINATOR_PLATFORM };
  process.env.HOME = home;
  process.env.COORDINATOR_TEST_MODE = '1';
  process.env.COORDINATOR_PLATFORM = 'linux';
  const mod = await import(`../index.js?conflicts=${Date.now()}-${Math.random()}`);
  return {
    api: mod.__test__,
    restore: () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } },
  };
}

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), 'coord-conflicts-'));
  const terminals = join(home, '.claude', 'terminals');
  const inbox = join(terminals, 'inbox');
  const results = join(terminals, 'results');
  const sessionCache = join(home, '.claude', 'session-cache');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(results, { recursive: true });
  mkdirSync(sessionCache, { recursive: true });
  return { home, terminals };
}

test('detect_conflicts finds overlapping files_touched', async () => {
  const { home, terminals } = setupHome();
  writeFileSync(join(terminals, 'session-abcd1234.json'), JSON.stringify({
    session: 'abcd1234', status: 'active', project: 'demo', cwd: '/tmp/project',
    last_active: new Date().toISOString(), files_touched: ['/tmp/project/src/index.ts'],
  }));
  writeFileSync(join(terminals, 'session-efgh5678.json'), JSON.stringify({
    session: 'efgh5678', status: 'active', project: 'demo', cwd: '/tmp/project',
    last_active: new Date().toISOString(), files_touched: ['/tmp/project/src/index.ts', '/tmp/project/src/utils.ts'],
  }));
  writeFileSync(join(terminals, 'activity.jsonl'), '');

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_detect_conflicts', {
      session_id: 'abcd1234',
      files: ['/tmp/project/src/index.ts'],
    });
    const text = result?.content?.[0]?.text || '';
    assert.match(text, /CONFLICTS DETECTED/);
    assert.match(text, /efgh5678/);
    assert.match(text, /index\.ts/);
  } finally {
    restore();
  }
});

test('detect_conflicts returns safe when no overlaps', async () => {
  const { home, terminals } = setupHome();
  writeFileSync(join(terminals, 'session-abcd1234.json'), JSON.stringify({
    session: 'abcd1234', status: 'active', project: 'demo', cwd: '/tmp/project',
    last_active: new Date().toISOString(), files_touched: ['/tmp/project/src/a.ts'],
  }));
  writeFileSync(join(terminals, 'session-efgh5678.json'), JSON.stringify({
    session: 'efgh5678', status: 'active', project: 'demo', cwd: '/tmp/project',
    last_active: new Date().toISOString(), files_touched: ['/tmp/project/src/b.ts'],
  }));
  writeFileSync(join(terminals, 'activity.jsonl'), '');

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_detect_conflicts', {
      session_id: 'abcd1234',
      files: ['/tmp/project/src/a.ts'],
    });
    const text = result?.content?.[0]?.text || '';
    assert.match(text, /No conflicts detected/);
  } finally {
    restore();
  }
});

test('detect_conflicts prefers current_files over historical files_touched', async () => {
  const { home, terminals } = setupHome();
  writeFileSync(join(terminals, 'session-abcd1234.json'), JSON.stringify({
    session: 'abcd1234', status: 'active', project: 'demo', cwd: '/tmp/project',
    last_active: new Date().toISOString(),
    files_touched: ['/tmp/project/src/shared.ts'],
    current_files: ['/tmp/project/src/shared.ts'],
  }));
  writeFileSync(join(terminals, 'session-efgh5678.json'), JSON.stringify({
    session: 'efgh5678', status: 'active', project: 'demo', cwd: '/tmp/project',
    last_active: new Date().toISOString(),
    files_touched: ['/tmp/project/src/shared.ts'],
    current_files: ['/tmp/project/tests/auth.integration.test.ts'],
  }));
  writeFileSync(join(terminals, 'activity.jsonl'), '');

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_detect_conflicts', {
      session_id: 'abcd1234',
      files: ['/tmp/project/src/shared.ts'],
    });
    const text = result?.content?.[0]?.text || '';
    assert.match(text, /No conflicts detected/);
  } finally {
    restore();
  }
});

test('detect_conflicts prefers recent activity over historical files_touched', async () => {
  const { home, terminals } = setupHome();
  const now = new Date().toISOString();
  writeFileSync(join(terminals, 'session-abcd1234.json'), JSON.stringify({
    session: 'abcd1234', status: 'active', project: 'demo', cwd: '/tmp/project',
    last_active: now,
    files_touched: ['/tmp/project/src/shared.ts'],
  }));
  writeFileSync(join(terminals, 'session-efgh5678.json'), JSON.stringify({
    session: 'efgh5678', status: 'active', project: 'demo', cwd: '/tmp/project',
    last_active: now,
    files_touched: ['/tmp/project/src/shared.ts'],
  }));
  writeFileSync(join(terminals, 'activity.jsonl'), `${JSON.stringify({
    ts: now,
    session: 'efgh5678',
    tool: 'Write',
    file: 'auth.integration.test.ts',
    path: '/tmp/project/tests/auth.integration.test.ts',
    project: 'demo',
  })}\n`);

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_detect_conflicts', {
      session_id: 'abcd1234',
      files: ['/tmp/project/src/shared.ts'],
    });
    const text = result?.content?.[0]?.text || '';
    assert.match(text, /No conflicts detected/);
  } finally {
    restore();
  }
});

test('detect_conflicts ignores single-session recent edits when overlap is gone', async () => {
  const { home, terminals } = setupHome();
  const now = new Date().toISOString();
  writeFileSync(join(terminals, 'session-abcd1234.json'), JSON.stringify({
    session: 'abcd1234', status: 'active', project: 'demo', cwd: '/tmp/project',
    last_active: now,
  }));
  writeFileSync(join(terminals, 'session-efgh5678.json'), JSON.stringify({
    session: 'efgh5678', status: 'active', project: 'demo', cwd: '/tmp/project',
    last_active: now,
    files_touched: ['/tmp/project/src/shared.ts'],
    current_files: ['/tmp/project/tests/auth.integration.test.ts'],
  }));
  writeFileSync(join(terminals, 'activity.jsonl'), `${JSON.stringify({
    ts: now,
    session: 'efgh5678',
    tool: 'Write',
    file: 'auth.integration.test.ts',
    path: '/tmp/project/tests/auth.integration.test.ts',
    project: 'demo',
  })}\n`);

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_detect_conflicts', {
      session_id: 'abcd1234',
      files: ['/tmp/project/src/shared.ts'],
    });
    const text = result?.content?.[0]?.text || '';
    assert.match(text, /No conflicts detected/);
  } finally {
    restore();
  }
});

test('detect_conflicts excludes closed sessions', async () => {
  const { home, terminals } = setupHome();
  writeFileSync(join(terminals, 'session-abcd1234.json'), JSON.stringify({
    session: 'abcd1234', status: 'active', project: 'demo', cwd: '/tmp/project',
    last_active: new Date().toISOString(), files_touched: ['/tmp/project/src/shared.ts'],
  }));
  writeFileSync(join(terminals, 'session-efgh5678.json'), JSON.stringify({
    session: 'efgh5678', status: 'closed', project: 'demo', cwd: '/tmp/project',
    last_active: new Date().toISOString(), files_touched: ['/tmp/project/src/shared.ts'],
  }));
  writeFileSync(join(terminals, 'activity.jsonl'), '');

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_detect_conflicts', {
      session_id: 'abcd1234',
      files: ['/tmp/project/src/shared.ts'],
    });
    const text = result?.content?.[0]?.text || '';
    assert.match(text, /No conflicts detected/);
  } finally {
    restore();
  }
});

test('detect_conflicts rejects empty files array', async () => {
  const { home, terminals } = setupHome();
  writeFileSync(join(terminals, 'session-abcd1234.json'), JSON.stringify({
    session: 'abcd1234', status: 'active', project: 'demo', cwd: '/tmp',
    last_active: new Date().toISOString(),
  }));
  writeFileSync(join(terminals, 'activity.jsonl'), '');

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_detect_conflicts', {
      session_id: 'abcd1234',
      files: [],
    });
    assert.match(result?.content?.[0]?.text || '', /No files specified/);
  } finally {
    restore();
  }
});
