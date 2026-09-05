import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  addApproverGroupMember,
  createApprovalAssignment,
  createApproverGroup,
  createApproverIdentity,
  decideAssignedApproval,
  disableApproverIdentity,
  getActiveApprovalAssignment
} from '../src/application/approval-operations.js';
import { createApiCredentialRecord } from '../src/auth/api-credentials.js';
import { API_SCOPES, createStaticApiKeyAuthenticator } from '../src/auth/authentication.js';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import { createApprovalRequest, decideApproval } from '../src/domain/approvals.js';
import { createMandate } from '../src/domain/mandates.js';
import { createRuntimeHandler } from '../src/http/runtime-handler.js';
import { MemoryStore } from '../src/store/memory-store.js';

const ownership = { tenantId: 'ten_approval_assignments', environment: 'test' };
const fixedNow = new Date('2026-09-05T20:00:00.000Z');

function credential(id, secret, scopes = ['*']) {
  return createApiCredentialRecord({
    id,
    ...ownership,
    name: id,
    scopes
  }, secret, fixedNow);
}

function authentication(credentialId, scopes = ['*']) {
  return Object.freeze({ ...ownership, credentialId, scopes: Object.freeze([...scopes]) });
}

async function transaction(store, work) {
  return store.transaction((view) => work(view));
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

async function post(baseUrl, path, apiKey, body, idempotencyKey) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
    },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

test('runtime approval decisions derive approver identity from authentication, not caller text', async () => {
  const apiKey = 'approval-runtime-secret-123456789';
  const credentialId = 'key_approval_runtime';
  const scopes = [
    API_SCOPES.APPROVALS_READ,
    API_SCOPES.APPROVALS_WRITE,
    API_SCOPES.APPROVALS_DECIDE,
    API_SCOPES.APPROVERS_READ,
    API_SCOPES.APPROVERS_WRITE
  ];
  const store = new MemoryStore(ownership);
  store.save('apiCredentials', ownership, credential(credentialId, apiKey, scopes));
  const mandate = createMandate({
    principalId: 'principal_owner',
    agentId: 'agent_coder',
    purpose: 'Merge an approved change',
    resources: ['github:owner/repo'],
    allowedActions: ['pull_request.merge'],
    approvalRequiredActions: ['pull_request.merge'],
    validUntil: '2027-01-01T00:00:00.000Z'
  }, fixedNow);
  store.save('mandates', ownership, mandate);

  const signer = createReceiptSigner({ keyId: 'key_approval_runtime_signer' });
  const runtime = {
    store,
    signer,
    signingKeys: {},
    authenticator: createStaticApiKeyAuthenticator({
      apiKey,
      ...ownership,
      credentialId,
      scopes
    })
  };
  const server = await startServer(runtime);
  try {
    const identityResult = await post(server.baseUrl, '/v1/approver-identities', apiKey, {
      displayName: 'Release approver',
      bindCurrentCredential: true
    }, 'create-identity');
    assert.equal(identityResult.response.status, 201);
    const approver = identityResult.body;
    assert.match(approver.id, /^apv_/);
    assert.equal(approver.binding.credentialId, credentialId);

    const approvalResult = await post(server.baseUrl, '/v1/approvals', apiKey, {
      mandateId: mandate.id,
      agentId: mandate.agentId,
      action: 'pull_request.merge',
      resource: 'github:owner/repo',
      summary: 'Approve merge after review',
      expiresAt: '2026-12-31T21:00:00.000Z',
      assignment: { type: 'APPROVER', id: approver.id }
    }, 'create-assigned-approval');
    assert.equal(approvalResult.response.status, 201);
    assert.deepEqual(approvalResult.body.assignment.eligibleApproverIds, [approver.id]);

    const spoofed = await post(
      server.baseUrl,
      `/v1/approvals/${approvalResult.body.id}/decide`,
      apiKey,
      { decision: 'APPROVED', decidedBy: 'principal_spoofed' },
      'spoofed-decision'
    );
    assert.equal(spoofed.response.status, 400);
    assert.equal(spoofed.body.error.code, 'INVALID_REQUEST');

    const decided = await post(
      server.baseUrl,
      `/v1/approvals/${approvalResult.body.id}/decide`,
      apiKey,
      { decision: 'APPROVED', reason: 'Reviewed' },
      'real-decision'
    );
    assert.equal(decided.response.status, 200);
    assert.equal(decided.body.status, 'APPROVED');
    assert.equal(decided.body.decidedBy, approver.id);
    assert.equal(decided.body.decidedByApproverId, approver.id);

    const decisionAudit = store.list('auditEvents', ownership)
      .find((event) => event.type === 'approval.decided');
    assert.equal(decisionAudit.actorType, 'APPROVER');
    assert.equal(decisionAudit.actorId, approver.id);
    assert.equal(decisionAudit.data.credentialId, credentialId);
    assert.equal(decisionAudit.data.assignmentId, approvalResult.body.assignment.id);
  } finally {
    await server.close();
  }
});

