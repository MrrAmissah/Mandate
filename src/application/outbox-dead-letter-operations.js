import { createHash, randomUUID } from 'node:crypto';

const REQUIRED_MIGRATION = '010_outbox_dead_letter_replays';

function text(value, name, maximum) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new Error(`${name} must contain between 1 and ${maximum} characters.`);
  }
  return value;
}

function codePointText(value, name, maximum) {
  text(value, name, maximum * 4);
  if (Array.from(value).length > maximum) throw new Error(`${name} may not exceed ${maximum} characters.`);
  return value;
}

function integer(value, fallback, { name, minimum, maximum }) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function booleanValue(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('Boolean environment values must be true or false.');
}

function tenantId(value, { optional = false } = {}) {
  if (optional && (value === undefined || value === '')) return undefined;
  if (typeof value !== 'string' || !/^ten_[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('MANDATE_TENANT_ID must use the ten_ prefix.');
  }
  return value;
}

function environment(value) {
  if (!['test', 'live'].includes(value)) throw new Error('MANDATE_ENVIRONMENT must be explicitly set to test or live.');
  return value;
}

function normalizeEventTypes(values) {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) throw new Error('Event type filters must be an array.');
  const normalized = [...new Set(values)];
  if (normalized.length === 0 || normalized.length > 100) {
    throw new Error('Event type filters must contain between 1 and 100 values.');
  }
  for (const eventType of normalized) text(eventType, 'event type', 255);
  return normalized;
}

function eventTypesFromEnvironment(value) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('MANDATE_OUTBOX_EVENT_TYPES must be a comma-separated list or JSON string array.');
    }
    return normalizeEventTypes(parsed);
  }
  return normalizeEventTypes(value.split(',').map((entry) => entry.trim()).filter(Boolean));
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function fingerprint(request) {
  return digest(JSON.stringify({
    environment: request.environment,
    tenantId: request.tenantId,
    sourceMessageId: request.sourceMessageId,
    expectedAttemptCount: request.expectedAttemptCount,
    operatorId: request.operatorId,
    reason: request.reason
  }));
}

function operationalError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeMessage(row) {
  return Object.freeze({
    tenantId: row.tenant_id,
    id: row.id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    status: row.status,
    attemptCount: row.attempt_count,
    processedAt: row.processed_at?.toISOString() ?? null,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at.toISOString(),
    replayMessageId: row.replay_message_id ?? null
  });
}

function replayResult(row) {
  return Object.freeze({
    id: row.id,
    sourceMessageId: row.source_message_id,
    replayMessageId: row.replay_message_id,
    operatorAuditEventId: row.operator_audit_event_id,
    operatorId: row.operator_id,
    reason: row.reason,
    requestId: row.request_id,
    createdAt: row.created_at.toISOString()
  });
}

export function parseDeadLetterListConfig(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for dead-letter inspection.');
  return Object.freeze({
    databaseUrl: env.DATABASE_URL,
    databaseSsl: booleanValue(env.MANDATE_DATABASE_SSL, false),
    databasePoolMax: integer(env.MANDATE_DATABASE_POOL_MAX, 2, {
      name: 'MANDATE_DATABASE_POOL_MAX', minimum: 1, maximum: 100
    }),
    environment: environment(env.MANDATE_ENVIRONMENT),
    tenantId: tenantId(env.MANDATE_TENANT_ID, { optional: true }),
    eventTypes: eventTypesFromEnvironment(env.MANDATE_OUTBOX_EVENT_TYPES),
    limit: integer(env.MANDATE_OUTBOX_DEAD_LETTER_LIMIT, 100, {
      name: 'MANDATE_OUTBOX_DEAD_LETTER_LIMIT', minimum: 1, maximum: 500
    })
  });
}

