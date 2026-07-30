import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OutboxWorkerProcess,
  loadOutboxHandlers,
  parseOutboxWorkerConfig
} from '../src/application/outbox-worker-process.js';

function validEnvironment(overrides = {}) {
  return {
    DATABASE_URL: 'postgresql://unused',
    MANDATE_ENVIRONMENT: 'test',
    MANDATE_OUTBOX_HANDLER_MODULE: './test/fixtures/outbox-handlers.js',
    ...overrides
  };
}

test('outbox worker configuration is explicit and bounded', () => {
  const config = parseOutboxWorkerConfig(validEnvironment());
  assert.equal(config.environment, 'test');
  assert.equal(config.handlerModule, './test/fixtures/outbox-handlers.js');
  assert.equal(config.pollIntervalMs, 1000);
  assert.equal(config.cycleLimit, 100);
  assert.equal(config.healthHost, '127.0.0.1');
  assert.equal(config.healthPort, 8789);

  assert.throws(() => parseOutboxWorkerConfig({}), /DATABASE_URL is required/);
  assert.throws(
    () => parseOutboxWorkerConfig({ DATABASE_URL: 'postgresql://unused', MANDATE_ENVIRONMENT: 'test' }),
    /HANDLER_MODULE is required/
  );
  assert.throws(
    () => parseOutboxWorkerConfig(validEnvironment({ MANDATE_ENVIRONMENT: 'live' })),
    /WORKER_ID is required/
  );
  assert.throws(
    () => parseOutboxWorkerConfig(validEnvironment({ MANDATE_OUTBOX_POLL_INTERVAL_MS: '99' })),
    /between 100 and 60000/
  );
  assert.throws(
    () => parseOutboxWorkerConfig(validEnvironment({ MANDATE_OUTBOX_CYCLE_LIMIT: '5001' })),
    /between 1 and 5000/
  );
});

test('handler modules must be local, non-empty, and exact', async () => {
  const handlers = await loadOutboxHandlers('./test/fixtures/outbox-handlers.js');
  assert.deepEqual([...handlers.keys()], ['test.outbox.event']);

  await assert.rejects(
    loadOutboxHandlers('https://example.com/handlers.js'),
    /Only local file handler modules/
  );
  await assert.rejects(
    loadOutboxHandlers('./unused.js', { importer: async () => ({ handlers: {} }) }),
    /at least one exact event handler/
  );
  await assert.rejects(
    loadOutboxHandlers('./unused.js', {
      importer: async () => ({ handlers: { '*': async () => {} } })
    }),
    /exact non-wildcard/
  );
  await assert.rejects(
    loadOutboxHandlers('./unused.js', {
      importer: async () => ({ handlers: { 'event.valid': 'not-a-function' } })
    }),
    /exact non-wildcard/
  );
});

test('outbox process records bounded outcomes and cached backlog state', async () => {
  const results = [
    { kind: 'PROCESSED' },
    { kind: 'RETRY_SCHEDULED' },
    { kind: 'DEAD_LETTERED' },
    { kind: 'LEASE_LOST' },
    { kind: 'IDLE', reason: 'NO_DUE_MESSAGES' }
  ];
  const dispatcher = {
    scope: { environment: 'test', tenantId: 'ten_process' },
    eventTypes: () => ['test.outbox.event'],
    async pollOnce() { return results.shift(); }
  };
  const queue = {
    async inspectBacklog(options) {
      assert.deepEqual(options, {
        scope: dispatcher.scope,
        eventTypes: ['test.outbox.event'],
        sampleLimit: 10
      });
      return {
        dueSampleCount: 1,
        staleSampleCount: 0,
        deadLetterSampleCount: 2,
        hasDue: true,
        hasStale: false,
        hasDeadLetter: true,
        observedAt: '2026-07-30T02:00:00.000Z'
      };
    }
  };
  const logs = [];
  let clockIndex = 0;
  const times = [
    new Date('2026-07-30T02:00:00.000Z'),
    new Date('2026-07-30T02:00:01.000Z')
  ];
  const process = new OutboxWorkerProcess({
    dispatcher,
    queue,
    pollIntervalMs: 1000,
    cycleLimit: 10,
    readinessStaleMs: 5000,
    readinessFailureThreshold: 3,
    logger: { log: (value) => logs.push(value), error: (value) => logs.push(value) },
    clock: () => times[Math.min(clockIndex++, times.length - 1)]
  });

  const result = await process.runCycle();
  assert.deepEqual(result.outcomes, {
    processed: 1,
    retryScheduled: 1,
    deadLettered: 1,
    leaseLost: 1,
    worked: 4
  });
  assert.equal(result.limitReached, false);
  const snapshot = process.snapshot();
  assert.equal(snapshot.processedTotal, 1);
  assert.equal(snapshot.retryScheduledTotal, 1);
  assert.equal(snapshot.deadLetteredTotal, 1);
  assert.equal(snapshot.leaseLostTotal, 1);
  assert.equal(snapshot.deadLetterSampleCount, 2);
  assert.equal(snapshot.hasDue, true);
  assert.ok(logs.every((entry) => !entry.includes('payload') && !entry.includes('messageId')));
});

test('outbox readiness fails closed for startup, repeated failures, staleness, and shutdown', async () => {
  const dispatcher = {
    scope: { environment: 'test' },
    eventTypes: () => ['test.outbox.event'],
    async pollOnce() { throw Object.assign(new Error('secret'), { code: 'db_down' }); }
  };
  const queue = { async inspectBacklog() { throw new Error('unreachable'); } };
  const process = new OutboxWorkerProcess({
    dispatcher,
    queue,
    pollIntervalMs: 1000,
    cycleLimit: 1,
    readinessStaleMs: 2000,
    readinessFailureThreshold: 2,
    logger: { log() {}, error() {} },
    clock: () => new Date('2026-07-30T02:00:00.000Z')
  });

  assert.equal(process.readiness().reason, 'STARTING');
  process.running = true;
  await assert.rejects(process.runCycle(), /secret/);
  await assert.rejects(process.runCycle(), /secret/);
  process.metrics.lastSuccessAt = '2026-07-30T01:59:59.000Z';
  assert.equal(process.readiness().reason, 'CYCLE_FAILURES');
  process.metrics.consecutiveFailures = 0;
  assert.equal(process.readiness(new Date('2026-07-30T02:00:02.001Z')).reason, 'STALE');
  process.shuttingDown = true;
  assert.equal(process.readiness().reason, 'SHUTTING_DOWN');
});
