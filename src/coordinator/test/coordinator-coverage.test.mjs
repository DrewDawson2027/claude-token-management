/**
 * Coordinator coverage tests — workers.js, tasks.js, teams.js
 * Targets functions below 80% statement coverage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── helpers ─────────────────────────────────────────────────────────────────

async function loadForTest(home, envOverrides = {}) {
  const prev = {
    HOME: process.env.HOME,
    COORDINATOR_TEST_MODE: process.env.COORDINATOR_TEST_MODE,
    COORDINATOR_PLATFORM: process.env.COORDINATOR_PLATFORM,
    COORDINATOR_CLAUDE_BIN: process.env.COORDINATOR_CLAUDE_BIN,
  };
  process.env.HOME = home;
  process.env.COORDINATOR_TEST_MODE = '1';
  process.env.COORDINATOR_PLATFORM = 'linux';
  process.env.COORDINATOR_CLAUDE_BIN = 'echo';
  for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;
  const mod = await import(`../index.js?cov=${Date.now()}-${Math.random()}`);
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

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), 'coord-cov-'));
  const terminals = join(home, '.claude', 'terminals');
  mkdirSync(join(terminals, 'inbox'), { recursive: true });
  mkdirSync(join(terminals, 'results'), { recursive: true });
  mkdirSync(join(terminals, 'tasks'), { recursive: true });
  mkdirSync(join(terminals, 'teams'), { recursive: true });
  mkdirSync(join(home, '.claude', 'session-cache'), { recursive: true });
  return { home, terminals };
}

function textOf(result) {
  return result?.content?.[0]?.text || '';
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════════
// workers.js coverage
// ═══════════════════════════════════════════════════════════════════════════════





















// ═══════════════════════════════════════════════════════════════════════════════
// tasks.js coverage
// ═══════════════════════════════════════════════════════════════════════════════

test('handleCreateTask creates a task with team and subject', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleCreateTask({
      team_name: 'alpha',
      subject: 'Build the API',
      priority: 'high',
    });
    const txt = textOf(result);
    assert.match(txt, /Task created/);
    assert.match(txt, /Build the API/);
    assert.match(txt, /high/);
    assert.match(txt, /alpha/);
  } finally {
    restore();
  }
});

test('handleUpdateTask updates status and creates audit trail', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    // Create first
    const createResult = api.handleCreateTask({
      team_name: 'alpha',
      subject: 'Test update',
    });
    const taskId = textOf(createResult).match(/\*\*(T\d+)\*\*/)?.[1];
    assert.ok(taskId, 'Should extract task ID from: ' + textOf(createResult));

    // Update status
    const updateResult = api.handleUpdateTask({
      task_id: taskId,
      status: 'in_progress',
    });
    assert.match(textOf(updateResult), /status → in_progress/);

    // Verify audit trail
    const auditResult = api.handleGetTaskAudit({ task_id: taskId });
    const auditText = textOf(auditResult);
    assert.match(auditText, /Audit Trail/);
    assert.match(auditText, /created/);
    assert.match(auditText, /status_in_progress/);
  } finally {
    restore();
  }
});

test('handleUpdateTask with quality_gates metadata', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const createResult = api.handleCreateTask({ team_name: 'alpha', subject: 'QG test' });
    const taskId = textOf(createResult).match(/\*\*(T\d+)\*\*/)?.[1];
    assert.ok(taskId);

    const updateResult = api.handleUpdateTask({
      task_id: taskId,
      metadata: {
        quality_gates: ['tests_pass', 'lint_clean'],
        acceptance_criteria: ['API responds 200', 'No regressions'],
      },
    });
    assert.match(textOf(updateResult), /metadata updated/);

    // Verify gates are stored
    const taskFile = join(home, '.claude', 'terminals', 'tasks', `${taskId}.json`);
    const task = readJson(taskFile);
    assert.deepEqual(task.metadata.quality_gates, ['tests_pass', 'lint_clean']);
    assert.deepEqual(task.metadata.acceptance_criteria, ['API responds 200', 'No regressions']);
  } finally {
    restore();
  }
});

