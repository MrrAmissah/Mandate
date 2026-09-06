import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ApprovalExpiryWorker } from '../src/application/approval-expiry-worker.js';
import {
  cancelApprovalOperation,
  createApprovalAssignment,
  createApproverIdentity,
  decideAssignedApproval,
  getActiveApprovalAssignment,
  reassignApproval
} from '../src/application/approval-operations.js';
import { recordSecurityEvent } from '../src/application/security-events.js';
import { createApiCredentialRecord } from '../src/auth/api-credentials.js';
import { consumeApproval, createApprovalRequest, decideApproval } from '../src/domain/approvals.js';
import { createMandate } from '../src/domain/mandates.js';
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
    scopes: ['approvals:write', 'approvals:decide']
  }, secret, new Date());
}

function auth(tenantId, credentialId) {
  return Object.freeze({
    tenantId,
    environment: 'test',
    credentialId,
    scopes: Object.freeze(['approvals:write', 'approvals:decide'])
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

integration('PostgreSQL approval expiry uses database time, one-winner claims and immutable system evidence', async () => {
  const tenantId = opaque('ten_approval_expiry_pg');
  const ownership = { tenantId, environment: 'test' };
  const adminCredentialId = opaque('key_admin');
  const approverCredentialId = opaque('key_approver');
  const adminCredential = credential(adminCredentialId, tenantId, `admin-${randomUUID()}`);
  const approverCredential = credential(approverCredentialId, tenantId, `approver-${randomUUID()}`);
  const pool = await createPostgresPool({ connectionString, max: 8 });
  const store = new PostgresStore(pool, { maximumTransactionAttempts: 4 });

  try {
    await store.ensureBootstrap({
      tenantId,
      tenantName: 'Approval expiry PostgreSQL tenant',
      environment: 'test',
      credential: adminCredential
    });
    await store.save('apiCredentials', ownership, approverCredential);

    const baseNow = new Date();
    const mandate = createMandate({
      principalId: 'principal_owner',
      agentId: 'agent_expiry',
      purpose: 'Exercise approval deadline precedence',
      resources: ['payguard:deal/*'],
      allowedActions: ['payment.release'],
      approvalRequiredActions: ['payment.release'],
      validUntil: new Date(baseNow.getTime() + 60 * 60 * 1000).toISOString()
    }, baseNow);
    await store.save('mandates', ownership, mandate);

    const approver = await store.transaction((view) => createApproverIdentity({
      view,
      ownership,
      authentication: auth(tenantId, adminCredentialId),
      input: { displayName: 'Expiry approver', credentialId: approverCredentialId },
      now: baseNow
    }));

    async function assignedApproval({ expiresInMs, suffix }) {
      const requestedAt = new Date();
      const expiresAt = new Date(requestedAt.getTime() + expiresInMs).toISOString();
      const approval = createApprovalRequest({
        mandateId: mandate.id,
        agentId: mandate.agentId,
        action: 'payment.release',
        resource: `payguard:deal/${suffix}`,
        summary: `Approve release ${suffix}`,
        expiresAt
      }, requestedAt);
      await store.save('approvals', ownership, approval);
      const assignment = await store.transaction((view) => createApprovalAssignment({
        view,
        ownership,
        approvalId: approval.id,
        assignment: { type: 'APPROVER', id: approver.id },
        authentication: auth(tenantId, adminCredentialId),
        now: requestedAt
      }));
      return { approval, assignment, requestedAt };
    }

    const concurrent = await assignedApproval({ expiresInMs: 500, suffix: 'concurrent' });
    await sleep(650);

    const workerA = new ApprovalExpiryWorker({
      store,
      workerId: 'approval-expiry-pg-a',
      scope: ownership
    });
    const workerB = new ApprovalExpiryWorker({
      store,
      workerId: 'approval-expiry-pg-b',
      scope: ownership
    });
    const winners = await Promise.all([workerA.pollOnce(), workerB.pollOnce()]);
    assert.deepEqual(winners.map((result) => result.status).sort(), ['EXPIRED', 'IDLE']);

    const persistedConcurrent = await store.get('approvals', ownership, concurrent.approval.id);
    assert.equal(persistedConcurrent.status, 'EXPIRED');
    assert.equal(persistedConcurrent.expirationReason, 'DEADLINE_ELAPSED');
    assert.match(persistedConcurrent.expirationRequestId, /^sys_approval_expiry_/);
    assert.ok(persistedConcurrent.expiredAt);
    assert.equal(await getActiveApprovalAssignment(store, ownership, concurrent.approval.id), null);

    const concurrentAssignments = await pool.query(
      `SELECT status, ended_at, end_reason
         FROM mandate.approval_assignments
        WHERE tenant_id=$1 AND environment=$2 AND approval_id=$3`,
      [tenantId, ownership.environment, concurrent.approval.id]
    );
    assert.deepEqual(concurrentAssignments.rows.map((row) => ({
      status: row.status,
      endReason: row.end_reason,
      ended: Boolean(row.ended_at)
    })), [{ status: 'EXPIRED', endReason: 'APPROVAL_EXPIRED', ended: true }]);

    const concurrentEvents = await pool.query(
      `SELECT actor_type, actor_id, request_id, data
         FROM mandate.audit_events
        WHERE tenant_id=$1 AND environment=$2 AND type='approval.expired' AND object_id=$3`,
      [tenantId, ownership.environment, concurrent.approval.id]
    );
    assert.equal(concurrentEvents.rowCount, 1);
    assert.equal(concurrentEvents.rows[0].actor_type, 'SYSTEM');
    assert.match(concurrentEvents.rows[0].actor_id, /^approval-expiry-pg-[ab]$/);
    assert.equal(concurrentEvents.rows[0].request_id, persistedConcurrent.expirationRequestId);
    assert.equal(concurrentEvents.rows[0].data.assignmentId, concurrent.assignment.id);
    assert.equal(concurrentEvents.rows[0].data.previousStatus, 'PENDING');

    const concurrentOutbox = await pool.query(
      `SELECT count(*)::integer AS count
         FROM mandate.outbox_messages
        WHERE tenant_id=$1 AND environment=$2 AND event_type='approval.expired' AND aggregate_id=$3`,
      [tenantId, ownership.environment, concurrent.approval.id]
    );
    assert.equal(concurrentOutbox.rows[0].count, 1);

    const approvedThenOverdue = await assignedApproval({ expiresInMs: 1000, suffix: 'approved-overdue' });
    await store.transaction(async (view) => {
      const approval = await view.get('approvals', ownership, approvedThenOverdue.approval.id);
      const decided = await decideAssignedApproval({
        view,
        ownership,
        approval,
        input: { decision: 'APPROVED', reason: 'Approved before deadline' },
        authentication: auth(tenantId, approverCredentialId),
        decide: decideApproval,
        now: new Date()
      });
      await recordSecurityEvent({
        transaction: view,
        ownership,
        authentication: auth(tenantId, approverCredentialId),
        actorType: 'APPROVER',
        actorId: decided.approver.id,
        requestId: opaque('req_decide_approved'),
        type: 'approval.decided',
        objectType: 'approval',
        objectId: approvedThenOverdue.approval.id,
        data: {
          decision: decided.approval.status,
          approverId: decided.approver.id,
          credentialId: approverCredentialId,
          assignmentId: decided.assignment.id
        },
        now: new Date(decided.approval.decidedAt)
      });
    });
    assert.equal((await store.get('approvals', ownership, approvedThenOverdue.approval.id)).status, 'APPROVED');
    await sleep(1100);

    await assert.rejects(
      store.transaction(async (view) => {
        const approval = await view.get('approvals', ownership, approvedThenOverdue.approval.id);
        await view.save(
          'approvals',
          ownership,
          consumeApproval(approval, opaque('dec_stale_consume'), approvedThenOverdue.requestedAt)
        );
      }),
      (error) => error?.code === 'APPROVAL_EXPIRED' && error?.status === 409
    );
    assert.equal((await store.get('approvals', ownership, approvedThenOverdue.approval.id)).status, 'APPROVED');

    const skewedDecision = await assignedApproval({ expiresInMs: 500, suffix: 'decision' });
    const skewedCancel = await assignedApproval({ expiresInMs: 500, suffix: 'cancel' });
    const skewedReassign = await assignedApproval({ expiresInMs: 500, suffix: 'reassign' });
    await sleep(650);

    const fakeBeforeDeadline = skewedDecision.requestedAt;
    await assert.rejects(
      store.transaction(async (view) => {
        const approval = await view.get('approvals', ownership, skewedDecision.approval.id);
        const decided = await decideAssignedApproval({
          view,
          ownership,
          approval,
          input: { decision: 'APPROVED', reason: 'Application clock is intentionally stale' },
          authentication: auth(tenantId, approverCredentialId),
          decide: decideApproval,
          now: fakeBeforeDeadline
        });
        await recordSecurityEvent({
          transaction: view,
          ownership,
          authentication: auth(tenantId, approverCredentialId),
          actorType: 'APPROVER',
          actorId: decided.approver.id,
          requestId: opaque('req_decide'),
          type: 'approval.decided',
          objectType: 'approval',
          objectId: skewedDecision.approval.id,
          data: {
            decision: decided.approval.status,
            approverId: decided.approver.id,
            credentialId: approverCredentialId,
            assignmentId: decided.assignment.id
          },
          now: fakeBeforeDeadline
        });
      }),
      (error) => error?.code === 'APPROVAL_EXPIRED' && error?.status === 409
    );

    await assert.rejects(
      store.transaction(async (view) => {
        const approval = await view.get('approvals', ownership, skewedCancel.approval.id);
        await cancelApprovalOperation({
          view,
          ownership,
          approval,
          input: { reason: 'Stale application clock cancellation' },
          authentication: auth(tenantId, adminCredentialId),
          now: skewedCancel.requestedAt
        });
      }),
      (error) => error?.code === 'APPROVAL_EXPIRED' && error?.status === 409
    );

    await assert.rejects(
      store.transaction(async (view) => {
        const approval = await view.get('approvals', ownership, skewedReassign.approval.id);
        await reassignApproval({
          view,
          ownership,
          approval,
          input: {
            assignment: { type: 'APPROVER', id: approver.id },
            reason: 'Stale application clock reassignment'
          },
          authentication: auth(tenantId, adminCredentialId),
          now: skewedReassign.requestedAt
        });
      }),
      (error) => error?.code === 'APPROVAL_EXPIRED' && error?.status === 409
    );

    for (const item of [skewedDecision, skewedCancel, skewedReassign]) {
      assert.equal((await store.get('approvals', ownership, item.approval.id)).status, 'PENDING');
      assert.equal((await getActiveApprovalAssignment(store, ownership, item.approval.id)).id, item.assignment.id);
    }

    const drained = await workerA.drain({ limit: 10 });
    assert.equal(drained.expired.length, 4);
    assert.deepEqual(
      drained.expired.map((approval) => approval.id).sort(),
      [
        approvedThenOverdue.approval.id,
        skewedDecision.approval.id,
        skewedCancel.approval.id,
        skewedReassign.approval.id
      ].sort()
    );

    const approvedExpiredEvent = await pool.query(
      `SELECT data
         FROM mandate.audit_events
        WHERE tenant_id=$1 AND environment=$2 AND type='approval.expired' AND object_id=$3`,
      [tenantId, ownership.environment, approvedThenOverdue.approval.id]
    );
    assert.equal(approvedExpiredEvent.rowCount, 1);
    assert.equal(approvedExpiredEvent.rows[0].data.previousStatus, 'APPROVED');

    const index = await pool.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname='mandate' AND indexname='approvals_expiring_scope_idx'`
    );
    assert.equal(index.rowCount, 1);
  } finally {
    await store.close();
  }
});
