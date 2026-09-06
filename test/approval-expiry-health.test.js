import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import {
  createApprovalExpiryHealthServer,
  renderApprovalExpiryMetrics
} from '../src/application/approval-expiry-health.js';

function observableProcess() {
  let ready = false;
  const snapshot = {
    cycles: 7,
    expiredTotal: 11,
    failures: 2,
    limitReachedTotal: 1,
    consecutiveFailures: 1,
    lastCycleAt: '2026-09-06T12:00:00.000Z',
    lastSuccessAt: '2026-09-06T11:59:59.000Z',
    lastErrorCode: '40001',
    backlogExpiring: 5,
    backlogDue: 3,
    oldestDueAt: '2026-09-06T11:58:00.000Z',
    oldestOverdueSeconds: 120,
    backlogObservedAt: '2026-09-06T12:00:00.000Z',
    running: true,
    shuttingDown: false,
    startedAt: '2026-09-06T11:00:00.000Z',
    stoppedAt: null
  };
  return {
    setReady(value) { ready = value; },
    snapshot() { return Object.freeze({ ...snapshot }); },
    readiness(now) {
      return Object.freeze({
        ready,
        reason: ready ? 'READY' : 'CYCLE_FAILURES',
        checkedAt: now.toISOString(),
        lastSuccessAt: snapshot.lastSuccessAt,
        consecutiveFailures: snapshot.consecutiveFailures
      });
    }
  };
}

function rawHttpRequest({ host, port, request }) {
  return new Promise((resolve, reject) => {
    let response = '';
    const socket = connect({ host, port }, () => socket.write(request));
    socket.setEncoding('utf8');
    socket.setTimeout(2000, () => socket.destroy(new Error('raw health request timed out')));
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

test('approval expiry health exposes liveness, cached readiness, and Prometheus metrics', async () => {
  const expiryProcess = observableProcess();
  const clock = () => new Date('2026-09-06T12:00:01.000Z');
  const health = createApprovalExpiryHealthServer({ expiryProcess, host: '127.0.0.1', port: 0, clock });
  const address = await health.start();
  const base = `http://${address.host}:${address.port}`;
  try {
    const live = await fetch(`${base}/health/live`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), {
      status: 'ok',
      service: 'mandate-approval-expiry',
      at: '2026-09-06T12:00:01.000Z'
    });
    assert.equal(live.headers.get('cache-control'), 'no-store');

    const unready = await fetch(`${base}/health/ready`);
    assert.equal(unready.status, 503);
    assert.equal((await unready.json()).reason, 'CYCLE_FAILURES');

    expiryProcess.setReady(true);
    const ready = await fetch(`${base}/health/ready`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).status, 'ready');

    const metrics = await fetch(`${base}/metrics`);
    assert.equal(metrics.status, 200);
    const text = await metrics.text();
    assert.match(text, /mandate_approval_expiry_cycles_total 7/);
    assert.match(text, /mandate_approval_expiry_expired_total 11/);
    assert.match(text, /mandate_approval_expiry_backlog_expiring 5/);
    assert.match(text, /mandate_approval_expiry_backlog_due 3/);
    assert.match(text, /mandate_approval_expiry_oldest_overdue_seconds 120/);
    assert.match(text, /mandate_approval_expiry_ready 1/);

    const head = await fetch(`${base}/metrics`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    const method = await fetch(`${base}/metrics`, { method: 'POST' });
    assert.equal(method.status, 405);
    assert.equal(method.headers.get('allow'), 'GET, HEAD');

    assert.equal((await fetch(`${base}/missing`)).status, 404);
  } finally {
    await health.close();
  }
});

test('approval expiry health survives malformed request targets', async () => {
  const expiryProcess = observableProcess();
  const health = createApprovalExpiryHealthServer({
    expiryProcess,
    host: '127.0.0.1',
    port: 0,
    clock: () => new Date('2026-09-06T12:00:01.000Z')
  });
  const address = await health.start();
  try {
    const malformed = await rawHttpRequest({
      host: address.host,
      port: address.port,
      request: 'GET http://[ HTTP/1.1\r\nHost: health.local\r\nConnection: close\r\n\r\n'
    });
    assert.match(malformed, /^HTTP\/1\.1 400/);
    assert.equal((await fetch(`http://${address.host}:${address.port}/health/live`)).status, 200);
  } finally {
    await health.close();
  }
});

test('approval expiry metrics render zero before backlog observation', () => {
  const expiryProcess = {
    snapshot() {
      return {
        cycles: 0,
        expiredTotal: 0,
        failures: 0,
        limitReachedTotal: 0,
        consecutiveFailures: 0,
        lastSuccessAt: null,
        backlogExpiring: null,
        backlogDue: null,
        oldestOverdueSeconds: null,
        backlogObservedAt: null
      };
    },
    readiness(now) {
      return { ready: false, reason: 'STARTING', checkedAt: now.toISOString() };
    }
  };
  const metrics = renderApprovalExpiryMetrics(expiryProcess, new Date('2026-09-06T12:00:00.000Z'));
  assert.match(metrics, /mandate_approval_expiry_backlog_expiring 0/);
  assert.match(metrics, /mandate_approval_expiry_backlog_due 0/);
  assert.match(metrics, /mandate_approval_expiry_backlog_observed_unixtime_seconds 0/);
  assert.match(metrics, /mandate_approval_expiry_ready 0/);
});