test('handleUpdateTask with blocked_by creates reverse blocks reference', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    // Create two tasks with explicit IDs to avoid timestamp collision
    const taskA = 'BLOCKA1';
    const taskB = 'BLOCKB1';
    api.handleCreateTask({ team_name: 'alpha', subject: 'Task A', task_id: taskA });
    api.handleCreateTask({ team_name: 'alpha', subject: 'Task B', task_id: taskB });

    // Task B is blocked by Task A
    api.handleUpdateTask({ task_id: taskB, add_blocked_by: [taskA] });

    // Verify reverse: Task A should now "block" Task B
    const taskAFile = join(home, '.claude', 'terminals', 'tasks', `${taskA}.json`);
    const taskAData = readJson(taskAFile);
    assert.ok(taskAData.blocks?.includes(taskB), 'Task A should have blocks reference to Task B');
  } finally {
    restore();
  }
});

test('handleUpdateTask with add_blocks creates reverse blocked_by', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const blocker = 'BLOCKER1';
    const blocked = 'BLOCKED1';
    api.handleCreateTask({ team_name: 'alpha', subject: 'Blocker', task_id: blocker });
    api.handleCreateTask({ team_name: 'alpha', subject: 'Blocked', task_id: blocked });

    api.handleUpdateTask({ task_id: blocker, add_blocks: [blocked] });

    const blockedFile = join(home, '.claude', 'terminals', 'tasks', `${blocked}.json`);
    const blockedData = readJson(blockedFile);
    assert.ok(blockedData.blocked_by?.includes(blocker), 'Blocked task should have blocked_by reference');
  } finally {
    restore();
  }
});

test('handleReassignTask reassigns in-progress task', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const createResult = api.handleCreateTask({
      team_name: 'alpha',
      subject: 'Reassign me',
      assignee: 'worker-a',
    });
    const taskId = textOf(createResult).match(/\*\*(T\d+)\*\*/)?.[1];
    assert.ok(taskId);

    // Set to in_progress (required for reassignment)
    api.handleUpdateTask({ task_id: taskId, status: 'in_progress' });

    const result = api.handleReassignTask({
      task_id: taskId,
      new_assignee: 'worker-b',
      reason: 'worker-a is overloaded',
    });
    const txt = textOf(result);
    assert.match(txt, /Task Reassigned/);
    assert.match(txt, /worker-a/);
    assert.match(txt, /worker-b/);
    assert.match(txt, /overloaded/);

    // Verify handoff file was created
    const handoffFile = join(home, '.claude', 'terminals', 'results', `${taskId}.handoff.json`);
    assert.ok(existsSync(handoffFile), 'Handoff file should be created');
    const handoff = readJson(handoffFile);
    assert.equal(handoff.from, 'worker-a');
    assert.equal(handoff.to, 'worker-b');
  } finally {
    restore();
  }
});

test('handleReassignTask rejects non-in-progress task', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const createResult = api.handleCreateTask({ team_name: 'alpha', subject: 'Pending task' });
    const taskId = textOf(createResult).match(/\*\*(T\d+)\*\*/)?.[1];
    assert.ok(taskId);

    const result = api.handleReassignTask({ task_id: taskId, new_assignee: 'worker-b' });
    assert.match(textOf(result), /not in_progress/i);
  } finally {
    restore();
  }
});

test('handleReassignTask returns not found for missing task', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleReassignTask({ task_id: 'TASK-99999', new_assignee: 'x' });
    assert.match(textOf(result), /not found/i);
  } finally {
    restore();
  }
});

test('handleCheckQualityGates returns pass when all gates pass', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const createResult = api.handleCreateTask({ team_name: 'alpha', subject: 'Gates test' });
    const taskId = textOf(createResult).match(/\*\*(T\d+)\*\*/)?.[1];
    assert.ok(taskId);

    // Set quality gates and mark them all as passed
    api.handleUpdateTask({
      task_id: taskId,
      metadata: {
        quality_gates: ['tests_pass', 'lint_clean'],
        gate_results: { tests_pass: true, lint_clean: true },
        acceptance_criteria: ['API works'],
        criteria_results: ['API works'],
      },
    });

    const result = api.handleCheckQualityGates({ task_id: taskId });
    const txt = textOf(result);
    assert.match(txt, /Overall: PASS/);
    assert.match(txt, /\[x\].*tests_pass/);
    assert.match(txt, /\[x\].*lint_clean/);
  } finally {
    restore();
  }
});

