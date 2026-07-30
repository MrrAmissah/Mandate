import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('production containers execute Node entrypoints directly', async () => {
  const compose = await readFile(
    new URL('../deployment/compose.production.yaml', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(compose, /command: \["npm"/);
  for (const entrypoint of [
    'scripts/migrate.js',
    'scripts/configure-database-roles.js',
    'src/server.js',
    'scripts/run-action-attempt-expiry.js',
    'scripts/run-outbox-worker.js'
  ]) {
    assert.match(compose, new RegExp(entrypoint.replaceAll('.', '\\.')));
  }
});
