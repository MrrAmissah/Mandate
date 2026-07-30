import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiHealth, parseApiHealthConfig } from '../src/application/api-health.js';
import { createServerHandler } from '../src/http/server-handler.js';

function fixedClock() {
  return new Date('2026-07-30T00:00:00.000Z');
}

function responseCapture() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = JSON.parse(body);
    }
  };
}

function runtimeWithHealth(health) {
  return {
    health,
    signingKeys: {},
    authenticator: {},
    store: {},
    signer: {}
  };
}

test('API health configuration is bounded', () => {
  assert.equal(parseApiHealthConfig({}).queryTimeoutMs, 2000);
  assert.equal(parseApiHealthConfig({ MANDATE_API_READINESS_TIMEOUT_MS: '750' }).queryTimeoutMs, 750);
  assert.throws(
    () => parseApiHealthConfig({ MANDATE_API_READINESS_TIMEOUT_MS: '99' }),
    /between 100 and 10000/
  );
});

test('memory mode is live and explicitly identifies reference-store readiness', async () => {
  const health = createApiHealth({ mode: 'memory', clock: fixedClock });
  assert.deepEqual(health.liveness(), {
    live: true,
    status: 'ok',
    service: 'mandate-api',
    checkedAt: '2026-07-30T00:00:00.000Z'
  });
  assert.deepEqual(await health.readiness(), {
    ready: true,
    reason: 'READY_REFERENCE_STORE',
    mode: 'memory',
    checkedAt: '2026-07-30T00:00:00.000Z'
  });
});

test('PostgreSQL readiness checks the required migration with a bounded query timeout', async () => {
  const calls = [];
  const pool = {
    async query(config) {
      calls.push(config);
      return {
        rows: [{ migration_ready: true, observed_at: new Date('2026-07-30T00:00:01.000Z') }]
      };
    }
  };
  const health = createApiHealth({ mode: 'postgres', pool, queryTimeoutMs: 750, clock: fixedClock });
  assert.deepEqual(await health.readiness(), {
    ready: true,
    reason: 'READY',
    mode: 'postgres',
    requiredMigration: '010_outbox_dead_letter_replays',
    databaseObservedAt: '2026-07-30T00:00:01.000Z',
    checkedAt: '2026-07-30T00:00:00.000Z'
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query_timeout, 750);
  assert.deepEqual(calls[0].values, ['010_outbox_dead_letter_replays']);
});

test('readiness fails closed for missing migration, database errors and shutdown', async () => {
  const missing = createApiHealth({
    mode: 'postgres',
    pool: { async query() { return { rows: [{ migration_ready: false }] }; } },
    clock: fixedClock
  });
  assert.equal((await missing.readiness()).reason, 'MIGRATION_NOT_READY');

  const unavailable = createApiHealth({
    mode: 'postgres',
    pool: { async query() { throw new Error('do not expose this'); } },
    clock: fixedClock
  });
  assert.deepEqual(await unavailable.readiness(), {
    ready: false,
    reason: 'DATABASE_UNAVAILABLE',
    mode: 'postgres',
    requiredMigration: '010_outbox_dead_letter_replays',
    checkedAt: '2026-07-30T00:00:00.000Z'
  });

  missing.beginShutdown();
  assert.equal((await missing.readiness()).reason, 'SHUTTING_DOWN');
});

test('server health routes return liveness and readiness without authentication', async () => {
  const health = createApiHealth({ mode: 'memory', clock: fixedClock });
  const handler = createServerHandler(runtimeWithHealth(health));

  const liveResponse = responseCapture();
  await handler({ method: 'GET', url: '/health/live', headers: {} }, liveResponse);
  assert.equal(liveResponse.status, 200);
  assert.equal(liveResponse.body.live, true);
  assert.match(liveResponse.body.requestId, /^req_/);

  const readyResponse = responseCapture();
  await handler({ method: 'GET', url: '/health/ready', headers: {} }, readyResponse);
  assert.equal(readyResponse.status, 200);
  assert.equal(readyResponse.body.reason, 'READY_REFERENCE_STORE');

  health.beginShutdown();
  const shutdownResponse = responseCapture();
  await handler({ method: 'GET', url: '/health/ready', headers: {} }, shutdownResponse);
  assert.equal(shutdownResponse.status, 503);
  assert.equal(shutdownResponse.body.reason, 'SHUTTING_DOWN');
});
