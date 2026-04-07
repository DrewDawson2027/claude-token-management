import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, '..', 'test');

const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join(testDir, name));

if (files.length === 0) {
  console.error('No test files found in', testDir);
  process.exit(1);
}

if (process.env.COORD_TEST_DEBUG === '1') {
  console.error(`Running ${files.length} coordinator test file(s):`);
  for (const file of files) console.error(` - ${file}`);
}

const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
