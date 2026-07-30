import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  listDeadLetterMessages,
  replayDeadLetterMessage
} from '../src/application/outbox-dead-letter-operations.js';
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
    [tenantId, `Dead letter ${tenantId}`]
  );
}

async function createDeadLetter(pool, tenantId, {
  eventType = 'test.dead.letter',
  attemptCount = 5,
  payload = { safe: 'payload' }
} = {}) {
  const auditId = unique('aud_dead_letter');
  const messageId = unique('out_dead_letter');
  await pool.query(
    `INSERT INTO mandate.audit_events
      (tenant_id, environment, id, sequence, type, object_type, object_id,
       actor_type, actor_id, request_id, data, created_at)
     VALUES ($1,'test',$2,0,'test.dead_letter','test_object',$3,
             'SYSTEM','test',$4,'{}'::jsonb,clock_timestamp())`,
    [tenantId, auditId, messageId, unique('req_dead_letter')]
  );
  await pool.query(
    `INSERT INTO mandate.outbox_messages
      (tenant_id, environment, id, event_type, aggregate_type, aggregate_id,
       audit_event_id, payload, status, attempt_count, available_at,
       locked_by, locked_at, lock_expires_at, processed_at, last_error_code, created_at)
     VALUES ($1,'test',$2,$3,'test_object',$2,$4,$5::jsonb,
             'DEAD_LETTER',$6,clock_timestamp() - interval '1 day',
             NULL,NULL,NULL,clock_timestamp() - interval '1 hour','TEST_FAILURE',
             clock_timestamp() - interval '2 days')`,
    [tenantId, messageId, eventType, auditId, JSON.stringify(payload), attemptCount]
  );
  return { auditId, messageId };
}

function replayRequest(tenantId, sourceMessageId, overrides = {}) {
  return {
    environment: 'test',
    tenantId,
    sourceMessageId,
    expectedAttemptCount: 5,
    operatorId: 'operator@test',
    reason: 'The downstream outage has been resolved.',
    requestId: unique('req_replay'),
    idempotencyKey: unique('replay_key_000000'),
    ...overrides
  };
}

