import { randomUUID } from 'node:crypto';

function requiredText(value, name, maximum = 200) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new TypeError(`${name} must contain between 1 and ${maximum} characters.`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function instant(value, name) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${name} must be a valid timestamp.`);
  return parsed;
}

function owner(value) {
  if (
    !value ||
    typeof value.tenantId !== 'string' ||
    !/^ten_[A-Za-z0-9_-]+$/.test(value.tenantId) ||
    !['test', 'live'].includes(value.environment)
  ) {
    throw new TypeError('A valid tenantId and test/live environment is required.');
  }
  return value;
}

function messageFromRow(row) {
  if (!row) return null;
  return {
    tenantId: row.tenant_id,
    environment: row.environment,
    id: row.id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    auditEventId: row.audit_event_id,
    payload: row.payload,
    status: row.status,
    attemptCount: row.attempt_count,
    availableAt: row.available_at?.toISOString(),
    lockedBy: row.locked_by,
    lockedAt: row.locked_at?.toISOString() ?? null,
    lockExpiresAt: row.lock_expires_at?.toISOString() ?? null,
    processedAt: row.processed_at?.toISOString() ?? null,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at?.toISOString()
  };
}

function attemptFromRow(row) {
  return {
    id: row.id,
    outboxMessageId: row.outbox_message_id,
    attemptNumber: row.attempt_number,
    workerId: row.worker_id,
    outcome: row.outcome,
    errorCode: row.error_code,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at.toISOString(),
    createdAt: row.created_at.toISOString()
  };
}

async function appendAttempt(client, {
  tenantId,
  environment,
  messageId,
  attemptNumber,
  workerId,
  outcome,
  errorCode = null,
  startedAt,
  completedAt
}) {
  await client.query(
    `INSERT INTO mandate.outbox_attempts
      (tenant_id, environment, id, outbox_message_id, attempt_number, worker_id, outcome,
       error_code, started_at, completed_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
     ON CONFLICT (tenant_id, environment, outbox_message_id, attempt_number, outcome)
     DO NOTHING`,
    [tenantId, environment, `oba_${randomUUID()}`, messageId, attemptNumber, workerId,
      outcome, errorCode, startedAt, completedAt]
  );
}

export class PostgresOutboxQueue {
  constructor(pool) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required.');
    this.pool = pool;
  }

  async claim({
    workerId,
    eventTypes,
    now = new Date(),
    leaseMs = 30_000,
    maxAttempts = 5
  }) {
    requiredText(workerId, 'workerId');
    positiveInteger(leaseMs, 'leaseMs');
    positiveInteger(maxAttempts, 'maxAttempts');
    if (!Array.isArray(eventTypes) || eventTypes.length === 0) return null;
    const types = [...new Set(eventTypes.map((value) => requiredText(value, 'eventType', 255)))];
    const claimedAt = instant(now, 'now');
    const leaseExpiresAt = new Date(claimedAt.getTime() + leaseMs);
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const candidate = await client.query(
        `SELECT *
         FROM mandate.outbox_messages
         WHERE event_type = ANY($1::text[])
           AND (
             (status = 'PENDING' AND available_at <= $2)
             OR (status = 'PROCESSING' AND lock_expires_at <= $2)
           )
         ORDER BY
           CASE WHEN status = 'PROCESSING' THEN 0 ELSE 1 END,
           available_at,
           created_at,
           id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [types, claimedAt]
      );
      const row = candidate.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }

      if (row.status === 'PROCESSING') {
        await appendAttempt(client, {
          tenantId: row.tenant_id,
          environment: row.environment,
          messageId: row.id,
          attemptNumber: row.attempt_count,
          workerId: row.locked_by,
          outcome: 'LEASE_EXPIRED',
          errorCode: 'LEASE_EXPIRED',
          startedAt: row.locked_at,
          completedAt: claimedAt
        });
      }

      if (row.attempt_count >= maxAttempts) {
        const exhausted = await client.query(
          `UPDATE mandate.outbox_messages
           SET status = 'DEAD_LETTER', processed_at = $4, last_error_code = $5,
               locked_by = NULL, locked_at = NULL, lock_expires_at = NULL
           WHERE tenant_id = $1 AND environment = $2 AND id = $3
           RETURNING *`,
          [row.tenant_id, row.environment, row.id, claimedAt, 'ATTEMPT_LIMIT_REACHED']
        );
        await appendAttempt(client, {
          tenantId: row.tenant_id,
          environment: row.environment,
          messageId: row.id,
          attemptNumber: Math.max(row.attempt_count, 1),
          workerId,
          outcome: 'DEAD_LETTER',
          errorCode: 'ATTEMPT_LIMIT_REACHED',
          startedAt: row.locked_at ?? claimedAt,
          completedAt: claimedAt
        });
        await client.query('COMMIT');
        return { kind: 'DEAD_LETTERED', message: messageFromRow(exhausted.rows[0]) };
      }

      const claimed = await client.query(
        `UPDATE mandate.outbox_messages
         SET status = 'PROCESSING', attempt_count = attempt_count + 1,
             locked_by = $4, locked_at = $5, lock_expires_at = $6,
             processed_at = NULL
         WHERE tenant_id = $1 AND environment = $2 AND id = $3
         RETURNING *`,
        [row.tenant_id, row.environment, row.id, workerId, claimedAt, leaseExpiresAt]
      );
      await client.query('COMMIT');
      return { kind: 'CLAIMED', message: messageFromRow(claimed.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async succeed(message, { workerId, now = new Date() }) {
    return this.#complete(message, {
      workerId,
      now,
      errorCode: null,
      maxAttempts: message.attemptCount,
      retryAt: null,
      success: true
    });
  }

  async fail(message, {
    workerId,
    errorCode,
    retryAt,
    maxAttempts,
    now = new Date()
  }) {
    requiredText(errorCode, 'errorCode', 64);
    positiveInteger(maxAttempts, 'maxAttempts');
    return this.#complete(message, {
      workerId,
      now,
      errorCode,
      maxAttempts,
      retryAt: instant(retryAt, 'retryAt'),
      success: false
    });
  }

  async #complete(message, {
    workerId,
    now,
    errorCode,
    maxAttempts,
    retryAt,
    success
  }) {
    const ownership = owner(message);
    requiredText(workerId, 'workerId');
    positiveInteger(message.attemptCount, 'message.attemptCount');
    const completedAt = instant(now, 'now');
    const startedAt = instant(message.lockedAt, 'message.lockedAt');
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT * FROM mandate.outbox_messages
         WHERE tenant_id = $1 AND environment = $2 AND id = $3
         FOR UPDATE`,
        [ownership.tenantId, ownership.environment, message.id]
      );
      const row = current.rows[0];
      const ownsLease = row
        && row.status === 'PROCESSING'
        && row.locked_by === workerId
        && row.attempt_count === message.attemptCount
        && row.lock_expires_at > completedAt;

      if (!ownsLease) {
        await appendAttempt(client, {
          tenantId: ownership.tenantId,
          environment: ownership.environment,
          messageId: message.id,
          attemptNumber: message.attemptCount,
          workerId,
          outcome: 'LEASE_LOST',
          startedAt,
          completedAt
        });
        await client.query('COMMIT');
        return { kind: 'LEASE_LOST', message: messageFromRow(row) };
      }

      if (success) {
        const updated = await client.query(
          `UPDATE mandate.outbox_messages
           SET status = 'PROCESSED', processed_at = $4, last_error_code = NULL,
               locked_by = NULL, locked_at = NULL, lock_expires_at = NULL
           WHERE tenant_id = $1 AND environment = $2 AND id = $3
           RETURNING *`,
          [ownership.tenantId, ownership.environment, message.id, completedAt]
        );
        await appendAttempt(client, {
          tenantId: ownership.tenantId,
          environment: ownership.environment,
          messageId: message.id,
          attemptNumber: message.attemptCount,
          workerId,
          outcome: 'SUCCEEDED',
          startedAt,
          completedAt
        });
        await client.query('COMMIT');
        return { kind: 'PROCESSED', message: messageFromRow(updated.rows[0]) };
      }

      const deadLetter = message.attemptCount >= maxAttempts;
      const updated = await client.query(
        `UPDATE mandate.outbox_messages
         SET status = $4, available_at = $5, processed_at = $6, last_error_code = $7,
             locked_by = NULL, locked_at = NULL, lock_expires_at = NULL
         WHERE tenant_id = $1 AND environment = $2 AND id = $3
         RETURNING *`,
        [ownership.tenantId, ownership.environment, message.id,
          deadLetter ? 'DEAD_LETTER' : 'PENDING',
          deadLetter ? row.available_at : retryAt,
          deadLetter ? completedAt : null,
          errorCode]
      );
      await appendAttempt(client, {
        tenantId: ownership.tenantId,
        environment: ownership.environment,
        messageId: message.id,
        attemptNumber: message.attemptCount,
        workerId,
        outcome: deadLetter ? 'DEAD_LETTER' : 'FAILED',
        errorCode,
        startedAt,
        completedAt
      });
      await client.query('COMMIT');
      return {
        kind: deadLetter ? 'DEAD_LETTERED' : 'RETRY_SCHEDULED',
        message: messageFromRow(updated.rows[0])
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listAttempts(ownership, messageId) {
    const scope = owner(ownership);
    const result = await this.pool.query(
      `SELECT * FROM mandate.outbox_attempts
       WHERE tenant_id = $1 AND environment = $2 AND outbox_message_id = $3
       ORDER BY attempt_number, created_at, id`,
      [scope.tenantId, scope.environment, messageId]
    );
    return result.rows.map(attemptFromRow);
  }
}
