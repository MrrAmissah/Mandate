import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  listDeadLetterMessages,
  parseDeadLetterListConfig,
  parseDeadLetterReplayConfig
} from '../src/application/outbox-dead-letter-operations.js';

function listEnvironment(overrides = {}) {
  return {
    DATABASE_URL: 'postgresql://unused',
    MANDATE_ENVIRONMENT: 'test',
    ...overrides
  };
}

function replayEnvironment(overrides = {}) {
  return {
    DATABASE_URL: 'postgresql://unused',
    MANDATE_ENVIRONMENT: 'test',
    MANDATE_TENANT_ID: 'ten_operator',
    MANDATE_OUTBOX_MESSAGE_ID: 'out_failed_message',
    MANDATE_OUTBOX_EXPECTED_ATTEMPT_COUNT: '5',
    MANDATE_OPERATOR_ID: 'operator@example.com',
    MANDATE_OUTBOX_REPLAY_REASON: 'Provider outage was resolved.',
    MANDATE_OUTBOX_REPLAY_IDEMPOTENCY_KEY: 'replay-operation-0001',
    ...overrides
  };
}

test('dead-letter inspection configuration is bounded and optionally scoped', () => {
  const config = parseDeadLetterListConfig(listEnvironment({
    MANDATE_TENANT_ID: 'ten_inspect',
    MANDATE_OUTBOX_EVENT_TYPES: 'mandate.created, receipt.issued,mandate.created',
    MANDATE_OUTBOX_DEAD_LETTER_LIMIT: '50'
  }));
  assert.equal(config.tenantId, 'ten_inspect');
  assert.deepEqual(config.eventTypes, ['mandate.created', 'receipt.issued']);
  assert.equal(config.limit, 50);

  assert.throws(() => parseDeadLetterListConfig({}), /DATABASE_URL is required/);
  assert.throws(
    () => parseDeadLetterListConfig(listEnvironment({ MANDATE_OUTBOX_DEAD_LETTER_LIMIT: '501' })),
    /between 1 and 500/
  );
});

test('dead-letter replay configuration requires explicit optimistic and idempotency controls', () => {
  const config = parseDeadLetterReplayConfig(replayEnvironment());
  assert.equal(config.expectedAttemptCount, 5);
  assert.equal(config.sourceMessageId, 'out_failed_message');
  assert.match(config.requestId, /^req_/);

  assert.throws(
    () => parseDeadLetterReplayConfig(replayEnvironment({ MANDATE_TENANT_ID: '' })),
    /ten_ prefix/
  );
  assert.throws(
    () => parseDeadLetterReplayConfig(replayEnvironment({ MANDATE_OUTBOX_MESSAGE_ID: 'wrong' })),
    /out_ prefix/
  );
  assert.throws(
    () => parseDeadLetterReplayConfig(replayEnvironment({ MANDATE_OUTBOX_EXPECTED_ATTEMPT_COUNT: '0' })),
    /between 1 and 1000000/
  );
  assert.throws(
    () => parseDeadLetterReplayConfig(replayEnvironment({ MANDATE_OUTBOX_REPLAY_IDEMPOTENCY_KEY: 'short' })),
    /at least 16 characters/
  );
  assert.throws(
    () => parseDeadLetterReplayConfig(replayEnvironment({ MANDATE_OUTBOX_REPLAY_REASON: '😀'.repeat(501) })),
    /may not exceed 500 characters/
  );
});

test('dead-letter inspection returns safe metadata without payload or replay secrets', async () => {
  const calls = [];
  const pool = {
    async query(text, parameters) {
      calls.push({ text, parameters });
      return {
        rows: [{
          id: 'out_failed',
          event_type: 'mandate.created',
          aggregate_type: 'mandate',
          aggregate_id: 'man_1',
          status: 'DEAD_LETTER',
          attempt_count: 5,
          processed_at: new Date('2026-07-30T03:00:00.000Z'),
          last_error_code: 'PROVIDER_DOWN',
          created_at: new Date('2026-07-30T02:00:00.000Z'),
          replay_message_id: null,
          payload: { secret: true },
          idempotency_key_hash: 'hidden'
        }]
      };
    }
  };
  const messages = await listDeadLetterMessages(pool, {
    environment: 'test',
    tenantId: 'ten_inspect',
    eventTypes: ['mandate.created'],
    limit: 10
  });
  assert.deepEqual(messages, [{
    id: 'out_failed',
    eventType: 'mandate.created',
    aggregateType: 'mandate',
    aggregateId: 'man_1',
    status: 'DEAD_LETTER',
    attemptCount: 5,
    processedAt: '2026-07-30T03:00:00.000Z',
    lastErrorCode: 'PROVIDER_DOWN',
    createdAt: '2026-07-30T02:00:00.000Z',
    replayMessageId: null
  }]);
  assert.doesNotMatch(calls[0].text, /payload|idempotency_key_hash|request_fingerprint/);
  assert.deepEqual(calls[0].parameters, ['test', 'ten_inspect', ['mandate.created'], 10]);
});

test('dead-letter operator entry points have no API or migration authority', async () => {
  const [listSource, replaySource] = await Promise.all([
    readFile(new URL('../scripts/list-outbox-dead-letters.js', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/replay-outbox-dead-letter.js', import.meta.url), 'utf8')
  ]);
  for (const source of [listSource, replaySource]) {
    assert.doesNotMatch(source, /MANDATE_API_KEY/);
    assert.doesNotMatch(source, /applyMigrations|scripts\/migrate|schema_migrations.*INSERT/s);
    assert.doesNotMatch(source, /idempotencyKey|payload|requestFingerprint/);
  }
  assert.match(listSource, /assertDeadLetterOperationsSchema/);
  assert.match(replaySource, /assertDeadLetterOperationsSchema/);
});
