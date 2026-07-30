import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const entrypointPath = new URL('../scripts/run-outbox-worker.js', import.meta.url);
const processPath = new URL('../src/application/outbox-worker-process.js', import.meta.url);

test('outbox entry point has no API credential or migration authority', async () => {
  const [entrypoint, processSource] = await Promise.all([
    readFile(entrypointPath, 'utf8'),
    readFile(processPath, 'utf8')
  ]);
  assert.doesNotMatch(entrypoint, /MANDATE_API_KEY/);
  assert.doesNotMatch(processSource, /MANDATE_API_KEY/);
  assert.doesNotMatch(entrypoint, /applyMigrations|scripts\/migrate/);
  assert.doesNotMatch(processSource, /applyMigrations|schema_migrations.*INSERT/s);
  assert.match(entrypoint, /SIGINT/);
  assert.match(entrypoint, /SIGTERM/);
  assert.match(entrypoint, /OUTBOX_STARTUP_FAILED/);
  assert.match(processSource, /MANDATE_OUTBOX_HANDLER_MODULE/);
  assert.match(processSource, /queue\.databaseNow\(\)/);
});
