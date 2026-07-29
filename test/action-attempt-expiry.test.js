import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionAttemptExpiryWorker } from '../src/application/action-attempt-expiry-worker.js';
import { MemoryStore } from '../src/store/memory-store.js';

const ownership = { tenantId: 'ten_expiry_memory', environment: 'test' };
const now = new Date('2026-07-29T12:00:00.000Z');

function attempt({ id, expiresAt, status = 'RESERVED' }) {
  return {
    id,
    decisionId: `dec_${id}`,
    mandateId: `mnd_${id}`,
    agentId: 'agent_expiry',
    action: 'repository.write',
    resource: 'github:repo',
    status,
    reservedByCredentialId: 'key_expiry_owner',
    reservedAt: '2026-07-29T11:00:00.000Z',
    expiresAt,
    requestId: `req_${id}`,
    executionStatus: status === 'COMPLETED' ? 'SUCCEEDED' : null,
    inputHash: status === 'COMPLETED' ? `sha256:${'a'.repeat(64)}` : null,
    outputHash: status === 'COMPLETED' ? `sha256:${'b'.repeat(64)}` : null,
    tool: status === 'COMPLETED' ? 'github.create_commit' : null,
    provider: status === 'COMPLETED' ? 'github' : null,
    model: null,
    completedAt: status === 'COMPLETED' ? '2026-07-29T11:10:00.000Z' : null,
    completionRequestId: status === 'COMPLETED' ? `req_complete_${id}` : null,
    terminatedAt: null,
    terminationReason: null,
    terminationRequestId: null,
    version: status === 'COMPLETED' ? 1 : 0
  };
}

test('expiry worker materializes due reservations with one audit and outbox event', async () => {
  const store = new MemoryStore(ownership);
  store.save('actionAttempts', ownership, attempt({
    id: 'att_due_memory',
    expiresAt: '2026-07-29T11:59:59.000Z'
  }));
  store.save('actionAttempts', ownership, attempt({
    id: 'att_future_memory',
    expiresAt: '2026-07-29T12:05:00.000Z'
  }));
  store.save('actionAttempts', ownership, attempt({
    id: 'att_completed_memory',
    expiresAt: '2026-07-29T11:30:00.000Z',
    status: 'COMPLETED'
  }));

  const worker = new ActionAttemptExpiryWorker({
    store,
    workerId: 'expiry-worker-memory',
    scope: ownership,
    now: () => now
  });

  const result = await worker.pollOnce();
  assert.equal(result.status, 'EXPIRED');
  assert.equal(result.actionAttempt.id, 'att_due_memory');
  assert.equal(result.actionAttempt.status, 'EXPIRED');
  assert.equal(result.actionAttempt.terminatedAt, now.toISOString());
  assert.equal(result.actionAttempt.terminationReason, 'RESERVATION_EXPIRED');
  assert.match(result.actionAttempt.terminationRequestId, /^sys_expiry_/);

  assert.equal(store.get('actionAttempts', ownership, 'att_future_memory').status, 'RESERVED');
  assert.equal(store.get('actionAttempts', ownership, 'att_completed_memory').status, 'COMPLETED');

  const events = store.list('auditEvents', ownership).filter((event) => event.type === 'action_attempt.expired');
  assert.equal(events.length, 1);
  assert.equal(events[0].actorType, 'SYSTEM');
  assert.equal(events[0].actorId, 'expiry-worker-memory');
  assert.equal(store.list('outboxMessages', ownership).filter((message) => message.eventType === 'action_attempt.expired').length, 1);

  assert.deepEqual(await worker.pollOnce(), { status: 'IDLE' });
});

test('expiry drain is bounded and ordered by expiry time', async () => {
  const store = new MemoryStore(ownership);
  for (const [id, expiresAt] of [
    ['att_due_later', '2026-07-29T11:59:59.000Z'],
    ['att_due_first', '2026-07-29T11:00:00.000Z'],
    ['att_due_middle', '2026-07-29T11:30:00.000Z']
  ]) {
    store.save('actionAttempts', ownership, attempt({ id, expiresAt }));
  }
  const worker = new ActionAttemptExpiryWorker({
    store,
    workerId: 'expiry-worker-drain',
    scope: ownership,
    now: () => now
  });
  const first = await worker.drain({ limit: 2 });
  assert.deepEqual(first.expired.map((item) => item.id), ['att_due_first', 'att_due_middle']);
  assert.equal(first.limitReached, true);
  const second = await worker.drain({ limit: 2 });
  assert.deepEqual(second.expired.map((item) => item.id), ['att_due_later']);
  assert.equal(second.limitReached, false);
});
