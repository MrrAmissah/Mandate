import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApprovalExpiryProcess,
  parseApprovalExpiryConfig
} from '../src/application/approval-expiry-process.js';

function capturingLogger() {
  const entries = [];
  return {
    entries,
    log(value) { entries.push(JSON.parse(value)); },
    error(value) { entries.push(JSON.parse(value)); }
  };
}

function backlog(overrides = {}) {
  return {
    expiringCount: 4,
    dueCount: 2,
    oldestDueAt: '2026-09-06T11:59:30.000Z',
    oldestOverdueSeconds: 30,
    observedAt: '2026-09-06T12:00:00.000Z',
    ...overrides
  };
}

function processOptions(worker, overrides = {}) {
  return {
    worker,
    pollIntervalMs: 100,
    batchLimit: 5,
    readinessStaleMs: 500,
    readinessFailureThreshold: 2,
    ...overrides
  };
}

async function waitFor(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition was not reached');
}

test('approval expiry configuration requires database and explicit live worker identity', () => {
  assert.throws(() => parseApprovalExpiryConfig({
    MANDATE_ENVIRONMENT: 'test'
  }), /DATABASE_URL is required/);
  assert.throws(() => parseApprovalExpiryConfig({
    DATABASE_URL: 'postgresql://example',
    MANDATE_ENVIRONMENT: 'live'
  }), /MANDATE_APPROVAL_EXPIRY_WORKER_ID is required/);
  assert.throws(() => parseApprovalExpiryConfig({
    DATABASE_URL: 'postgresql://example',
    MANDATE_ENVIRONMENT: 'test',
    MANDATE_APPROVAL_EXPIRY_POLL_INTERVAL_MS: '1000',
    MANDATE_APPROVAL_EXPIRY_READINESS_STALE_MS: '1500'
  }), /between 2000 and 3600000/);

  const config = parseApprovalExpiryConfig({
    DATABASE_URL: 'postgresql://example',
    MANDATE_ENVIRONMENT: 'live',
    MANDATE_TENANT_ID: 'ten_live',
    MANDATE_APPROVAL_EXPIRY_WORKER_ID: 'approval-expiry.worker-live-01.internal',
    MANDATE_APPROVAL_EXPIRY_POLL_INTERVAL_MS: '500',
    MANDATE_APPROVAL_EXPIRY_BATCH_LIMIT: '25',
    MANDATE_APPROVAL_EXPIRY_READINESS_STALE_MS: '4000',
    MANDATE_APPROVAL_EXPIRY_READINESS_FAILURE_THRESHOLD: '4',
    MANDATE_APPROVAL_EXPIRY_HEALTH_HOST: '127.0.0.2',
    MANDATE_APPROVAL_EXPIRY_HEALTH_PORT: '9798',
    MANDATE_DATABASE_POOL_MAX: '4',
    MANDATE_DATABASE_SSL: 'true'
  });
  assert.deepEqual(config, {
    databaseUrl: 'postgresql://example',
    databaseSsl: true,
    databasePoolMax: 4,
    environment: 'live',
    tenantId: 'ten_live',
    workerId: 'approval-expiry.worker-live-01.internal',
    pollIntervalMs: 500,
    batchLimit: 25,
    readinessStaleMs: 4000,
    readinessFailureThreshold: 4,
    healthHost: '127.0.0.2',
    healthPort: 9798
  });
});

