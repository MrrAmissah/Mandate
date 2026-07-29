import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const contractUrl = new URL('../openapi.yaml', import.meta.url);

async function contract() {
  return readFile(contractUrl, 'utf8');
}

test('stable OpenAPI publishes the current execution lifecycle contract', async () => {
  const yaml = await contract();
  assert.match(yaml, /version: 0\.7\.0/);
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
    '/v1/receipts:',
    '/v1/receipts/{id}/supersede:'
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

test('stable receipt requests bind issuance to an attempt and corrections to a predecessor', async () => {
  const yaml = await contract();
  const issueRequest = yaml.match(/IssueAttemptReceiptRequest:([\s\S]*?)\n    SupersedeReceiptRequest:/)?.[1];
  assert.ok(issueRequest, 'missing IssueAttemptReceiptRequest schema');
  assert.match(issueRequest, /required: \[actionAttemptId\]/);
  assert.match(issueRequest, /actionAttemptId:/);
  assert.doesNotMatch(issueRequest, /decisionId:|executionStatus:|inputHash:|outputHash:|tool:/);

  const supersedeRequest = yaml.match(/SupersedeReceiptRequest:([\s\S]*?)\n    Receipt:/)?.[1];
  assert.ok(supersedeRequest, 'missing SupersedeReceiptRequest schema');
  assert.match(supersedeRequest, /required: \[reason\]/);
  assert.match(supersedeRequest, /maxLength: 1000/);

  const receiptSchema = yaml.match(/    Receipt:([\s\S]*?)\n    ErrorResponse:/)?.[1];
  assert.ok(receiptSchema, 'missing Receipt schema');
  assert.match(receiptSchema, /version: \{ type: string, enum: \['1\.1', '1\.2'\] \}/);
  assert.match(receiptSchema, /then:\n            required: \[supersedesReceiptId, supersessionReason\]/);
  assert.match(receiptSchema, /else:\n            not:\n              anyOf:/);
  assert.match(receiptSchema, /- required: \[supersedesReceiptId\]/);
  assert.match(receiptSchema, /- required: \[supersessionReason\]/);
});

test('receipt writes document inactive signing-key availability failures', async () => {
  const yaml = await contract();
  const receiptWriteSection = yaml.match(/\/v1\/receipts:([\s\S]*?)\n    get:/)?.[1];
  const supersessionSection = yaml.match(/\/v1\/receipts\/\{id\}\/supersede:([\s\S]*?)\n  \/v1\/receipts\/verify:/)?.[1];
  assert.ok(receiptWriteSection, 'missing root receipt write operation');
  assert.ok(supersessionSection, 'missing receipt supersession operation');
  assert.match(receiptWriteSection, /'503': \{ \$ref: '#\/components\/responses\/ServiceUnavailable' \}/);
  assert.match(supersessionSection, /'503': \{ \$ref: '#\/components\/responses\/ServiceUnavailable' \}/);
  assert.match(yaml, /ServiceUnavailable:/);
  assert.match(yaml, /SIGNING_KEY_NOT_ACTIVE/);
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