test('group assignment snapshots eligibility and later membership does not expand pending authority', async () => {
  const store = new MemoryStore(ownership);
  const credentials = [
    ['key_alice', 'alice-secret-123456789'],
    ['key_bob', 'bob-secret-12345678900'],
    ['key_charlie', 'charlie-secret-1234567']
  ];
  for (const [id, secret] of credentials) store.save('apiCredentials', ownership, credential(id, secret));

  const identities = {};
  for (const [name, [credentialId]] of Object.entries({
    alice: credentials[0], bob: credentials[1], charlie: credentials[2]
  })) {
    identities[name] = await transaction(store, (view) => createApproverIdentity({
      view,
      ownership,
      authentication: authentication('key_admin'),
      input: { displayName: name, credentialId },
      now: fixedNow
    }));
  }

  const group = await transaction(store, (view) => createApproverGroup({
    view, ownership, input: { name: 'Release managers' }, now: fixedNow
  }));
  await transaction(store, (view) => addApproverGroupMember({
    view, ownership, groupId: group.id, approverId: identities.alice.id, now: fixedNow
  }));
  await transaction(store, (view) => addApproverGroupMember({
    view, ownership, groupId: group.id, approverId: identities.bob.id, now: fixedNow
  }));

  const approval = createApprovalRequest({
    mandateId: 'mnd_group_snapshot',
    agentId: 'agent_coder',
    action: 'repository.write',
    resource: 'github:owner/repo',
    summary: 'Approve repository write',
    expiresAt: '2026-09-05T22:00:00.000Z'
  }, fixedNow);
  store.save('approvals', ownership, approval);

  const assigned = await transaction(store, (view) => createApprovalAssignment({
    view,
    ownership,
    approvalId: approval.id,
    assignment: { type: 'GROUP', id: group.id },
    authentication: authentication('key_admin'),
    now: fixedNow
  }));
  assert.deepEqual(assigned.eligibleApproverIds, [identities.alice.id, identities.bob.id].sort());

  await transaction(store, (view) => addApproverGroupMember({
    view, ownership, groupId: group.id, approverId: identities.charlie.id,
    now: new Date('2026-09-05T20:05:00.000Z')
  }));
  const stillAssigned = await getActiveApprovalAssignment(store, ownership, approval.id);
  assert.equal(stillAssigned.eligibleApproverIds.includes(identities.charlie.id), false);

  await assert.rejects(
    transaction(store, (view) => decideAssignedApproval({
      view,
      ownership,
      approval: view.get('approvals', ownership, approval.id),
      input: { decision: 'APPROVED' },
      authentication: authentication('key_charlie'),
      decide: decideApproval,
      now: new Date('2026-09-05T20:06:00.000Z')
    })),
    (error) => error?.code === 'APPROVER_NOT_ELIGIBLE'
  );

  const decided = await transaction(store, (view) => decideAssignedApproval({
    view,
    ownership,
    approval: view.get('approvals', ownership, approval.id),
    input: { decision: 'APPROVED' },
    authentication: authentication('key_bob'),
    decide: decideApproval,
    now: new Date('2026-09-05T20:07:00.000Z')
  }));
  assert.equal(decided.approval.decidedByApproverId, identities.bob.id);
});

test('disabling a snapshotted approver immediately removes live decision authority', async () => {
  const store = new MemoryStore(ownership);
  store.save('apiCredentials', ownership, credential('key_disable_target', 'disable-secret-12345678'));
  const approver = await transaction(store, (view) => createApproverIdentity({
    view,
    ownership,
    authentication: authentication('key_admin'),
    input: { displayName: 'Temporary approver', credentialId: 'key_disable_target' },
    now: fixedNow
  }));
  const approval = createApprovalRequest({
    mandateId: 'mnd_disable',
    agentId: 'agent_coder',
    action: 'repository.write',
    resource: 'github:owner/repo',
    summary: 'Approval will be revoked',
    expiresAt: '2026-09-05T22:00:00.000Z'
  }, fixedNow);
  store.save('approvals', ownership, approval);
  await transaction(store, (view) => createApprovalAssignment({
    view,
    ownership,
    approvalId: approval.id,
    assignment: { type: 'APPROVER', id: approver.id },
    authentication: authentication('key_admin'),
    now: fixedNow
  }));
  await transaction(store, (view) => disableApproverIdentity({
    view,
    ownership,
    approverId: approver.id,
    reason: 'Access removed',
    now: new Date('2026-09-05T20:01:00.000Z')
  }));

  await assert.rejects(
    transaction(store, (view) => decideAssignedApproval({
      view,
      ownership,
      approval: view.get('approvals', ownership, approval.id),
      input: { decision: 'APPROVED' },
      authentication: authentication('key_disable_target'),
      decide: decideApproval,
      now: new Date('2026-09-05T20:02:00.000Z')
    })),
    (error) => error?.code === 'APPROVER_IDENTITY_REQUIRED'
  );
});
