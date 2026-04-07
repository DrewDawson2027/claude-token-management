import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COORD_INDEX_URL = pathToFileURL(join(__dirname, '..', 'index.js')).href;

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), 'coord-e2e-p2p-dm-'));
  const terminals = join(home, '.claude', 'terminals');
  const inbox = join(terminals, 'inbox');
  const results = join(terminals, 'results');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(results, { recursive: true });
  mkdirSync(join(home, '.claude', 'session-cache'), { recursive: true });
  return { home, inbox, results };
}

function writeWorkerMeta(results, { taskId, workerName, sessionId, leadSessionId }) {
  writeFileSync(
    join(results, `${taskId}.meta.json`),
    JSON.stringify({
      task_id: taskId,
      worker_name: workerName,
      session_id: sessionId,
      claude_session_id: sessionId,
      notify_session_id: leadSessionId,
      status: 'running',
      mode: 'interactive',
      team_name: 'e2e-p2p',
    }),
  );
}

function buildProtocolSenderScript(coordUrl) {
  return `process.env.HOME = process.env.TEST_HOME;
process.env.COORDINATOR_TEST_MODE = '1';
process.env.COORDINATOR_PLATFORM = 'linux';

const mod = await import(${JSON.stringify(coordUrl)});
const api = mod.__test__;
api.ensureDirsOnce();

const result = api.handleToolCall('coord_send_protocol', {
  type: 'shutdown_request',
  from: process.env.SENDER_NAME,
  recipient: process.env.RECIPIENT_NAME,
  request_id: process.env.REQUEST_ID,
});

process.stdout.write(JSON.stringify(result) + '\\n');
`;
}

function runProtocolSender(home, { sender, recipient, requestId }) {
  const scriptPath = join(home, `protocol-subprocess-${Date.now()}.mjs`);
  writeFileSync(scriptPath, buildProtocolSenderScript(COORD_INDEX_URL));

  const out = spawnSync(process.execPath, [scriptPath], {
    env: {
      ...process.env,
      TEST_HOME: home,
      COORDINATOR_TEST_MODE: '1',
      COORDINATOR_PLATFORM: 'linux',
      SENDER_NAME: sender,
      RECIPIENT_NAME: recipient,
      REQUEST_ID: requestId,
    },
    encoding: 'utf8',
    timeout: 15000,
  });

  return {
    status: out.status,
    stdout: out.stdout,
    stderr: out.stderr,
    result: out.stdout.trim() ? JSON.parse(out.stdout.trim()) : null,
  };
}

function readInbox(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('cross-process protocol DM: worker-a delivers directly to worker-b inbox without lead write', () => {
  const { home, inbox, results } = setupHome();

  writeWorkerMeta(results, {
    taskId: 'task-a',
    workerName: 'worker-a',
    sessionId: 'aaaa1111',
    leadSessionId: 'lead0001',
  });
  writeWorkerMeta(results, {
    taskId: 'task-b',
    workerName: 'worker-b',
    sessionId: 'bbbb2222',
    leadSessionId: 'lead0001',
  });

  const { status, stderr, result } = runProtocolSender(home, {
    sender: 'worker-a',
    recipient: 'worker-b',
    requestId: 'req12345',
  });

  assert.equal(status, 0, `subprocess exited with code ${status}\nSTDERR: ${stderr}`);

  const responseText = result?.content?.[0]?.text ?? '';
  assert.match(responseText, /Protocol message sent/i);
  assert.match(responseText, /bbbb2222/);

  const workerInboxPath = join(inbox, 'bbbb2222.jsonl');
  assert.equal(existsSync(workerInboxPath), true, 'worker-b inbox must be created');

  const workerInbox = readInbox(workerInboxPath);
  assert.equal(workerInbox.length, 1, 'worker-b inbox must contain one protocol message');
  assert.equal(workerInbox[0].from, 'worker-a');
  assert.equal(workerInbox[0].priority, 'urgent');
  assert.equal(workerInbox[0].protocol_type, 'shutdown_request');
  assert.equal(workerInbox[0].request_id, 'req12345');
  assert.match(workerInbox[0].content, /\[SHUTDOWN_REQUEST\]/);
  assert.match(workerInbox[0].content, /from=worker-a/);

  assert.equal(
    existsSync(join(inbox, 'lead0001.jsonl')),
    false,
    'lead inbox must not be written for worker-to-worker protocol DMs',
  );
  assert.equal(
    existsSync(join(inbox, 'worker-b.jsonl')),
    false,
    'worker name must resolve to the peer session inbox, not a name-based inbox file',
  );
});
