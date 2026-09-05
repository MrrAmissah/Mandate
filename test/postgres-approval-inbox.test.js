import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createApprovalAssignment,
  createApproverIdentity,
  reassignApproval
} from '../src/application/approval-operations.js';
import {
  getApprovalInboxItem,
  listApprovalInbox
} from '../src/application/approval-inbox.js';
import { createApiCredentialRecord } from '../src/auth/api-credentials.js';
import { createApprovalRequest } from '../src/domain/approvals.js';
import { pageWindow, parsePageRequest } from '../src/http/pagination.js';
import { createPostgresPool, PostgresStore } from '../src/store/postgres-store.js';

const connectionString = process.env.DATABASE_URL;
const integration = connectionString ? test : test.skip;

function opaque(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function credential(id, tenantId, secret) {
  return createApiCredentialRecord({
    id,
    tenantId,
    environment: 'test',
    name: id,
    scopes: ['approval_inbox:read']
  }, secret, new Date());
}

function auth(tenantId, credentialId) {
  return Object.freeze({
    tenantId,
    environment: 'test',
    credentialId,
    scopes: Object.freeze(['approval_inbox:read'])
  });
}

integration('PostgreSQL approval inbox enforces active assignment authority, keyset paging and indexed access', async () => {
  const tenantId = opaque('ten_inbox_pg');
  const ownership = { tenantId, environment: 'test' };
  const aliceCredentialId = opaque('key_alice');
  const bobCredentialId = opaque('key_bob');
  const adminCredentialId = opaque('key_admin');
  const aliceCredential = credential(aliceCredentialId, tenantId, `alice-${randomUUID()}`);
  const bobCredential = credential(bobCredentialId, tenantId, `bob-${randomUUID()}`);
  const adminCredential = credential(adminCredentialId, tenantId, `admin-${randomUUID()}`);
  const pool = await createPostgresPool({ connectionString, max: 6 });
  const store = new PostgresStore(pool, { maximumTransactionAttempts: 4 });
  const baseNow = new Date();
  const expiry = new Date(baseNow.getTime() + 60 * 60 * 1000).toISOString();

  try {
    await store.ensureBootstrap({
      tenantId,
      tenantName: 'Approval inbox PostgreSQL tenant',
      environment: 'test',
      credential: aliceCredential
    });
    await store.save('apiCredentials', ownership, bobCredential);
    await store.save('apiCredentials', ownership, adminCredential);

    const { alice, bob } = await store.transaction(async (view) => ({
      alice: await createApproverIdentity({
        view,
        ownership,
        authentication: auth(tenantId, adminCredentialId),
        input: { displayName: 'Alice', credentialId: aliceCredentialId },
        now: baseNow
      }),
      bob: await createApproverIdentity({
        view,
        ownership,
        authentication: auth(tenantId, adminCredentialId),
        input: { displayName: 'Bob', credentialId: bobCredentialId },
        now: baseNow
      })
    }));

    async function assigned(approverId, offsetMs, action) {
      const requestedAt = new Date(baseNow.getTime() + offsetMs);
      const approval = createApprovalRequest({
        mandateId: opaque('mnd_inbox'),
        agentId: 'agent_coder',
        action,
        resource: 'github:owner/repo',
        summary: `Approve ${action}`,
        expiresAt: expiry
      }, requestedAt);
      await store.save('approvals', ownership, approval);
      const assignment = await store.transaction((view) => createApprovalAssignment({
        view,
        ownership,
        approvalId: approval.id,
        assignment: { type: 'APPROVER', id: approverId },
        authentication: auth(tenantId, adminCredentialId),
        now: requestedAt
      }));
      return { approval, assignment };
    }

    const first = await assigned(alice.id, 10, 'repository.write');
    const second = await assigned(alice.id, 20, 'pull_request.merge');
    const bobOnly = await assigned(bob.id, 30, 'deployment.promote');

    const firstWindow = await listApprovalInbox({
      view: store,
      ownership,
      authentication: auth(tenantId, aliceCredentialId),
      limit: 1
    });
    assert.equal(firstWindow.length, 2);
    const firstPage = pageWindow(firstWindow, { limit: 1, timestampField: 'requestedAt' });
    assert.deepEqual(firstPage.data.map((item) => item.id), [first.approval.id]);
    assert.equal(firstPage.hasMore, true);
    assert.equal(typeof firstPage.nextCursor, 'string');

    const parsed = parsePageRequest(new URL(
      `http://localhost/v1/approval-inbox?limit=1&startingAfter=${encodeURIComponent(firstPage.nextCursor)}`
    ));
    const secondWindow = await listApprovalInbox({
      view: store,
      ownership,
      authentication: auth(tenantId, aliceCredentialId),
      limit: parsed.limit,
      cursor: parsed.cursor
    });
    assert.deepEqual(secondWindow.map((item) => item.id), [second.approval.id]);

    await assert.rejects(
      getApprovalInboxItem({
        view: store,
        ownership,
        authentication: auth(tenantId, aliceCredentialId),
        approvalId: bobOnly.approval.id
      }),
      (error) => error?.code === 'APPROVAL_INBOX_ITEM_NOT_FOUND' && error?.status === 404
    );

    await store.transaction(async (view) => {
      const approval = await view.get('approvals', ownership, first.approval.id);
      await reassignApproval({
        view,
        ownership,
        approval,
        input: {
          assignment: { type: 'APPROVER', id: bob.id },
          reason: 'Move to current on-call approver'
        },
        authentication: auth(tenantId, adminCredentialId),
        now: new Date(baseNow.getTime() + 40)
      });
    });

    const aliceAfter = await listApprovalInbox({
      view: store,
      ownership,
      authentication: auth(tenantId, aliceCredentialId),
      state: 'PENDING'
    });
    assert.equal(aliceAfter.some((item) => item.id === first.approval.id), false);
    assert.equal(aliceAfter.some((item) => item.id === second.approval.id), true);

    const bobAfter = await listApprovalInbox({
      view: store,
      ownership,
      authentication: auth(tenantId, bobCredentialId),
      state: 'PENDING'
    });
    assert.equal(bobAfter.some((item) => item.id === first.approval.id), true);
    assert.equal(bobAfter.some((item) => item.id === bobOnly.approval.id), true);

    const indexes = await pool.query(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname='mandate'
          AND indexname = ANY($1::text[])
        ORDER BY indexname`,
      [[
        'approval_assignment_eligibility_inbox_idx',
        'approvals_pending_inbox_order_idx'
      ]]
    );
    assert.deepEqual(indexes.rows.map((row) => row.indexname), [
      'approval_assignment_eligibility_inbox_idx',
      'approvals_pending_inbox_order_idx'
    ]);
  } finally {
    await store.close();
  }
});