test('handleCheckQualityGates returns fail when gates missing', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const createResult = api.handleCreateTask({ team_name: 'alpha', subject: 'Fail gates' });
    const taskId = textOf(createResult).match(/\*\*(T\d+)\*\*/)?.[1];
    assert.ok(taskId);

    // Set gates but don't mark any as passed
    api.handleUpdateTask({
      task_id: taskId,
      metadata: {
        quality_gates: ['tests_pass', 'lint_clean'],
        // no gate_results → all fail
      },
    });

    const result = api.handleCheckQualityGates({ task_id: taskId });
    const txt = textOf(result);
    assert.match(txt, /Overall: FAIL/);
    assert.match(txt, /\[ \].*tests_pass/);
  } finally {
    restore();
  }
});

test('handleCheckQualityGates returns no gates message when none set', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const createResult = api.handleCreateTask({ team_name: 'alpha', subject: 'No gates' });
    const taskId = textOf(createResult).match(/\*\*(T\d+)\*\*/)?.[1];
    assert.ok(taskId);

    const result = api.handleCheckQualityGates({ task_id: taskId });
    assert.match(textOf(result), /no quality gates/i);
  } finally {
    restore();
  }
});

test('handleGetTaskAudit returns empty message for task with no trail', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleGetTaskAudit({ task_id: 'TASK-NOAUDIT' });
    assert.match(textOf(result), /No audit trail/i);
  } finally {
    restore();
  }
});

test('handleListTasks filters by status and assignee', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    // Create multiple tasks
    api.handleCreateTask({ team_name: 'alpha', subject: 'Pending task', assignee: 'worker-a' });
    const r2 = api.handleCreateTask({ team_name: 'alpha', subject: 'Active task', assignee: 'worker-b' });
    const activeId = textOf(r2).match(/\*\*(T\d+)\*\*/)?.[1];
    if (activeId) api.handleUpdateTask({ task_id: activeId, status: 'in_progress' });

    // Filter by status
    const pending = api.handleListTasks({ status: 'pending' });
    assert.match(textOf(pending), /Pending task/);

    // Filter by assignee
    const workerA = api.handleListTasks({ assignee: 'worker-a' });
    assert.match(textOf(workerA), /worker-a/);
    assert.doesNotMatch(textOf(workerA), /worker-b/);

    // List all
    const all = api.handleListTasks({});
    assert.match(textOf(all), /Tasks \(/);
  } finally {
    restore();
  }
});

test('handleUpdateTask returns no changes when empty update', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const createResult = api.handleCreateTask({ team_name: 'alpha', subject: 'Empty update' });
    const taskId = textOf(createResult).match(/\*\*(T\d+)\*\*/)?.[1];
    assert.ok(taskId);

    const result = api.handleUpdateTask({ task_id: taskId });
    assert.match(textOf(result), /No changes/i);
  } finally {
    restore();
  }
});

test('handleUpdateTask with metadata null deletes key', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const createResult = api.handleCreateTask({ team_name: 'alpha', subject: 'Meta delete' });
    const taskId = textOf(createResult).match(/\*\*(T\d+)\*\*/)?.[1];
    assert.ok(taskId);

    // Add metadata
    api.handleUpdateTask({ task_id: taskId, metadata: { foo: 'bar', baz: 123 } });

    // Delete foo key
    api.handleUpdateTask({ task_id: taskId, metadata: { foo: null } });

    const taskFile = join(home, '.claude', 'terminals', 'tasks', `${taskId}.json`);
    const task = readJson(taskFile);
    assert.equal(task.metadata.foo, undefined, 'foo should be deleted');
    assert.equal(task.metadata.baz, 123, 'baz should remain');
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// teams.js coverage
// ═══════════════════════════════════════════════════════════════════════════════

test('handleCreateTeam with preset "simple" applies correct defaults', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleCreateTeam({
      team_name: 'test-simple',
      preset: 'simple',
      members: [{ name: 'worker-1', role: 'implementer' }],
    });
    const txt = textOf(result);
    assert.match(txt, /Team.*created.*test-simple/i);
    assert.match(txt, /worker-1/);

    const teamFile = join(home, '.claude', 'terminals', 'teams', 'test-simple.json');
    const team = readJson(teamFile);
    assert.equal(team.execution_path, 'hybrid');
    assert.equal(team.preset, 'simple');
    assert.equal(team.policy.permission_mode, 'acceptEdits');
    assert.equal(team.policy.require_plan, false);
    assert.equal(team.policy.budget_policy, 'warn');
    assert.equal(team.policy.default_context_level, 'standard');
  } finally {
    restore();
  }
});

