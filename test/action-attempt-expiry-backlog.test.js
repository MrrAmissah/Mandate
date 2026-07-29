import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectActionAttemptExpiryBacklog } from '../src/store/action-attempts.js';
import { MemoryStore } from '../src/store/memory-store.js';

const ownership = { tenantId: 'ten_backlog_memory', environment: 'test' };
const observedAt = new Date('2026-07-29T12:00:00.000Z');

function attempt(id, status, expiresAt) {
  return {
    id,
    decisionId: `dec_${id}`,
    mandateId: `mnd_${id}`,
    agentId: 'agent_backlog',
    action: 'repository.write',
    resource: 'github:repo',
    status,
    reservedByCredentialId: 'key_backlog',
    reservedAt: '2026-07-29T11:00:00.000Z',
    expiresAt,
    requestId: `req_${id}`,
    executionStatus: null,
    inputHash: null,
    outputHash: null,
    tool: null,
    provider: null,
    model: null,
    completedAt: null,
    completionRequestId: null,
    terminatedAt: status === 'EXPIRED' ? '2026-07-29T11:30:00.000Z' : null,
    terminationReason: status === 'EXPIRED' ? 'RESERVATION_EXPIRED' : null,
    terminationRequestId: status === 'EXPIRED' ? `sys_${id}` : null,
    version: status === 'EXPIRED' ? 1 : 0
  };
}

test('memory expiry backlog reports only scoped reserved attempts from one clock snapshot', async () => {
  const store = new MemoryStore(ownership);
  store.save('actionAttempts', ownership, attempt('att_due_oldest', 'RESERVED', '2026-07-29T11:58:20.000Z'));
  store.save('actionAttempts', ownership, attempt('att_due_newer', 'RESERVED', '2026-07-29T11:59:50.000Z'));
  store.save('actionAttempts', ownership, attempt('att_future', 'RESERVED', '2026-07-29T12:05:00.000Z'));
  store.save('actionAttempts', ownership, attempt('att_terminal', 'EXPIRED', '2026-07-29T11:30:00.000Z'));

  assert.deepEqual(await inspectActionAttemptExpiryBacklog(store, ownership, { now: observedAt }), {
    reservedCount: 3,
    dueCount: 2,
    oldestDueAt: '2026-07-29T11:58:20.000Z',
    oldestOverdueSeconds: 100,
    observedAt: observedAt.toISOString()
  });
});

test('memory expiry backlog is empty when no reservation is overdue', async () => {
  const store = new MemoryStore(ownership);
  store.save('actionAttempts', ownership, attempt('att_future_only', 'RESERVED', '2026-07-29T12:05:00.000Z'));

  assert.deepEqual(await inspectActionAttemptExpiryBacklog(store, ownership, { now: observedAt }), {
    reservedCount: 1,
    dueCount: 0,
    oldestDueAt: null,
    oldestOverdueSeconds: 0,
    observedAt: observedAt.toISOString()
  });
});
