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
    decidedAt: null,
    decidedBy: null,
    decidedByApproverId: null,
    decisionReason: null,
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

test('approval expiry worker materializes deadline expiry with assignment, audit, and outbox evidence', async () => {
  const store = new MemoryStore(ownership);
  const due = approval({ id: 'apr_due', expiresAt: '2026-09-06T11:59:59.000Z' });
  const future = approval({ id: 'apr_future', expiresAt: '2026-09-06T12:05:00.000Z' });
  const alreadyDecided = approval({ id: 'apr_decided', expiresAt: '2026-09-06T11:30:00.000Z', status: 'APPROVED' });
  store.save('approvals', ownership, due);
  store.save('approvals', ownership, future);
  store.save('approvals', ownership, alreadyDecided);
  const assignmentId = seedAssignment(store, due.id);

  const worker = new ApprovalExpiryWorker({
    store,
    workerId: 'approval-expiry-worker-memory',
    scope: ownership,
    now: () => now
  });

  const result = await worker.pollOnce();
  assert.equal(result.status, 'EXPIRED');
  assert.equal(result.approval.id, due.id);
  assert.equal(result.approval.status, 'EXPIRED');
  assert.equal(result.approval.expiredAt, now.toISOString());
  assert.equal(result.approval.expirationReason, 'DEADLINE_ELAPSED');
  assert.match(result.approval.expirationRequestId, /^sys_approval_expiry_/);
  assert.equal(result.assignmentId, assignmentId);

  const assignment = store.state.approvalAssignments.get(`${ownership.tenantId}:${ownership.environment}:${assignmentId}`);
  assert.equal(assignment.status, 'EXPIRED');
  assert.equal(assignment.endedAt, now.toISOString());
  assert.equal(assignment.endReason, 'APPROVAL_EXPIRED');
  assert.equal(assignment.version, 1);

  assert.equal(store.get('approvals', ownership, future.id).status, 'PENDING');
  assert.equal(store.get('approvals', ownership, alreadyDecided.id).status, 'APPROVED');

  const events = store.list('auditEvents', ownership).filter((event) => event.type === 'approval.expired');
  assert.equal(events.length, 1);
  assert.equal(events[0].actorType, 'SYSTEM');
  assert.equal(events[0].actorId, 'approval-expiry-worker-memory');
  assert.equal(events[0].objectId, due.id);
  assert.equal(events[0].data.assignmentId, assignmentId);
  assert.equal(events[0].data.expiresAt, due.expiresAt);
  assert.equal(events[0].data.expiredAt, now.toISOString());
  assert.equal(store.list('outboxMessages', ownership).filter((message) => message.eventType === 'approval.expired').length, 1);

  assert.deepEqual(await worker.pollOnce(), { status: 'IDLE' });
});

test('approval expiry drain is bounded and ordered by deadline', async () => {
  const store = new MemoryStore(ownership);
  for (const [id, expiresAt] of [
    ['apr_later', '2026-09-06T11:59:59.000Z'],
    ['apr_first', '2026-09-06T11:00:00.000Z'],
    ['apr_middle', '2026-09-06T11:30:00.000Z']
  ]) {
    store.save('approvals', ownership, approval({ id, expiresAt }));
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

test('approval expiry backlog counts only pending approvals with deadlines', async () => {
  const store = new MemoryStore(ownership);
  store.save('approvals', ownership, approval({ id: 'apr_due_backlog', expiresAt: '2026-09-06T11:59:00.000Z' }));
  store.save('approvals', ownership, approval({ id: 'apr_future_backlog', expiresAt: '2026-09-06T12:10:00.000Z' }));
  store.save('approvals', ownership, approval({ id: 'apr_no_deadline', expiresAt: null }));
  store.save('approvals', ownership, approval({ id: 'apr_terminal_backlog', expiresAt: '2026-09-06T11:00:00.000Z', status: 'REJECTED' }));

  assert.deepEqual(await inspectApprovalExpiryBacklog(store, ownership, { now }), {
    pendingExpiringCount: 2,
    dueCount: 1,
    oldestDueAt: '2026-09-06T11:59:00.000Z',
    oldestOverdueSeconds: 60,
    observedAt: now.toISOString()
  });
});
