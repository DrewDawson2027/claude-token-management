import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { __test__ } from '../index.js';

function setupCoordinatorHome() {
  const home = mkdtempSync(join(tmpdir(), 'coord-cover-'));
  const claude = join(home, '.claude');
  const terminals = join(claude, 'terminals');
  mkdirSync(join(terminals, 'inbox'), { recursive: true });
  mkdirSync(join(terminals, 'results'), { recursive: true });
  mkdirSync(join(terminals, 'context'), { recursive: true });
  return { home, claude, terminals };
}

function withHome(fn) {
  const prevHome = process.env.HOME;
  const prevPlatform = process.env.COORDINATOR_PLATFORM;
  const env = setupCoordinatorHome();
  process.env.HOME = env.home;
  process.env.COORDINATOR_PLATFORM = 'linux';
  try {
    return fn(env);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevPlatform === undefined) delete process.env.COORDINATOR_PLATFORM; else process.env.COORDINATOR_PLATFORM = prevPlatform;
    rmSync(env.home, { recursive: true, force: true });
  }
}

function textOf(result) {
  return result?.content?.[0]?.text || '';
}

function writeSession(terminals, sid, data = {}) {
  const now = new Date().toISOString();
  const session = {
    session: sid,
    status: 'active',
    last_active: now,
    project: 'proj',
    current_task: null,
    ...data,
  };
  writeFileSync(join(terminals, `session-${sid}.json`), JSON.stringify(session, null, 2));
  return session;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('approval handlers write approval files and notify worker inbox', () => withHome(({ terminals }) => {
  const sid = 'work1234';
  const taskId = 'TASK_APPROVE_1';
  writeSession(terminals, sid, { current_task: taskId });
  writeFileSync(join(terminals, 'results', `${taskId}.meta.json`), JSON.stringify({ task_id: taskId }, null, 2));

  const approved = __test__.handleApprovePlan({ task_id: taskId, message: 'Ship it' });
  assert.match(textOf(approved), /Plan approved/);
  const approvalFile = join(terminals, 'results', `${taskId}.approval`);
  const approval = readJson(approvalFile);
  assert.equal(approval.status, 'approved');
  assert.equal(approval.message, 'Ship it');
  const inbox = readJsonl(join(terminals, 'inbox', `${sid}.jsonl`));
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].content, /\[APPROVED]/);

  const rejectedMissingFeedback = __test__.handleRejectPlan({ task_id: taskId });
  assert.match(textOf(rejectedMissingFeedback), /Feedback is required/);

  const rejected = __test__.handleRejectPlan({ task_id: taskId, feedback: 'Needs clearer rollback plan' });
  assert.match(textOf(rejected), /Plan revision requested/);
  const revised = readJson(approvalFile);
  assert.equal(revised.status, 'revision_requested');
  assert.match(revised.feedback, /rollback/);
  const inbox2 = readJsonl(join(terminals, 'inbox', `${sid}.jsonl`));
  assert.equal(inbox2.length, 2);
  assert.match(inbox2[1].content, /\[REVISION]/);
}));

test('approval handlers return not found for missing meta', () => withHome(() => {
  const out = __test__.handleApprovePlan({ task_id: 'MISSING_TASK_1' });
  assert.match(textOf(out), /not found/i);
}));

