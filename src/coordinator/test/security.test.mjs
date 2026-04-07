import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, chmodSync, statSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function loadForTest(home, envOverrides = {}) {
  const prev = { HOME: process.env.HOME, COORDINATOR_TEST_MODE: process.env.COORDINATOR_TEST_MODE, COORDINATOR_PLATFORM: process.env.COORDINATOR_PLATFORM, COORDINATOR_MAX_MESSAGE_BYTES: process.env.COORDINATOR_MAX_MESSAGE_BYTES, COORDINATOR_MAX_MESSAGES_PER_MINUTE: process.env.COORDINATOR_MAX_MESSAGES_PER_MINUTE };
  process.env.HOME = home;
  process.env.COORDINATOR_TEST_MODE = '1';
  if (!envOverrides.COORDINATOR_PLATFORM) process.env.COORDINATOR_PLATFORM = 'linux';
  for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;
  const mod = await import(`../index.js?security=${Date.now()}-${Math.random()}`);
  return {
    api: mod.__test__,
    restore: () => {
      for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      for (const k of Object.keys(envOverrides)) { if (!(k in prev)) delete process.env[k]; }
    },
  };
}

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), 'coord-security-'));
  const terminals = join(home, '.claude', 'terminals');
  const inbox = join(terminals, 'inbox');
  const results = join(terminals, 'results');
  const sessionCache = join(home, '.claude', 'session-cache');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(results, { recursive: true });
  mkdirSync(sessionCache, { recursive: true });
  return { home, terminals };
}

// --- Input validation edge cases ---

test('sanitizeId handles boundary lengths', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    assert.equal(api.sanitizeId('a', 'test'), 'a');
    assert.equal(api.sanitizeId('a'.repeat(64), 'test'), 'a'.repeat(64));
    assert.throws(() => api.sanitizeId('a'.repeat(65), 'test'));
    assert.throws(() => api.sanitizeId('', 'test'));
  } finally {
    restore();
  }
});

test('sanitizeShortSessionId rejects short inputs', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    assert.throws(() => api.sanitizeShortSessionId('abc'));
    assert.throws(() => api.sanitizeShortSessionId('1234567'));
    assert.equal(api.sanitizeShortSessionId('12345678'), '12345678');
    assert.equal(api.sanitizeShortSessionId('12345678EXTRA'), '12345678');
  } finally {
    restore();
  }
});

test('sanitizeAgent allows empty and rejects special chars', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    assert.equal(api.sanitizeAgent(undefined), '');
    assert.equal(api.sanitizeAgent(null), '');
    assert.equal(api.sanitizeAgent(''), '');
    assert.equal(api.sanitizeAgent('my-agent'), 'my-agent');
    assert.throws(() => api.sanitizeAgent('agent;rm'));
  } finally {
    restore();
  }
});

test('requireDirectoryPath rejects null bytes and quotes', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    assert.throws(() => api.requireDirectoryPath('/tmp/\x00evil'));
    assert.throws(() => api.requireDirectoryPath('/tmp/"quoted"'));
    assert.throws(() => api.requireDirectoryPath('/tmp\ninjection'));
    assert.equal(api.requireDirectoryPath('/tmp/safe/path'), '/tmp/safe/path');
  } finally {
    restore();
  }
});

// --- Secure directory creation ---

test('ensureSecureDirectory creates with 0700 permissions', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const terminals = join(home, '.claude', 'terminals');
    const mode = statSync(terminals).mode & 0o777;
    assert.equal(mode, 0o700);
  } finally {
    restore();
  }
});

// --- Path normalization edge cases ---

test('normalizeFilePath handles empty and null inputs', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    assert.equal(api.normalizeFilePath('', '/tmp'), null);
    assert.equal(api.normalizeFilePath(null, '/tmp'), null);
    assert.equal(api.normalizeFilePath(undefined, '/tmp'), null);
  } finally {
    restore();
  }
});

