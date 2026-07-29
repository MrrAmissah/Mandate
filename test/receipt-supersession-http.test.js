import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createStaticApiKeyAuthenticator, API_SCOPES } from '../src/auth/authentication.js';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import { createStaticSigningKeyRegistry } from '../src/crypto/signing-key-registry.js';
import { issueReceipt } from '../src/domain/receipts.js';
import { createRuntimeHandler } from '../src/http/runtime-handler.js';
import { MemoryStore } from '../src/store/memory-store.js';

const ownership = { tenantId: 'ten_receipt_supersession_http', environment: 'test' };
const secret = 'receipt-supersession-http-secret';

function decision(id = 'dec_receipt_supersession_http') {
  return {
    id,
    mandateId: 'mnd_receipt_supersession_http',
    agentId: 'agent_receipt_supersession',
    action: 'repository.write',
    resource: 'github:MrrAmissah/Mandate',
    context: {},
    outcome: 'ALLOW',
    reasonCode: 'ACTION_ALLOWED',
    reason: 'The action is allowed.',
    approvalId: null,
    evaluatedAt: '2026-07-29T18:00:00.000Z',
    requestId: `req_${id}`
  };
}

function mandate() {
  return {
    id: 'mnd_receipt_supersession_http',
    principalId: 'principal_receipt_supersession',
    agentId: 'agent_receipt_supersession',
    purpose: 'Exercise receipt correction semantics',
    resources: ['github:MrrAmissah/Mandate'],
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

function createRootReceipt(signer, { id = 'dec_receipt_supersession_http', actionAttempt = true } = {}) {
  return issueReceipt({
    input: {
      actionAttemptId: actionAttempt ? 'att_receipt_supersession_http' : undefined,
      executionStatus: 'SUCCEEDED',
      inputHash: `sha256:${'a'.repeat(64)}`,
      outputHash: `sha256:${'b'.repeat(64)}`,
      tool: 'github.create_commit',
      provider: 'github',
      model: null,
      executedAt: '2026-07-29T18:01:00.000Z'
    },
    decision: decision(id),
    mandate: mandate(),
    signer,
    now: new Date('2026-07-29T18:02:00.000Z')
  });
}

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

async function post(baseUrl, path, body, idempotencyKey = null) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': secret
  };
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

function fixture() {
  const store = new MemoryStore(ownership);
  const signer = createReceiptSigner({ keyId: 'key_receipt_supersession_http' });
  const root = createRootReceipt(signer);
  store.save('mandates', ownership, mandate());
  store.save('decisions', ownership, decision());
  store.save('receipts', ownership, root);
  return {
    store,
    signer,
    root,
    runtime: {
      store,
      signer,
      signingKeys: createStaticSigningKeyRegistry(signer),
      authenticator: createStaticApiKeyAuthenticator({
        apiKey: secret,
        ...ownership,
        credentialId: 'key_receipt_supersession_http',
        scopes: [API_SCOPES.RECEIPTS_READ, API_SCOPES.RECEIPTS_WRITE]
      })
    }
  };
}

const evidenceFields = [
  'decisionId', 'mandateId', 'actionAttemptId', 'principalId', 'agentId', 'action',
  'resource', 'executionStatus', 'inputHash', 'outputHash', 'tool', 'provider', 'model',
  'approvalId', 'authorizedAt', 'executedAt'
];

test('HTTP supersession is idempotent, append-only, verifiable, and linear', async () => {
  const { runtime, store, root } = fixture();
  const server = await startServer(runtime);
  try {
    const first = await post(
      server.baseUrl,
      `/v1/receipts/${root.id}/supersede`,
      { reason: 'Reissue under the current receipt contract.' },
      'supersede-root'
    );
    assert.equal(first.status, 201);
    assert.equal(first.body.version, '1.2');
    assert.equal(first.body.supersedesReceiptId, root.id);
    for (const field of evidenceFields) assert.deepEqual(first.body[field], root[field], field);

    const replay = await post(
      server.baseUrl,
      `/v1/receipts/${root.id}/supersede`,
      { reason: 'Reissue under the current receipt contract.' },
      'supersede-root'
    );
    assert.equal(replay.status, 201);
    assert.equal(replay.body.id, first.body.id);
    assert.equal(replay.body.signature, first.body.signature);

    const fork = await post(
      server.baseUrl,
      `/v1/receipts/${root.id}/supersede`,
      { reason: 'Attempt a second successor.' },
      'supersede-root-fork'
    );
    assert.equal(fork.status, 409);
    assert.equal(fork.body.error.code, 'RECEIPT_ALREADY_SUPERSEDED');
    assert.equal(fork.body.error.details.successorReceiptId, first.body.id);

    const second = await post(
      server.baseUrl,
      `/v1/receipts/${first.body.id}/supersede`,
      { reason: 'Advance the linear correction chain.' },
      'supersede-first-successor'
    );
    assert.equal(second.status, 201);
    assert.equal(second.body.supersedesReceiptId, first.body.id);
    for (const field of evidenceFields) assert.deepEqual(second.body[field], root[field], field);

    for (const receipt of [root, first.body, second.body]) {
      const verification = await post(server.baseUrl, '/v1/receipts/verify', { receipt });
      assert.equal(verification.status, 200);
      assert.equal(verification.body.valid, true);
    }

    const storedRoot = store.get('receipts', ownership, root.id);
    assert.deepEqual(storedRoot, root);
    assert.equal(store.list('receipts', ownership).length, 3);
    const supersessionEvents = store.list('auditEvents', ownership)
      .filter((event) => event.type === 'receipt.superseded');
    assert.equal(supersessionEvents.length, 2);
    assert.equal(store.list('outboxMessages', ownership)
      .filter((message) => message.eventType === 'receipt.superseded').length, 2);
  } finally {
    await server.close();
  }
});

test('tampered and legacy predecessors fail closed without creating successors', async () => {
  const { runtime, store, signer, root } = fixture();
  const tampered = {
    ...root,
    id: 'rcpt_tampered_predecessor',
    outputHash: `sha256:${'c'.repeat(64)}`
  };
  const legacy = createRootReceipt(signer, {
    id: 'dec_receipt_supersession_legacy',
    actionAttempt: false
  });
  store.save('decisions', ownership, decision('dec_receipt_supersession_legacy'));
  store.save('receipts', ownership, tampered);
  store.save('receipts', ownership, legacy);

  const server = await startServer(runtime);
  try {
    const tamperedResponse = await post(
      server.baseUrl,
      `/v1/receipts/${tampered.id}/supersede`,
      { reason: 'Must not re-sign corrupted evidence.' },
      'supersede-tampered'
    );
    assert.equal(tamperedResponse.status, 409);
    assert.equal(tamperedResponse.body.error.code, 'RECEIPT_NOT_VERIFIABLE');

    const legacyResponse = await post(
      server.baseUrl,
      `/v1/receipts/${legacy.id}/supersede`,
      { reason: 'Legacy receipts have no action attempt.' },
      'supersede-legacy'
    );
    assert.equal(legacyResponse.status, 409);
    assert.equal(legacyResponse.body.error.code, 'RECEIPT_NOT_SUPERSEDABLE');

    assert.equal(store.list('receipts', ownership).length, 3);
    assert.equal(store.list('auditEvents', ownership)
      .filter((event) => event.type === 'receipt.superseded').length, 0);
  } finally {
    await server.close();
  }
});

test('an inactive configured signer returns a safe 503 without committing a successor', async () => {
  const { runtime, store, root } = fixture();
  runtime.signingKeys = {
    ...runtime.signingKeys,
    async verifyActiveSigner() { return false; }
  };
  const server = await startServer(runtime);
  try {
    const response = await post(
      server.baseUrl,
      `/v1/receipts/${root.id}/supersede`,
      { reason: 'This must fail before signing.' },
      'supersede-inactive-signer'
    );
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'SIGNING_KEY_NOT_ACTIVE');
    assert.equal(store.list('receipts', ownership).length, 1);
    assert.equal(store.list('auditEvents', ownership)
      .filter((event) => event.type === 'receipt.superseded').length, 0);
  } finally {
    await server.close();
  }
});
