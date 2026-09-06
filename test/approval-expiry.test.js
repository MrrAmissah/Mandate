import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalExpiryWorker } from '../src/application/approval-expiry-worker.js';
import { inspectApprovalExpiryBacklog } from '../src/store/approval-expiry.js';
import { MemoryStore } from '../src/store/memory-store.js';

const ownership = { tenantId: 'ten_approval_expiry_memory', environment: 'test' };
const now = new Date('2026-09-06T12:00:00.000Z');

function approval({ id, expiresAt, status = 'PENDING' }) {
  return {
    id,
    mandateId: `mnd_${id}`,
    agentId: 'agent_expiry',
    action: 'payment.release',
    resource: 'payguard:deal/123',
    summary: `Approval ${id}`,
    status,
    requestedAt: '2026-09-06T11:00:00.000Z',
    expiresAt,
    decidedAt: status === 'APPROVED' ? '2026-09-06T11:30:00.000Z' : null,
    decidedBy: status === 'APPROVED' ? 'apv_expiry' : null,
    decidedByApproverId: status === 'APPROVED' ? 'apv_expiry' : null,
    decisionReason: status === 'APPROVED' ? 'Approved before deadline' : null,
    cancelledAt: null,
    cancelledByCredentialId: null,
    cancellationReason: null,
    expiredAt: null,
    expirationReason: null,
    expirationRequestId: null,
    consumedAt: null,
    consumedByDecisionId: null
  };
}

function seedAssignment(store, approvalId, assignmentId = `apa_${approvalId}`) {
  const key = `${ownership.tenantId}:${ownership.environment}:${assignmentId}`;
  store.state.approvalAssignments.set(key, {
    ...ownership,
    id: assignmentId,
    approvalId,
    sourceType: 'APPROVER',
    sourceId: 'apv_expiry',
    status: 'ACTIVE',
    assignedByCredentialId: 'key_expiry',
    assignedAt: '2026-09-06T11:00:00.000Z',
    endedAt: null,
    endReason: null,
    version: 0
  });
  return assignmentId;
}

test('approval expiry worker materializes pending and approved deadline expiry with immutable evidence', async () => {
  const store = new MemoryStore(ownership);
  const duePending = approval({ id: 'apr_due_pending', expiresAt: '2026-09-06T11:59:59.000Z' });
  const dueApproved = approval({ id: 'apr_due_approved', expiresAt: '2026-09-06T11:30:00.000Z', status: 'APPROVED' });
  const future = approval({ id: 'apr_future', expiresAt: '2026-09-06T12:05:00.000Z' });
  const rejected = approval({ id: 'apr_rejected', expiresAt: '2026-09-06T11:30:00.000Z', status: 'REJECTED' });
  for (const item of [duePending, dueApproved, future, rejected]) store.save('approvals', ownership, item);
  const pendingAssignmentId = seedAssignment(store, duePending.id);
  const approvedAssignmentId = seedAssignment(store, dueApproved.id);

  const worker = new ApprovalExpiryWorker({
    store,
    workerId: 'approval-expiry-worker-memory',
    scope: ownership,
    now: () => now
  });

  const first = await worker.pollOnce();
  assert.equal(first.status, 'EXPIRED');
  assert.equal(first.approval.id, dueApproved.id);
  assert.equal(first.approval.status, 'EXPIRED');
  assert.equal(first.approval.expiredAt, now.toISOString());
  assert.equal(first.approval.expirationReason, 'DEADLINE_ELAPSED');
  assert.match(first.approval.expirationRequestId, /^sys_approval_expiry_/);
  assert.equal(first.assignmentId, approvedAssignmentId);

  const second = await worker.pollOnce();
  assert.equal(second.status, 'EXPIRED');
  assert.equal(second.approval.id, duePending.id);
  assert.equal(second.assignmentId, pendingAssignmentId);

  for (const assignmentId of [pendingAssignmentId, approvedAssignmentId]) {
    const assignment = store.state.approvalAssignments.get(`${ownership.tenantId}:${ownership.environment}:${assignmentId}`);
    assert.equal(assignment.status, 'EXPIRED');
    assert.equal(assignment.endedAt, now.toISOString());
    assert.equal(assignment.endReason, 'APPROVAL_EXPIRED');
    assert.equal(assignment.version, 1);
  }

  assert.equal(store.get('approvals', ownership, future.id).status, 'PENDING');
  assert.equal(store.get('approvals', ownership, rejected.id).status, 'REJECTED');

  const events = store.list('auditEvents', ownership).filter((event) => event.type === 'approval.expired');
  assert.equal(events.length, 2);
  assert.deepEqual(new Set(events.map((event) => event.data.previousStatus)), new Set(['PENDING', 'APPROVED']));
  assert.ok(events.every((event) => event.actorType === 'SYSTEM'));
  assert.ok(events.every((event) => event.actorId === 'approval-expiry-worker-memory'));
  assert.equal(store.list('outboxMessages', ownership).filter((message) => message.eventType === 'approval.expired').length, 2);

  assert.deepEqual(await worker.pollOnce(), { status: 'IDLE' });
});

test('approval expiry drain is bounded and ordered by deadline across pending and approved state', async () => {
  const store = new MemoryStore(ownership);
  for (const [id, expiresAt, status] of [
    ['apr_later', '2026-09-06T11:59:59.000Z', 'PENDING'],
    ['apr_first', '2026-09-06T11:00:00.000Z', 'APPROVED'],
    ['apr_middle', '2026-09-06T11:30:00.000Z', 'PENDING']
  ]) {
    store.save('approvals', ownership, approval({ id, expiresAt, status }));
  }
  const worker = new ApprovalExpiryWorker({
    store,
    workerId: 'approval-expiry-worker-drain',
    scope: ownership,
    now: () => now
  });
  const first = await worker.drain({ limit: 2 });
  assert.deepEqual(first.expired.map((item) => item.id), ['apr_first', 'apr_middle']);
  assert.equal(first.limitReached, true);
  const second = await worker.drain({ limit: 2 });
  assert.deepEqual(second.expired.map((item) => item.id), ['apr_later']);
  assert.equal(second.limitReached, false);
});

test('approval expiry backlog counts only expirable pending or approved approvals with deadlines', async () => {
  const store = new MemoryStore(ownership);
  store.save('approvals', ownership, approval({ id: 'apr_due_backlog', expiresAt: '2026-09-06T11:59:00.000Z' }));
  store.save('approvals', ownership, approval({ id: 'apr_approved_due', expiresAt: '2026-09-06T11:58:00.000Z', status: 'APPROVED' }));
  store.save('approvals', ownership, approval({ id: 'apr_future_backlog', expiresAt: '2026-09-06T12:10:00.000Z' }));
  store.save('approvals', ownership, approval({ id: 'apr_no_deadline', expiresAt: null }));
  store.save('approvals', ownership, approval({ id: 'apr_terminal_backlog', expiresAt: '2026-09-06T11:00:00.000Z', status: 'REJECTED' }));

  assert.deepEqual(await inspectApprovalExpiryBacklog(store, ownership, { now }), {
    expiringCount: 3,
    dueCount: 2,
    oldestDueAt: '2026-09-06T11:58:00.000Z',
    oldestOverdueSeconds: 120,
    observedAt: now.toISOString()
  });
});
