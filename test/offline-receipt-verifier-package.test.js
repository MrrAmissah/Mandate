import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

const execute = promisify(execFile);
const fixtureUrl = new URL('./fixtures/receipt-verification/ed25519-v1.1.json', import.meta.url);

const allowedFiles = new Set([
  'README.md',
  'canonical-json.d.ts',
  'canonical-json.js',
  'index.d.ts',
  'index.js',
  'key-set-cache.js',
  'package.json'
]);

test('receipt verifier dry-run package contains only intended public files', async () => {
  const { stdout } = await execute('npm', [
    'pack',
    '--dry-run',
    '--json',
    './packages/receipt-verifier'
  ], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  });
  const report = JSON.parse(stdout)[0];
  const paths = report.files.map((file) => file.path).sort();
  for (const expected of allowedFiles) assert.ok(paths.includes(expected), `package is missing ${expected}`);
  assert.equal(paths.every((path) => allowedFiles.has(path)), true, `unexpected package files: ${paths.join(', ')}`);
});

test('public conformance fixture contains no private key material', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  assert.match(fixture, /BEGIN PUBLIC KEY/);
  assert.doesNotMatch(fixture, /BEGIN (?:ENCRYPTED )?PRIVATE KEY/);
});
