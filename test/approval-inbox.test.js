import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  createApprovalAssignment,
  createApproverIdentity,
  decideAssignedApproval,
  reassignApproval
} from '../src/application/approval-operations.js';
import {
  getApprovalInboxItem,
  listApprovalInbox
} from '../src/application/approval-inbox.js';
import { createApiHealth } from '../src/application/api-health.js';
import { createApiCredentialRecord } from '../src/auth/api-credentials.js';
import { API_SCOPES, createStaticApiKeyAuthenticator } from '../src/auth/authentication.js';
import { createApprovalRequest, decideApproval } from '../src/domain/approvals.js';
import { createServerHandler } from '../src/http/server-handler.js';
import { MemoryStore } from '../src/store/memory-store.js';

const ownership = { tenantId: 'ten_approval_inbox', environment: 'test' };
const setupNow = new Date('2020-01-01T00:00:00.000Z');

function credential(id, secret, scopes = ['*']) {
  return createApiCredentialRecord({
    id,
    ...ownership,
    name: id,
    scopes
  }, secret, setupNow);
}

function authentication(credentialId, scopes = ['*']) {
  return Object.freeze({ ...ownership, credentialId, scopes: Object.freeze([...scopes]) });
}

async function createIdentity(store, approverName, credentialId) {
  return store.transaction((view) => createApproverIdentity({
    view,
    ownership,
    authentication: authentication('key_admin'),
    input: { displayName: approverName, credentialId },
    now: setupNow
  }));
}

async function createAssignedApproval(store, {
  approverId,
  requestedAt,
  expiresAt = '2030-01-01T00:00:00.000Z',
  action = 'repository.write'
}) {
  const approval = createApprovalRequest({
    mandateId: `mnd_${requestedAt.replaceAll(/[^0-9]/g, '').slice(-12)}`,
    agentId: 'agent_coder',
    action,
    resource: 'github:owner/repo',
    summary: `Approve ${action}`,
    expiresAt
  }, new Date(requestedAt));
  await store.save('approvals', ownership, approval);
  const assignment = await store.transaction((view) => createApprovalAssignment({
    view,
    ownership,
    approvalId: approval.id,
    assignment: { type: 'APPROVER', id: approverId },
    authentication: authentication('key_admin'),
    now: new Date(requestedAt)
  }));
  return { approval, assignment };
}

async function startInboxServer(store, { apiKey, credentialId, scopes }) {
  const runtime = {
    store,
    signer: {},
    signingKeys: {},
    health: createApiHealth({ mode: 'memory' }),
    authenticator: createStaticApiKeyAuthenticator({
      apiKey,
      ...ownership,
      credentialId,
      scopes
    })
  };
  const server = createServer(createServerHandler(runtime));
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

async function getJson(baseUrl, path, apiKey) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { 'x-api-key': apiKey }
  });
  return { response, body: await response.json() };
}

