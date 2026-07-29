import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActionAttemptExpiryProcess,
  parseActionAttemptExpiryConfig
} from '../src/application/action-attempt-expiry-process.js';

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
    reservedCount: 4,
    dueCount: 2,
    oldestDueAt: '2026-07-29T11:59:30.000Z',
    oldestOverdueSeconds: 30,
    observedAt: '2026-07-29T12:00:00.000Z',
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

test('expiry process configuration requires a database, explicit live identity, and bounded health settings', () => {
  assert.throws(() => parseActionAttemptExpiryConfig({
    MANDATE_ENVIRONMENT: 'test'
  }), /DATABASE_URL is required/);
  assert.throws(() => parseActionAttemptExpiryConfig({
    DATABASE_URL: 'postgresql://example',
    MANDATE_ENVIRONMENT: 'live'
  }), /MANDATE_EXPIRY_WORKER_ID is required/);
  assert.throws(() => parseActionAttemptExpiryConfig({
    DATABASE_URL: 'postgresql://example',
    MANDATE_ENVIRONMENT: 'test',
    MANDATE_EXPIRY_POLL_INTERVAL_MS: '1000',
    MANDATE_EXPIRY_READINESS_STALE_MS: '1500'
  }), /between 2000 and 3600000/);

  const config = parseActionAttemptExpiryConfig({
    DATABASE_URL: 'postgresql://example',
    MANDATE_ENVIRONMENT: 'live',
    MANDATE_TENANT_ID: 'ten_live',
    MANDATE_EXPIRY_WORKER_ID: 'expiry.worker-live-01.example.internal',
    MANDATE_EXPIRY_POLL_INTERVAL_MS: '500',
    MANDATE_EXPIRY_BATCH_LIMIT: '25',
    MANDATE_EXPIRY_READINESS_STALE_MS: '4000',
    MANDATE_EXPIRY_READINESS_FAILURE_THRESHOLD: '4',
    MANDATE_EXPIRY_HEALTH_HOST: '127.0.0.2',
    MANDATE_EXPIRY_HEALTH_PORT: '9797',
    MANDATE_DATABASE_POOL_MAX: '4',
    MANDATE_DATABASE_SSL: 'true',
    MANDATE_API_KEY: 'must-not-be-consumed-by-worker'
  });
  assert.deepEqual(config, {
    databaseUrl: 'postgresql://example',
    databaseSsl: true,
    databasePoolMax: 4,
    environment: 'live',
    tenantId: 'ten_live',
    workerId: 'expiry.worker-live-01.example.internal',
    pollIntervalMs: 500,
    batchLimit: 25,
    readinessStaleMs: 4000,
    readinessFailureThreshold: 4,
    healthHost: '127.0.0.2',
    healthPort: 9797
  });
});

test('expiry process timestamps success after drain and backlog work complete', async () => {
  const logger = capturingLogger();
  const startedAt = new Date('2026-07-29T12:00:00.000Z');
  const completedAt = new Date('2026-07-29T12:00:10.000Z');
  const expiryProcess = new ActionAttemptExpiryProcess(processOptions({
    async drain({ limit }) {
      assert.equal(limit, 2);
      return {
        expired: [{ id: 'att_one' }, { id: 'att_two' }],
        limitReached: true
      };
    },
    async backlog() { return backlog(); }
  }, {
    batchLimit: 2,
    logger,
    clock: () => completedAt
  }));
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
    backlogReserved: 4,
    backlogDue: 2,
    oldestDueAt: '2026-07-29T11:59:30.000Z',
    oldestOverdueSeconds: 30,
    backlogObservedAt: '2026-07-29T12:00:00.000Z',
    running: false,
    shuttingDown: false,
    startedAt: null,
    stoppedAt: null
  });
  assert.equal(logger.entries[0].event, 'action_attempt_expiry.cycle');
  assert.equal(logger.entries[0].startedAt, startedAt.toISOString());
  assert.equal(logger.entries[0].at, completedAt.toISOString());

  expiryProcess.running = true;
  assert.equal(expiryProcess.readiness(new Date('2026-07-29T12:00:10.100Z')).reason, 'READY');
});

