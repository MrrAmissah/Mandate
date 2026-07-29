import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const contractPath = new URL('../openapi/action-attempts.yaml', import.meta.url);

test('action attempt contract documents routes, scopes, bounds, and statuses', async () => {
  const yaml = await readFile(contractPath, 'utf8');
  assert.match(yaml, /\/v1\/action-attempts:/);
  assert.match(yaml, /\/v1\/action-attempts\/\{id\}:/);
  assert.match(yaml, /x-required-scope: action_attempts:write/);
  assert.match(yaml, /x-required-scope: action_attempts:read/);
  assert.match(yaml, /minimum: 30/);
  assert.match(yaml, /maximum: 900/);
  assert.match(yaml, /enum: \[RESERVED, COMPLETED, CANCELLED, EXPIRED\]/);
  assert.match(yaml, /pattern: '\^att_\.\+'/);
});
