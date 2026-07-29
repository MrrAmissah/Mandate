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

test('expiry process configuration requires a database, explicit live identity, and bounded settings', () => {
  assert.throws(() => parseActionAttemptExpiryConfig({
    MANDATE_ENVIRONMENT: 'test'
  }), /DATABASE_URL is required/);
  assert.throws(() => parseActionAttemptExpiryConfig({
    DATABASE_URL: 'postgresql://example',
    MANDATE_ENVIRONMENT: 'live'
  }), /MANDATE_EXPIRY_WORKER_ID is required/);

  const config = parseActionAttemptExpiryConfig({
    DATABASE_URL: 'postgresql://example',
    MANDATE_ENVIRONMENT: 'live',
    MANDATE_TENANT_ID: 'ten_live',
    MANDATE_EXPIRY_WORKER_ID: 'expiry.worker-live-01.example.internal',
    MANDATE_EXPIRY_POLL_INTERVAL_MS: '500',
    MANDATE_EXPIRY_BATCH_LIMIT: '25',
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
    batchLimit: 25
  });
});

test('expiry process records successful cycle counters and limit state', async () => {
  const logger = capturingLogger();
  const process = new ActionAttemptExpiryProcess({
    worker: {
      async drain({ limit }) {
        assert.equal(limit, 2);
        return {
          expired: [{ id: 'att_one' }, { id: 'att_two' }],
          limitReached: true
        };
      }
    },
    pollIntervalMs: 100,
    batchLimit: 2,
    logger
  });
  const at = new Date('2026-07-29T12:00:00.000Z');
  const result = await process.runCycle(at);
  assert.equal(result.expired.length, 2);
  assert.equal(result.limitReached, true);
  assert.deepEqual(process.snapshot(), {
    cycles: 1,
    expiredTotal: 2,
    failures: 0,
    consecutiveFailures: 0,
    lastCycleAt: at.toISOString(),
    lastSuccessAt: at.toISOString(),
    lastErrorCode: null
  });
  assert.equal(logger.entries[0].event, 'action_attempt_expiry.cycle');
  assert.equal(logger.entries[0].expired, 2);
});

test('expiry process exposes safe failure counters and recovers on the next cycle', async () => {
  const logger = capturingLogger();
  let fail = true;
  const process = new ActionAttemptExpiryProcess({
    worker: {
      async drain() {
        if (fail) {
          const error = new Error('secret database detail');
          error.code = '40001';
          throw error;
        }
        return { expired: [], limitReached: false };
      }
    },
    pollIntervalMs: 100,
    batchLimit: 5,
    logger
  });

  await assert.rejects(process.runCycle(new Date('2026-07-29T12:00:00.000Z')), /secret database detail/);
  assert.equal(process.snapshot().lastErrorCode, '40001');
  assert.equal(process.snapshot().consecutiveFailures, 1);
  assert.equal(JSON.stringify(logger.entries).includes('secret database detail'), false);

  fail = false;
  await process.runCycle(new Date('2026-07-29T12:00:01.000Z'));
  assert.equal(process.snapshot().consecutiveFailures, 0);
  assert.equal(process.snapshot().lastErrorCode, null);
  assert.equal(process.snapshot().lastSuccessAt, '2026-07-29T12:00:01.000Z');
});

test('expiry process loop stops through an AbortSignal', async () => {
  const controller = new AbortController();
  const logger = capturingLogger();
  let cycles = 0;
  const process = new ActionAttemptExpiryProcess({
    worker: {
      async drain() {
        cycles += 1;
        controller.abort();
        return { expired: [], limitReached: false };
      }
    },
    pollIntervalMs: 100,
    batchLimit: 5,
    logger,
    sleep: async () => {}
  });
  await process.run({ signal: controller.signal });
  assert.equal(cycles, 1);
  assert.deepEqual(logger.entries.map((entry) => entry.event), [
    'action_attempt_expiry.started',
    'action_attempt_expiry.cycle',
    'action_attempt_expiry.stopped'
  ]);
});