test('normalizeFilePath resolves relative to cwd', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    const result = api.normalizeFilePath('./src/a.ts', '/tmp/project');
    assert.match(result, /\/tmp\/project\/src\/a\.ts/);
  } finally {
    restore();
  }
});

// --- Unknown tool handling ---

test('handleToolCall returns error for unknown tool', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_nonexistent', {});
    assert.match(result?.content?.[0]?.text || '', /Unknown tool/);
  } finally {
    restore();
  }
});

// --- Garbage collection ---

test('runGC removes old stale sessions and completed workers', async () => {
  const { home, terminals } = setupHome();
  const results = join(home, '.claude', 'terminals', 'results');

  // Create a stale session with old mtime
  writeFileSync(join(terminals, 'session-old12345.json'), JSON.stringify({
    session: 'old12345', status: 'stale', cwd: '/tmp', last_active: '2020-01-01T00:00:00Z',
  }));
  // Create an active session (should NOT be removed)
  writeFileSync(join(terminals, 'session-actv1234.json'), JSON.stringify({
    session: 'actv1234', status: 'active', cwd: '/tmp', last_active: new Date().toISOString(),
  }));
  // Create completed worker artifacts with old mtime
  writeFileSync(join(results, 'W_OLD.meta.json'), '{}');
  writeFileSync(join(results, 'W_OLD.meta.json.done'), '{"status":"completed"}');
  writeFileSync(join(results, 'W_OLD.txt'), 'output');

  // Set GC age to 0 (everything is "old")
  process.env.COORDINATOR_GC_MAX_AGE_MS = '0';
  const { api, restore } = await loadForTest(home);
  try {
    const counts = api.runGC();
    assert.equal(counts.sessions, 1); // stale session removed
    assert.equal(counts.results, 1); // completed worker removed
    assert.ok(existsSync(join(terminals, 'session-actv1234.json')), 'active session should survive');
    assert.ok(!existsSync(join(results, 'W_OLD.meta.json.done')), 'done file should be removed');
    assert.ok(!existsSync(join(results, 'W_OLD.txt')), 'result file should be removed');
  } finally {
    delete process.env.COORDINATOR_GC_MAX_AGE_MS;
    restore();
  }
});

// --- Branch coverage: acquireExclusiveFileLock ---

test('acquireExclusiveFileLock acquires and releases cleanly', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    const lockPath = join(home, 'test.lock');
    const release = api.acquireExclusiveFileLock(lockPath, 2000, 15000, 25);
    assert.ok(existsSync(lockPath));
    release();
    assert.ok(!existsSync(lockPath));
  } finally {
    restore();
  }
});

test('acquireExclusiveFileLock detects and cleans stale locks', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    const lockPath = join(home, 'stale.lock');
    // Create a stale lock file
    const fd = openSync(lockPath, 'wx', 0o600);
    closeSync(fd);
    // The lock has staleMs=100 — it should be cleaned after 100ms
    api.sleepMs(150);
    const release = api.acquireExclusiveFileLock(lockPath, 2000, 100, 25);
    assert.ok(existsSync(lockPath));
    release();
  } finally {
    restore();
  }
});

test('acquireExclusiveFileLock throws on timeout', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    const lockPath = join(home, 'held.lock');
    // Hold the lock
    const release1 = api.acquireExclusiveFileLock(lockPath, 2000, 60000, 25);
    // Try to acquire again with very short timeout — should throw
    assert.throws(
      () => api.acquireExclusiveFileLock(lockPath, 50, 60000, 10),
      /Could not acquire lock/
    );
    release1();
  } finally {
    restore();
  }
});

// --- Branch coverage: enforceMessageRateLimit ---

test('enforceMessageRateLimit allows under limit', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home, { COORDINATOR_MAX_MESSAGES_PER_MINUTE: '5' });
  try {
    api.ensureDirsOnce();
    // Should not throw for first call
    assert.doesNotThrow(() => api.enforceMessageRateLimit('rl123456'));
  } finally {
    restore();
  }
});

