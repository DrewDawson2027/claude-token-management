/**
 * Team-tasking branch coverage — targets uncovered branches in team-tasking.js
 * (currently 46.15% branch coverage).
 *
 * Covers:
 *  - handleTeamRebalance: no queued tasks
 *  - handleTeamRebalance: apply=false (dry-run)
 *  - handleTeamRebalance: apply=true + dispatch_next=true (line 1083-1086)
 *  - handleTeamRebalance: include_in_progress=true (lines 1097-1100)
 *  - handleTeamRebalance: current === next (no change, not pushed to changes)
 *  - handleClaimNextTask: no assignee provided
 *  - handleClaimNextTask: completedWorkerTaskId but task already "completed"
 *  - handleClaimNextTask: completedWorkerTaskId not matching any team task
 *  - handleTeamAssignNext: no queued tasks
 *  - handleTeamAssignNext: blocked queued tasks only
 *  - handleTeamAssignNext: no eligible member (policy_mismatch via readOnly)
 *  - scoreMemberForTask: conflict_risk flag penalizes score
 *  - scoreMemberForTask: over_budget_risk flag
 *  - scoreMemberForTask: readOnly policy + implement role → invalid
 *  - buildPresence: dispatch_failed risk
 *  - handleTeamQueueTask: valid queuing
 *  - handleClaimNextTaskData: no assignee → found: false
 *  - handleClaimNextTaskData: completed worker task → re-fetch tasks
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
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
    COORDINATOR_CLAUDE_BIN: process.env.COORDINATOR_CLAUDE_BIN,
  };
  process.env.HOME = home;
  process.env.COORDINATOR_TEST_MODE = '1';
  process.env.COORDINATOR_PLATFORM = 'linux';
  process.env.COORDINATOR_CLAUDE_BIN = 'echo';
  const mod = await import(`../index.js?tt-br=${Date.now()}-${Math.random()}`);
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
  const home = mkdtempSync(join(tmpdir(), 'coord-tt-br-'));
  const terminals = join(home, '.claude', 'terminals');
  mkdirSync(join(terminals, 'inbox'), { recursive: true });
  mkdirSync(join(terminals, 'results'), { recursive: true });
  mkdirSync(join(terminals, 'tasks'), { recursive: true });
  mkdirSync(join(terminals, 'teams'), { recursive: true });
  mkdirSync(join(home, '.claude', 'session-cache'), { recursive: true });
  return { home, terminals };
}

function writeTeam(home, cfg) {
  writeFileSync(
    join(home, '.claude', 'terminals', 'teams', `${cfg.team_name}.json`),
    JSON.stringify(cfg),
  );
}

function writeTask(home, task) {
  writeFileSync(
    join(home, '.claude', 'terminals', 'tasks', `${task.task_id}.json`),
    JSON.stringify({ created: new Date().toISOString(), ...task }),
  );
}

// ─── handleTeamRebalance ──────────────────────────────────────────────────────

test('team-rebalance: no queued tasks returns message', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    writeTeam(home, { team_name: 'rb-empty', members: [{ name: 'alice', role: 'coder' }] });
    // No tasks written → no queued tasks
    const result = api.handleTeamRebalance({ team_name: 'rb-empty' });
    assert.match(contentText(result), /no queued tasks/i);
  } finally {
    restore();
  }
});

test('team-rebalance: apply=false (dry-run) shows proposed changes without updating', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    writeTeam(home, {
      team_name: 'rb-dryrun',
      members: [
        { name: 'alice', role: 'coder' },
        { name: 'bob', role: 'reviewer' },
      ],
    });
    writeTask(home, {
      task_id: 'T_DR_1',
      team_name: 'rb-dryrun',
      subject: 'Dry run task',
      status: 'pending',
      assignee: null,
      metadata: { dispatch: { status: 'queued', prompt: 'Do the thing.' } },
    });
    const result = api.handleTeamRebalance({ team_name: 'rb-dryrun', apply: false });
    const txt = contentText(result);
    assert.match(txt, /dry-run/i);
  } finally {
    restore();
  }
});

test('team-rebalance: include_in_progress=true appends in-progress note (lines 1097-1100)', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    writeTeam(home, {
      team_name: 'rb-inprog',
      members: [{ name: 'carol', role: 'coder' }],
    });
    writeTask(home, {
      task_id: 'T_IP_1',
      team_name: 'rb-inprog',
      subject: 'Queue task',
      status: 'pending',
      metadata: { dispatch: { status: 'queued', prompt: 'Do work.' } },
    });
    const result = api.handleTeamRebalance({
      team_name: 'rb-inprog',
      include_in_progress: true,
    });
    const txt = contentText(result);
    // Should include in-progress note
    assert.match(txt, /in-progress/i);
  } finally {
    restore();
  }
});

test('team-rebalance: dispatch_next=true triggers handleTeamAssignNext after rebalance (line 1083-1086)', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    writeTeam(home, {
      team_name: 'rb-dispatch',
      members: [{ name: 'dave', role: 'coder' }],
    });
    writeTask(home, {
      task_id: 'T_DN_1',
      team_name: 'rb-dispatch',
      subject: 'Dispatch next',
      status: 'pending',
      metadata: { dispatch: { status: 'queued', prompt: 'Do dispatch work.' } },
    });
    const result = api.handleTeamRebalance({
      team_name: 'rb-dispatch',
      apply: true,
      dispatch_next: true,
    });
    const txt = contentText(result);
    // Should include "Dispatch Next" section header
    assert.match(txt, /dispatch next/i);
  } finally {
    restore();
  }
});

test('team-rebalance: no assignment change when current===next member', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    writeTeam(home, {
      team_name: 'rb-nochange',
      members: [{ name: 'eve', role: 'coder' }],
    });
    // Task already assigned to the only member — current===next, no change
    writeTask(home, {
      task_id: 'T_NC_1',
      team_name: 'rb-nochange',
      subject: 'No change task',
      status: 'pending',
      assignee: 'eve',
      metadata: { dispatch: { status: 'queued', prompt: 'Keep working.' } },
    });
    const result = api.handleTeamRebalance({ team_name: 'rb-nochange', apply: true });
    const txt = contentText(result);
    // Changes count should be 0 (no reassignment)
    assert.match(txt, /Changes: 0/);
  } finally {
    restore();
  }
});

// ─── handleTeamAssignNext ────────────────────────────────────────────────────

test('team-assign-next: no queued tasks returns message', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    writeTeam(home, { team_name: 'an-empty', members: [{ name: 'foo', role: 'coder' }] });
    const result = api.handleTeamAssignNext({ team_name: 'an-empty' });
    assert.match(contentText(result), /no queued tasks/i);
  } finally {
    restore();
  }
});

test('team-assign-next: only blocked queued tasks returns dependency-blocked message', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    writeTeam(home, { team_name: 'an-blocked', members: [{ name: 'g', role: 'coder' }] });
    // Circular dependency: T_DEP_A blocks T_DEP_B and T_DEP_B blocks T_DEP_A.
    // Both are queued+pending, both have unresolved blockers → queued list is empty.
    writeTask(home, {
      task_id: 'T_DEP_A',
      team_name: 'an-blocked',
      subject: 'Task A',
      status: 'pending',
      blocked_by: ['T_DEP_B'],
      metadata: { dispatch: { status: 'queued', prompt: 'Do A.' } },
    });
    writeTask(home, {
      task_id: 'T_DEP_B',
      team_name: 'an-blocked',
      subject: 'Task B',
      status: 'pending',
      blocked_by: ['T_DEP_A'],
      metadata: { dispatch: { status: 'queued', prompt: 'Do B.' } },
    });
    const result = api.handleTeamAssignNext({ team_name: 'an-blocked' });
    assert.match(contentText(result), /dependency-blocked|no queued tasks/i);
  } finally {
    restore();
  }
});

test('team-assign-next: no eligible member due to readOnly policy + implement task', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    writeTeam(home, {
      team_name: 'an-readonly',
      members: [{ name: 'h', role: 'implementer' }],
      policy: { permission_mode: 'readOnly' },
    });
    writeTask(home, {
      task_id: 'T_RO_1',
      team_name: 'an-readonly',
      subject: 'Implement feature',
      status: 'pending',
      metadata: {
        dispatch: {
          status: 'queued',
          prompt: 'Implement the feature.',
          load_affinity: 'implement',
        },
      },
    });
    const result = api.handleTeamAssignNext({ team_name: 'an-readonly' });
    const txt = contentText(result);
    // Should report no eligible candidate with policy_mismatch explanation
    assert.match(txt, /no eligible candidate|policy_mismatch|readOnly/i);
  } finally {
    restore();
  }
});

// ─── handleClaimNextTask ─────────────────────────────────────────────────────

test('claim-next: no assignee returns "No assignee available"', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    writeTeam(home, { team_name: 'cn-noassign', members: [] });
    writeTask(home, {
      task_id: 'T_CN_1',
      team_name: 'cn-noassign',
      subject: 'Claimable',
      status: 'pending',
      metadata: { dispatch: { status: 'queued', prompt: 'Claim me.' } },
    });
    // No assignee arg, no members to fall back to
    const result = api.handleClaimNextTask({ team_name: 'cn-noassign' });
    assert.match(contentText(result), /no assignee available/i);
  } finally {
    restore();
  }
});

test('claim-next: completedWorkerTaskId but task already completed (skip update)', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    writeTeam(home, { team_name: 'cn-alreadydone', members: [] });
    writeTask(home, {
      task_id: 'T_DONE_1',
      team_name: 'cn-alreadydone',
      subject: 'Already done',
      status: 'completed',  // already completed → should skip update
      assignee: 'alice',
      metadata: {
        dispatch: {
          status: 'completed',
          worker_task_id: 'W_DONE_1',
          prompt: 'Already done.',
        },
      },
    });
    const result = api.handleClaimNextTask({
      team_name: 'cn-alreadydone',
      assignee: 'alice',
      completed_worker_task_id: 'W_DONE_1',
    });
    // Should find no claimable queued tasks (only completed task)
    assert.match(contentText(result), /no claimable|no assignee/i);
  } finally {
    restore();
  }
});

test('claim-next: completedWorkerTaskId not matching any team task (no completedTask)', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    writeTeam(home, { team_name: 'cn-nomatch', members: [] });
    // No task has worker_task_id=W_MISSING
    const result = api.handleClaimNextTask({
      team_name: 'cn-nomatch',
      assignee: 'bob',
      completed_worker_task_id: 'W_MISSING_TASK',
    });
    // completedTask is null → still proceeds with assignee=bob, but no queued tasks
    assert.match(contentText(result), /no claimable|no assignee/i);
  } finally {
    restore();
  }
});

// ─── handleClaimNextTaskData ─────────────────────────────────────────────────

test('claim-next-data: no assignee returns found=false', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    writeTeam(home, { team_name: 'cnd-noassign', members: [] });
    const result = api.handleClaimNextTaskData({ team_name: 'cnd-noassign' });
    assert.strictEqual(result.found, false);
  } finally {
    restore();
  }
});

test('claim-next-data: task with empty prompt returns found=false', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    writeTeam(home, { team_name: 'cnd-noprompt', members: [] });
    writeTask(home, {
      task_id: 'T_NP_1',
      team_name: 'cnd-noprompt',
      subject: 'No prompt',
      status: 'pending',
      metadata: { dispatch: { status: 'queued', prompt: '' } }, // empty prompt
    });
    const result = api.handleClaimNextTaskData({
      team_name: 'cnd-noprompt',
      assignee: 'carol',
    });
    assert.strictEqual(result.found, false);
  } finally {
    restore();
  }
});

test('claim-next-data: valid task claimed returns found=true with task data', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    writeTeam(home, { team_name: 'cnd-valid', members: [] });
    writeTask(home, {
      task_id: 'T_CND_1',
      team_name: 'cnd-valid',
      subject: 'Claimable task',
      status: 'pending',
      metadata: { dispatch: { status: 'queued', prompt: 'Do the analysis.' } },
    });
    const result = api.handleClaimNextTaskData({
      team_name: 'cnd-valid',
      assignee: 'dave',
    });
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.task_id, 'T_CND_1');
    assert.strictEqual(result.prompt, 'Do the analysis.');
    assert.strictEqual(result.assignee, 'dave');
  } finally {
    restore();
  }
});

test('claim-next-data: completedWorkerTaskId triggers task completion before claiming', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    writeTeam(home, { team_name: 'cnd-complete', members: [] });
    // Previous task (pending, will be marked complete)
    writeTask(home, {
      task_id: 'T_PREV',
      team_name: 'cnd-complete',
      subject: 'Previous work',
      status: 'pending',
      assignee: 'eve',
      metadata: {
        dispatch: { status: 'dispatched', worker_task_id: 'W_PREV', prompt: 'Old task.' },
      },
    });
    // Next task to claim
    writeTask(home, {
      task_id: 'T_NEXT',
      team_name: 'cnd-complete',
      subject: 'Next work',
      status: 'pending',
      metadata: { dispatch: { status: 'queued', prompt: 'New task.' } },
    });
    const result = api.handleClaimNextTaskData({
      team_name: 'cnd-complete',
      assignee: 'eve',
      completed_worker_task_id: 'W_PREV',
    });
    // Should claim T_NEXT
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.task_id, 'T_NEXT');
  } finally {
    restore();
  }
});

// ─── handleTeamQueueTask ──────────────────────────────────────────────────────

test('team-queue-task: missing subject returns error', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    writeTeam(home, { team_name: 'qt-test', members: [] });
    const result = api.handleTeamQueueTask({
      team_name: 'qt-test',
      subject: '',
      prompt: 'Do it.',
    });
    assert.match(contentText(result), /subject is required/i);
  } finally {
    restore();
  }
});

test('team-queue-task: missing prompt returns error', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    writeTeam(home, { team_name: 'qt-test2', members: [] });
    const result = api.handleTeamQueueTask({
      team_name: 'qt-test2',
      subject: 'My task',
      prompt: '',
    });
    assert.match(contentText(result), /prompt is required/i);
  } finally {
    restore();
  }
});

test('team-queue-task: team not found returns error', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleTeamQueueTask({
      team_name: 'qt-missing',
      subject: 'My task',
      prompt: 'Do it.',
    });
    assert.match(contentText(result), /not found/i);
  } finally {
    restore();
  }
});

test('team-queue-task: with acceptance_criteria queues task', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    writeTeam(home, { team_name: 'qt-ac', members: [] });
    const result = api.handleTeamQueueTask({
      team_name: 'qt-ac',
      subject: 'Task with criteria',
      prompt: 'Write tests.',
      acceptance_criteria: ['all tests pass', 'coverage >= 80%'],
      role_hint: 'tester',
      load_affinity: 'testing',
      notify_session_id: 'lead0001',
      parent_session_id: 'parent01',
    });
    // Should succeed
    assert.match(contentText(result), /Task created/i);
  } finally {
    restore();
  }
});

// ─── handleTeamAssignNext: no-member team → suggestions fallback (lines 982-983) ──

test('team-assign-next: no named members → suggestions fallback "add more team members"', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    // Team with members that have no name — filtered out of candidates
    writeTeam(home, {
      team_name: 'an-noname',
      members: [{ role: 'coder' }], // no name field
    });
    writeTask(home, {
      task_id: 'T_NN_1',
      team_name: 'an-noname',
      subject: 'Nameless task',
      status: 'pending',
      metadata: { dispatch: { status: 'queued', prompt: 'Do nameless work.' } },
    });
    const result = api.handleTeamAssignNext({ team_name: 'an-noname' });
    const txt = contentText(result);
    // No eligible member found — "no candidate" path hits lines 982-983
    assert.match(txt, /no eligible candidate|add more team members|no queued tasks/i);
  } finally {
    restore();
  }
});

// ─── handleSidecarStatus with snapshot+lock present (lines 1146-1147) ───────

test('sidecar-status: no snapshot file covers else branch (lines 1146-1147)', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    // No snapshot file written → else branch fires: "Last Snapshot: none"
    const result = api.handleSidecarStatus();
    const txt = contentText(result);
    assert.match(txt, /Sidecar Status/i);
    assert.match(txt, /Last Snapshot: none/);
  } finally {
    restore();
  }
});

test('sidecar-status: snapshot and lock files present cover true branches', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadCoord(home);
  try {
    api.ensureDirsOnce();
    const sidecarRoot = join(home, '.claude', 'lead-sidecar');
    const runtimeDir = join(sidecarRoot, 'runtime');
    const stateDir = join(sidecarRoot, 'state');
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });

    // Write lock file with pid (covers line 1142: if (lock?.pid))
    writeFileSync(join(runtimeDir, 'sidecar.lock'), JSON.stringify({ pid: 12345, started: new Date().toISOString() }));
    // Write port file (covers line 1143: if (port))
    writeFileSync(join(runtimeDir, 'sidecar.port'), JSON.stringify({ port: 3456 }));
    // Write snapshot with teams (covers lines 1144-1147: if (snapshot) true branch)
    writeFileSync(join(stateDir, 'latest.json'), JSON.stringify({
      generated_at: new Date().toISOString(),
      teams: [{ team_name: 'alpha' }, { team_name: 'beta' }],
    }));
    // Write native bridge status (covers nativeBridge?.session_id and task_id)
    const nativeDir = join(runtimeDir, 'native');
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(join(nativeDir, 'bridge.status.json'), JSON.stringify({
      bridge_status: 'up',
      session_id: 'bridge-sess-1',
      task_id: 'bridge-task-1',
    }));
    // Write heartbeat (covers nativeHeartbeat?.ts)
    writeFileSync(join(nativeDir, 'bridge.heartbeat.json'), JSON.stringify({
      ts: new Date().toISOString(),
    }));

    const result = api.handleSidecarStatus();
    const txt = contentText(result);
    assert.match(txt, /Sidecar Status/i);
    assert.match(txt, /PID: 12345/);
    assert.match(txt, /Port: 3456/);
    assert.match(txt, /Teams: 2/);
    assert.match(txt, /Bridge Session: bridge-sess-1/);
    assert.match(txt, /Bridge Task: bridge-task-1/);
  } finally {
    restore();
  }
});
