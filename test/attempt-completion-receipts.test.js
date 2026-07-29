import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createStaticApiKeyAuthenticator, API_SCOPES } from '../src/auth/authentication.js';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import { createStaticSigningKeyRegistry } from '../src/crypto/signing-key-registry.js';
import { createRuntimeHandler } from '../src/http/runtime-handler.js';
import { MemoryStore } from '../src/store/memory-store.js';

const ownership = { tenantId: 'ten_attempt_completion', environment: 'test' };
const secret = 'attempt-completion-secret';
const hashes = {
  inputHash: `sha256:${'1'.repeat(64)}`,
  outputHash: `sha256:${'2'.repeat(64)}`
};

async function startServer(runtime) {
  const server = createServer(createRuntimeHandler(runtime));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      await once(server, 'close');
    }
  };
}

function mandate(id = 'mnd_completion') {
  return {
    id,
    principalId: 'principal_completion',
    agentId: 'agent_completion',
    purpose: 'Execute one protected operation',
    resources: ['github:repo'],
    allowedActions: ['repository.write'],
    deniedActions: [],
    approvalRequiredActions: [],
    constraints: {},
    validFrom: '2026-07-29T00:00:00.000Z',
    validUntil: '2030-01-01T00:00:00.000Z',
    maxUses: 10,
    uses: 1,
    status: 'ACTIVE',
    createdAt: '2026-07-29T00:00:00.000Z',
    revokedAt: null,
    revocationReason: null
  };
}

function decision(id, mandateId) {
  return {
    id,
    mandateId,
    agentId: 'agent_completion',
    action: 'repository.write',
    resource: 'github:repo',
    context: {},
    outcome: 'ALLOW',
    reasonCode: 'ACTION_ALLOWED',
    reason: 'The action is allowed.',
    approvalId: null,
    evaluatedAt: '2026-07-29T00:00:01.000Z',
    requestId: `req_${id}`
  };
}

function fixture() {
  const store = new MemoryStore(ownership);
  const signer = createReceiptSigner({ keyId: 'key_attempt_completion' });
  const mnd = mandate();
  store.save('mandates', ownership, mnd);
  store.save('decisions', ownership, decision('dec_completion', mnd.id));
  store.save('decisions', ownership, decision('dec_cancellation', mnd.id));
  return {
    store,
    runtime: {
      store,
      signer,
      signingKeys: createStaticSigningKeyRegistry(signer),
      authenticator: createStaticApiKeyAuthenticator({
        apiKey: secret,
        ...ownership,
        credentialId: 'key_attempt_completion',
        scopes: [
          API_SCOPES.ACTION_ATTEMPTS_READ,
          API_SCOPES.ACTION_ATTEMPTS_WRITE,
          API_SCOPES.RECEIPTS_READ,
          API_SCOPES.RECEIPTS_WRITE
        ]
      })
    }
  };
}

async function post(baseUrl, path, body, idempotencyKey) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': secret,
      'idempotency-key': idempotencyKey
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test('completed attempt is the only server path to an execution receipt', async () => {
  const { runtime, store } = fixture();
  const server = await startServer(runtime);
  try {
    const reserved = await post(server.baseUrl, '/v1/action-attempts', {
      decisionId: 'dec_completion', expiresInSeconds: 300
    }, 'reserve-completion');
    assert.equal(reserved.status, 201);

    const premature = await post(server.baseUrl, '/v1/receipts', {
      actionAttemptId: reserved.body.id
    }, 'premature-receipt');
    assert.equal(premature.status, 409);
    assert.equal(premature.body.error.code, 'ACTION_ATTEMPT_NOT_COMPLETED');

    const completed = await post(server.baseUrl, `/v1/action-attempts/${reserved.body.id}/complete`, {
      executionStatus: 'SUCCEEDED',
      ...hashes,
      tool: 'github.create_commit',
      provider: 'github'
    }, 'complete-attempt');
    assert.equal(completed.status, 200);
    assert.equal(completed.body.status, 'COMPLETED');
    assert.equal(completed.body.executionStatus, 'SUCCEEDED');

    const replay = await post(server.baseUrl, `/v1/action-attempts/${reserved.body.id}/complete`, {
      executionStatus: 'SUCCEEDED',
      ...hashes,
      tool: 'github.create_commit',
      provider: 'github'
    }, 'complete-attempt');
    assert.equal(replay.status, 200);
    assert.equal(replay.body.completedAt, completed.body.completedAt);

    store.save('mandates', ownership, {
      ...store.get('mandates', ownership, 'mnd_completion'),
      status: 'REVOKED',
      revokedAt: '2026-07-29T00:05:00.000Z',
      revocationReason: 'No further actions'
    });

    const issued = await post(server.baseUrl, '/v1/receipts', {
      actionAttemptId: reserved.body.id
    }, 'issue-attempt-receipt');
    assert.equal(issued.status, 201);
    assert.equal(issued.body.version, '1.1');
    assert.equal(issued.body.actionAttemptId, reserved.body.id);
    assert.equal(issued.body.executionStatus, 'SUCCEEDED');
    assert.equal(issued.body.executedAt, completed.body.completedAt);

    const verify = await post(server.baseUrl, '/v1/receipts/verify', {
      receipt: issued.body
    }, 'verify-does-not-use-idempotency');
    assert.equal(verify.status, 200);
    assert.equal(verify.body.valid, true);

    const duplicate = await post(server.baseUrl, '/v1/receipts', {
      actionAttemptId: reserved.body.id
    }, 'different-receipt-key');
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'RECEIPT_ALREADY_EXISTS');

    assert.equal(store.list('receipts', ownership).length, 1);
    assert.equal(store.list('auditEvents', ownership).filter((event) => event.type === 'action_attempt.completed').length, 1);
    assert.equal(store.list('auditEvents', ownership).filter((event) => event.type === 'receipt.issued').length, 1);
  } finally {
    await server.close();
  }
});

test('cancelled attempts cannot complete or produce receipts', async () => {
  const { runtime } = fixture();
  const server = await startServer(runtime);
  try {
    const reserved = await post(server.baseUrl, '/v1/action-attempts', {
      decisionId: 'dec_cancellation'
    }, 'reserve-cancel');
    const cancelled = await post(server.baseUrl, `/v1/action-attempts/${reserved.body.id}/cancel`, {
      reason: 'Caller abandoned the operation'
    }, 'cancel-attempt');
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, 'CANCELLED');

    const completion = await post(server.baseUrl, `/v1/action-attempts/${reserved.body.id}/complete`, {
      executionStatus: 'FAILED',
      ...hashes,
      tool: 'github.create_commit'
    }, 'complete-cancelled');
    assert.equal(completion.status, 409);
    assert.equal(completion.body.error.code, 'ACTION_ATTEMPT_ALREADY_TERMINAL');

    const receipt = await post(server.baseUrl, '/v1/receipts', {
      actionAttemptId: reserved.body.id
    }, 'receipt-cancelled');
    assert.equal(receipt.status, 409);
    assert.equal(receipt.body.error.code, 'ACTION_ATTEMPT_NOT_COMPLETED');
  } finally {
    await server.close();
  }
});
