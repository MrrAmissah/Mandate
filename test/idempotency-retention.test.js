import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  IDEMPOTENCY_RETENTION_MAXIMUM_SECONDS,
  IDEMPOTENCY_RETENTION_MINIMUM_SECONDS,
  assertIdempotencyRetentionSchema,
  cleanupExpiredIdempotencyRecords,
  deleteExpiredIdempotencyBatch,
  parseIdempotencyRetentionConfig
} from '../src/application/idempotency-retention.js';

const entrypointPath = new URL('../scripts/cleanup-idempotency.js', import.meta.url);

function validEnvironment(overrides = {}) {
  return {
    DATABASE_URL: 'postgresql://unused',
    MANDATE_ENVIRONMENT: 'test',
    ...overrides
  };
}

test('idempotency retention configuration keeps a seven-day safety floor', () => {
  const config = parseIdempotencyRetentionConfig(validEnvironment());
  assert.equal(config.retentionSeconds, IDEMPOTENCY_RETENTION_MINIMUM_SECONDS);
  assert.equal(config.batchLimit, 500);
  assert.equal(config.maximumBatches, 20);
  assert.deepEqual(config.scope, { environment: 'test', tenantId: undefined });

  assert.throws(
    () => parseIdempotencyRetentionConfig(validEnvironment({
      MANDATE_IDEMPOTENCY_RETENTION_SECONDS: String(IDEMPOTENCY_RETENTION_MINIMUM_SECONDS - 1)
    })),
    /between 604800 and 7776000/
  );
  assert.throws(
    () => parseIdempotencyRetentionConfig(validEnvironment({
      MANDATE_IDEMPOTENCY_RETENTION_SECONDS: String(IDEMPOTENCY_RETENTION_MAXIMUM_SECONDS + 1)
    })),
    /between 604800 and 7776000/
  );
});

test('idempotency retention configuration fails closed on ambiguous scope and bounds', () => {
  assert.throws(() => parseIdempotencyRetentionConfig({}), /DATABASE_URL is required/);
  assert.throws(
    () => parseIdempotencyRetentionConfig({ DATABASE_URL: 'postgresql://unused' }),
    /explicitly set to test or live/
  );
  assert.throws(
    () => parseIdempotencyRetentionConfig(validEnvironment({ MANDATE_TENANT_ID: 'wrong' })),
    /ten_ prefix/
  );
  assert.throws(
    () => parseIdempotencyRetentionConfig(validEnvironment({ MANDATE_DATABASE_SSL: 'yes' })),
    /must be true or false/
  );
  assert.throws(
    () => parseIdempotencyRetentionConfig(validEnvironment({ MANDATE_IDEMPOTENCY_CLEANUP_BATCH_LIMIT: '0' })),
    /between 1 and 5000/
  );
  assert.throws(
    () => parseIdempotencyRetentionConfig(validEnvironment({ MANDATE_IDEMPOTENCY_CLEANUP_MAX_BATCHES: '1001' })),
    /between 1 and 1000/
  );
});

test('schema readiness requires the retention migration without applying it', async () => {
  await assert.rejects(
    assertIdempotencyRetentionSchema({
      async query() { return { rows: [{ registry_exists: false }], rowCount: 1 }; }
    }),
    /migration registry is unavailable/
  );

  let call = 0;
  await assert.rejects(
    assertIdempotencyRetentionSchema({
      async query() {
        call += 1;
        return call === 1
          ? { rows: [{ registry_exists: true }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
    }),
    /008_idempotency_retention is not applied/
  );
});

test('cleanup batch uses database time, index-aligned locking, and returns counts only', async () => {
  const calls = [];
  let released = false;
  const client = {
    async query(text, parameters = []) {
      calls.push({ text, parameters });
      if (text.includes('DELETE FROM mandate.idempotency_records')) return { rowCount: 2, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release() { released = true; }
  };
  const result = await deleteExpiredIdempotencyBatch(
    { async connect() { return client; } },
    { environment: 'live', tenantId: 'ten_cleanup' },
    { retentionSeconds: 604800, batchLimit: 25 }
  );

  assert.deepEqual(result, { deletedCount: 2 });
  assert.equal(released, true);
  const mutation = calls.find(({ text }) => text.includes('DELETE FROM mandate.idempotency_records'));
  assert.ok(mutation);
  assert.match(mutation.text, /clock_timestamp\(\)/);
  assert.match(mutation.text, /FOR UPDATE OF records SKIP LOCKED/);
  assert.match(mutation.text, /records\.environment = \$1/);
  assert.match(mutation.text, /records\.tenant_id = \$2/);
  assert.match(
    mutation.text,
    /ORDER BY records\.tenant_id, records\.expires_at, records\.created_at,\s+records\.scope, records\.idempotency_key/
  );
  assert.doesNotMatch(mutation.text, /RETURNING/);
  assert.deepEqual(mutation.parameters, ['live', 'ten_cleanup', 604800, 25]);
});

test('cleanup is bounded and uses capped backlog samples instead of full counts', async () => {
  const batchCounts = [2, 2];
  const pool = {
    async connect() {
      return {
        async query(text) {
          if (text.includes('DELETE FROM mandate.idempotency_records')) {
            return { rowCount: batchCounts.shift() ?? 0, rows: [] };
          }
          return { rowCount: 0, rows: [] };
        },
        release() {}
      };
    },
    async query(text, parameters) {
      assert.match(text, /expired_sample AS MATERIALIZED/);
      assert.match(text, /eligible_sample AS MATERIALIZED/);
      assert.equal((text.match(/LIMIT \$4/g) ?? []).length, 2);
      assert.deepEqual(parameters, ['test', null, 604800, 2]);
      return {
        rowCount: 1,
        rows: [{
          expired_sample_count: '2',
          eligible_sample_count: '1',
          has_eligible: true,
          oldest_eligible_at: new Date('2026-01-01T00:00:00.000Z'),
          observed_at: new Date('2026-01-10T00:00:00.000Z')
        }]
      };
    }
  };

  const result = await cleanupExpiredIdempotencyRecords({
    pool,
    scope: { environment: 'test' },
    retentionSeconds: 604800,
    batchLimit: 2,
    maximumBatches: 2
  });
  assert.equal(result.deletedCount, 4);
  assert.equal(result.batches, 2);
  assert.equal(result.limitReached, true);
  assert.equal(result.backlog.sampleLimit, 2);
  assert.equal(result.backlog.eligibleSampleCount, 1);
  assert.equal(result.backlog.expiredSampleCount, 2);
  assert.equal(result.backlog.hasEligible, true);
});

test('cleanup entry point has no API credential or migration authority', async () => {
  const source = await readFile(entrypointPath, 'utf8');
  assert.doesNotMatch(source, /MANDATE_API_KEY/);
  assert.doesNotMatch(source, /applyMigrations|scripts\/migrate|schema_migrations.*INSERT/s);
  assert.doesNotMatch(source, /idempotency_key|response_body/);
  assert.match(source, /assertIdempotencyRetentionSchema/);
  assert.match(source, /IDEMPOTENCY_RETENTION_STARTUP_FAILED/);
});