test('production approval inbox is current-approver scoped, paginated and requires its dedicated scope', async () => {
  const store = new MemoryStore(ownership);
  const aliceSecret = 'alice-inbox-secret-123456789';
  const bobSecret = 'bob-inbox-secret-12345678901';
  const adminSecret = 'admin-inbox-secret-123456789';
  await store.save('apiCredentials', ownership, credential('key_alice', aliceSecret, [API_SCOPES.APPROVAL_INBOX_READ]));
  await store.save('apiCredentials', ownership, credential('key_bob', bobSecret, [API_SCOPES.APPROVAL_INBOX_READ]));
  await store.save('apiCredentials', ownership, credential('key_admin', adminSecret));

  const alice = await createIdentity(store, 'Alice', 'key_alice');
  const bob = await createIdentity(store, 'Bob', 'key_bob');
  const first = await createAssignedApproval(store, {
    approverId: alice.id,
    requestedAt: '2020-01-01T00:01:00.000Z'
  });
  const second = await createAssignedApproval(store, {
    approverId: alice.id,
    requestedAt: '2020-01-01T00:02:00.000Z',
    action: 'pull_request.merge'
  });
  const bobOnly = await createAssignedApproval(store, {
    approverId: bob.id,
    requestedAt: '2020-01-01T00:03:00.000Z'
  });

  const server = await startInboxServer(store, {
    apiKey: aliceSecret,
    credentialId: 'key_alice',
    scopes: [API_SCOPES.APPROVAL_INBOX_READ]
  });
  try {
    const pageOne = await getJson(server.baseUrl, '/v1/approval-inbox?limit=1', aliceSecret);
    assert.equal(pageOne.response.status, 200);
    assert.equal(pageOne.body.state, 'ACTIONABLE');
    assert.equal(pageOne.body.data.length, 1);
    assert.equal(pageOne.body.data[0].id, first.approval.id);
    assert.equal(pageOne.body.data[0].approver.id, alice.id);
    assert.equal(pageOne.body.data[0].assignment.sourceId, alice.id);
    assert.equal(pageOne.body.hasMore, true);
    assert.equal(typeof pageOne.body.nextCursor, 'string');

    const pageTwo = await getJson(
      server.baseUrl,
      `/v1/approval-inbox?limit=1&startingAfter=${encodeURIComponent(pageOne.body.nextCursor)}`,
      aliceSecret
    );
    assert.equal(pageTwo.response.status, 200);
    assert.deepEqual(pageTwo.body.data.map((item) => item.id), [second.approval.id]);
    assert.equal(pageTwo.body.hasMore, false);
    assert.equal(pageTwo.body.nextCursor, null);

    const visible = await getJson(server.baseUrl, `/v1/approval-inbox/${first.approval.id}`, aliceSecret);
    assert.equal(visible.response.status, 200);
    assert.equal(visible.body.id, first.approval.id);

    const hidden = await getJson(server.baseUrl, `/v1/approval-inbox/${bobOnly.approval.id}`, aliceSecret);
    assert.equal(hidden.response.status, 404);
    assert.equal(hidden.body.error.code, 'APPROVAL_INBOX_ITEM_NOT_FOUND');
  } finally {
    await server.close();
  }

  const insufficient = await startInboxServer(store, {
    apiKey: aliceSecret,
    credentialId: 'key_alice',
    scopes: [API_SCOPES.APPROVALS_READ]
  });
  try {
    const denied = await getJson(insufficient.baseUrl, '/v1/approval-inbox', aliceSecret);
    assert.equal(denied.response.status, 403);
    assert.equal(denied.body.error.code, 'MISSING_SCOPE');
    assert.equal(denied.body.error.details.requiredScope, API_SCOPES.APPROVAL_INBOX_READ);
  } finally {
    await insufficient.close();
  }
});

test('overdue pending approvals are inspectable but never reported as actionable', async () => {
  const store = new MemoryStore(ownership);
  const aliceSecret = 'alice-overdue-secret-123456789';
  await store.save('apiCredentials', ownership, credential('key_alice', aliceSecret, [API_SCOPES.APPROVAL_INBOX_READ]));
  await store.save('apiCredentials', ownership, credential('key_admin', 'admin-overdue-secret-123456789'));
  const alice = await createIdentity(store, 'Alice overdue', 'key_alice');
  const overdue = await createAssignedApproval(store, {
    approverId: alice.id,
    requestedAt: '2020-01-01T00:00:00.000Z',
    expiresAt: '2020-01-02T00:00:00.000Z'
  });

  const server = await startInboxServer(store, {
    apiKey: aliceSecret,
    credentialId: 'key_alice',
    scopes: [API_SCOPES.APPROVAL_INBOX_READ]
  });
  try {
    const actionable = await getJson(server.baseUrl, '/v1/approval-inbox', aliceSecret);
    assert.equal(actionable.response.status, 200);
    assert.deepEqual(actionable.body.data, []);

    const pending = await getJson(server.baseUrl, '/v1/approval-inbox?state=PENDING', aliceSecret);
    assert.equal(pending.response.status, 200);
    assert.equal(pending.body.state, 'PENDING');
    assert.equal(pending.body.data.length, 1);
    assert.equal(pending.body.data[0].id, overdue.approval.id);
    assert.equal(pending.body.data[0].overdue, true);
    assert.equal(pending.body.data[0].actionable, false);

    const item = await getJson(server.baseUrl, `/v1/approval-inbox/${overdue.approval.id}`, aliceSecret);
    assert.equal(item.response.status, 200);
    assert.equal(item.body.overdue, true);
    assert.equal(item.body.actionable, false);

    const invalid = await getJson(server.baseUrl, '/v1/approval-inbox?state=APPROVED', aliceSecret);
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID_INBOX_STATE');
  } finally {
    await server.close();
  }
});

