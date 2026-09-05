import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  addApproverGroupMember,
  createApprovalAssignment,
  createApproverGroup,
  createApproverIdentity,
  decideAssignedApproval
} from '../src/application/approval-operations.js';
import { createApiCredentialRecord } from '../src/auth/api-credentials.js';
import { createApprovalRequest, decideApproval } from '../src/domain/approvals.js';
import { createMandate } from '../src/domain/mandates.js';
import { createPostgresPool, PostgresStore } from '../src/store/postgres-store.js';

const connectionString = process.env.DATABASE_URL;
const integration = connectionString ? test : test.skip;
const fixedNow = new Date('2026-09-05T20:00:00.000Z');

function unique(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function credential(id, tenantId, secret) {
  return createApiCredentialRecord({
    id,
    tenantId,
    environment: 'test',
    name: id,
    scopes: ['approvals:decide']
  }, secret, fixedNow);
}

function auth(tenantId, credentialId) {
  return { tenantId, environment: 'test', credentialId, scopes: ['approvals:decide'] };
}

integration('PostgreSQL rejects free-text decision attribution and serializes eligible approvers', async () => {
  const tenantId = unique('ten_assignment_pg');
  const ownership = { tenantId, environment: 'test' };
  const aliceCredentialId = unique('key_alice');
  const bobCredentialId = unique('key_bob');
  const aliceCredential = credential(aliceCredentialId, tenantId, `alice-${randomUUID()}`);
  const bobCredential = credential(bobCredentialId, tenantId, `bob-${randomUUID()}`);
  const pool = await createPostgresPool({ connectionString, max: 8 });
  const store = new PostgresStore(pool, { maximumTransactionAttempts: 4 });

  try {
    await store.ensureBootstrap({
      tenantId,
      tenantName: 'Approval assignment PostgreSQL tenant',
      environment: 'test',
      credential: aliceCredential
    });
    await store.save('apiCredentials', ownership, bobCredential);

    const mandate = createMandate({
      principalId: 'principal_owner',
      agentId: 'agent_coder',
      purpose: 'Merge a reviewed change',
      resources: ['github:owner/repo'],
      allowedActions: ['pull_request.merge'],
      approvalRequiredActions: ['pull_request.merge'],
      validUntil: '2027-01-01T00:00:00.000Z'
    }, fixedNow);
    await store.save('mandates', ownership, mandate);

    const approval = createApprovalRequest({
      mandateId: mandate.id,
      agentId: mandate.agentId,
      action: 'pull_request.merge',
      resource: 'github:owner/repo',
      summary: 'Approve merge after human review',
      expiresAt: '2026-09-05T22:00:00.000Z'
    }, fixedNow);
    await store.save('approvals', ownership, approval);

    const setup = await store.transaction(async (transaction) => {
      const alice = await createApproverIdentity({
        view: transaction,
        ownership,
        authentication: auth(tenantId, aliceCredentialId),
        input: { displayName: 'Alice', credentialId: aliceCredentialId },
        now: fixedNow
      });
      const bob = await createApproverIdentity({
        view: transaction,
        ownership,
        authentication: auth(tenantId, aliceCredentialId),
        input: { displayName: 'Bob', credentialId: bobCredentialId },
        now: fixedNow
      });
      const group = await createApproverGroup({
        view: transaction,
        ownership,
        input: { name: unique('release_managers') },
        now: fixedNow
      });
      await addApproverGroupMember({
        view: transaction, ownership, groupId: group.id, approverId: alice.id, now: fixedNow
      });
      await addApproverGroupMember({
        view: transaction, ownership, groupId: group.id, approverId: bob.id, now: fixedNow
      });
      const assignment = await createApprovalAssignment({
        view: transaction,
        ownership,
        approvalId: approval.id,
        assignment: { type: 'GROUP', id: group.id },
        authentication: auth(tenantId, aliceCredentialId),
        now: fixedNow
      });
      return { alice, bob, group, assignment };
    });
    assert.deepEqual(setup.assignment.eligibleApproverIds, [setup.alice.id, setup.bob.id].sort());

    await assert.rejects(
      store.transaction(async (transaction) => {
        const current = await transaction.get('approvals', ownership, approval.id);
        await transaction.save('approvals', ownership, decideApproval(current, {
          decision: 'APPROVED',
          decidedBy: 'spoofed-free-text-actor'
        }, new Date('2026-09-05T20:01:00.000Z')));
      }),
      /approval decision requires authenticated approver identity/
    );
    const afterSpoof = await store.get('approvals', ownership, approval.id);
    assert.equal(afterSpoof.status, 'PENDING');

    await assert.rejects(
      pool.query(
        `UPDATE mandate.approval_assignment_eligibility
         SET created_at = created_at + interval '1 second'
         WHERE tenant_id=$1 AND environment='test' AND assignment_id=$2`,
        [tenantId, setup.assignment.id]
      ),
      (error) => error?.code === '55000'
    );

    const decideAs = (credentialId) => store.transaction(async (transaction) => {
      const current = await transaction.get('approvals', ownership, approval.id);
      return decideAssignedApproval({
        view: transaction,
        ownership,
        approval: current,
        input: { decision: 'APPROVED', reason: 'Reviewed' },
        authentication: auth(tenantId, credentialId),
        decide: decideApproval,
        now: new Date('2026-09-05T20:02:00.000Z')
      });
    });

    const outcomes = await Promise.allSettled([
      decideAs(aliceCredentialId),
      decideAs(bobCredentialId)
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason?.code, 'APPROVAL_ALREADY_DECIDED');

    const winner = fulfilled[0].value;
    const persisted = await pool.query(
      `SELECT status, decided_by, decided_by_approver_id
       FROM mandate.approvals
       WHERE tenant_id=$1 AND environment='test' AND id=$2`,
      [tenantId, approval.id]
    );
    assert.equal(persisted.rows[0].status, 'APPROVED');
    assert.equal(persisted.rows[0].decided_by, winner.approver.id);
    assert.equal(persisted.rows[0].decided_by_approver_id, winner.approver.id);
  } finally {
    await store.close();
  }
});