test('context store handlers cover create, update, append, read, export and limits', () => withHome(({ terminals }) => {
  const created = __test__.handleWriteContext({ team_name: 'alpha', key: 'goal', value: 'Finish API v1' });
  assert.match(textOf(created), /Context stored/);

  const updated = __test__.handleWriteContext({ team_name: 'alpha', key: 'goal', value: 'Finish API v1 + docs' });
  assert.match(textOf(updated), /Updated entry/);

  const appended = __test__.handleWriteContext({ team_name: 'alpha', key: 'goal', value: 'Add tests', append: true });
  assert.match(textOf(appended), /Appended to entry/);

  const readTeam = __test__.handleReadContext({ team_name: 'alpha' });
  assert.match(textOf(readTeam), /Shared Context: alpha/);
  assert.match(textOf(readTeam), /goal/);
  assert.match(textOf(readTeam), /Add tests/);

  const exportedLead = __test__.handleExportContext({ session_id: 'lead1234', summary: 'User wants v1 parity and docs sync.' });
  assert.match(textOf(exportedLead), /Lead context exported/);

  const readWithLead = __test__.handleReadContext({ team_name: 'alpha', include_lead: true, key: 'goal' });
  assert.match(textOf(readWithLead), /Lead's Conversation Context/);

  const noKey = __test__.handleWriteContext({ team_name: 'alpha', value: 'x' });
  assert.match(textOf(noKey), /Key is required/);
  const noValue = __test__.handleWriteContext({ team_name: 'alpha', key: 'empty', value: '' });
  assert.match(textOf(noValue), /Value is required/);
  const noSummary = __test__.handleExportContext({ session_id: 'lead1234', summary: '' });
  assert.match(textOf(noSummary), /Summary is required/);
  const noSession = __test__.handleExportContext({ summary: 'hello' });
  assert.match(textOf(noSession), /session_id is required/);

  const tooLarge = __test__.handleWriteContext({
    team_name: 'alpha',
    key: 'huge',
    value: 'x'.repeat(120_000),
  });
  assert.match(textOf(tooLarge), /100KB limit/);

  const emptyTeam = __test__.handleReadContext({ team_name: 'beta', include_lead: false });
  assert.match(textOf(emptyTeam), /No context found/);

  assert.ok(existsSync(join(terminals, 'context', 'alpha.json')));
  assert.ok(existsSync(join(terminals, 'context', 'lead-context-lead1234.json')));
}));

test('messaging handlers cover direct send, name resolution, broadcast, inbox read, and directive wake paths', () => withHome(({ terminals }) => {
  writeSession(terminals, 'sess1234', { worker_name: 'worker-a', has_messages: false, last_active: new Date().toISOString() });
  writeSession(terminals, 'sess5678', { worker_name: 'worker-b', status: 'closed', last_active: new Date().toISOString() });
  writeSession(terminals, 'stale999', { worker_name: 'worker-c', status: 'stale', last_active: new Date(Date.now() - 20 * 60_000).toISOString() });

  const missingContent = __test__.handleSendMessage({ to: 'sess1234', content: '' });
  assert.match(textOf(missingContent), /Message content is required/);
  const missingTarget = __test__.handleSendMessage({ content: 'hi' });
  assert.match(textOf(missingTarget), /Either 'to'/);

  const direct = __test__.handleSendMessage({ to: 'sess1234', from: 'lead', content: 'hello', priority: 'urgent' });
  assert.match(textOf(direct), /Message sent to sess1234/);
  const sess = readJson(join(terminals, 'session-sess1234.json'));
  assert.equal(sess.has_messages, true);

  const byName = __test__.handleSendMessage({ target_name: 'worker-a', content: 'named route' });
  assert.match(textOf(byName), /Message sent to sess1234/);

  const unknownName = __test__.handleSendMessage({ target_name: 'missing-worker', content: 'x' });
  assert.match(textOf(unknownName), /not found/);

  const broadcast = __test__.handleBroadcast({ content: 'all hands', from: 'lead' });
  assert.match(textOf(broadcast), /Broadcast sent to 2 session\(s\)/);

  const checkInbox = __test__.handleCheckInbox({ session_id: 'sess1234' });
  assert.match(textOf(checkInbox), /Message\(s\)/);
  assert.match(textOf(checkInbox), /hello/);

  const noInbox = __test__.handleCheckInbox({ session_id: 'sess1234' });
  assert.match(textOf(noInbox), /No pending messages/);

  const directiveActive = __test__.handleSendDirective({ to: 'sess1234', content: 'do the thing', from: 'lead' });
  assert.match(textOf(directiveActive), /Directive sent/);
  assert.match(textOf(directiveActive), /Session is active/);

  const directiveByName = __test__.handleSendDirective({ target_name: 'worker-a', content: 'named directive' });
  assert.match(textOf(directiveByName), /Directive sent to sess1234/);

  const directiveUnknownName = __test__.handleSendDirective({ target_name: 'missing-worker', content: 'x' });
  assert.match(textOf(directiveUnknownName), /not found/);

  const directiveNoTarget = __test__.handleSendDirective({ content: 'x' });
  assert.match(textOf(directiveNoTarget), /Either 'to'.*'target_name'/);

  const directiveMissing = __test__.handleSendDirective({ to: 'deadbeef', content: 'x' });
  assert.match(textOf(directiveMissing), /not found/i);

  const directiveStale = __test__.handleSendDirective({ to: 'stale999', content: 'wake up' });
  assert.match(textOf(directiveStale), /auto-wake triggered|auto-wake failed/i);
}));

test('shutdown handlers cover request, approve, reject and lead notifications', () => withHome(({ terminals }) => {
  const leadSid = 'lead1111';
  const workerSid = 'work2222';
  const taskId = 'TASK_SHUT_1';
  writeSession(terminals, leadSid, { status: 'active' });
  writeSession(terminals, workerSid, { worker_name: 'worker-z', current_task: taskId, status: 'active' });
  writeFileSync(join(terminals, 'results', `${taskId}.meta.json`), JSON.stringify({ task_id: taskId, notify_session_id: leadSid }, null, 2));

  const reqMissing = __test__.handleShutdownRequest({});
  assert.match(textOf(reqMissing), /required/);

  const reqByName = __test__.handleShutdownRequest({ target_name: 'worker-z', message: 'Wrap up', force_timeout_seconds: 15 });
  const reqText = textOf(reqByName);
  assert.match(reqText, /Shutdown requested/);
  const requestId = (reqText.match(/Request ID: (shutdown-[^\n]+)/) || [])[1];
  assert.ok(requestId, 'request id parsed from response');
  const trackingPath = join(terminals, 'results', `${requestId}.shutdown`);
  const tracking = readJson(trackingPath);
  assert.equal(tracking.status, 'pending');
  assert.equal(tracking.target_session, workerSid);

  const approve = __test__.handleShutdownResponse({ request_id: requestId, approve: true });
  assert.match(textOf(approve), /Shutdown approved/);
  const trackingApproved = readJson(trackingPath);
  assert.equal(trackingApproved.status, 'approved');
  const leadInbox1 = readJsonl(join(terminals, 'inbox', `${leadSid}.jsonl`));
  assert.ok(leadInbox1.some((m) => /\[SHUTDOWN_APPROVED]/.test(m.content)));

  const requestId2 = `shutdown-${Date.now()}-manual`;
  writeFileSync(join(terminals, 'results', `${requestId2}.shutdown`), JSON.stringify({
    request_id: requestId2,
    task_id: taskId,
    target_session: workerSid,
    status: 'pending',
    requested_at: new Date().toISOString(),
  }, null, 2));
  const reject = __test__.handleShutdownResponse({ request_id: requestId2, approve: false, reason: 'Need more time' });
  assert.match(textOf(reject), /Shutdown rejected/);
  const trackingRejected = readJson(join(terminals, 'results', `${requestId2}.shutdown`));
  assert.equal(trackingRejected.status, 'rejected');
  const leadInbox2 = readJsonl(join(terminals, 'inbox', `${leadSid}.jsonl`));
  assert.ok(leadInbox2.some((m) => /\[SHUTDOWN_REJECTED]/.test(m.content)));

  const missingReq = __test__.handleShutdownResponse({ request_id: 'missing-id', approve: true });
  assert.match(textOf(missingReq), /not found/i);
}));