test('reassignment moves inbox authority and terminal decisions disappear from the inbox', async () => {
  const store = new MemoryStore(ownership);
  await store.save('apiCredentials', ownership, credential('key_admin', 'admin-reassign-secret-123456789'));
  await store.save('apiCredentials', ownership, credential('key_alice', 'alice-reassign-secret-123456789'));
  await store.save('apiCredentials', ownership, credential('key_bob', 'bob-reassign-secret-12345678901'));
  const alice = await createIdentity(store, 'Alice reassign', 'key_alice');
  const bob = await createIdentity(store, 'Bob reassign', 'key_bob');
  const seeded = await createAssignedApproval(store, {
    approverId: alice.id,
    requestedAt: '2020-01-01T00:04:00.000Z'
  });

  assert.equal((await listApprovalInbox({
    view: store,
    ownership,
    authentication: authentication('key_alice'),
    now: new Date('2020-01-01T00:05:00.000Z')
  })).length, 1);

  await store.transaction(async (view) => {
    const approval = await view.get('approvals', ownership, seeded.approval.id);
    await reassignApproval({
      view,
      ownership,
      approval,
      input: { assignment: { type: 'APPROVER', id: bob.id }, reason: 'Shift coverage' },
      authentication: authentication('key_admin'),
      now: new Date('2020-01-01T00:06:00.000Z')
    });
  });

  assert.equal((await listApprovalInbox({
    view: store,
    ownership,
    authentication: authentication('key_alice'),
    now: new Date('2020-01-01T00:07:00.000Z')
  })).length, 0);
  assert.equal((await listApprovalInbox({
    view: store,
    ownership,
    authentication: authentication('key_bob'),
    now: new Date('2020-01-01T00:07:00.000Z')
  })).length, 1);

  await store.transaction(async (view) => {
    const approval = await view.get('approvals', ownership, seeded.approval.id);
    await decideAssignedApproval({
      view,
      ownership,
      approval,
      input: { decision: 'APPROVED', reason: 'Reviewed' },
      authentication: authentication('key_bob'),
      decide: decideApproval,
      now: new Date('2020-01-01T00:08:00.000Z')
    });
  });

  assert.equal((await listApprovalInbox({
    view: store,
    ownership,
    authentication: authentication('key_bob'),
    state: 'PENDING',
    now: new Date('2020-01-01T00:09:00.000Z')
  })).length, 0);
  await assert.rejects(
    getApprovalInboxItem({
      view: store,
      ownership,
      authentication: authentication('key_bob'),
      approvalId: seeded.approval.id,
      now: new Date('2020-01-01T00:09:00.000Z')
    }),
    (error) => error?.code === 'APPROVAL_INBOX_ITEM_NOT_FOUND'
  );
});

test('an unbound credential cannot inspect approval inbox authority', async () => {
  const store = new MemoryStore(ownership);
  await store.save('apiCredentials', ownership, credential('key_unbound', 'unbound-secret-123456789'));
  await assert.rejects(
    listApprovalInbox({
      view: store,
      ownership,
      authentication: authentication('key_unbound'),
      now: setupNow
    }),
    (error) => error?.code === 'APPROVER_IDENTITY_REQUIRED' && error?.status === 403
  );
});