export function parseDeadLetterReplayConfig(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for dead-letter replay.');
  const sourceMessageId = text(env.MANDATE_OUTBOX_MESSAGE_ID, 'MANDATE_OUTBOX_MESSAGE_ID', 200);
  if (!/^out_[A-Za-z0-9_-]+$/.test(sourceMessageId)) throw new Error('MANDATE_OUTBOX_MESSAGE_ID must use the out_ prefix.');
  const idempotencyKey = text(
    env.MANDATE_OUTBOX_REPLAY_IDEMPOTENCY_KEY,
    'MANDATE_OUTBOX_REPLAY_IDEMPOTENCY_KEY',
    256
  );
  if (idempotencyKey.length < 16) throw new Error('MANDATE_OUTBOX_REPLAY_IDEMPOTENCY_KEY must contain at least 16 characters.');
  const operatorId = text(env.MANDATE_OPERATOR_ID, 'MANDATE_OPERATOR_ID', 200);
  const reason = codePointText(env.MANDATE_OUTBOX_REPLAY_REASON, 'MANDATE_OUTBOX_REPLAY_REASON', 500);
  const requestId = env.MANDATE_REQUEST_ID || `req_${randomUUID()}`;
  if (!/^req_[A-Za-z0-9_-]+$/.test(requestId)) throw new Error('MANDATE_REQUEST_ID must use the req_ prefix.');

  return Object.freeze({
    databaseUrl: env.DATABASE_URL,
    databaseSsl: booleanValue(env.MANDATE_DATABASE_SSL, false),
    databasePoolMax: integer(env.MANDATE_DATABASE_POOL_MAX, 2, {
      name: 'MANDATE_DATABASE_POOL_MAX', minimum: 1, maximum: 100
    }),
    environment: environment(env.MANDATE_ENVIRONMENT),
    tenantId: tenantId(env.MANDATE_TENANT_ID),
    sourceMessageId,
    expectedAttemptCount: integer(env.MANDATE_OUTBOX_EXPECTED_ATTEMPT_COUNT, undefined, {
      name: 'MANDATE_OUTBOX_EXPECTED_ATTEMPT_COUNT', minimum: 1, maximum: 1000000
    }),
    operatorId,
    reason,
    requestId,
    idempotencyKey
  });
}

