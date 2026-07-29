import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const contractPath = new URL('../openapi/action-attempts.yaml', import.meta.url);

test('execution lifecycle contract documents reservation, completion, cancellation, and receipts', async () => {
  const yaml = await readFile(contractPath, 'utf8');
  assert.match(yaml, /version: 0\.6\.0-phase3b/);
  assert.match(yaml, /\/v1\/action-attempts:/);
  assert.match(yaml, /\/v1\/action-attempts\/\{id\}\/complete:/);
  assert.match(yaml, /\/v1\/action-attempts\/\{id\}\/cancel:/);
  assert.match(yaml, /\/v1\/receipts:/);
  assert.match(yaml, /x-required-scope: action_attempts:write/);
  assert.match(yaml, /x-required-scope: action_attempts:read/);
  assert.match(yaml, /x-required-scope: receipts:write/);
  assert.match(yaml, /minimum: 30/);
  assert.match(yaml, /maximum: 900/);
  assert.match(yaml, /enum: \[RESERVED, COMPLETED, CANCELLED, EXPIRED\]/);
  assert.match(yaml, /const: '1\.1'/);
  assert.match(yaml, /actionAttemptId/);
});