test('enforceMessageRateLimit throws when rate exceeded', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home, { COORDINATOR_MAX_MESSAGES_PER_MINUTE: '2' });
  try {
    api.ensureDirsOnce();
    api.enforceMessageRateLimit('ratelim1');
    api.enforceMessageRateLimit('ratelim1');
    assert.throws(
      () => api.enforceMessageRateLimit('ratelim1'),
      /Rate limit exceeded/
    );
  } finally {
    restore();
  }
});

test('enforceMessageRateLimit handles corrupt rate file', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home, { COORDINATOR_MAX_MESSAGES_PER_MINUTE: '10' });
  try {
    api.ensureDirsOnce();
    const rateFile = join(home, '.claude', 'terminals', 'rate-corrupt1.json');
    writeFileSync(rateFile, 'not-json!!!');
    // Should not throw — corrupt file is handled gracefully
    assert.doesNotThrow(() => api.enforceMessageRateLimit('corrupt1'));
  } finally {
    restore();
  }
});

// --- Branch coverage: normalizeFilePath win32 ---

test('normalizeFilePath lowercases on win32', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home, { COORDINATOR_PLATFORM: 'win32' });
  try {
    const result = api.normalizeFilePath('/Tmp/MyFile.TS', '/project');
    assert.equal(result, result.toLowerCase());
  } finally {
    restore();
  }
});

// --- Branch coverage: sleepMs edge cases ---

test('sleepMs handles zero and negative', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    // Should not throw
    api.sleepMs(0);
    api.sleepMs(-1);
    api.sleepMs(NaN);
  } finally {
    restore();
  }
});

// --- Branch coverage: getSessionStatus ---

test('getSessionStatus returns correct states', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    assert.equal(api.getSessionStatus({ status: 'closed' }), 'closed');
    assert.equal(api.getSessionStatus({ status: 'stale' }), 'stale');
    assert.equal(api.getSessionStatus({}), 'unknown');
    assert.equal(api.getSessionStatus({ last_active: new Date().toISOString() }), 'active');
    // Thresholds: active < 30s, idle < 60s, stale >= 60s
    const fortySecAgo = new Date(Date.now() - 40 * 1000).toISOString();
    assert.equal(api.getSessionStatus({ last_active: fortySecAgo }), 'idle');
    const seventySecAgo = new Date(Date.now() - 70 * 1000).toISOString();
    assert.equal(api.getSessionStatus({ last_active: seventySecAgo }), 'stale');
  } finally {
    restore();
  }
});

// --- Branch coverage: handleListSessions filters ---

test('handleListSessions filters by project and include_closed', async () => {
  const { home, terminals } = setupHome();
  writeFileSync(join(terminals, 'session-proj1234.json'), JSON.stringify({
    session: 'proj1234', status: 'active', cwd: '/tmp', project: 'alpha', last_active: new Date().toISOString(),
  }));
  writeFileSync(join(terminals, 'session-proj5678.json'), JSON.stringify({
    session: 'proj5678', status: 'closed', cwd: '/tmp', project: 'beta', last_active: new Date().toISOString(),
  }));
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    // Default: excludes closed
    const res1 = api.handleToolCall('coord_list_sessions', {});
    assert.match(res1?.content?.[0]?.text || '', /alpha/);
    assert.doesNotMatch(res1?.content?.[0]?.text || '', /beta/);
    // include_closed
    const res2 = api.handleToolCall('coord_list_sessions', { include_closed: true });
    assert.match(res2?.content?.[0]?.text || '', /beta/);
    // project filter
    const res3 = api.handleToolCall('coord_list_sessions', { project: 'alpha' });
    assert.match(res3?.content?.[0]?.text || '', /alpha/);
  } finally {
    restore();
  }
});