test('handleCreateTeam with preset "strict" applies strict policy', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleCreateTeam({
      team_name: 'test-strict',
      preset: 'strict',
      members: [{ name: 'reviewer', role: 'reviewer' }],
    });
    assert.match(textOf(result), /test-strict/);

    const teamFile = join(home, '.claude', 'terminals', 'teams', 'test-strict.json');
    const team = readJson(teamFile);
    assert.equal(team.execution_path, 'coordinator');
    assert.equal(team.policy.permission_mode, 'planOnly');
    assert.equal(team.policy.require_plan, true);
    assert.equal(team.policy.budget_policy, 'enforce');
  } finally {
    restore();
  }
});

test('handleCreateTeam with preset "native-first" sets native execution path', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleCreateTeam({
      team_name: 'test-native',
      preset: 'native-first',
    });
    assert.match(textOf(result), /test-native/);

    const teamFile = join(home, '.claude', 'terminals', 'teams', 'test-native.json');
    const team = readJson(teamFile);
    assert.equal(team.execution_path, 'native');
  } finally {
    restore();
  }
});

test('handleGetTeam returns team details for existing team', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    api.handleCreateTeam({
      team_name: 'get-test',
      project: 'demo-project',
      description: 'A test team',
      members: [{ name: 'worker-x', role: 'planner' }],
    });

    const result = api.handleGetTeam({ team_name: 'get-test' });
    const txt = textOf(result);
    assert.match(txt, /Team: get-test/);
    assert.match(txt, /demo-project/);
    assert.match(txt, /worker-x/);
    assert.match(txt, /planner/);
  } finally {
    restore();
  }
});

test('handleGetTeam returns not found for missing team', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleGetTeam({ team_name: 'nonexistent' });
    assert.match(textOf(result), /not found/i);
  } finally {
    restore();
  }
});

test('handleDeleteTeam removes team file', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    api.handleCreateTeam({ team_name: 'delete-me', members: [{ name: 'w1', role: 'worker' }] });

    const teamFile = join(home, '.claude', 'terminals', 'teams', 'delete-me.json');
    assert.ok(existsSync(teamFile), 'Team file should exist before delete');

    const result = api.handleToolCall('coord_delete_team', { team_name: 'delete-me' });
    assert.match(textOf(result), /deleted/i);
    assert.ok(!existsSync(teamFile), 'Team file should be removed after delete');
  } finally {
    restore();
  }
});

test('handleDeleteTeam with clean_tasks removes associated tasks', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    api.handleCreateTeam({ team_name: 'clean-team' });
    api.handleCreateTask({ team_name: 'clean-team', subject: 'Task to clean' });

    const result = api.handleToolCall('coord_delete_team', { team_name: 'clean-team', clean_tasks: true });
    const txt = textOf(result);
    assert.match(txt, /deleted/i);
    assert.match(txt, /Tasks cleaned/);
  } finally {
    restore();
  }
});

test('handleDeleteTeam returns not found for missing team', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_delete_team', { team_name: 'ghost-team' });
    assert.match(textOf(result), /not found/i);
  } finally {
    restore();
  }
});

test('handleCreateTeam normalizes invalid policy fields to defaults', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleCreateTeam({
      team_name: 'bad-policy',
      policy: {
        permission_mode: 'invalid_mode',     // not in enum → dropped
        require_plan: 'maybe',               // not boolean → dropped
        budget_tokens: -100,                  // negative → dropped
        max_active_workers: 0,               // zero → dropped (posInt requires > 0)
        default_mode: 'pipe',                // valid → kept
        budget_policy: 'enforce',            // valid → kept
      },
    });
    assert.match(textOf(result), /bad-policy/);

    const teamFile = join(home, '.claude', 'terminals', 'teams', 'bad-policy.json');
    const team = readJson(teamFile);
    // Invalid fields should NOT be present
    assert.equal(team.policy.permission_mode, undefined, 'invalid mode should be dropped');
    assert.equal(team.policy.require_plan, undefined, 'non-boolean should be dropped');
    assert.equal(team.policy.budget_tokens, undefined, 'negative int should be dropped');
    assert.equal(team.policy.max_active_workers, undefined, 'zero should be dropped');
    // Valid fields should be present
    assert.equal(team.policy.default_mode, 'pipe');
    assert.equal(team.policy.budget_policy, 'enforce');
  } finally {
    restore();
  }
});

