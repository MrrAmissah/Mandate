import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createStaticApiKeyAuthenticator, API_SCOPES } from '../src/auth/authentication.js';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import { createStaticSigningKeyRegistry } from '../src/crypto/signing-key-registry.js';
import { createRuntimeHandler } from '../src/http/runtime-handler.js';
import { MemoryStore } from '../src/store/memory-store.js';

const ownership = { tenantId: 'ten_action_attempts', environment: 'test' };
const secret = 'action-attempt-test-secret';

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

async function fixture(scopes = [API_SCOPES.ACTION_ATTEMPTS_READ, API_SCOPES.ACTION_ATTEMPTS_WRITE]) {
  const store = new MemoryStore(ownership);
  const signer = createReceiptSigner({ keyId: 'key_action_attempts' });
  const mandate = {
    id: 'mnd_action_attempts',
    principalId: 'principal_test',
    agentId: 'agent_test',
    purpose: 'Run one protected tool action',
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
  const decision = {
    id: 'dec_action_attempts',
    mandateId: mandate.id,
    agentId: mandate.agentId,
    action: 'repository.write',
    resource: 'github:repo',
    context: {},
    outcome: 'ALLOW',
    reasonCode: 'ACTION_ALLOWED',
    reason: 'The action is allowed.',
    approvalId: null,
    evaluatedAt: '2026-07-29T00:00:01.000Z',
    requestId: 'req_authorization'
  };
  store.save('mandates', ownership, mandate);
  store.save('decisions', ownership, decision);
  return {
    store,
    runtime: {
      store,
      signer,
      signingKeys: createStaticSigningKeyRegistry(signer),
      authenticator: createStaticApiKeyAuthenticator({
        apiKey: secret,
        ...ownership,
        credentialId: 'key_action_attempts',
        scopes
      })
    }
  };
}

async function reserve(baseUrl, idempotencyKey) {
  const response = await fetch(`${baseUrl}/v1/action-attempts`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': secret,
      'idempotency-key': idempotencyKey
    },
    body: JSON.stringify({ decisionId: 'dec_action_attempts', expiresInSeconds: 300 })
  });
  return { status: response.status, body: await response.json() };
}

test('action attempt reservation is idempotent, tenant-visible, and audited once', async () => {
  const { runtime, store } = await fixture();
  const server = await startServer(runtime);
  try {
    const first = await reserve(server.baseUrl, 'reserve-once');
    const replay = await reserve(server.baseUrl, 'reserve-once');
    assert.equal(first.status, 201);
    assert.equal(replay.status, 201);
    assert.equal(replay.body.id, first.body.id);
    assert.equal(first.body.status, 'RESERVED');
    assert.equal(first.body.decisionId, 'dec_action_attempts');
    assert.equal(first.body.reservedByCredentialId, 'key_action_attempts');

    const list = await fetch(`${server.baseUrl}/v1/action-attempts`, {
      headers: { 'x-api-key': secret }
    });
    assert.equal(list.status, 200);
    const page = await list.json();
    assert.equal(page.data.length, 1);
    assert.equal(page.data[0].id, first.body.id);

    const read = await fetch(`${server.baseUrl}/v1/action-attempts/${first.body.id}`, {
      headers: { 'x-api-key': secret }
    });
    assert.equal(read.status, 200);
    assert.equal((await read.json()).id, first.body.id);

    assert.equal(store.list('actionAttempts', ownership).length, 1);
    assert.equal(store.list('auditEvents', ownership).filter((event) => event.type === 'action_attempt.reserved').length, 1);
    assert.equal(store.list('outboxMessages', ownership).filter((message) => message.eventType === 'action_attempt.reserved').length, 1);
  } finally {
    await server.close();
  }
});

test('different requests cannot reserve one decision twice under concurrency', async () => {
  const { runtime } = await fixture();
  const server = await startServer(runtime);
  try {
    const results = await Promise.all([
      reserve(server.baseUrl, 'reservation-a'),
      reserve(server.baseUrl, 'reservation-b')
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
    assert.equal(results.find((result) => result.status === 409).body.error.code, 'ACTION_ATTEMPT_ALREADY_RESERVED');
  } finally {
    await server.close();
  }
});

test('action attempt routes enforce dedicated scopes', async () => {
  const { runtime } = await fixture([API_SCOPES.ACTION_ATTEMPTS_READ]);
  const server = await startServer(runtime);
  try {
    const result = await reserve(server.baseUrl, 'missing-write-scope');
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, 'MISSING_SCOPE');
  } finally {
    await server.close();
  }
});