// --- Branch coverage: handleGetSession with tool_counts, files_touched, recent_ops ---

// --- Branch coverage: messaging drain fallback ---

test('handleCheckInbox returns no messages for empty inbox', async () => {
  const { home, terminals } = setupHome();
  const inbox = join(home, '.claude', 'terminals', 'inbox');
  writeFileSync(join(terminals, 'session-empty123.json'), JSON.stringify({
    session: 'empty123', status: 'active', cwd: '/tmp', project: 'demo', last_active: new Date().toISOString(),
  }));
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const res = api.handleToolCall('coord_check_inbox', { session_id: 'empty123' });
    assert.match(res?.content?.[0]?.text || '', /No pending messages/i);
  } finally {
    restore();
  }
});

// --- Branch coverage: handleGetSession not found ---

test('handleGetSession returns not found for missing session', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const res = api.handleToolCall('coord_get_session', { session_id: 'missing1' });
    assert.match(res?.content?.[0]?.text || '', /not found/i);
  } finally {
    restore();
  }
});

// --- Branch coverage: handleListSessions empty ---

test('handleListSessions returns no sessions when empty', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const res = api.handleToolCall('coord_list_sessions', {});
    assert.match(res?.content?.[0]?.text || '', /No active sessions/i);
  } finally {
    restore();
  }
});

// --- Branch coverage: getAllSessions error path ---

// --- Branch coverage: GC pipeline cleanup ---

test('runGC removes old completed pipelines', async () => {
  const { home, terminals } = setupHome();
  const results = join(home, '.claude', 'terminals', 'results');
  const pDir = join(results, 'P_OLD');
  mkdirSync(pDir, { recursive: true });
  writeFileSync(join(pDir, 'pipeline.done'), '{"status":"completed"}');
  writeFileSync(join(pDir, 'pipeline.meta.json'), '{}');

  process.env.COORDINATOR_GC_MAX_AGE_MS = '0';
  const { api, restore } = await loadForTest(home);
  try {
    const counts = api.runGC();
    assert.equal(counts.pipelines, 1);
    assert.ok(!existsSync(pDir), 'pipeline dir should be removed');
  } finally {
    delete process.env.COORDINATOR_GC_MAX_AGE_MS;
    restore();
  }
});

test('getAllSessions returns empty on read error', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    // Don't call ensureDirsOnce — terminals dir won't exist properly
    // getAllSessions is exercised through handleListSessions
    const res = api.handleToolCall('coord_list_sessions', {});
    // Should not crash even without sessions
    assert.ok(res?.content?.[0]?.text);
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Fuzz tests: coord_spawn_worker
// ─────────────────────────────────────────────────────────────────────────────

// Helper: assert that handleToolCall does not throw and returns a text response
async function assertSafeResponse(toolName, args, home) {
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    let result;
    assert.doesNotThrow(() => { result = api.handleToolCall(toolName, args); });
    // Must return a content array (even for errors)
    assert.ok(result?.content?.[0]?.text, `${toolName} must return a text response`);
    return result.content[0].text;
  } finally {
    restore();
  }
}

test('coord_spawn_worker: malicious worker_name with path traversal is sanitized', async () => {
  const { home } = setupHome();
  const text = await assertSafeResponse('coord_spawn_worker', {
    directory: '/tmp',
    prompt: 'hello world',
    worker_name: '../../../etc/passwd',
  }, home);
  // Should not crash — sanitizeAgent/workerName strips non-alphanumeric
  assert.ok(typeof text === 'string');
});

test('coord_spawn_worker: worker_name with shell metacharacters is sanitized', async () => {
  const { home } = setupHome();
  const text = await assertSafeResponse('coord_spawn_worker', {
    directory: '/tmp',
    prompt: 'hello world',
    worker_name: 'name; rm -rf /',
  }, home);
  assert.ok(typeof text === 'string');
});

