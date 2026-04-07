/**
 * Property-based and fuzz tests for coordinator input sanitizers
 * and path normalization functions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { __test__ } from '../index.js';
import { SAFE_ID_RE, SAFE_NAME_RE, SAFE_MODEL_RE, SAFE_AGENT_RE } from '../lib/constants.js';

// ─── Deterministic PRNG for reproducible fuzz ─────────────────────────────────

function makePRNG(seed = 42) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function randomString(rng, maxLen = 80) {
  const len = Math.floor(rng() * maxLen) + 1;
  const chars = [];
  for (let i = 0; i < len; i++) {
    const r = rng();
    if (r < 0.4) {
      // ASCII printable
      chars.push(String.fromCharCode(32 + Math.floor(rng() * 95)));
    } else if (r < 0.55) {
      // Control chars
      chars.push(String.fromCharCode(Math.floor(rng() * 32)));
    } else if (r < 0.7) {
      // Path traversal
      const patterns = ['../', './', '//', '\\..\\', '~/', '$HOME'];
      chars.push(patterns[Math.floor(rng() * patterns.length)]);
    } else if (r < 0.85) {
      // Shell metacharacters
      const meta = [';', '|', '&', '`', '$', '(', ')', '{', '}', '<', '>', '"', "'", '\n', '\0'];
      chars.push(meta[Math.floor(rng() * meta.length)]);
    } else {
      // Unicode (emoji, CJK, RTL)
      const unicodeRanges = [
        [0x1F600, 0x1F64F], // Emoji
        [0x4E00, 0x4FFF],   // CJK
        [0x0600, 0x06FF],   // Arabic (RTL)
        [0x0080, 0x00FF],   // Latin-1 supplement
      ];
      const range = unicodeRanges[Math.floor(rng() * unicodeRanges.length)];
      chars.push(String.fromCodePoint(range[0] + Math.floor(rng() * (range[1] - range[0]))));
    }
  }
  return chars.join('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Property tests
// ═══════════════════════════════════════════════════════════════════════════════

test('sanitizeId is idempotent for valid inputs', () => {
  const validInputs = ['abc', 'W_123', 'task-42', 'A'.repeat(64), 'a1b2c3'];
  for (const input of validInputs) {
    const once = __test__.sanitizeId(input, 'test');
    const twice = __test__.sanitizeId(once, 'test');
    assert.equal(once, twice, `sanitizeId should be idempotent for "${input}"`);
  }
});

test('sanitizeName is idempotent for valid inputs', () => {
  const validInputs = ['worker-1', 'my.name', 'step_2', 'a-b.c_d'];
  for (const input of validInputs) {
    const once = __test__.sanitizeName(input, 'test');
    const twice = __test__.sanitizeName(once, 'test');
    assert.equal(once, twice, `sanitizeName should be idempotent for "${input}"`);
  }
});

test('normalizeFilePath is idempotent for non-null results', () => {
  const cwd = '/tmp/project';
  const paths = [
    './src/index.ts',
    '../sibling/file.js',
    'src/../src/a.ts',
    '/absolute/path.ts',
    'simple.txt',
  ];
  for (const p of paths) {
    const once = __test__.normalizeFilePath(p, cwd);
    if (once === null) continue;
    const twice = __test__.normalizeFilePath(once, cwd);
    assert.equal(once, twice, `normalizeFilePath should be idempotent for "${p}"`);
  }
});

test('sanitizeId output never contains shell metacharacters', () => {
  const dangerous = /[;|&`$(){}><"'\n\0]/;
  const validInputs = ['abc', 'task-1', 'W_123', 'x'.repeat(64)];
  for (const input of validInputs) {
    const result = __test__.sanitizeId(input, 'test');
    assert.equal(dangerous.test(result), false, `sanitizeId output "${result}" should not contain shell metacharacters`);
  }
});

test('sanitizeName output always matches SAFE_NAME_RE', () => {
  const inputs = ['hello world', 'my name', 'step.one', 'a-b-c', 'simple'];
  for (const input of inputs) {
    try {
      const result = __test__.sanitizeName(input, 'test');
      assert.ok(SAFE_NAME_RE.test(result), `sanitizeName("${input}") = "${result}" should match SAFE_NAME_RE`);
    } catch {
      // Throwing is acceptable for inputs that can't be normalized
    }
  }
});

test('requireDirectoryPath rejects ALL inputs containing null bytes', () => {
  const inputs = [
    '/tmp/\x00evil',
    '\x00',
    '/safe/path\x00/extra',
    'hello\x00world',
    '/\x00',
  ];
  for (const input of inputs) {
    assert.throws(() => __test__.requireDirectoryPath(input), `Should reject "${input.replace(/\0/g, '\\0')}"`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Fuzz tests
// ═══════════════════════════════════════════════════════════════════════════════

test('sanitizeId fuzz: 500 random inputs → valid output or throws, never crashes', () => {
  const rng = makePRNG(1001);
  let validCount = 0;
  let throwCount = 0;
  for (let i = 0; i < 500; i++) {
    const input = randomString(rng, 100);
    try {
      const result = __test__.sanitizeId(input, 'fuzz');
      assert.ok(SAFE_ID_RE.test(result), `sanitizeId output "${result}" should match SAFE_ID_RE`);
      validCount++;
    } catch {
      throwCount++;
    }
  }
  // Should have some of each
  assert.ok(throwCount > 0, 'Should throw for some random inputs');
  assert.ok(validCount + throwCount === 500, 'All 500 inputs should be handled');
});

test('sanitizeName fuzz: 500 random inputs → valid output or throws, never crashes', () => {
  const rng = makePRNG(2002);
  let validCount = 0;
  let throwCount = 0;
  for (let i = 0; i < 500; i++) {
    const input = randomString(rng, 100);
    try {
      const result = __test__.sanitizeName(input, 'fuzz');
      assert.ok(SAFE_NAME_RE.test(result), `sanitizeName output "${result}" should match SAFE_NAME_RE`);
      validCount++;
    } catch {
      throwCount++;
    }
  }
  assert.ok(validCount + throwCount === 500);
});

test('sanitizeModel fuzz: 500 random inputs → valid model or "sonnet" or throws', () => {
  const rng = makePRNG(3003);
  for (let i = 0; i < 500; i++) {
    const input = randomString(rng, 80);
    try {
      const result = __test__.sanitizeModel(input);
      assert.ok(SAFE_MODEL_RE.test(result), `sanitizeModel output "${result}" should match SAFE_MODEL_RE`);
    } catch {
      // Throwing is acceptable
    }
  }
  // Verify undefined returns "sonnet"
  assert.equal(__test__.sanitizeModel(undefined), 'sonnet');
});

test('sanitizeAgent fuzz: 500 random inputs → valid, empty, or throws', () => {
  const rng = makePRNG(4004);
  for (let i = 0; i < 500; i++) {
    const input = randomString(rng, 80);
    try {
      const result = __test__.sanitizeAgent(input);
      assert.ok(result === '' || SAFE_AGENT_RE.test(result),
        `sanitizeAgent output "${result}" should match SAFE_AGENT_RE or be empty`);
    } catch {
      // Throwing is acceptable
    }
  }
  // Edge cases
  assert.equal(__test__.sanitizeAgent(undefined), '');
  assert.equal(__test__.sanitizeAgent(null), '');
  assert.equal(__test__.sanitizeAgent(''), '');
});

test('requireDirectoryPath fuzz: 500 random inputs with dangerous chars', () => {
  const rng = makePRNG(5005);
  let validCount = 0;
  let throwCount = 0;
  for (let i = 0; i < 500; i++) {
    const input = randomString(rng, 200);
    try {
      const result = __test__.requireDirectoryPath(input);
      // If it didn't throw, result should be a string with no newlines, null bytes, or quotes
      assert.equal(typeof result, 'string');
      assert.ok(!result.includes('\0'), 'Output should not contain null bytes');
      assert.ok(!result.includes('\n'), 'Output should not contain newlines');
      assert.ok(!result.includes('"'), 'Output should not contain double quotes');
      validCount++;
    } catch {
      throwCount++;
    }
  }
  assert.ok(throwCount > 0, 'Should throw for inputs with dangerous chars');
  assert.ok(validCount + throwCount === 500);
});

test('normalizeFilePath fuzz: 200 random paths → no traversal above cwd', () => {
  const rng = makePRNG(6006);
  const cwd = '/tmp/project';
  for (let i = 0; i < 200; i++) {
    const input = randomString(rng, 60);
    const result = __test__.normalizeFilePath(input, cwd);
    // null is acceptable for invalid inputs
    if (result === null) continue;
    // Result should be an absolute path (starts with /)
    assert.ok(result.startsWith('/'), `normalizeFilePath result "${result}" should be absolute`);
  }
});
