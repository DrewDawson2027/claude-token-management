/**
 * Integration tests for the native action bridge (queueNativeAction).
 * Verifies: message queuing, TTL cleanup, max queue depth enforcement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function loadForTest(home) {
  const prev = {
    HOME: process.env.HOME,
    COORDINATOR_TEST_MODE: process.env.COORDINATOR_TEST_MODE,
    COORDINATOR_PLATFORM: process.env.COORDINATOR_PLATFORM,
  };
  process.env.HOME = home;
  process.env.COORDINATOR_TEST_MODE = '1';
  process.env.COORDINATOR_PLATFORM = 'linux';
  const mod = await import(`../index.js?native-bridge=${Date.now()}-${Math.random()}`);
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
  const home = mkdtempSync(join(tmpdir(), 'coord-native-bridge-'));
  const terminals = join(home, '.claude', 'terminals');
  mkdirSync(join(terminals, 'inbox'), { recursive: true });
  mkdirSync(join(terminals, 'results'), { recursive: true });
  mkdirSync(join(terminals, 'teams'), { recursive: true });
  mkdirSync(join(home, '.claude', 'session-cache'), { recursive: true });
  return { home, terminals };
}

/** Team config lives at ${TERMINALS_DIR}/teams/${teamName}.json */
function createTeam(terminals, teamName, executionPath) {
  writeFileSync(
    join(terminals, 'teams', `${teamName}.json`),
    JSON.stringify({ team_name: teamName, execution_path: executionPath, members: [] }),
  );
}

const pendingDir = (home) =>
  join(home, '.claude', 'lead-sidecar', 'runtime', 'actions', 'pending');

// ─── Tests ───────────────────────────────────────────────────────────────────

test('native bridge: queues action file when team is hybrid', async () => {
  const { home, terminals } = setupHome();
  createTeam(terminals, 'test-team', 'hybrid');
  writeFileSync(join(terminals, 'inbox', 'abcd1234.jsonl'), '');

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    writeFileSync(join(terminals, 'session-abcd1234.json'), JSON.stringify({ session: 'abcd1234', status: 'active', last_active: new Date().toISOString() }));
    const result = api.handleToolCall('coord_send_message', {
      from: 'lead',
      to: 'abcd1234',
      content: 'hello from native bridge test',
      team_name: 'test-team',
    });
    const text = result?.content?.[0]?.text || '';
    assert.match(text, /Message sent/);
    assert.match(text, /Native push: queued/i);

    const pending = pendingDir(home);
    const files = readdirSync(pending).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1, 'expected exactly one action file queued');

    const action = JSON.parse(readFileSync(join(pending, files[0]), 'utf8'));
    assert.equal(action.action, 'native_send_message');
    assert.equal(action.content, 'hello from native bridge test');
    assert.equal(action.delivery, 'native_push');
  } finally {
    restore();
  }
});

test('native bridge: queues action when team execution_path is native', async () => {
  const { home, terminals } = setupHome();
  createTeam(terminals, 'native-team', 'native');
  writeFileSync(join(terminals, 'inbox', 'abcd1234.jsonl'), '');

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    writeFileSync(join(terminals, 'session-abcd1234.json'), JSON.stringify({ session: 'abcd1234', status: 'active', last_active: new Date().toISOString() }));
    api.handleToolCall('coord_send_message', {
      from: 'lead',
      to: 'abcd1234',
      content: 'native-only message',
      team_name: 'native-team',
    });

    const files = readdirSync(pendingDir(home)).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1, 'native team should queue action');
  } finally {
    restore();
  }
});

test('native bridge: does not queue action when team is coordinator-only', async () => {
  const { home, terminals } = setupHome();
  createTeam(terminals, 'coord-team', 'coordinator');
  writeFileSync(join(terminals, 'inbox', 'abcd1234.jsonl'), '');

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    api.handleToolCall('coord_send_message', {
      from: 'lead',
      to: 'abcd1234',
      content: 'coordinator message',
      team_name: 'coord-team',
    });

    const pending = pendingDir(home);
    let files = [];
    try { files = readdirSync(pending).filter((f) => f.endsWith('.json')); } catch {}
    assert.equal(files.length, 0, 'coordinator team should not queue native actions');
  } finally {
    restore();
  }
});

