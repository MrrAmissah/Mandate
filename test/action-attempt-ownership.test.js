import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveActionAttempt } from '../src/application/action-attempt-service.js';
import { cancelAttempt, completeAttempt } from '../src/application/attempt-lifecycle-service.js';
import { MemoryStore } from '../src/store/memory-store.js';

const ownership = { tenantId: 'ten_attempt_owner', environment: 'test' };
const owner = { ...ownership, credentialId: 'key_attempt_owner', scopes: ['action_attempts:write'] };
const other = { ...ownership, credentialId: 'key_attempt_other', scopes: ['action_attempts:write'] };
const observedAt = new Date('2026-07-29T12:00:00.000Z');

function storeWithAllowedDecision() {
  const store = new MemoryStore(ownership);
  store.save('mandates', ownership, {
    id: 'mnd_attempt_owner',
    principalId: 'principal_owner',
    agentId: 'agent_owner',
    purpose: 'Protect one owned execution',
    resources: ['github:repo'],
    allowedActions: ['repository.write'],
    deniedActions: [],
    approvalRequiredActions: [],
    constraints: {},
    validFrom: observedAt.toISOString(),
    validUntil: '2030-01-01T00:00:00.000Z',
    maxUses: 10,
    uses: 1,
    status: 'ACTIVE',
    createdAt: observedAt.toISOString(),
    revokedAt: null,
    revocationReason: null
  });
  store.save('decisions', ownership, {
    id: 'dec_attempt_owner',
    mandateId: 'mnd_attempt_owner',
    agentId: 'agent_owner',
    action: 'repository.write',
    resource: 'github:repo',
    context: {},
    outcome: 'ALLOW',
    reasonCode: 'ACTION_ALLOWED',
    reason: 'The action is allowed.',
    approvalId: null,
    evaluatedAt: observedAt.toISOString(),
    requestId: 'req_attempt_owner_authorize'
  });
  return store;
}

async function reserve(store) {
  return store.transaction((transaction) => reserveActionAttempt({
    transaction,
    ownership,
    authentication: owner,
    input: { decisionId: 'dec_attempt_owner', expiresInSeconds: 300 },
    requestId: 'req_attempt_owner_reserve',
    now: observedAt
  }));
}

test('only the reserving credential may complete an action attempt', async () => {
  const store = storeWithAllowedDecision();
  const attempt = await reserve(store);
  await assert.rejects(
    store.transaction((transaction) => completeAttempt({
      transaction,
      ownership,
      authentication: other,
      attemptId: attempt.id,
      input: {
        executionStatus: 'FAILED',
        inputHash: `sha256:${'a'.repeat(64)}`,
        outputHash: `sha256:${'b'.repeat(64)}`,
        tool: 'github.create_commit'
      },
      requestId: 'req_attempt_other_complete',
      now: new Date(observedAt.getTime() + 1000)
    })),
    (error) => error.code === 'ACTION_ATTEMPT_OWNER_MISMATCH' && error.status === 403
  );
  assert.equal(store.get('actionAttempts', ownership, attempt.id).status, 'RESERVED');
});

test('only the reserving credential may cancel an action attempt', async () => {
  const store = storeWithAllowedDecision();
  const attempt = await reserve(store);
  await assert.rejects(
    store.transaction((transaction) => cancelAttempt({
      transaction,
      ownership,
      authentication: other,
      attemptId: attempt.id,
      input: { reason: 'Unrelated credential cancellation' },
      requestId: 'req_attempt_other_cancel',
      now: new Date(observedAt.getTime() + 1000)
    })),
    (error) => error.code === 'ACTION_ATTEMPT_OWNER_MISMATCH' && error.status === 403
  );
  assert.equal(store.get('actionAttempts', ownership, attempt.id).status, 'RESERVED');
});
