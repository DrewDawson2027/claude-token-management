import test from 'node:test';
import assert from 'node:assert/strict';
import { __test__ } from '../index.js';
import { resolve, join } from 'node:path';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('sanitizeId accepts safe IDs', () => {
  assert.equal(__test__.sanitizeId('W123_abc-DEF', 'task_id'), 'W123_abc-DEF');
});

test('sanitizeId rejects unsafe IDs', () => {
  assert.throws(() => __test__.sanitizeId('bad;rm -rf', 'task_id'));
});

test('sanitizeShortSessionId enforces minimum length and truncates to 8', () => {
  assert.equal(__test__.sanitizeShortSessionId('abcd1234zzzz'), 'abcd1234');
  assert.throws(() => __test__.sanitizeShortSessionId('abc123'));
});

test('sanitizeModel defaults to sonnet', () => {
  assert.equal(__test__.sanitizeModel(undefined), 'sonnet');
});

test('sanitizeModel rejects shell metacharacters', () => {
  assert.throws(() => __test__.sanitizeModel('sonnet;echo hacked'));
});

test('sanitizeModel normalizes supported full model aliases', () => {
  assert.equal(__test__.sanitizeModel('claude-sonnet-4-5'), 'sonnet');
  assert.equal(__test__.sanitizeModel('claude-sonnet-4-6'), 'sonnet');
  assert.equal(__test__.sanitizeModel('claude-haiku-4-5'), 'haiku');
  assert.equal(__test__.sanitizeModel('claude-haiku-4-6'), 'haiku');
});

test('sanitizeModel rejects unsupported models', () => {
  assert.throws(() => __test__.sanitizeModel('opus'));
  assert.throws(() => __test__.sanitizeModel('claude-opus-4-5'));
  assert.throws(() => __test__.sanitizeModel('claude-opus-4-6'));
});

test('bundled model-router accepts modern sonnet aliases from settings defaults', () => {
  const home = mkdtempSync(join(tmpdir(), 'model-router-'));
  const claudeDir = join(home, '.claude');
  const settingsPath = join(claudeDir, 'settings.local.json');
  const scriptPath = join(process.cwd(), 'hooks', 'model-router.py');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ model: 'claude-sonnet-4-6' }, null, 2));
  const payload = JSON.stringify({
    tool_name: 'Task',
    tool_input: { subagent_type: 'implementer', prompt: 'do work' },
  });
  const result = spawnSync('python3', [scriptPath], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    input: payload,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('bundled model-router blocks unsupported explicit models', () => {
  const scriptPath = join(process.cwd(), 'hooks', 'model-router.py');
  const payload = JSON.stringify({
    tool_name: 'Task',
    tool_input: { subagent_type: 'implementer', prompt: 'do work', model: 'opus' },
  });
  const result = spawnSync('python3', [scriptPath], {
    cwd: process.cwd(),
    input: payload,
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Only sonnet and haiku workers are allowed/);
});

test('sanitizeName accepts safe pipeline step names', () => {
  assert.equal(__test__.sanitizeName('step_1.build-v2', 'task name'), 'step_1.build-v2');
});

test('sanitizeName normalizes common unsafe characters', () => {
  assert.equal(__test__.sanitizeName('step one', 'task name'), 'step-one');
  assert.equal(__test__.sanitizeName('../escape', 'task name'), 'escape');
});

test('requireDirectoryPath rejects empty and newline values', () => {
  assert.throws(() => __test__.requireDirectoryPath(''));
  assert.throws(() => __test__.requireDirectoryPath('/tmp\nfoo'));
  assert.throws(() => __test__.requireDirectoryPath('/tmp/"quoted"'));
});

test('normalizeFilePath resolves relative paths consistently', () => {
  const base = '/tmp/demo-project';
  const normalized = __test__.normalizeFilePath('./src/../src/index.ts', base);
  let expected = resolve(base, 'src/index.ts').replace(/\\/g, '/');
  if (__test__.PLATFORM === 'win32') expected = expected.toLowerCase();
  assert.equal(normalized, expected);
});

test('process helpers reject invalid PID input safely', () => {
  assert.equal(__test__.isProcessAlive('bad-pid'), false);
  assert.throws(() => __test__.killProcess('bad-pid'));
});

test('wake text always returns empty (safe mode only, no injection)', () => {
  assert.equal(__test__.selectWakeText('run rm -rf /'), '');
  assert.equal(__test__.selectWakeText('status check'), '');
});

test('batQuote escapes cmd.exe metacharacters', () => {
  assert.equal(__test__.batQuote('simple'), '"simple"');
  assert.equal(__test__.batQuote('foo&bar'), '"foo^&bar"');
  assert.equal(__test__.batQuote('a|b>c<d'), '"a^|b^>c^<d"');
  assert.equal(__test__.batQuote('100%'), '"100%%"');
  assert.equal(__test__.batQuote('a^b'), '"a^^b"');
  assert.equal(__test__.batQuote(null), '""');
});

test('batQuote fuzz: no unquoted metacharacters in random input', () => {
  const dangerous = /(?<!\^)[&|><]|(?<!%)%(?!%)|(?<!\^)\^(?![&|><^!])/;
  for (let i = 0; i < 200; i++) {
    const len = Math.floor(Math.random() * 50) + 1;
    const input = Array.from({ length: len }, () =>
      String.fromCharCode(Math.floor(Math.random() * 128))
    ).join('');
    const result = __test__.batQuote(input);
    // Must be wrapped in double quotes
    assert.match(result, /^".*"$/s, `batQuote output must be quoted for input ${i}`);
    const inner = result.slice(1, -1);
    // No bare & | > < — each should be preceded by ^
    for (const ch of ['&', '|', '>', '<']) {
      const idx = inner.indexOf(ch);
      if (idx >= 0) {
        assert.equal(inner[idx - 1], '^', `bare '${ch}' found at pos ${idx} in output for input ${i}`);
      }
    }
    // No bare % — each should be doubled
    const singles = inner.match(/(?<!%)%(?!%)/g);
    assert.equal(singles, null, `bare '%' found in output for input ${i}`);
  }
});

test('readJSONLLimited handles truncation and invalid lines', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'jsonl-'));
  const file = join(tmp, 'test.jsonl');
  writeFileSync(file, '{"a":1}\n{"b":2}\nnot-json\n{"c":3}\n');
  const result = __test__.readJSONLLimited(file, 2, 1024 * 1024);
  assert.equal(result.items.length, 2); // limited to 2 lines
  assert.equal(result.truncated, true); // had more lines than limit
  assert.equal(result.items[0].a, 1);
});