test('native bridge: TTL cleanup removes stale action files', async () => {
  const { home, terminals } = setupHome();
  createTeam(terminals, 'test-team', 'hybrid');
  writeFileSync(join(terminals, 'inbox', 'abcd1234.jsonl'), '');

  // Pre-populate pending/ with a stale file (mtime = 10 minutes ago)
  const pending = pendingDir(home);
  mkdirSync(pending, { recursive: true });
  const staleFile = join(pending, 'msg-stale.json');
  writeFileSync(staleFile, JSON.stringify({ action: 'stale' }));
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(staleFile, tenMinAgo, tenMinAgo);

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    writeFileSync(join(terminals, 'session-abcd1234.json'), JSON.stringify({ session: 'abcd1234', status: 'active', last_active: new Date().toISOString() }));
    api.handleToolCall('coord_send_message', {
      from: 'lead',
      to: 'abcd1234',
      content: 'fresh message',
      team_name: 'test-team',
    });

    const files = readdirSync(pending).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1, 'stale file cleaned up — only new file remains');
    assert.ok(!files.includes('msg-stale.json'), 'stale file should be deleted');
  } finally {
    restore();
  }
});

test('native bridge: drops action when queue depth reaches 50', async () => {
  const { home, terminals } = setupHome();
  createTeam(terminals, 'test-team', 'hybrid');
  writeFileSync(join(terminals, 'inbox', 'abcd1234.jsonl'), '');

  // Pre-populate pending/ with 50 fresh files
  const pending = pendingDir(home);
  mkdirSync(pending, { recursive: true });
  for (let i = 0; i < 50; i++) {
    writeFileSync(join(pending, `msg-${i}.json`), JSON.stringify({ action: 'test' }));
  }

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    api.handleToolCall('coord_send_message', {
      from: 'lead',
      to: 'abcd1234',
      content: 'overflow message',
      team_name: 'test-team',
    });

    const files = readdirSync(pending).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 50, 'queue should stay at 50 — overflow action dropped');
  } finally {
    restore();
  }
});

// ─── Queue Drain Tests ────────────────────────────────────────────────────────

test('coord_drain_native_queue: delivers pending action via coordinator inbox', async () => {
  const { home, terminals } = setupHome();
  writeFileSync(join(terminals, 'inbox', 'abcd1234.jsonl'), '');

  // Pre-populate pending/ with a native_send_message action
  const pending = pendingDir(home);
  mkdirSync(pending, { recursive: true });
  writeFileSync(join(pending, 'msg-test.json'), JSON.stringify({
    action: 'native_send_message',
    recipient: 'abcd1234',
    content: 'hello via drain',
    priority: 'normal',
  }));

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    writeFileSync(join(terminals, 'session-abcd1234.json'), JSON.stringify({ session: 'abcd1234', status: 'active', last_active: new Date().toISOString() }));
    const result = api.handleToolCall('coord_drain_native_queue', {});
    const text = result?.content?.[0]?.text || '';
    assert.match(text, /1 processed/);

    // Inbox should now contain the delivered message
    const inbox = readFileSync(join(terminals, 'inbox', 'abcd1234.jsonl'), 'utf8');
    assert.ok(inbox.includes('hello via drain'), 'message should be in inbox after drain');

    // Action file should be moved to done/
    const doneDir = join(pending, '..', 'done');
    const doneFiles = readdirSync(doneDir);
    assert.equal(doneFiles.length, 1, 'processed file should be in done/ dir');
    assert.ok(doneFiles[0].endsWith('.json'));
  } finally {
    restore();
  }
});

test('coord_drain_native_queue: skips unknown action types', async () => {
  const { home } = setupHome();
  const pending = pendingDir(home);
  mkdirSync(pending, { recursive: true });
  writeFileSync(join(pending, 'msg-unknown.json'), JSON.stringify({
    action: 'unknown_future_action',
    recipient: 'abcd1234',
    content: 'test',
  }));

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_drain_native_queue', {});
    const text = result?.content?.[0]?.text || '';
    assert.match(text, /0 processed.*1 skipped/);
  } finally {
    restore();
  }
});

test('coord_drain_native_queue: empty queue returns clean message', async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const result = api.handleToolCall('coord_drain_native_queue', {});
    const text = result?.content?.[0]?.text || '';
    assert.ok(text.includes('empty'), 'should say queue is empty');
  } finally {
    restore();
  }
});

// ─── Resume Agent Tests ───────────────────────────────────────────────────────


