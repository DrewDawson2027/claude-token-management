import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test__ } from '../index.js';

test('readJSONLLimited tolerates malformed and hostile lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-fuzz-'));
  const inbox = join(dir, 'inbox.jsonl');
  const payload = [
    '{"ts":"2026-02-20T00:00:00Z","from":"lead","content":"ok-1"}',
    '{"ts":"2026-02-20T00:00:01Z","from":"lead","content":"ok-2"}',
    '{"ts":"oops",',
    '{"bad_json":',
    'not-json-at-all',
    '{"ts":"2026-02-20T00:00:02Z","from":"evil","content":"x'.padEnd(1600, 'x') + '"}',
    '{"ts":"2026-02-20T00:00:03Z","from":"lead","content":"ok-3"}',
  ].join('\n');
  writeFileSync(inbox, `${payload}\n`, 'utf-8');

  const parsed = __test__.readJSONLLimited(inbox, 4, 1024);
  assert.equal(Array.isArray(parsed.items), true);
  assert.equal(parsed.items.length <= 4, true);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.items.some((m) => m?.content === 'ok-1'), true);
});

test('readJSONLLimited handles random garbage corpus without throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-fuzz-'));
  const inbox = join(dir, 'garbage.jsonl');
  const lines = [];
  let expectedValid = 0;
  let seed = 1337;
  const nextRand = () => {
    seed = (seed * 1103515245 + 12345) % 0x80000000;
    return seed / 0x80000000;
  };
  for (let i = 0; i < 200; i += 1) {
    const r = nextRand();
    if (r < 0.33) {
      lines.push(`{"ts":"2026-02-20T00:00:${String(i % 60).padStart(2, '0')}Z","from":"f","content":"m-${i}"}`);
      expectedValid += 1;
    }
    else if (r < 0.66) lines.push(`{${'x'.repeat(i % 40)}`);
    else lines.push('\u0000\u0007BAD\u001b[31mLINE');
  }
  writeFileSync(inbox, `${lines.join('\n')}\n`, 'utf-8');

  const parsed = __test__.readJSONLLimited(inbox, 500, 64 * 1024);
  assert.equal(Array.isArray(parsed.items), true);
  assert.equal(parsed.items.length, expectedValid);
});

test('isSafeTTYPath only allows expected device paths', () => {
  assert.equal(__test__.isSafeTTYPath('/dev/ttys003'), true);
  assert.equal(__test__.isSafeTTYPath('/dev/pts/7'), true);
  assert.equal(__test__.isSafeTTYPath('/tmp/not-a-tty'), false);
  assert.equal(__test__.isSafeTTYPath('../../etc/passwd'), false);
});
