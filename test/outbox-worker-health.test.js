import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutboxWorkerHealthServer, renderOutboxWorkerMetrics } from '../src/application/outbox-worker-health.js';

function processStub({ ready = true } = {}) {
  return {
    snapshot() {
      return {
        cycles: 4,
        processedTotal: 7,
        retryScheduledTotal: 2,
        deadLetteredTotal: 1,
        leaseLostTotal: 1,
        failures: 1,
        limitReachedTotal: 2,
        consecutiveFailures: ready ? 0 : 3,
        dueSampleCount: 5,
        staleSampleCount: 1,
        deadLetterSampleCount: 2,
        hasDue: true,
        hasStale: true,
        hasDeadLetter: true,
        backlogObservedAt: '2026-07-30T02:00:00.000Z',
        lastSuccessAt: '2026-07-30T02:00:01.000Z'
      };
    },
    readiness(now) {
      return {
        ready,
        reason: ready ? 'READY' : 'CYCLE_FAILURES',
        checkedAt: now.toISOString(),
        lastSuccessAt: '2026-07-30T02:00:01.000Z',
        consecutiveFailures: ready ? 0 : 3
      };
    }
  };
}

test('outbox metrics are low-cardinality and expose cached operational state', () => {
  const metrics = renderOutboxWorkerMetrics(processStub(), new Date('2026-07-30T02:00:02.000Z'));
  assert.match(metrics, /mandate_outbox_processed_total 7/);
  assert.match(metrics, /mandate_outbox_due_sample 5/);
  assert.match(metrics, /mandate_outbox_has_dead_letter 1/);
  assert.match(metrics, /mandate_outbox_ready 1/);
  assert.doesNotMatch(metrics, /event_type|tenant_id|message_id/);
});

test('outbox health server exposes liveness, readiness, metrics, and safe errors', async () => {
  const health = createOutboxWorkerHealthServer({
    outboxProcess: processStub({ ready: false }),
    host: '127.0.0.1',
    port: 0,
    clock: () => new Date('2026-07-30T02:00:02.000Z')
  });
  const address = await health.start();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const live = await fetch(`${base}/health/live`);
    assert.equal(live.status, 200);
    assert.equal((await live.json()).service, 'mandate-outbox-worker');

    const ready = await fetch(`${base}/health/ready`);
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).reason, 'CYCLE_FAILURES');

    const metrics = await fetch(`${base}/metrics`);
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /mandate_outbox_ready 0/);

    const missing = await fetch(`${base}/unknown`);
    assert.equal(missing.status, 404);

    const method = await fetch(`${base}/health/live`, { method: 'POST' });
    assert.equal(method.status, 405);
    assert.equal(method.headers.get('allow'), 'GET, HEAD');
  } finally {
    await health.close();
  }
});