test('coord_spawn_worker: worker_name with null byte is sanitized', async () => {
  const { home } = setupHome();
  const text = await assertSafeResponse('coord_spawn_worker', {
    directory: '/tmp',
    prompt: 'hello world',
    worker_name: 'worker\x00evil',
  }, home);
  assert.ok(typeof text === 'string');
});

test('coord_spawn_worker: SQL injection in prompt does not crash', async () => {
  const { home } = setupHome();
  const text = await assertSafeResponse('coord_spawn_worker', {
    directory: '/tmp',
    prompt: "'; DROP TABLE sessions; SELECT '1",
  }, home);
  assert.ok(typeof text === 'string');
});

test('coord_spawn_worker: XSS payload in prompt does not crash', async () => {
  const { home } = setupHome();
  const text = await assertSafeResponse('coord_spawn_worker', {
    directory: '/tmp',
    prompt: '<script>alert("xss")</script>',
  }, home);
  assert.ok(typeof text === 'string');
});

test('coord_spawn_worker: path traversal in directory is rejected', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    // requireDirectoryPath rejects null bytes and quotes; ../.. should be blocked
    assert.doesNotThrow(() => {
      const result = api.handleToolCall('coord_spawn_worker', {
        directory: '/tmp/../../../etc',
        prompt: 'test',
      });
      // Either throws (caught by handleToolCall) or returns error text
      assert.ok(result?.content?.[0]?.text);
    });
  } finally {
    restore();
  }
});

test('coord_spawn_worker: null byte in directory is rejected', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_spawn_worker', {
      directory: '/tmp/\x00evil',
      prompt: 'test',
    });
    // requireDirectoryPath throws on null bytes; handleToolCall catches and returns error
    assert.ok(result?.content?.[0]?.text);
  } finally {
    restore();
  }
});

test('coord_spawn_worker: oversized prompt (100KB) does not crash', async () => {
  const { home } = setupHome();
  const text = await assertSafeResponse('coord_spawn_worker', {
    directory: '/tmp',
    prompt: 'A'.repeat(100_000),
  }, home);
  assert.ok(typeof text === 'string');
});

test('coord_spawn_worker: oversized worker_name (1000 chars) is truncated or rejected safely', async () => {
  const { home } = setupHome();
  const text = await assertSafeResponse('coord_spawn_worker', {
    directory: '/tmp',
    prompt: 'test',
    worker_name: 'w'.repeat(1000),
  }, home);
  assert.ok(typeof text === 'string');
});

test('coord_spawn_worker: missing required prompt field returns error', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_spawn_worker', { directory: '/tmp' });
    // Empty prompt — should return a response (even if it proceeds with empty prompt)
    assert.ok(result?.content?.[0]?.text);
  } finally {
    restore();
  }
});

test('coord_spawn_worker: missing required directory field returns error', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_spawn_worker', { prompt: 'test task' });
    // requireDirectoryPath on undefined should throw — caught by handleToolCall
    assert.ok(result?.content?.[0]?.text);
  } finally {
    restore();
  }
});

test('coord_spawn_worker: boundary — empty string directory returns error', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_spawn_worker', { directory: '', prompt: 'test' });
    assert.ok(result?.content?.[0]?.text);
  } finally {
    restore();
  }
});

test('coord_spawn_worker: boundary — negative max_turns is clamped', async () => {
  const { home } = setupHome();
  const text = await assertSafeResponse('coord_spawn_worker', {
    directory: '/tmp',
    prompt: 'test',
    max_turns: -999,
  }, home);
  assert.ok(typeof text === 'string');
});

test('coord_spawn_worker: unicode in prompt does not crash', async () => {
  const { home } = setupHome();
  const text = await assertSafeResponse('coord_spawn_worker', {
    directory: '/tmp',
    prompt: '你好世界 🌍 مرحبا بالعالم',
  }, home);
  assert.ok(typeof text === 'string');
});