test('expiry process exposes safe failure counters and preserves committed expiry counts', async () => {
  const logger = capturingLogger();
  let failBacklog = true;
  const completedAt = new Date('2026-07-29T12:00:02.000Z');
  const expiryProcess = new ActionAttemptExpiryProcess(processOptions({
    async drain() {
      return { expired: [{ id: 'att_committed' }], limitReached: false };
    },
    async backlog() {
      if (failBacklog) {
        const error = new Error('secret database detail');
        error.code = '40001';
        throw error;
      }
      return backlog({ dueCount: 0, oldestDueAt: null, oldestOverdueSeconds: 0 });
    }
  }, { logger, clock: () => completedAt }));

  await assert.rejects(expiryProcess.runCycle(new Date('2026-07-29T12:00:00.000Z')), /secret database detail/);
  assert.equal(expiryProcess.snapshot().expiredTotal, 1);
  assert.equal(expiryProcess.snapshot().lastErrorCode, '40001');
  assert.equal(expiryProcess.snapshot().consecutiveFailures, 1);
  assert.equal(JSON.stringify(logger.entries).includes('secret database detail'), false);

  failBacklog = false;
  await expiryProcess.runCycle(new Date('2026-07-29T12:00:01.000Z'));
  assert.equal(expiryProcess.snapshot().expiredTotal, 2);
  assert.equal(expiryProcess.snapshot().consecutiveFailures, 0);
  assert.equal(expiryProcess.snapshot().lastErrorCode, null);
  assert.equal(expiryProcess.snapshot().lastSuccessAt, completedAt.toISOString());
});

test('expiry readiness becomes ready, stale, and shutting down without database probe traffic', async () => {
  const controller = new AbortController();
  let releaseSleep;
  let backlogCalls = 0;
  const clockValues = [
    new Date('2026-07-29T12:00:00.000Z'),
    new Date('2026-07-29T12:00:00.000Z'),
    new Date('2026-07-29T12:00:00.000Z'),
    new Date('2026-07-29T12:00:01.000Z')
  ];
  const expiryProcess = new ActionAttemptExpiryProcess(processOptions({
    async drain() { return { expired: [], limitReached: false }; },
    async backlog() {
      backlogCalls += 1;
      return backlog({ reservedCount: 0, dueCount: 0, oldestDueAt: null, oldestOverdueSeconds: 0 });
    }
  }, {
    clock: () => clockValues.shift() ?? new Date('2026-07-29T12:00:01.000Z'),
    sleep: async () => new Promise((resolve) => { releaseSleep = resolve; })
  }));

  const run = expiryProcess.run({ signal: controller.signal });
  await waitFor(() => expiryProcess.snapshot().lastSuccessAt !== null);
  assert.equal(expiryProcess.readiness(new Date('2026-07-29T12:00:00.200Z')).reason, 'READY');
  assert.equal(expiryProcess.readiness(new Date('2026-07-29T12:00:00.600Z')).reason, 'STALE');
  assert.equal(backlogCalls, 1);

  controller.abort();
  releaseSleep?.();
  await run;
  assert.equal(expiryProcess.readiness(new Date('2026-07-29T12:00:01.000Z')).reason, 'SHUTTING_DOWN');
});

test('expiry process loop stops through an AbortSignal', async () => {
  const controller = new AbortController();
  const logger = capturingLogger();
  let cycles = 0;
  const expiryProcess = new ActionAttemptExpiryProcess(processOptions({
    async drain() {
      cycles += 1;
      controller.abort();
      return { expired: [], limitReached: false };
    },
    async backlog() { return backlog({ reservedCount: 0, dueCount: 0, oldestDueAt: null, oldestOverdueSeconds: 0 }); }
  }, {
    logger,
    sleep: async () => {}
  }));
  await expiryProcess.run({ signal: controller.signal });
  assert.equal(cycles, 1);
  assert.deepEqual(logger.entries.map((entry) => entry.event), [
    'action_attempt_expiry.started',
    'action_attempt_expiry.cycle',
    'action_attempt_expiry.stopped'
  ]);
});
