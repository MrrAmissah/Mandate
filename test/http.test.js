import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import { MemoryStore } from '../src/store/memory-store.js';

const fixedNow = new Date('2026-07-29T06:00:00.000Z');

async function withServer(run) {
  const store = new MemoryStore();
  const server = createServer(createApp({
    store,
    signer: createReceiptSigner({ keyId: 'test' }),
    apiKey: 'secret',
    now: () => fixedNow
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`, store);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

const headers = {
  'content-type': 'application/json',
  'x-api-key': 'secret'
};

async function createMandate(baseUrl, overrides = {}, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}/v1/mandates`, {
    method: 'POST',
    headers: { ...headers, ...extraHeaders },
    body: JSON.stringify({
      principalId: 'user_prince',
      agentId: 'agent_coder',
      purpose: 'Read a repository',
      resources: ['github:MrrAmissah/demo-api'],
      allowedActions: ['repository.read'],
      ...overrides
    })
  });
  return { response, body: await response.json() };
}

test('HTTP flow creates a mandate and returns an authorization decision', async () => {
  await withServer(async (baseUrl) => {
    const { response: mandateResponse, body: mandate } = await createMandate(baseUrl);
    assert.equal(mandateResponse.status, 201);

    const authorizationResponse = await fetch(`${baseUrl}/v1/authorize`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mandateId: mandate.id,
        agentId: 'agent_coder',
        action: 'repository.read',
        resource: 'github:MrrAmissah/demo-api'
      })
    });
    assert.equal(authorizationResponse.status, 200);
    const decision = await authorizationResponse.json();
    assert.equal(decision.outcome, 'ALLOW');
  });
});

test('responses preserve a valid client request ID', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { 'x-request-id': 'req_client_12345' }
    });
    assert.equal(response.headers.get('x-request-id'), 'req_client_12345');
    assert.equal((await response.json()).requestId, 'req_client_12345');
  });
});

test('same idempotency key and payload returns the original resource', async () => {
  await withServer(async (baseUrl) => {
    const extraHeaders = { 'idempotency-key': 'mandate-create-1' };
    const first = await createMandate(baseUrl, {}, extraHeaders);
    const second = await createMandate(baseUrl, {}, extraHeaders);
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 201);
    assert.equal(second.body.id, first.body.id);
  });
});

test('same idempotency key with a different payload returns a conflict', async () => {
  await withServer(async (baseUrl) => {
    const extraHeaders = { 'idempotency-key': 'mandate-create-2' };
    const first = await createMandate(baseUrl, {}, extraHeaders);
    assert.equal(first.response.status, 201);

    const second = await createMandate(baseUrl, { purpose: 'Write a repository' }, extraHeaders);
    assert.equal(second.response.status, 409);
    assert.equal(second.body.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.ok(second.body.error.requestId);
  });
});

test('an approval is consumed by the first allowed authorization', async () => {
  await withServer(async (baseUrl, store) => {
    const { body: mandate } = await createMandate(baseUrl, {
      allowedActions: ['commit.create'],
      approvalRequiredActions: ['commit.create']
    });

    const approvalResponse = await fetch(`${baseUrl}/v1/approvals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mandateId: mandate.id,
        agentId: 'agent_coder',
        action: 'commit.create',
        resource: 'github:MrrAmissah/demo-api',
        summary: 'Commit reviewed changes',
        expiresAt: '2026-07-29T07:00:00.000Z'
      })
    });
    const pending = await approvalResponse.json();

    const decisionResponse = await fetch(`${baseUrl}/v1/approvals/${pending.id}/decide`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        decision: 'APPROVED',
        decidedBy: 'user_prince',
        reason: 'Reviewed'
      })
    });
    const approval = await decisionResponse.json();

    const authorizeBody = {
      mandateId: mandate.id,
      agentId: 'agent_coder',
      action: 'commit.create',
      resource: 'github:MrrAmissah/demo-api',
      approvalId: approval.id
    };
    const firstAuthorization = await fetch(`${baseUrl}/v1/authorize`, {
      method: 'POST',
      headers,
      body: JSON.stringify(authorizeBody)
    });
    assert.equal((await firstAuthorization.json()).outcome, 'ALLOW');
    assert.equal(store.get('approvals', approval.id).status, 'CONSUMED');

    const secondAuthorization = await fetch(`${baseUrl}/v1/authorize`, {
      method: 'POST',
      headers,
      body: JSON.stringify(authorizeBody)
    });
    assert.equal((await secondAuthorization.json()).outcome, 'REQUIRE_APPROVAL');
  });
});
