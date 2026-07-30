import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  cleanupExpiredIdempotencyRecords,
  inspectIdempotencyRetentionBacklog
} from '../src/application/idempotency-retention.js';
import { createPostgresPool } from '../src/store/postgres-store.js';

const connectionString = process.env.DATABASE_URL;
const integration = connectionString ? test : test.skip;

function unique(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

async function createTenant(pool, tenantId) {
  await pool.query(
    `INSERT INTO mandate.tenants (id, name, status, created_at, updated_at)
     VALUES ($1,$2,'ACTIVE',clock_timestamp(),clock_timestamp())`,
    [tenantId, `Retention tenant ${tenantId}`]
  );
}

async function insertRecord(pool, {
  tenantId,
  environment,
  key,
  createdOffset,
  expiresOffset
}) {
  await pool.query(
    `INSERT INTO mandate.idempotency_records
      (tenant_id, environment, scope, idempotency_key, request_fingerprint,
       response_status, response_headers, response_body, created_at, expires_at)
     VALUES (
       $1,$2,'create-mandate',$3,$4,201,'{}'::jsonb,'{}'::jsonb,
       clock_timestamp() + $5::interval,
       clock_timestamp() + $6::interval
     )`,
    [tenantId, environment, key, `sha256:${'a'.repeat(64)}`, createdOffset, expiresOffset]
  );
}

integration('PostgreSQL idempotency cleanup is scoped, bounded, and multi-worker safe', async () => {
  const pool = await createPostgresPool({ connectionString, max: 8 });
  const tenantA = unique('ten_retention_a');
  const tenantB = unique('ten_retention_b');
  try {
    await createTenant(pool, tenantA);
    await createTenant(pool, tenantB);

    for (let index = 0; index < 3; index += 1) {
      await insertRecord(pool, {
        tenantId: tenantA,
        environment: 'test',
        key: unique(`eligible_${index}`),
        createdOffset: '-8 days',
        expiresOffset: '-1 day'
      });
    }
    await insertRecord(pool, {
      tenantId: tenantA,
      environment: 'test',
      key: unique('young_expired'),
      createdOffset: '-6 days',
      expiresOffset: '-1 hour'
    });
    await insertRecord(pool, {
      tenantId: tenantA,
      environment: 'test',
      key: unique('future'),
      createdOffset: '-1 day',
      expiresOffset: '+6 days'
    });
    await insertRecord(pool, {
      tenantId: tenantB,
      environment: 'test',
      key: unique('other_tenant'),
      createdOffset: '-8 days',
      expiresOffset: '-1 day'
    });
    await insertRecord(pool, {
      tenantId: tenantA,
      environment: 'live',
      key: unique('other_environment'),
      createdOffset: '-8 days',
      expiresOffset: '-1 day'
    });

    const scope = { environment: 'test', tenantId: tenantA };
    const [first, second] = await Promise.all([
      cleanupExpiredIdempotencyRecords({
        pool, scope, retentionSeconds: 604800, batchLimit: 1, maximumBatches: 1
      }),
      cleanupExpiredIdempotencyRecords({
        pool, scope, retentionSeconds: 604800, batchLimit: 1, maximumBatches: 1
      })
    ]);
    assert.equal(first.deletedCount + second.deletedCount, 2);

    const final = await cleanupExpiredIdempotencyRecords({
      pool, scope, retentionSeconds: 604800, batchLimit: 10, maximumBatches: 10
    });
    assert.equal(final.deletedCount, 1);
    assert.equal(final.limitReached, false);

    const backlog = await inspectIdempotencyRetentionBacklog(pool, scope, {
      retentionSeconds: 604800
    });
    assert.equal(backlog.eligibleCount, 0);
    assert.equal(backlog.expiredCount, 1);
    assert.equal(backlog.oldestEligibleAt, null);
    assert.match(backlog.observedAt, /^\d{4}-\d{2}-\d{2}T/);

    const tenantACount = await pool.query(
      `SELECT count(*)::integer AS count
       FROM mandate.idempotency_records
       WHERE tenant_id = $1 AND environment = 'test'`,
      [tenantA]
    );
    assert.equal(tenantACount.rows[0].count, 2);

    const isolatedRows = await pool.query(
      `SELECT tenant_id, environment, count(*)::integer AS count
       FROM mandate.idempotency_records
       WHERE (tenant_id = $1 AND environment = 'test')
          OR (tenant_id = $2 AND environment = 'live')
       GROUP BY tenant_id, environment
       ORDER BY tenant_id, environment`,
      [tenantB, tenantA]
    );
    assert.deepEqual(isolatedRows.rows, [
      { tenant_id: tenantA, environment: 'live', count: 1 },
      { tenant_id: tenantB, environment: 'test', count: 1 }
    ].sort((left, right) => `${left.tenant_id}:${left.environment}`.localeCompare(`${right.tenant_id}:${right.environment}`)));
  } finally {
    await pool.end();
  }
});