test('coord_update_team_policy merges interrupt_weights via dedicated action', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    api.handleCreateTeam({
      team_name: 'policy-merge-team',
      policy: {
        default_mode: 'pipe',
        interrupt_weights: { approval: 100, bridge: 90 },
      },
    });

    const result = api.handleToolCall('coord_update_team_policy', {
      team_name: 'policy-merge-team',
      interrupt_weights: {
        bridge: 123,
        stale: 77,
      },
    });
    assert.match(textOf(result), /Team policy updated/i);

    const teamFile = join(home, '.claude', 'terminals', 'teams', 'policy-merge-team.json');
    const team = readJson(teamFile);
    assert.equal(team.policy.default_mode, 'pipe');
    assert.deepEqual(team.policy.interrupt_weights, {
      approval: 100,
      bridge: 123,
      stale: 77,
    });
  } finally {
    restore();
  }
});

test('handleCreateTeam updates existing team with member merge', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    // Create initial team
    api.handleCreateTeam({
      team_name: 'merge-team',
      members: [{ name: 'original', role: 'worker' }],
    });

    // Update with new member and update existing
    api.handleCreateTeam({
      team_name: 'merge-team',
      members: [
        { name: 'original', role: 'lead' },   // update role
        { name: 'new-member', role: 'tester' }, // add new
      ],
    });

    const teamFile = join(home, '.claude', 'terminals', 'teams', 'merge-team.json');
    const team = readJson(teamFile);
    assert.equal(team.members.length, 2);
    const original = team.members.find(m => m.name === 'original');
    const newMember = team.members.find(m => m.name === 'new-member');
    assert.equal(original.role, 'lead', 'Existing member role should be updated');
    assert.equal(newMember.role, 'tester', 'New member should be added');
  } finally {
    restore();
  }
});

test('handleListTeams shows all teams', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    api.handleCreateTeam({ team_name: 'team-alpha', project: 'alpha-proj' });
    api.handleCreateTeam({ team_name: 'team-beta', project: 'beta-proj' });

    const result = api.handleListTeams();
    const txt = textOf(result);
    assert.match(txt, /Teams \(2\)/);
    assert.match(txt, /team-alpha/);
    assert.match(txt, /team-beta/);
  } finally {
    restore();
  }
});

// ─── GAP 4: auto permission mode ──────────────────────────────────────────────

test('normalizeTeamPolicy accepts auto permission_mode', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    api.handleCreateTeam({
      team_name: 'auto-mode-team',
      policy: { permission_mode: 'auto' },
    });

    const teamFile = join(home, '.claude', 'terminals', 'teams', 'auto-mode-team.json');
    const team = readJson(teamFile);
    assert.equal(team.policy.permission_mode, 'auto', 'auto mode should be accepted by normalizeTeamPolicy');
  } finally {
    restore();
  }
});

// ─── GAP 6: active teammate guard ─────────────────────────────────────────────

test('handleDeleteTeam blocks deletion when teammate is active', async () => {
  const { home, terminals } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();

    // Create team with a member that has a session_id
    const sessionId = 'abcd1234';
    api.handleCreateTeam({
      team_name: 'guarded-team',
      members: [{ name: 'worker-alpha', role: 'worker', session_id: sessionId }],
    });

    // Write a session file that looks active (last_active = now)
    const sessionFile = join(terminals, `session-${sessionId}.json`);
    writeFileSync(sessionFile, JSON.stringify({
      status: 'active',
      last_active: new Date().toISOString(),
      worker_name: 'worker-alpha',
    }));

    const result = api.handleToolCall('coord_delete_team', { team_name: 'guarded-team' });
    const txt = textOf(result);
    assert.match(txt, /Cannot delete team/, 'should block deletion when teammate is active');
    assert.match(txt, /worker-alpha/, 'should name the active teammate');
  } finally {
    restore();
  }
});

test('handleDeleteTeam proceeds with force:true even if teammate is active', async () => {
  const { home, terminals } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();

    const sessionId = 'eeee9999';
    api.handleCreateTeam({
      team_name: 'force-delete-team',
      members: [{ name: 'worker-beta', role: 'worker', session_id: sessionId }],
    });

    // Write an active session
    const sessionFile = join(terminals, `session-${sessionId}.json`);
    writeFileSync(sessionFile, JSON.stringify({
      status: 'active',
      last_active: new Date().toISOString(),
      worker_name: 'worker-beta',
    }));

    const result = api.handleToolCall('coord_delete_team', { team_name: 'force-delete-team', force: true });
    const txt = textOf(result);
    assert.match(txt, /deleted/i, 'force:true should bypass active check and delete');
  } finally {
    restore();
  }
});