test('readJSONLLimited returns empty for missing file', () => {
  const result = __test__.readJSONLLimited('/nonexistent/file.jsonl');
  assert.deepEqual(result.items, []);
  assert.equal(result.truncated, false);
});

test('isSafeTTYPath validates tty paths', () => {
  assert.equal(__test__.isSafeTTYPath('/dev/ttys001'), true);
  assert.equal(__test__.isSafeTTYPath('/dev/pts/0'), true);
  assert.equal(__test__.isSafeTTYPath('/dev/tty42'), true);
  assert.equal(__test__.isSafeTTYPath('/tmp/evil'), false);
  assert.equal(__test__.isSafeTTYPath('/dev/../etc/passwd'), false);
  assert.equal(__test__.isSafeTTYPath(''), false);
});

test('legacy cost JSON output is decorated with deprecation metadata', () => {
  const raw = JSON.stringify({ window: 'today', totalUSD: 12.34 });
  const out = __test__.applyLegacyDeprecationToOutput('coord_cost_summary', raw);
  const parsed = JSON.parse(out);
  assert.equal(parsed.deprecated, true);
  assert.equal(parsed.canonical_tool, 'coord_cost_overview');
  assert.match(parsed.canonical_command, /cost overview/);
});

test('legacy envelope-mode output preserves deprecation metadata inside data.text', () => {
  const script = `
    process.env.CLAUDE_COORDINATOR_RESULT_ENVELOPE = "1";
    const mod = await import('./index.js');
    const r = mod.__test__.withEnvelope(
      'coord_cost_trends',
      Date.now(),
      'req-test',
      () => JSON.stringify({ period: 'week', series: [] })
    );
    console.log(JSON.stringify(r));
  `;
  const cp = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: resolve(process.cwd()),
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(cp.status, 0, cp.stderr || cp.stdout);
  const outer = JSON.parse(cp.stdout.trim());
  const envelope = JSON.parse(outer.content[0].text);
  const inner = JSON.parse(envelope.data.text);
  assert.equal(inner.deprecated, true);
  assert.equal(inner.canonical_tool, 'coord_ops_trends');
  assert.match(inner.canonical_command, /ops trends/);
});
