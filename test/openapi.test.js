import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const contractUrl = new URL('../openapi.yaml', import.meta.url);

async function contract() {
  return readFile(contractUrl, 'utf8');
}

test('PostgreSQL runtime work preserves the current API contract version and collection routes', async () => {
  const yaml = await contract();
  assert.match(yaml, /version: 0\.3\.0/);
  for (const route of [
    '/v1/mandates:',
    '/v1/approvals:',
    '/v1/approvals/{id}:',
    '/v1/decisions:',
    '/v1/decisions/{id}:',
    '/v1/receipts:'
  ]) {
    assert.ok(yaml.includes(route), `OpenAPI is missing ${route}`);
  }
});

test('OpenAPI documents pagination, scopes, and tenant-safe authorization errors', async () => {
  const yaml = await contract();
  assert.match(yaml, /name: startingAfter/);
  assert.match(yaml, /name: limit/);
  assert.match(yaml, /x-required-scope: mandates:write/);
  assert.match(yaml, /x-required-scope: authorizations:write/);
  assert.match(yaml, /Forbidden:/);
  assert.match(yaml, /MISSING_SCOPE|missing the required scope/i);
});

test('OpenAPI decision and mandate fields match runtime names', async () => {
  const yaml = await contract();
  assert.match(yaml, /revocationReason:/);
  assert.doesNotMatch(yaml, /revokeReason:/);
  assert.match(yaml, /requestId:/);
  assert.match(yaml, /context:/);
});
