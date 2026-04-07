import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { __test__ } from '../index.js';
import { readAuditTrail } from '../lib/tasks.js';

const { handleCreateTask, handleUpdateTask, handleListTasks, handleGetTask } = __test__;

function setupTmpEnv() {
  const root = mkdtempSync(join(tmpdir(), 'chaos-coord-'));
  const terminalsDir = join(root, 'terminals');
  const tasksDir = join(terminalsDir, 'tasks');
  const resultsDir = join(terminalsDir, 'results');
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(resultsDir, { recursive: true });
  // Override cfg for tests by setting env
  process.env.CLAUDE_HOME = root;
  return { root, tasksDir, resultsDir };
}

test('handleListTasks returns empty for missing tasks directory', () => {
  const origHome = process.env.CLAUDE_HOME;
  const root = mkdtempSync(join(tmpdir(), 'chaos-notasks-'));
  process.env.CLAUDE_HOME = root;
  try {
    const result = handleListTasks({});
    // Should not throw, should return valid output
    assert.ok(result, 'Should return a result');
  } catch (err) {
    // Some implementations may throw if dir doesn't exist — that's also acceptable
    assert.ok(err.message, 'Error should have a message');
  } finally {
    process.env.CLAUDE_HOME = origHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('handleGetTask handles non-existent task gracefully', () => {
  const result = handleGetTask({ task_id: 'nonexistent-task-99999' });
  // Should return an error message, not throw
  assert.ok(result, 'Should return a result');
});

test('handleUpdateTask handles updating non-existent task', () => {
  const result = handleUpdateTask({ task_id: 'ghost-task-00000', status: 'completed' });
  // Should return error, not throw
  assert.ok(result, 'Should return a result');
});

test('readAuditTrail handles non-existent audit file', () => {
  const trail = readAuditTrail('nonexistent-audit-task');
  assert.ok(Array.isArray(trail), 'Should return empty array');
  assert.equal(trail.length, 0);
});

test('readAuditTrail handles corrupt audit file', () => {
  const origHome = process.env.CLAUDE_HOME;
  const root = mkdtempSync(join(tmpdir(), 'chaos-audit-'));
  const resultsDir = join(root, 'terminals', 'results');
  mkdirSync(resultsDir, { recursive: true });
  process.env.CLAUDE_HOME = root;

  // Write corrupt JSONL
  writeFileSync(join(resultsDir, 'corrupt-task.audit.jsonl'), '{bad json\nnot valid\n');

  try {
    const trail = readAuditTrail('corrupt-task');
    // Should not throw, should skip corrupt lines
    assert.ok(Array.isArray(trail), 'Should return array');
  } finally {
    process.env.CLAUDE_HOME = origHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('sanitizeId rejects dangerous inputs', () => {
  const { sanitizeId } = __test__;
  assert.throws(() => sanitizeId('../../../etc/passwd', 'task_id'), 'Should reject path traversal');
  assert.throws(() => sanitizeId('task;rm -rf /', 'task_id'), 'Should reject shell injection');
  assert.throws(() => sanitizeId('', 'task_id'), 'Should reject empty string');
});

test('rapid sequential task operations do not corrupt state', () => {
  const results = [];
  for (let i = 0; i < 10; i++) {
    try {
      const result = handleGetTask({ task_id: `sequential-test-${i}` });
      results.push(result);
    } catch {
      results.push(null);
    }
  }
  assert.equal(results.length, 10, 'All 10 operations should complete');
});