integration('dead-letter replay preserves business provenance and creates one idempotent replacement', async () => {
  const pool = await createPostgresPool({ connectionString, max: 8 });
  const tenantId = unique('ten_dead_letter');
  const eventType = unique('test.dead.letter');
  try {
    await createTenant(pool, tenantId);
    const { auditId: sourceAuditEventId, messageId: sourceMessageId } = await createDeadLetter(
      pool,
      tenantId,
      { eventType }
    );
    const request = replayRequest(tenantId, sourceMessageId);

    const [first, second] = await Promise.all([
      replayDeadLetterMessage(pool, request),
      replayDeadLetterMessage(pool, { ...request, requestId: unique('req_retry') })
    ]);
    assert.equal(first.id, second.id);
    assert.equal(first.replayMessageId, second.replayMessageId);
    assert.equal(first.sourceMessageId, sourceMessageId);
    assert.equal(first.operatorAuditEventId, second.operatorAuditEventId);

    const source = await pool.query(
      `SELECT status, attempt_count, payload, processed_at, last_error_code,
              audit_event_id, replay_message_id
       FROM mandate.outbox_messages
       WHERE tenant_id = $1 AND environment = 'test' AND id = $2`,
      [tenantId, sourceMessageId]
    );
    assert.equal(source.rows[0].status, 'DEAD_LETTER');
    assert.equal(source.rows[0].attempt_count, 5);
    assert.deepEqual(source.rows[0].payload, { safe: 'payload' });
    assert.equal(source.rows[0].last_error_code, 'TEST_FAILURE');
    assert.equal(source.rows[0].audit_event_id, sourceAuditEventId);
    assert.equal(source.rows[0].replay_message_id, first.replayMessageId);
    assert.ok(source.rows[0].processed_at);

    const replacement = await pool.query(
      `SELECT status, attempt_count, payload, event_type, processed_at,
              last_error_code, audit_event_id, replay_message_id
       FROM mandate.outbox_messages
       WHERE tenant_id = $1 AND environment = 'test' AND id = $2`,
      [tenantId, first.replayMessageId]
    );
    assert.equal(replacement.rows[0].status, 'PENDING');
    assert.equal(replacement.rows[0].attempt_count, 0);
    assert.deepEqual(replacement.rows[0].payload, { safe: 'payload' });
    assert.equal(replacement.rows[0].event_type, eventType);
    assert.equal(replacement.rows[0].processed_at, null);
    assert.equal(replacement.rows[0].last_error_code, null);
    assert.equal(replacement.rows[0].audit_event_id, sourceAuditEventId);
    assert.equal(replacement.rows[0].replay_message_id, null);

    const replayLink = await pool.query(
      `SELECT operator_audit_event_id
       FROM mandate.outbox_dead_letter_replays
       WHERE tenant_id = $1 AND environment = 'test' AND id = $2`,
      [tenantId, first.id]
    );
    assert.equal(replayLink.rows[0].operator_audit_event_id, first.operatorAuditEventId);
    assert.notEqual(first.operatorAuditEventId, sourceAuditEventId);

    const audit = await pool.query(
      `SELECT type, object_id, actor_type, actor_id, data
       FROM mandate.audit_events
       WHERE tenant_id = $1 AND environment = 'test' AND id = $2`,
      [tenantId, first.operatorAuditEventId]
    );
    assert.equal(audit.rows[0].type, 'outbox.dead_letter_replayed');
    assert.equal(audit.rows[0].object_id, sourceMessageId);
    assert.equal(audit.rows[0].actor_type, 'OPERATOR');
    assert.equal(audit.rows[0].actor_id, 'operator@test');
    assert.equal(audit.rows[0].data.replayMessageId, first.replayMessageId);
    assert.equal(audit.rows[0].data.originalAuditEventId, sourceAuditEventId);

    const listed = await listDeadLetterMessages(pool, {
      environment: 'test', tenantId: undefined, eventTypes: [eventType], limit: 10
    });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].tenantId, tenantId);
    assert.equal(listed[0].id, sourceMessageId);
    assert.equal(listed[0].replayMessageId, first.replayMessageId);
    assert.equal('payload' in listed[0], false);

    await assert.rejects(
      replayDeadLetterMessage(pool, { ...request, reason: 'Different input.' }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT'
    );
    await assert.rejects(
      replayDeadLetterMessage(pool, replayRequest(tenantId, sourceMessageId)),
      (error) => error.code === 'OUTBOX_MESSAGE_ALREADY_REPLAYED'
    );
    await assert.rejects(
      pool.query(
        `UPDATE mandate.outbox_dead_letter_replays SET reason = 'changed'
         WHERE tenant_id = $1 AND environment = 'test' AND id = $2`,
        [tenantId, first.id]
      ),
      /immutable table outbox_dead_letter_replays cannot be updated or deleted/
    );
    await assert.rejects(
      pool.query(
        `UPDATE mandate.outbox_messages SET replay_message_id = NULL
         WHERE tenant_id = $1 AND environment = 'test' AND id = $2`,
        [tenantId, sourceMessageId]
      ),
      /outbox replay link is immutable/
    );

    const { messageId: unrelatedId } = await createDeadLetter(pool, tenantId, { eventType });
    await assert.rejects(
      pool.query(
        `UPDATE mandate.outbox_messages SET replay_message_id = $3
         WHERE tenant_id = $1 AND environment = 'test' AND id = $2`,
        [tenantId, unrelatedId, first.replayMessageId]
      ),
      /outbox replay link requires an immutable replay record/
    );
  } finally {
    await pool.end();
  }
});

