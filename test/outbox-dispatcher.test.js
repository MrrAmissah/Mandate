import test from 'node:test';
import assert from 'node:assert/strict';
import { OutboxDispatcher, retryDelayMs, safeOutboxErrorCode } from '../src/outbox/dispatcher.js';

const scope = { tenantId: 'ten_example', environment: 'test' };
const message = {
  tenantId: 'ten_example',
  environment: 'test',
  id: 'out_example',
  eventType: 'mandate.created',
  aggregateType: 'mandate',
  aggregateId: 'mnd_example',
  payload: { type: 'mandate.created' },
  attemptCount: 1,
  lockedAt: '2026-07-29T08:00:00.000Z'
};

test('dispatcher requires an explicit environment scope', () => {
  assert.throws(
    () => new OutboxDispatcher({ queue: { claim() {} }, workerId: 'worker_unscoped' }),
    /environment scope/
  );
});

test('dispatcher with no handlers never claims an event', async () => {
  let claims = 0;
  const dispatcher = new OutboxDispatcher({
    queue: {
      async claim() {
        claims += 1;
      }
    },
    workerId: 'worker_empty',
    scope
  });

  assert.deepEqual(await dispatcher.pollOnce(), { kind: 'IDLE', reason: 'NO_HANDLERS' });
  assert.equal(claims, 0);
});

test('dispatcher processes only exact registered event types inside its scope', async () => {
  const calls = [];
  const queue = {
    async claim(input) {
      assert.deepEqual(input.eventTypes, ['mandate.created']);
      assert.deepEqual(input.scope, scope);
      return { kind: 'CLAIMED', message };
    },
    async succeed(value, input) {
      calls.push({ value, input });
      return { kind: 'PROCESSED', message: value };
    }
  };
  const dispatcher = new OutboxDispatcher({
    queue,
    workerId: 'worker_success',
    scope,
    handlers: {
      'mandate.created': async (payload, claimed) => {
        assert.deepEqual(payload, message.payload);
        assert.equal(claimed.id, message.id);
      }
    },
    now: () => new Date('2026-07-29T08:00:01.000Z')
  });

  const result = await dispatcher.pollOnce();
  assert.equal(result.kind, 'PROCESSED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.workerId, 'worker_success');
});

test('dispatcher schedules a sanitized bounded retry after handler failure', async () => {
  const failures = [];
  const queue = {
    async claim() {
      return { kind: 'CLAIMED', message: { ...message, attemptCount: 3 } };
    },
    async fail(value, input) {
      failures.push({ value, input });
      return { kind: 'RETRY_SCHEDULED', message: value };
    }
  };
  const completedAt = new Date('2026-07-29T08:00:10.000Z');
  const dispatcher = new OutboxDispatcher({
    queue,
    workerId: 'worker_retry',
    scope,
    handlers: {
      'mandate.created': async () => {
        const error = new Error('secret provider body');
        error.code = 'provider-timeout!';
        throw error;
      }
    },
    now: () => completedAt,
    baseDelayMs: 2_000,
    maximumDelayMs: 5_000,
    maxAttempts: 4
  });

  assert.equal((await dispatcher.pollOnce()).kind, 'RETRY_SCHEDULED');
  assert.equal(failures[0].input.errorCode, 'HANDLER_FAILED');
  assert.equal(failures[0].input.retryAt.toISOString(), '2026-07-29T08:00:15.000Z');
  assert.equal(failures[0].input.maxAttempts, 4);
});

test('error codes and exponential delays are bounded', () => {
  assert.equal(safeOutboxErrorCode({ code: 'temporary_failure' }), 'TEMPORARY_FAILURE');
  assert.equal(safeOutboxErrorCode({ code: 'not safe!' }), 'HANDLER_FAILED');
  assert.equal(safeOutboxErrorCode(new Error('private details')), 'HANDLER_FAILED');
  assert.equal(retryDelayMs(1, { baseDelayMs: 1_000, maximumDelayMs: 5_000 }), 1_000);
  assert.equal(retryDelayMs(2, { baseDelayMs: 1_000, maximumDelayMs: 5_000 }), 2_000);
  assert.equal(retryDelayMs(8, { baseDelayMs: 1_000, maximumDelayMs: 5_000 }), 5_000);
});