export async function assertDeadLetterOperationsSchema(pool) {
  const registry = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'mandate' AND table_name = 'schema_migrations'
     ) AS registry_exists`
  );
  if (!registry.rows[0]?.registry_exists) {
    throw new Error('Mandate migration registry is unavailable. Run migrations with the deployment role first.');
  }
  const migration = await pool.query(
    'SELECT 1 FROM mandate.schema_migrations WHERE version = $1',
    [REQUIRED_MIGRATION]
  );
  if (migration.rowCount !== 1) throw new Error(`Required migration ${REQUIRED_MIGRATION} is not applied.`);
}

export async function listDeadLetterMessages(pool, {
  environment: scopeEnvironment,
  tenantId: scopeTenantId,
  eventTypes: types,
  limit = 100
}) {
  environment(scopeEnvironment);
  tenantId(scopeTenantId, { optional: true });
  integer(limit, 100, { name: 'limit', minimum: 1, maximum: 500 });
  const normalizedTypes = normalizeEventTypes(types) ?? null;
  const result = await pool.query(
    `WITH unreplayed AS MATERIALIZED (
       SELECT 0 AS replay_priority, messages.tenant_id, messages.id,
              messages.event_type, messages.aggregate_type, messages.aggregate_id,
              messages.status, messages.attempt_count, messages.processed_at,
              messages.last_error_code, messages.created_at,
              NULL::text AS replay_message_id
       FROM mandate.outbox_messages messages
       WHERE messages.environment = $1
         AND ($2::text IS NULL OR messages.tenant_id = $2)
         AND ($3::text[] IS NULL OR messages.event_type = ANY($3::text[]))
         AND messages.status = 'DEAD_LETTER'
         AND NOT EXISTS (
           SELECT 1 FROM mandate.outbox_dead_letter_replays replay
           WHERE replay.tenant_id = messages.tenant_id
             AND replay.environment = messages.environment
             AND replay.source_message_id = messages.id
         )
       ORDER BY messages.tenant_id, messages.event_type, messages.processed_at,
                messages.created_at, messages.id
       LIMIT $4
     ), replayed AS MATERIALIZED (
       SELECT 1 AS replay_priority, messages.tenant_id, messages.id,
              messages.event_type, messages.aggregate_type, messages.aggregate_id,
              messages.status, messages.attempt_count, messages.processed_at,
              messages.last_error_code, messages.created_at, replay.replay_message_id
       FROM mandate.outbox_messages messages
       JOIN mandate.outbox_dead_letter_replays replay
         ON replay.tenant_id = messages.tenant_id
        AND replay.environment = messages.environment
        AND replay.source_message_id = messages.id
       WHERE messages.environment = $1
         AND ($2::text IS NULL OR messages.tenant_id = $2)
         AND ($3::text[] IS NULL OR messages.event_type = ANY($3::text[]))
         AND messages.status = 'DEAD_LETTER'
       ORDER BY messages.tenant_id, messages.event_type, messages.processed_at,
                messages.created_at, messages.id
       LIMIT GREATEST($4 - (SELECT count(*) FROM unreplayed), 0)
     ), sample AS (
       SELECT * FROM unreplayed
       UNION ALL
       SELECT * FROM replayed
     )
     SELECT tenant_id, id, event_type, aggregate_type, aggregate_id, status,
            attempt_count, processed_at, last_error_code, created_at, replay_message_id
     FROM sample
     ORDER BY replay_priority, tenant_id, event_type, processed_at, created_at, id`,
    [scopeEnvironment, scopeTenantId ?? null, normalizedTypes, limit]
  );
  return Object.freeze(result.rows.map(safeMessage));
}

export async function replayDeadLetterMessage(pool, request) {
  const normalized = {
    environment: environment(request.environment),
    tenantId: tenantId(request.tenantId),
    sourceMessageId: text(request.sourceMessageId, 'sourceMessageId', 200),
    expectedAttemptCount: integer(request.expectedAttemptCount, undefined, {
      name: 'expectedAttemptCount', minimum: 1, maximum: 1000000
    }),
    operatorId: text(request.operatorId, 'operatorId', 200),
    reason: codePointText(request.reason, 'reason', 500),
    requestId: text(request.requestId, 'requestId', 200),
    idempotencyKey: text(request.idempotencyKey, 'idempotencyKey', 256)
  };
  if (!/^out_[A-Za-z0-9_-]+$/.test(normalized.sourceMessageId)) {
    throw new Error('sourceMessageId must use the out_ prefix.');
  }
  if (!/^req_[A-Za-z0-9_-]+$/.test(normalized.requestId)) {
    throw new Error('requestId must use the req_ prefix.');
  }
  if (normalized.idempotencyKey.length < 16) throw new Error('idempotencyKey must contain at least 16 characters.');

  const keyHash = digest(normalized.idempotencyKey);
  const requestFingerprint = fingerprint(normalized);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`outbox-replay:${normalized.tenantId}:${normalized.environment}:${keyHash}`]
    );

    const existing = await client.query(
      `SELECT * FROM mandate.outbox_dead_letter_replays
       WHERE tenant_id = $1 AND environment = $2 AND idempotency_key_hash = $3`,
      [normalized.tenantId, normalized.environment, keyHash]
    );
    if (existing.rowCount === 1) {
      if (existing.rows[0].request_fingerprint !== requestFingerprint) {
        throw operationalError('IDEMPOTENCY_CONFLICT', 'The replay idempotency key was already used for different input.');
      }
      await client.query('COMMIT');
      return replayResult(existing.rows[0]);
    }

    const sourceResult = await client.query(
      `SELECT * FROM mandate.outbox_messages
       WHERE tenant_id = $1 AND environment = $2 AND id = $3
       FOR UPDATE`,
      [normalized.tenantId, normalized.environment, normalized.sourceMessageId]
    );
    const source = sourceResult.rows[0];
    if (!source) throw operationalError('OUTBOX_MESSAGE_NOT_FOUND', 'The outbox message was not found.');
    if (source.status !== 'DEAD_LETTER') {
      throw operationalError('OUTBOX_MESSAGE_NOT_DEAD_LETTER', 'Only dead-letter messages can be replayed.');
    }
    if (source.attempt_count !== normalized.expectedAttemptCount) {
      throw operationalError('OUTBOX_ATTEMPT_COUNT_CONFLICT', 'The outbox attempt count changed before replay.');
    }

    const priorReplay = await client.query(
      `SELECT replay_message_id FROM mandate.outbox_dead_letter_replays
       WHERE tenant_id = $1 AND environment = $2 AND source_message_id = $3`,
      [normalized.tenantId, normalized.environment, normalized.sourceMessageId]
    );
    if (priorReplay.rowCount > 0) {
      throw operationalError('OUTBOX_MESSAGE_ALREADY_REPLAYED', 'The dead-letter message already has a replacement.');
    }

    const observed = await client.query('SELECT clock_timestamp() AS observed_at');
    const createdAt = observed.rows[0].observed_at;
    const replayId = `odr_${randomUUID()}`;
    const replayMessageId = `out_${randomUUID()}`;
    const operatorAuditEventId = `aud_${randomUUID()}`;

    await client.query(
      `INSERT INTO mandate.audit_events
        (tenant_id, environment, id, sequence, type, object_type, object_id,
         actor_type, actor_id, request_id, data, created_at)
       VALUES ($1,$2,$3,0,'outbox.dead_letter_replayed','outbox_message',$4,
               'OPERATOR',$5,$6,$7::jsonb,$8)`,
      [normalized.tenantId, normalized.environment, operatorAuditEventId,
        normalized.sourceMessageId, normalized.operatorId, normalized.requestId,
        JSON.stringify({
          sourceMessageId: normalized.sourceMessageId,
          replayMessageId,
          originalAuditEventId: source.audit_event_id,
          reason: normalized.reason
        }),
        createdAt]
    );

    const replacement = await client.query(
      `INSERT INTO mandate.outbox_messages
        (tenant_id, environment, id, event_type, aggregate_type, aggregate_id,
         audit_event_id, payload, status, attempt_count, available_at,
         locked_by, locked_at, lock_expires_at, processed_at, last_error_code, created_at)
       SELECT source.tenant_id, source.environment, $4, source.event_type,
              source.aggregate_type, source.aggregate_id, source.audit_event_id,
              source.payload, 'PENDING', 0, $5, NULL, NULL, NULL, NULL, NULL, $5
       FROM mandate.outbox_messages source
       WHERE source.tenant_id = $1 AND source.environment = $2 AND source.id = $3
       RETURNING id`,
      [normalized.tenantId, normalized.environment, normalized.sourceMessageId,
        replayMessageId, createdAt]
    );
    if (replacement.rowCount !== 1) {
      throw operationalError('OUTBOX_MESSAGE_NOT_FOUND', 'The outbox message was not found.');
    }

    const replay = await client.query(
      `INSERT INTO mandate.outbox_dead_letter_replays
        (tenant_id, environment, id, source_message_id, replay_message_id,
         operator_audit_event_id, operator_id, reason, idempotency_key_hash,
         request_fingerprint, request_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [normalized.tenantId, normalized.environment, replayId,
        normalized.sourceMessageId, replayMessageId, operatorAuditEventId,
        normalized.operatorId, normalized.reason, keyHash, requestFingerprint,
        normalized.requestId, createdAt]
    );
    await client.query('COMMIT');
    return replayResult(replay.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
