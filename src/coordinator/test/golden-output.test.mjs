/**
 * Golden output tests: verify user-facing tool response text
 * to prevent UX regressions in phrasing and structure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), 'coord-golden-'));
  const terminals = join(home, '.claude', 'terminals');
  mkdirSync(join(terminals, 'inbox'), { recursive: true });
  mkdirSync(join(terminals, 'results'), { recursive: true });
  mkdirSync(join(terminals, 'tasks'), { recursive: true });
  mkdirSync(join(terminals, 'teams'), { recursive: true });
  mkdirSync(join(home, '.claude', 'session-cache'), { recursive: true });
  return { home, terminals };
}

async function loadForTest(home, envOverrides = {}) {
  const prev = {
    HOME: process.env.HOME,
    COORDINATOR_TEST_MODE: process.env.COORDINATOR_TEST_MODE,
    COORDINATOR_PLATFORM: process.env.COORDINATOR_PLATFORM,
    COORDINATOR_CLAUDE_BIN: process.env.COORDINATOR_CLAUDE_BIN,
    COORDINATOR_GLOBAL_BUDGET_POLICY: process.env.COORDINATOR_GLOBAL_BUDGET_POLICY,
    COORDINATOR_GLOBAL_BUDGET_TOKENS: process.env.COORDINATOR_GLOBAL_BUDGET_TOKENS,
  };
  process.env.HOME = home;
  process.env.COORDINATOR_TEST_MODE = '1';
  process.env.COORDINATOR_PLATFORM = 'linux';
  process.env.COORDINATOR_CLAUDE_BIN = 'echo';
  for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;
  const mod = await import(`../index.js?golden=${Date.now()}-${Math.random()}`);
  return {
    api: mod.__test__,
    restore: () => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      for (const k of Object.keys(envOverrides)) {
        if (!(k in prev)) delete process.env[k];
      }
    },
  };
}

function textOf(result) {
  return result?.content?.[0]?.text || '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Worker spawn responses
// ═══════════════════════════════════════════════════════════════════════════════





// ═══════════════════════════════════════════════════════════════════════════════
// Team dispatch response
// ═══════════════════════════════════════════════════════════════════════════════



// ═══════════════════════════════════════════════════════════════════════════════
// Session listing response
// ═══════════════════════════════════════════════════════════════════════════════

test('coord_list_sessions with active sessions has structured output', async () => {
  const { home, terminals } = setupHome();
  // Write two active sessions
  writeFileSync(join(terminals, 'session-aaaa1234.json'), JSON.stringify({
    session: 'aaaa1234', status: 'active', cwd: '/tmp/a', project: 'alpha',
    last_active: new Date().toISOString(),
  }));
  writeFileSync(join(terminals, 'session-bbbb5678.json'), JSON.stringify({
    session: 'bbbb5678', status: 'active', cwd: '/tmp/b', project: 'beta',
    last_active: new Date().toISOString(),
  }));

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_list_sessions', {});
    const txt = textOf(result);
    assert.match(txt, /aaaa1234/, 'Should list first session ID');
    assert.match(txt, /bbbb5678/, 'Should list second session ID');
    assert.match(txt, /alpha/, 'Should show project name');
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Conflict detection responses
// ═══════════════════════════════════════════════════════════════════════════════

test('coord_detect_conflicts with conflicts has CONFLICTS DETECTED header', async () => {
  const { home, terminals } = setupHome();
  writeFileSync(join(terminals, 'session-sess1111.json'), JSON.stringify({
    session: 'sess1111', status: 'active', project: 'p', cwd: '/tmp/p',
    last_active: new Date().toISOString(), files_touched: ['/tmp/p/shared.ts'],
  }));
  writeFileSync(join(terminals, 'session-sess2222.json'), JSON.stringify({
    session: 'sess2222', status: 'active', project: 'p', cwd: '/tmp/p',
    last_active: new Date().toISOString(), files_touched: ['/tmp/p/shared.ts'],
  }));
  writeFileSync(join(terminals, 'activity.jsonl'), '');

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_detect_conflicts', {
      session_id: 'sess1111',
      files: ['/tmp/p/shared.ts'],
    });
    const txt = textOf(result);
    assert.match(txt, /CONFLICTS DETECTED/, 'Should have "CONFLICTS DETECTED" header');
    assert.match(txt, /shared\.ts/, 'Should list the conflicting file');
    assert.match(txt, /sess2222/, 'Should identify the conflicting session');
  } finally {
    restore();
  }
});

test('coord_detect_conflicts with no conflicts has clear safe message', async () => {
  const { home, terminals } = setupHome();
  writeFileSync(join(terminals, 'session-safesess.json'), JSON.stringify({
    session: 'safesess', status: 'active', project: 'p', cwd: '/tmp/p',
    last_active: new Date().toISOString(), files_touched: ['/tmp/p/unique.ts'],
  }));
  writeFileSync(join(terminals, 'activity.jsonl'), '');

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_detect_conflicts', {
      session_id: 'safesess',
      files: ['/tmp/p/unique.ts'],
    });
    const txt = textOf(result);
    assert.match(txt, /No conflicts detected/i, 'Should say no conflicts');
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Team creation response
// ═══════════════════════════════════════════════════════════════════════════════

test('handleCreateTeam success contains team name and member info', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleCreateTeam({
      team_name: 'golden-team',
      project: 'golden-project',
      members: [
        { name: 'alice', role: 'implementer' },
        { name: 'bob', role: 'reviewer' },
      ],
    });
    const txt = textOf(result);
    assert.match(txt, /golden-team/, 'Should mention team name');
    assert.match(txt, /created|updated/i, 'Should indicate creation/update');
    assert.match(txt, /alice/, 'Should list first member');
    assert.match(txt, /bob/, 'Should list second member');
    assert.match(txt, /Members: 2/, 'Should show member count');
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Task listing response
// ═══════════════════════════════════════════════════════════════════════════════

test('handleListTasks output has table structure with columns', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    api.handleCreateTask({ team_name: 'alpha', subject: 'First task', priority: 'high', task_id: 'GOLDEN_T1' });
    api.handleCreateTask({ team_name: 'alpha', subject: 'Second task', priority: 'low', task_id: 'GOLDEN_T2' });

    const result = api.handleListTasks({});
    const txt = textOf(result);
    assert.match(txt, /## Tasks \(\d+\)/, 'Should have Tasks header with count');
    assert.match(txt, /ID.*Team.*Subject.*Status.*Priority/i, 'Should have table headers');
    assert.match(txt, /First task/, 'Should list first task');
    assert.match(txt, /Second task/, 'Should list second task');
  } finally {
    restore();
  }
});
