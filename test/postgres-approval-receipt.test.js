import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import {
  createApprovalAssignment,
  createApproverIdentity,
  decideAssignedApproval
} from '../src/application/approval-operations.js';
import {
  assertCredentialUsable,
  createApiCredentialRecord,
  hashApiKey,
  verifyApiKey
} from '../src/auth/api-credentials.js';
import { createStoredApiKeyAuthenticator } from '../src/auth/authentication.js';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import { decideApproval } from '../src/domain/approvals.js';
import { createPostgresPool, PostgresStore } from '../src/store/postgres-store.js';

const connectionString = process.env.DATABASE_URL;
const integration = connectionString ? test : test.skip;
const fixedNow = new Date('2026-07-29T06:00:00.000Z');
const signer = createReceiptSigner({ keyId: 'postgres-lifecycle-ed25519' });

function unique(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

async function createStore() {
  return new PostgresStore(await createPostgresPool({ connectionString, max: 6 }));
}

async function withServer(store, run) {
  const authenticator = createStoredApiKeyAuthenticator({
    store,
    hashApiKey,
    verifyApiKey,
    assertCredentialUsable,
    now: () => fixedNow
  });
  const server = createServer(createApp({ store, signer, authenticator, now: () => fixedNow }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function headers(secret) {
  return { 'content-type': 'application/json', 'x-api-key': secret };
}

async function post(baseUrl, path, secret, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: headers(secret),
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

integration('consumed approvals and signed receipts survive PostgreSQL restart', async () => {
  const tenantId = unique('ten_lifecycle');
  const ownership = { tenantId, environment: 'test' };
  const credentialId = unique('key_lifecycle');
  const secret = `lifecycle-secret-${randomUUID()}`;
  const credential = createApiCredentialRecord({
    id: credentialId,
    ...ownership,
    name: 'Lifecycle integration credential',
    scopes: ['*']
  }, secret, fixedNow);
  const authentication = { ...ownership, credentialId, scopes: ['*'] };
  let approvalId;
  let receiptId;
  let approverId;

  const firstStore = await createStore();
  try {
    await firstStore.ensureBootstrap({ tenantId, tenantName: 'Lifecycle tenant', environment: 'test', credential });
    await withServer(firstStore, async (baseUrl) => {
      const mandate = await post(baseUrl, '/v1/mandates', secret, {
        principalId: 'principal_owner',
        agentId: 'agent_coder',
        purpose: 'Commit reviewed code',
        resources: ['github:owner/repository'],
        allowedActions: ['commit.create'],
        approvalRequiredActions: ['commit.create']
      });
      assert.equal(mandate.response.status, 201);

      const requested = await post(baseUrl, '/v1/approvals', secret, {
        mandateId: mandate.body.id,
        agentId: 'agent_coder',
        action: 'commit.create',
        resource: 'github:owner/repository',
        summary: 'Approve one reviewed commit',
        expiresAt: '2026-07-29T07:00:00.000Z'
      });
      assert.equal(requested.response.status, 201);
      approvalId = requested.body.id;

      const decided = await firstStore.transaction(async (transaction) => {
        const approver = await createApproverIdentity({
          view: transaction,
          ownership,
          authentication,
          input: { displayName: 'Lifecycle approver', credentialId },
          now: fixedNow
        });
        approverId = approver.id;
        await createApprovalAssignment({
          view: transaction,
          ownership,
          approvalId,
          assignment: { type: 'APPROVER', id: approver.id },
          authentication,
          now: fixedNow
        });
        const approval = await transaction.get('approvals', ownership, approvalId);
        return decideAssignedApproval({
          view: transaction,
          ownership,
          approval,
          input: { decision: 'APPROVED' },
          authentication,
          decide: decideApproval,
          now: fixedNow
        });
      });
      assert.equal(decided.approval.status, 'APPROVED');
      assert.equal(decided.approval.decidedByApproverId, approverId);

      const authorized = await post(baseUrl, '/v1/authorize', secret, {
        mandateId: mandate.body.id,
        agentId: 'agent_coder',
        action: 'commit.create',
        resource: 'github:owner/repository',
        approvalId
      });
      assert.equal(authorized.response.status, 200);
      assert.equal(authorized.body.outcome, 'ALLOW');

      const hash = `sha256:${'a'.repeat(64)}`;
      const issued = await post(baseUrl, '/v1/receipts', secret, {
        decisionId: authorized.body.id,
        executionStatus: 'SUCCEEDED',
        inputHash: hash,
        outputHash: hash,
        tool: 'github.commit.create',
        provider: 'github'
      });
      assert.equal(issued.response.status, 201);
      receiptId = issued.body.id;

      const verified = await post(baseUrl, '/v1/receipts/verify', secret, { receipt: issued.body });
      assert.equal(verified.response.status, 200);
      assert.equal(verified.body.valid, true);
    });
  } finally {
    await firstStore.close();
  }

  const restartedStore = await createStore();
  try {
    await withServer(restartedStore, async (baseUrl) => {
      const approvalResponse = await fetch(`${baseUrl}/v1/approvals/${approvalId}`, { headers: headers(secret) });
      assert.equal(approvalResponse.status, 200);
      const approval = await approvalResponse.json();
      assert.equal(approval.status, 'CONSUMED');
      assert.ok(approval.consumedByDecisionId);
      const persistedActor = await restartedStore.pool.query(
        `SELECT decided_by_approver_id
         FROM mandate.approvals
         WHERE tenant_id=$1 AND environment='test' AND id=$2`,
        [tenantId, approvalId]
      );
      assert.equal(persistedActor.rows[0].decided_by_approver_id, approverId);

      const receiptResponse = await fetch(`${baseUrl}/v1/receipts/${receiptId}`, { headers: headers(secret) });
      assert.equal(receiptResponse.status, 200);
      const receipt = await receiptResponse.json();
      assert.equal(receipt.executionStatus, 'SUCCEEDED');

      const verified = await post(baseUrl, '/v1/receipts/verify', secret, { receipt });
      assert.equal(verified.response.status, 200);
      assert.equal(verified.body.valid, true);
    });
  } finally {
    await restartedStore.close();
  }
});