test('approval expiry process records completed-cycle metrics after backlog inspection', async () => {
  const logger = capturingLogger();
  const startedAt = new Date('2026-09-06T12:00:00.000Z');
  const completedAt = new Date('2026-09-06T12:00:10.000Z');
  const expiryProcess = new ApprovalExpiryProcess(processOptions({
    async drain({ limit }) {
      assert.equal(limit, 2);
      return { expired: [{ id: 'apr_one' }, { id: 'apr_two' }], limitReached: true };
    },
    async backlog() { return backlog(); }
  }, { batchLimit: 2, logger, clock: () => completedAt }));

  const result = await expiryProcess.runCycle(startedAt);
  assert.equal(result.expired.length, 2);
  assert.equal(result.limitReached, true);
  assert.deepEqual(result.backlog, backlog());
  assert.deepEqual(expiryProcess.snapshot(), {
    cycles: 1,
    expiredTotal: 2,
    failures: 0,
    limitReachedTotal: 1,
    consecutiveFailures: 0,
    lastCycleAt: startedAt.toISOString(),
    lastSuccessAt: completedAt.toISOString(),
    lastErrorCode: null,
    backlogExpiring: 4,
    backlogDue: 2,
    oldestDueAt: '2026-09-06T11:59:30.000Z',
    oldestOverdueSeconds: 30,
    backlogObservedAt: '2026-09-06T12:00:00.000Z',
    running: false,
    shuttingDown: false,
    startedAt: null,
    stoppedAt: null
  });
  assert.equal(logger.entries[0].event, 'approval_expiry.cycle');

  expiryProcess.running = true;
  assert.equal(expiryProcess.readiness(new Date('2026-09-06T12:00:10.100Z')).reason, 'READY');
});

test('approval expiry process exposes safe failure state and recovers on the next successful cycle', async () => {
  const logger = capturingLogger();
  let failBacklog = true;
  const completedAt = new Date('2026-09-06T12:00:02.000Z');
  const expiryProcess = new ApprovalExpiryProcess(processOptions({
    async drain() { return { expired: [{ id: 'apr_committed' }], limitReached: false }; },
    async backlog() {
      if (failBacklog) {
        const error = new Error('secret database detail');
        error.code = '40001';
        throw error;
      }
      return backlog({ dueCount: 0, oldestDueAt: null, oldestOverdueSeconds: 0 });
    }
  }, { logger, clock: () => completedAt }));

  await assert.rejects(expiryProcess.runCycle(new Date('2026-09-06T12:00:00.000Z')), /secret database detail/);
  assert.equal(expiryProcess.snapshot().expiredTotal, 1);
  assert.equal(expiryProcess.snapshot().lastErrorCode, '40001');
  assert.equal(JSON.stringify(logger.entries).includes('secret database detail'), false);

  failBacklog = false;
  await expiryProcess.runCycle(new Date('2026-09-06T12:00:01.000Z'));
  assert.equal(expiryProcess.snapshot().expiredTotal, 2);
  assert.equal(expiryProcess.snapshot().consecutiveFailures, 0);
  assert.equal(expiryProcess.snapshot().lastErrorCode, null);
});

test('approval expiry readiness is cached and shutdown stops the loop', async () => {
  const controller = new AbortController();
  let releaseSleep;
  let backlogCalls = 0;
  const clockValues = [
    new Date('2026-09-06T12:00:00.000Z'),
    new Date('2026-09-06T12:00:00.000Z'),
    new Date('2026-09-06T12:00:00.000Z'),
    new Date('2026-09-06T12:00:01.000Z')
  ];
  const expiryProcess = new ApprovalExpiryProcess(processOptions({
    async drain() { return { expired: [], limitReached: false }; },
    async backlog() {
      backlogCalls += 1;
      return backlog({ expiringCount: 0, dueCount: 0, oldestDueAt: null, oldestOverdueSeconds: 0 });
    }
  }, {
    clock: () => clockValues.shift() ?? new Date('2026-09-06T12:00:01.000Z'),
    sleep: async () => new Promise((resolve) => { releaseSleep = resolve; })
  }));

  const run = expiryProcess.run({ signal: controller.signal });
  await waitFor(() => expiryProcess.snapshot().lastSuccessAt !== null);
  assert.equal(expiryProcess.readiness(new Date('2026-09-06T12:00:00.200Z')).reason, 'READY');
  assert.equal(expiryProcess.readiness(new Date('2026-09-06T12:00:00.600Z')).reason, 'STALE');
  assert.equal(backlogCalls, 1);

  controller.abort();
  releaseSleep?.();
  await run;
  assert.equal(expiryProcess.readiness(new Date('2026-09-06T12:00:01.000Z')).reason, 'SHUTTING_DOWN');
});