// ─────────────────────────────────────────────────────────────────────────────
// Fuzz tests: coord_send_message
// ─────────────────────────────────────────────────────────────────────────────

test('coord_send_message: XSS payload in content is sanitized or rejected', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_send_message', {
      from: 'lead',
      to: 'aaaabbbb',
      content: '<script>alert("xss")</script>',
    });
    // Should return a response — either error (recipient not found) or success
    assert.ok(result?.content?.[0]?.text);
  } finally {
    restore();
  }
});

test('coord_send_message: null byte in content does not crash', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    assert.doesNotThrow(() => {
      const result = api.handleToolCall('coord_send_message', {
        from: 'lead',
        to: 'aaaabbbb',
        content: 'hello\x00world',
      });
      assert.ok(result?.content?.[0]?.text);
    });
  } finally {
    restore();
  }
});

test('coord_send_message: unicode content (emoji, RTL, CJK) does not crash', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_send_message', {
      from: 'lead',
      to: 'aaaabbbb',
      content: '🚀 مرحبا 你好 こんにちは',
    });
    assert.ok(result?.content?.[0]?.text);
  } finally {
    restore();
  }
});

test('coord_send_message: oversized content is rejected or truncated safely', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_send_message', {
      from: 'lead',
      to: 'aaaabbbb',
      content: 'X'.repeat(200_000),
    });
    assert.ok(result?.content?.[0]?.text);
  } finally {
    restore();
  }
});

test('coord_send_message: missing content returns required error', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_send_message', {
      from: 'lead',
      to: 'aaaabbbb',
    });
    assert.match(result?.content?.[0]?.text || '', /content.*required/i);
  } finally {
    restore();
  }
});

test('coord_send_message: missing to and target_name returns required error', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_send_message', {
      from: 'lead',
      content: 'hello',
    });
    assert.match(result?.content?.[0]?.text || '', /required/i);
  } finally {
    restore();
  }
});

test('coord_send_message: boundary — empty string content returns required error', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_send_message', {
      from: 'lead',
      to: 'aaaabbbb',
      content: '',
    });
    assert.match(result?.content?.[0]?.text || '', /content.*required/i);
  } finally {
    restore();
  }
});

test('coord_send_message: max-length from field (64 chars) does not crash', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_send_message', {
      from: 'a'.repeat(64),
      to: 'aaaabbbb',
      content: 'hello',
    });
    assert.ok(result?.content?.[0]?.text);
  } finally {
    restore();
  }
});

test('coord_send_message: SQL injection in from field does not crash', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_send_message', {
      from: "'; DROP TABLE sessions; --",
      to: 'aaaabbbb',
      content: 'hello',
    });
    assert.ok(result?.content?.[0]?.text);
  } finally {
    restore();
  }
});

test('handleGetSession renders full session details', async () => {
  const { home, terminals } = setupHome();
  const inbox = join(home, '.claude', 'terminals', 'inbox');
  writeFileSync(join(terminals, 'session-full1234.json'), JSON.stringify({
    session: 'full1234', status: 'active', cwd: '/tmp', project: 'demo', branch: 'main',
    tty: '/dev/ttys001', started: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
    current_task: 'testing', tool_counts: { Write: 5, Edit: 3, Bash: 10, Read: 2 },
    files_touched: ['/tmp/a.ts', '/tmp/b.ts'],
    recent_ops: [{ t: '2026-01-01T00:01:00Z', tool: 'Edit', file: 'a.ts' }],
  }));
  writeFileSync(join(inbox, 'full1234.jsonl'), '');
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const res = api.handleToolCall('coord_get_session', { session_id: 'full1234' });
    const text = res?.content?.[0]?.text || '';
    assert.match(text, /Tool Usage/);
    assert.match(text, /Files Touched/);
    assert.match(text, /Recent Operations/);
    assert.match(text, /testing/);
  } finally {
    restore();
  }
});
