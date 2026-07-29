import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import { DomainError } from '../src/domain/errors.js';
import { MemoryStore } from '../src/store/memory-store.js';

const fixedNow = new Date('2026-07-29T06:00:00.000Z');
const fullScopes = ['*'];

function mapAuthenticator(entries) {
  const values = new Map(entries.map(([secret, value]) => [secret, {
    environment: 'test',
    credentialId: `key_${value.tenantId}`,
    scopes: fullScopes,
    ...value
  }]));
  return {
    async authenticate(secret) {
      const authentication = values.get(secret);
      if (!authentication) throw new DomainError('UNAUTHORIZED', 'A valid x-api-key header is required.', 401);
      return authentication;
    }
  };
}

async function withServer({ authenticator, store = new MemoryStore(), now = () => fixedNow }, run) {
  const server = createServer(createApp({
    store,
    signer: createReceiptSigner({ keyId: 'test' }),
    authenticator,
    now
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

function headers(secret, extra = {}) {
  return {
    'content-type': 'application/json',
    'x-api-key': secret,
    ...extra
  };
}

async function createMandate(baseUrl, secret, overrides = {}, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}/v1/mandates`, {
    method: 'POST',
    headers: headers(secret, extraHeaders),
    body: JSON.stringify({
      principalId: 'principal_owner',
      agentId: 'agent_coder',
      purpose: 'Inspect a repository',
      resources: ['github:owner/repository'],
      allowedActions: ['repository.read'],
      ...overrides
    })
  });
  return { response, body: await response.json() };
}

async function authorize(baseUrl, secret, mandate, overrides = {}) {
  const response = await fetch(`${baseUrl}/v1/authorize`, {
    method: 'POST',
    headers: headers(secret),
    body: JSON.stringify({
      mandateId: mandate.id,
      agentId: 'agent_coder',
      action: 'repository.read',
      resource: 'github:owner/repository',
      ...overrides
    })
  });
  return { response, body: await response.json() };
}

test('memory transactions roll back domain, audit, and outbox state together', async () => {
  const store = new MemoryStore();
  const ownership = { tenantId: 'ten_local', environment: 'test' };

  await assert.rejects(store.transaction(async (transaction) => {
    transaction.save('mandates', ownership, { id: 'mnd_rollback' });
    transaction.appendAudit(ownership, { id: 'aud_rollback' });
    transaction.enqueueOutbox(ownership, { id: 'out_rollback' });
    throw new Error('rollback');
  }), /rollback/);

  assert.equal(store.get('mandates', ownership, 'mnd_rollback'), null);
  assert.equal(store.get('auditEvents', ownership, 'aud_rollback'), null);
  assert.equal(store.get('outboxMessages', ownership, 'out_rollback'), null);
});

test('audit sequences are monotonic within each tenant and start independently', async () => {
  const store = new MemoryStore();
  const tenantA = { tenantId: 'ten_a', environment: 'test' };
  const tenantB = { tenantId: 'ten_b', environment: 'test' };

  await store.transaction(async (transaction) => {
    transaction.appendAudit(tenantA, { id: 'aud_a1' });
    transaction.appendAudit(tenantA, { id: 'aud_a2' });
    transaction.appendAudit(tenantB, { id: 'aud_b1' });
  });

  assert.deepEqual(store.list('auditEvents', tenantA).map((event) => event.sequence), [1, 2]);
  assert.deepEqual(store.list('auditEvents', tenantB).map((event) => event.sequence), [1]);
});

test('tenant ownership prevents cross-tenant reads and list disclosure', async () => {
  const authenticator = mapAuthenticator([
    ['tenant-a-secret', { tenantId: 'ten_a' }],
    ['tenant-b-secret', { tenantId: 'ten_b' }]
  ]);

  await withServer({ authenticator }, async (baseUrl) => {
    const created = await createMandate(baseUrl, 'tenant-a-secret');
    assert.equal(created.response.status, 201);

    const crossTenantRead = await fetch(`${baseUrl}/v1/mandates/${created.body.id}`, {
      headers: headers('tenant-b-secret')
    });
    assert.equal(crossTenantRead.status, 404);
    assert.equal((await crossTenantRead.json()).error.code, 'MANDATE_NOT_FOUND');

    const tenantBList = await fetch(`${baseUrl}/v1/mandates`, {
      headers: headers('tenant-b-secret')
    });
    assert.deepEqual((await tenantBList.json()).data, []);
  });
});

test('route scopes fail closed before resource access', async () => {
  const authenticator = mapAuthenticator([
    ['read-only', { tenantId: 'ten_read', scopes: ['mandates:read'] }]
  ]);

  await withServer({ authenticator }, async (baseUrl) => {
    const response = await createMandate(baseUrl, 'read-only');
    assert.equal(response.response.status, 403);
    assert.equal(response.body.error.code, 'MISSING_SCOPE');
    assert.equal(response.body.error.details.requiredScope, 'mandates:write');
  });
});

test('concurrent last-use authorization permits exactly one request', async () => {
  const authenticator = mapAuthenticator([['secret', { tenantId: 'ten_limit' }]]);

  await withServer({ authenticator }, async (baseUrl, store) => {
    const { body: mandate } = await createMandate(baseUrl, 'secret', { maxUses: 1 });
    const results = await Promise.all([
      authorize(baseUrl, 'secret', mandate),
      authorize(baseUrl, 'secret', mandate)
    ]);

    const outcomes = results.map(({ body }) => body.outcome).sort();
    assert.deepEqual(outcomes, ['ALLOW', 'DENY']);
    const denied = results.find(({ body }) => body.outcome === 'DENY').body;
    assert.equal(denied.reasonCode, 'USE_LIMIT_REACHED');

    const ownership = { tenantId: 'ten_limit', environment: 'test' };
    assert.equal(store.get('mandates', ownership, mandate.id).uses, 1);
    assert.equal(store.list('decisions', ownership).length, 2);
    assert.equal(store.list('auditEvents', ownership).length, 3);
    assert.equal(store.list('outboxMessages', ownership).length, 3);
  });
});

test('concurrent approval reuse permits exactly one allowed decision', async () => {
  const authenticator = mapAuthenticator([['secret', { tenantId: 'ten_approval' }]]);

  await withServer({ authenticator }, async (baseUrl, store) => {
    const { body: mandate } = await createMandate(baseUrl, 'secret', {
      allowedActions: ['commit.create'],
      approvalRequiredActions: ['commit.create']
    });

    const pendingResponse = await fetch(`${baseUrl}/v1/approvals`, {
      method: 'POST',
      headers: headers('secret'),
      body: JSON.stringify({
        mandateId: mandate.id,
        agentId: 'agent_coder',
        action: 'commit.create',
        resource: 'github:owner/repository',
        summary: 'Create the reviewed commit',
        expiresAt: '2026-07-29T07:00:00.000Z'
      })
    });
    const pending = await pendingResponse.json();

    const decisionResponse = await fetch(`${baseUrl}/v1/approvals/${pending.id}/decide`, {
      method: 'POST',
      headers: headers('secret'),
      body: JSON.stringify({
        decision: 'APPROVED',
        decidedBy: 'principal_owner',
        reason: 'Reviewed'
      })
    });
    const approval = await decisionResponse.json();

    const authorization = () => authorize(baseUrl, 'secret', mandate, {
      action: 'commit.create',
      approvalId: approval.id
    });
    const results = await Promise.all([authorization(), authorization()]);
    const outcomes = results.map(({ body }) => body.outcome).sort();
    assert.deepEqual(outcomes, ['ALLOW', 'REQUIRE_APPROVAL']);

    const ownership = { tenantId: 'ten_approval', environment: 'test' };
    const stored = store.get('approvals', ownership, approval.id);
    assert.equal(stored.status, 'CONSUMED');
    assert.ok(stored.consumedByDecisionId);
  });
});

test('idempotent replay does not duplicate audit or outbox events', async () => {
  const authenticator = mapAuthenticator([['secret', { tenantId: 'ten_replay' }]]);

  await withServer({ authenticator }, async (baseUrl, store) => {
    const replayHeaders = { 'idempotency-key': 'create-once' };
    const first = await createMandate(baseUrl, 'secret', {}, replayHeaders);
    const second = await createMandate(baseUrl, 'secret', {}, replayHeaders);
    assert.equal(first.body.id, second.body.id);

    const ownership = { tenantId: 'ten_replay', environment: 'test' };
    assert.equal(store.list('mandates', ownership).length, 1);
    assert.equal(store.list('auditEvents', ownership).length, 1);
    assert.equal(store.list('outboxMessages', ownership).length, 1);
  });
});

test('cursor pagination is tenant-scoped and stable', async () => {
  const authenticator = mapAuthenticator([['secret', { tenantId: 'ten_pages' }]]);
  let tick = 0;
  const now = () => new Date(fixedNow.getTime() + tick++ * 1_000);

  await withServer({ authenticator, now }, async (baseUrl) => {
    await createMandate(baseUrl, 'secret', { purpose: 'First' });
    await createMandate(baseUrl, 'secret', { purpose: 'Second' });
    await createMandate(baseUrl, 'secret', { purpose: 'Third' });

    const firstResponse = await fetch(`${baseUrl}/v1/mandates?limit=2`, {
      headers: headers('secret')
    });
    const first = await firstResponse.json();
    assert.equal(first.data.length, 2);
    assert.equal(first.hasMore, true);
    assert.ok(first.nextCursor);

    const secondResponse = await fetch(
      `${baseUrl}/v1/mandates?limit=2&startingAfter=${encodeURIComponent(first.nextCursor)}`,
      { headers: headers('secret') }
    );
    const second = await secondResponse.json();
    assert.equal(second.data.length, 1);
    assert.equal(second.hasMore, false);
    assert.equal(second.nextCursor, null);

    const ids = [...first.data, ...second.data].map((item) => item.id);
    assert.equal(new Set(ids).size, 3);
  });
});