integration('bounded dead-letter inspection prioritizes indexed unreplayed messages and exact event types', async () => {
  const pool = await createPostgresPool({ connectionString, max: 4 });
  const tenantId = unique('ten_dead_priority');
  const eventType = unique('test,dead.priority');
  try {
    await createTenant(pool, tenantId);
    const { messageId: replayedSourceId } = await createDeadLetter(pool, tenantId, { eventType });
    await replayDeadLetterMessage(pool, replayRequest(tenantId, replayedSourceId));
    const { messageId: actionableSourceId } = await createDeadLetter(pool, tenantId, { eventType });

    const listed = await listDeadLetterMessages(pool, {
      environment: 'test', tenantId, eventTypes: [eventType], limit: 1
    });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, actionableSourceId);
    assert.equal(listed[0].eventType, eventType);
    assert.equal(listed[0].replayMessageId, null);
  } finally {
    await pool.end();
  }
});

integration('dead-letter replay preserves JSONB numbers beyond JavaScript safe integer range', async () => {
  const pool = await createPostgresPool({ connectionString, max: 4 });
  const tenantId = unique('ten_dead_jsonb');
  try {
    await createTenant(pool, tenantId);
    const { messageId: sourceMessageId } = await createDeadLetter(pool, tenantId);
    await pool.query(
      `UPDATE mandate.outbox_messages
       SET payload = jsonb_build_object(
         'large', 9007199254740993::numeric,
         'nested', jsonb_build_object('amount', 9007199254740995::numeric)
       )
       WHERE tenant_id = $1 AND environment = 'test' AND id = $2`,
      [tenantId, sourceMessageId]
    );

    const replay = await replayDeadLetterMessage(pool, replayRequest(tenantId, sourceMessageId));
    const payloads = await pool.query(
      `SELECT id, payload::text AS payload_text, payload->>'large' AS large_value,
              payload #>> '{nested,amount}' AS nested_value
       FROM mandate.outbox_messages
       WHERE tenant_id = $1 AND environment = 'test' AND id = ANY($2::text[])
       ORDER BY id`,
      [tenantId, [sourceMessageId, replay.replayMessageId]]
    );
    assert.equal(payloads.rowCount, 2);
    assert.equal(payloads.rows[0].payload_text, payloads.rows[1].payload_text);
    for (const row of payloads.rows) {
      assert.equal(row.large_value, '9007199254740993');
      assert.equal(row.nested_value, '9007199254740995');
    }
  } finally {
    await pool.end();
  }
});

integration('dead-letter replay fails closed on stale attempt count and permits a linear replay chain', async () => {
  const pool = await createPostgresPool({ connectionString, max: 6 });
  const tenantId = unique('ten_dead_chain');
  try {
    await createTenant(pool, tenantId);
    const { messageId: sourceMessageId } = await createDeadLetter(pool, tenantId);
    await assert.rejects(
      replayDeadLetterMessage(pool, replayRequest(tenantId, sourceMessageId, { expectedAttemptCount: 4 })),
      (error) => error.code === 'OUTBOX_ATTEMPT_COUNT_CONFLICT'
    );

    const first = await replayDeadLetterMessage(pool, replayRequest(tenantId, sourceMessageId));
    await pool.query(
      `UPDATE mandate.outbox_messages
       SET status = 'DEAD_LETTER', attempt_count = 3, processed_at = clock_timestamp(),
           last_error_code = 'SECOND_FAILURE'
       WHERE tenant_id = $1 AND environment = 'test' AND id = $2`,
      [tenantId, first.replayMessageId]
    );
    const second = await replayDeadLetterMessage(pool, replayRequest(
      tenantId,
      first.replayMessageId,
      { expectedAttemptCount: 3 }
    ));
    assert.notEqual(second.replayMessageId, first.replayMessageId);

    const links = await pool.query(
      `SELECT source_message_id, replay_message_id
       FROM mandate.outbox_dead_letter_replays
       WHERE tenant_id = $1 AND environment = 'test'
       ORDER BY created_at, id`,
      [tenantId]
    );
    assert.deepEqual(links.rows, [
      { source_message_id: sourceMessageId, replay_message_id: first.replayMessageId },
      { source_message_id: first.replayMessageId, replay_message_id: second.replayMessageId }
    ]);
  } finally {
    await pool.end();
  }
});
