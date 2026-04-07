/**
 * Performance benchmarks for coordinator operations:
 * conflict detection scaling, regression thresholds, and metrics output.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), 'coord-bench-'));
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
    COORDINATOR_METRICS: process.env.COORDINATOR_METRICS,
  };
  process.env.HOME = home;
  process.env.COORDINATOR_TEST_MODE = '1';
  process.env.COORDINATOR_PLATFORM = 'linux';
  process.env.COORDINATOR_CLAUDE_BIN = 'echo';
  for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;
  const mod = await import(`../index.js?bench=${Date.now()}-${Math.random()}`);
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

function createSessions(terminals, count, filesPerSession) {
  for (let i = 0; i < count; i++) {
    const files = [];
    for (let j = 0; j < filesPerSession; j++) {
      files.push(`/tmp/project/src/file_${i}_${j}.ts`);
    }
    writeFileSync(join(terminals, `session-bench${String(i).padStart(4, '0')}.json`), JSON.stringify({
      session: `bench${String(i).padStart(4, '0')}`,
      status: 'active',
      cwd: '/tmp/project',
      project: 'bench-project',
      last_active: new Date().toISOString(),
      files_touched: files,
    }));
  }
  writeFileSync(join(terminals, 'activity.jsonl'), '');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Conflict detection benchmarks (Item 5)
// ═══════════════════════════════════════════════════════════════════════════════

test('conflict detection: 50 sessions × 10 files completes in <100ms', async () => {
  const { home, terminals } = setupHome();
  createSessions(terminals, 50, 10);

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const start = performance.now();
    api.handleToolCall('coord_detect_conflicts', {
      session_id: 'bench0000',
      files: ['/tmp/project/src/file_1_0.ts'], // overlaps with session bench0001
    });
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 100, `50×10 conflict detection took ${elapsed.toFixed(1)}ms, should be <100ms`);
  } finally {
    restore();
  }
});

test('conflict detection: 200 sessions × 20 files completes in <300ms', async () => {
  const { home, terminals } = setupHome();
  createSessions(terminals, 200, 20);

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const start = performance.now();
    api.handleToolCall('coord_detect_conflicts', {
      session_id: 'bench0000',
      files: ['/tmp/project/src/file_50_5.ts', '/tmp/project/src/file_100_10.ts'],
    });
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 300, `200×20 conflict detection took ${elapsed.toFixed(1)}ms, should be <300ms`);
  } finally {
    restore();
  }
});

test('conflict detection: 500 sessions × 50 files completes in <1500ms', async () => {
  const { home, terminals } = setupHome();
  createSessions(terminals, 500, 50);

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const start = performance.now();
    api.handleToolCall('coord_detect_conflicts', {
      session_id: 'bench0000',
      files: ['/tmp/project/src/file_250_25.ts'],
    });
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 1500, `500×50 conflict detection took ${elapsed.toFixed(1)}ms, should be <1500ms`);
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Structured metrics output (Item 7)
// ═══════════════════════════════════════════════════════════════════════════════

test('COORDINATOR_METRICS=1 adds timing to spawn_worker response', async () => {
  const { home } = setupHome();
  const projectDir = join(home, 'project');
  mkdirSync(projectDir, { recursive: true });

  const { api, restore } = await loadForTest(home, { COORDINATOR_METRICS: '1' });
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_spawn_worker', {
      directory: projectDir,
      prompt: 'Timed spawn',
      model: 'haiku',
    });
    const txt = textOf(result);
    assert.match(txt, /_timing: \d+(\.\d+)?ms_/, 'Response should contain timing metadata');
  } finally {
    restore();
  }
});

test('COORDINATOR_METRICS=1 adds timing to team_dispatch response', async () => {
  const { home } = setupHome();
  const projectDir = join(home, 'project');
  mkdirSync(projectDir, { recursive: true });

  const { api, restore } = await loadForTest(home, { COORDINATOR_METRICS: '1' });
  try {
    api.ensureDirsOnce();
    api.handleCreateTeam({
      team_name: 'metrics-team',
      members: [{ name: 'worker-m', role: 'implementer' }],
    });
    const result = api.handleToolCall('coord_team_dispatch', {
      team_name: 'metrics-team',
      subject: 'Metrics test task',
      prompt: 'Do something measurable',
      directory: projectDir,
    });
    const txt = textOf(result);
    assert.match(txt, /_timing: \d+(\.\d+)?ms_/, 'Dispatch response should contain timing');
  } finally {
    restore();
  }
});

test('COORDINATOR_METRICS unset does NOT add timing', async () => {
  const { home } = setupHome();
  const projectDir = join(home, 'project');
  mkdirSync(projectDir, { recursive: true });

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_spawn_worker', {
      directory: projectDir,
      prompt: 'No metrics',
      model: 'sonnet',
    });
    const txt = textOf(result);
    assert.ok(!txt.includes('_timing:'), 'Response should NOT contain timing when metrics disabled');
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Operation latency baselines (Item 6)
// ═══════════════════════════════════════════════════════════════════════════════

test('coord_spawn_worker dispatch latency under 100ms in no-op test mode', async () => {
  const { home } = setupHome();
  const projectDir = join(home, 'project');
  mkdirSync(projectDir, { recursive: true });

  const { api, restore } = await loadForTest(home, {
    COORDINATOR_FAKE_VISIBLE_LAUNCH_NOOP: '1',
    COORDINATOR_FAKE_VISIBLE_LAUNCH_READY: '1',
  });
  try {
    api.ensureDirsOnce();
    const start = performance.now();
    api.handleToolCall('coord_spawn_worker', {
      directory: projectDir,
      prompt: 'Latency test',
      model: 'sonnet',
    });
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 100, `spawn_worker took ${elapsed.toFixed(1)}ms, should be <100ms`);
  } finally {
    restore();
  }
});

test('coord_create_task + coord_list_tasks pipeline under 30ms', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const start = performance.now();
    api.handleToolCall('coord_create_task', {
      team_name: 'perf-team',
      subject: 'Perf test task',
      task_id: 'PERF_T1',
    });
    api.handleToolCall('coord_list_tasks', {});
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 30, `create+list pipeline took ${elapsed.toFixed(1)}ms, should be <30ms`);
  } finally {
    restore();
  }
});
