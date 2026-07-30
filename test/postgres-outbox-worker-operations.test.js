import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OutboxDispatcher } from '../src/outbox/dispatcher.js';
import { PostgresOutboxQueue } from '../src/outbox/postgres-outbox-queue.js';
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
    [tenantId, `Outbox worker ${tenantId}`]
  );
}

async function insertMessage(pool, {
  tenantId,
  environment = 'test',
  eventType = 'test.outbox.event',
  status = 'PENDING',
  availableOffset = '-1 minute',
  processedOffset = null,
  stale = false
}) {
  const auditId = unique('aud_outbox_worker');
  const messageId = unique('out_worker');
  await pool.query(
    `INSERT INTO mandate.audit_events
      (tenant_id, environment, id, sequence, type, object_type, object_id,
       actor_type, actor_id, request_id, data, created_at)
     VALUES ($1,$2,$3,0,'test.event','test_object',$4,'SYSTEM','worker-test',$5,'{}'::jsonb,clock_timestamp())`,
    [tenantId, environment, auditId, messageId, unique('req_outbox_worker')]
  );
  await pool.query(
    `INSERT INTO mandate.outbox_messages
      (tenant_id, environment, id, event_type, aggregate_type, aggregate_id,
       audit_event_id, payload, status, attempt_count, available_at,
       locked_by, locked_at, lock_expires_at, processed_at, last_error_code, created_at)
     VALUES (
       $1,$2,$3,$4,'test_object',$3,$5,'{"safe":true}'::jsonb,$6,$7,
       clock_timestamp() + $8::interval,
       $9,
       CASE WHEN $10::boolean THEN clock_timestamp() - interval '2 minutes' ELSE NULL END,
       CASE WHEN $10::boolean THEN clock_timestamp() - interval '1 minute' ELSE NULL END,
       CASE WHEN $11::text IS NULL THEN NULL ELSE clock_timestamp() + $11::interval END,
       CASE WHEN $6 = 'DEAD_LETTER' THEN 'TEST_FAILURE' ELSE NULL END,
       clock_timestamp() - interval '3 minutes'
     )`,
    [tenantId, environment, messageId, eventType, auditId, status, stale ? 1 : 0,
      availableOffset, stale ? 'worker_stale' : null, stale, processedOffset]
  );
  return messageId;
}

integration('PostgreSQL outbox worker backlog is scoped, bounded, and database-timed', async () => {
  const pool = await createPostgresPool({ connectionString, max: 6 });
  const tenantId = unique('ten_outbox_ops');
  const otherTenant = unique('ten_outbox_other');
  try {
    await createTenant(pool, tenantId);
    await createTenant(pool, otherTenant);
    await insertMessage(pool, { tenantId });
    await insertMessage(pool, { tenantId, stale: true, status: 'PROCESSING' });
    await insertMessage(pool, { tenantId, status: 'DEAD_LETTER', processedOffset: '-30 seconds' });
    await insertMessage(pool, { tenantId, availableOffset: '+1 day' });
    await insertMessage(pool, { tenantId, eventType: 'unregistered.event' });
    await insertMessage(pool, { tenantId: otherTenant });
    await insertMessage(pool, { tenantId, environment: 'live' });

    const migration = await pool.query(
      "SELECT 1 FROM mandate.schema_migrations WHERE version = '009_outbox_worker_operations'"
    );
    assert.equal(migration.rowCount, 1);

    const queue = new PostgresOutboxQueue(pool);
    const databaseNow = await queue.databaseNow();
    assert.ok(databaseNow instanceof Date);
    assert.ok(Math.abs(Date.now() - databaseNow.getTime()) < 30000);

    const backlog = await queue.inspectBacklog({
      scope: { environment: 'test', tenantId },
      eventTypes: ['test.outbox.event'],
      sampleLimit: 10
    });
    assert.equal(backlog.dueSampleCount, 1);
    assert.equal(backlog.staleSampleCount, 1);
    assert.equal(backlog.deadLetterSampleCount, 1);
    assert.equal(backlog.hasDue, true);
    assert.equal(backlog.hasStale, true);
    assert.equal(backlog.hasDeadLetter, true);
    assert.match(backlog.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await pool.end();
  }
});

integration('PostgreSQL-time dispatcher recovers stale work before pending work', async () => {
  const pool = await createPostgresPool({ connectionString, max: 6 });
  const tenantId = unique('ten_outbox_priority');
  try {
    await createTenant(pool, tenantId);
    const pendingId = await insertMessage(pool, { tenantId });
    const staleId = await insertMessage(pool, { tenantId, stale: true, status: 'PROCESSING' });
    const handled = [];
    const queue = new PostgresOutboxQueue(pool);
    const dispatcher = new OutboxDispatcher({
      queue,
      workerId: 'worker_database_time',
      scope: { environment: 'test', tenantId },
      handlers: {
        'test.outbox.event': async (_payload, message) => handled.push(message.id)
      },
      now: () => queue.databaseNow(),
      leaseMs: 30000,
      maxAttempts: 5
    });

    assert.equal((await dispatcher.pollOnce()).kind, 'PROCESSED');
    assert.equal((await dispatcher.pollOnce()).kind, 'PROCESSED');
    assert.deepEqual(handled, [staleId, pendingId]);

    const staleAttempts = await queue.listAttempts({ tenantId, environment: 'test' }, staleId);
    assert.deepEqual(
      staleAttempts.map((attempt) => attempt.outcome),
      ['LEASE_EXPIRED', 'SUCCEEDED']
    );
  } finally {
    await pool.end();
  }
});
