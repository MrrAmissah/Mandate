import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const contractUrl = new URL('../openapi.yaml', import.meta.url);

async function contract() {
  return readFile(contractUrl, 'utf8');
}

test('stable OpenAPI publishes the current execution lifecycle contract', async () => {
  const yaml = await contract();
  assert.match(yaml, /version: 0\.6\.0/);
  for (const route of [
    '/v1/mandates:',
    '/v1/approvals:',
    '/v1/approvals/{id}:',
    '/v1/decisions:',
    '/v1/decisions/{id}:',
    '/v1/action-attempts:',
    '/v1/action-attempts/{id}:',
    '/v1/action-attempts/{id}/complete:',
    '/v1/action-attempts/{id}/cancel:',
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
  assert.match(yaml, /x-required-scope: action_attempts:write/);
  assert.match(yaml, /x-required-scope: receipts:write/);
  assert.match(yaml, /Forbidden:/);
  assert.match(yaml, /MISSING_SCOPE/);
  assert.match(yaml, /ACTION_ATTEMPT_OWNER_MISMATCH/);
});

test('stable receipt request requires an action attempt and rejects the legacy decision body', async () => {
  const yaml = await contract();
  const request = yaml.match(/IssueAttemptReceiptRequest:([\s\S]*?)\n    Receipt:/)?.[1];
  assert.ok(request, 'missing IssueAttemptReceiptRequest schema');
  assert.match(request, /required: \[actionAttemptId\]/);
  assert.match(request, /actionAttemptId:/);
  assert.doesNotMatch(request, /decisionId:|executionStatus:|inputHash:|outputHash:|tool:/);
  assert.match(yaml, /version: \{ type: string, const: '1\.1' \}/);
});

test('OpenAPI decision, mandate, and execution fields match runtime names', async () => {
  const yaml = await contract();
  assert.match(yaml, /revocationReason:/);
  assert.doesNotMatch(yaml, /revokeReason:/);
  assert.match(yaml, /requestId:/);
  assert.match(yaml, /context:/);
  assert.match(yaml, /reservedByCredentialId:/);
  assert.match(yaml, /completionRequestId:/);
});
