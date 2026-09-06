import { DomainError } from '../domain/errors.js';

const ENVIRONMENTS = new Set(['test', 'live']);
const RETRYABLE_CODES = new Set(['40001', '40P01', '23505']);
const ENTITY_KINDS = new Set([
  'apiCredentials',
  'mandates',
  'approvals',
  'decisions',
  'receipts',
  'auditEvents',
  'outboxMessages'
]);

function ownership(value) {
  if (
    !value ||
    typeof value.tenantId !== 'string' ||
    !/^ten_[A-Za-z0-9_-]+$/.test(value.tenantId) ||
    !ENVIRONMENTS.has(value.environment)
  ) {
    throw new TypeError('A valid tenantId and test/live ownership scope is required.');
  }
  return value;
}

function timestamp(value) {
  return value ? new Date(value).toISOString() : null;
}

function json(value) {
  return JSON.stringify(value);
}

function translatePostgresDomainError(error) {
  if (error instanceof DomainError) return error;
  const message = typeof error?.message === 'string' ? error.message : '';
  if (
    message.includes('approval decision cannot commit after expiry deadline')
    || message.includes('approval cancellation cannot commit after expiry deadline')
    || message.includes('approval is unavailable for a new active assignment')
  ) {
    return new DomainError('APPROVAL_EXPIRED', 'This approval request has expired.', 409);
  }
  return error;
}

function credentialFromRow(row) {
  return row && {
    id: row.id,
    tenantId: row.tenant_id,
    environment: row.environment,
    name: row.name,
    secretHash: row.secret_hash,
    prefix: row.prefix,
    lastFour: row.last_four,
    scopes: row.scopes,
    status: row.status,
    createdAt: timestamp(row.created_at),
    expiresAt: timestamp(row.expires_at),
    revokedAt: timestamp(row.revoked_at),
    revocationReason: row.revocation_reason,
    lastUsedAt: timestamp(row.last_used_at)
  };
}

function mandateFromRow(row) {
  return row && {
    id: row.id,
    principalId: row.principal_id,
    agentId: row.agent_id,
    purpose: row.purpose,
    resources: row.resources,
    allowedActions: row.allowed_actions,
    deniedActions: row.denied_actions,
    approvalRequiredActions: row.approval_required_actions,
    constraints: row.constraints,
    validFrom: timestamp(row.valid_from),
    validUntil: timestamp(row.valid_until),
    maxUses: row.max_uses,
    uses: row.uses,
    status: row.status,
    createdAt: timestamp(row.created_at),
    revokedAt: timestamp(row.revoked_at),
    revocationReason: row.revocation_reason
  };
}

function approvalFromRow(row) {
  return row && {
    id: row.id,
    mandateId: row.mandate_id,
    agentId: row.agent_id,
    action: row.action,
    resource: row.resource,
    summary: row.summary,
    status: row.status,
    requestedAt: timestamp(row.requested_at),
    expiresAt: timestamp(row.expires_at),
    decidedAt: timestamp(row.decided_at),
    decidedBy: row.decided_by,
    decidedByApproverId: row.decided_by_approver_id ?? null,
    decisionReason: row.decision_reason,
    cancelledAt: timestamp(row.cancelled_at),
    cancelledByCredentialId: row.cancelled_by_credential_id ?? null,
    cancellationReason: row.cancellation_reason ?? null,
    expiredAt: timestamp(row.expired_at),
    expirationReason: row.expiration_reason ?? null,
    expirationRequestId: row.expiration_request_id ?? null,
    consumedAt: timestamp(row.consumed_at),
    consumedByDecisionId: row.consumed_by_decision_id
  };
}

function decisionFromRow(row) {
  return row && {
    id: row.id,
    mandateId: row.mandate_id,
    agentId: row.agent_id,
    action: row.action,
    resource: row.resource,
    context: row.context,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    reason: row.reason,
    approvalId: row.approval_id,
    evaluatedAt: timestamp(row.evaluated_at),
    requestId: row.request_id
  };
}

function receiptFromRow(row) {
  if (!row) return null;
  return { ...row.payload, signature: row.signature };
}

function auditFromRow(row) {
  return row && {
    id: row.id,
    sequence: Number(row.sequence),
    type: row.type,
    objectType: row.object_type,
    objectId: row.object_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    requestId: row.request_id,
    data: row.data,
    createdAt: timestamp(row.created_at)
  };
}

function outboxFromRow(row) {
  return row && {
    id: row.id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    auditEventId: row.audit_event_id,
    payload: row.payload,
    status: row.status,
    attemptCount: row.attempt_count,
    availableAt: timestamp(row.available_at),
    lockedBy: row.locked_by,
    lockedAt: timestamp(row.locked_at),
    lockExpiresAt: timestamp(row.lock_expires_at),
    processedAt: timestamp(row.processed_at),
    lastErrorCode: row.last_error_code,
    createdAt: timestamp(row.created_at)
  };
}

const MAPPERS = {
  apiCredentials: credentialFromRow,
  mandates: mandateFromRow,
  approvals: approvalFromRow,
  decisions: decisionFromRow,
  receipts: receiptFromRow,
  auditEvents: auditFromRow,
  outboxMessages: outboxFromRow
};

const TABLES = {
  apiCredentials: 'api_credentials',
  mandates: 'mandates',
  approvals: 'approvals',
  decisions: 'authorization_decisions',
  receipts: 'receipts',
  auditEvents: 'audit_events',
  outboxMessages: 'outbox_messages'
};

const ORDER_COLUMNS = {
  apiCredentials: 'created_at',
  mandates: 'created_at',
  approvals: 'requested_at',
  decisions: 'evaluated_at',
  receipts: 'issued_at',
  auditEvents: 'sequence',
  outboxMessages: 'created_at'
};

class PostgresView {
  constructor(queryable, { lockReads = false } = {}) {
    this.queryable = queryable;
    this.lockReads = lockReads;
  }

  async get(kind, owner, id) {
    if (!ENTITY_KINDS.has(kind)) throw new TypeError(`Unknown entity kind: ${kind}`);
    const scope = ownership(owner);
    const lock = this.lockReads && ['mandates', 'approvals'].includes(kind) ? ' FOR UPDATE' : '';
    const result = await this.queryable.query(
      `SELECT * FROM mandate.${TABLES[kind]} WHERE tenant_id = $1 AND environment = $2 AND id = $3${lock}`,
      [scope.tenantId, scope.environment, id]
    );
    return MAPPERS[kind](result.rows[0]);
  }

  async list(kind, owner) {
    if (!ENTITY_KINDS.has(kind)) throw new TypeError(`Unknown entity kind: ${kind}`);
    const scope = ownership(owner);
    const result = await this.queryable.query(
      `SELECT * FROM mandate.${TABLES[kind]} WHERE tenant_id = $1 AND environment = $2 ORDER BY ${ORDER_COLUMNS[kind]}, id`,
      [scope.tenantId, scope.environment]
    );
    return result.rows.map(MAPPERS[kind]);
  }

  async findCredentialBySecretHash(secretHash) {
    const result = await this.queryable.query(
      'SELECT * FROM mandate.api_credentials WHERE secret_hash = $1',
      [secretHash]
    );
    return credentialFromRow(result.rows[0]);
  }

  async markCredentialUsed(credential, now = new Date()) {
    const result = await this.queryable.query(
      `UPDATE mandate.api_credentials
       SET last_used_at = GREATEST(COALESCE(last_used_at, '-infinity'::timestamptz), $4::timestamptz)
       WHERE tenant_id = $1 AND environment = $2 AND id = $3
         AND status = 'ACTIVE'
         AND (expires_at IS NULL OR expires_at > $4::timestamptz)`,
      [credential.tenantId, credential.environment, credential.id, now.toISOString()]
    );
    return result.rowCount === 1;
  }

  async save(kind, owner, entity) {
    const scope = ownership(owner);
    switch (kind) {
      case 'apiCredentials':
        await this.queryable.query(
          `INSERT INTO mandate.api_credentials
            (tenant_id, environment, id, name, secret_hash, prefix, last_four, scopes, status,
             created_at, expires_at, revoked_at, revocation_reason, last_used_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (tenant_id, environment, id) DO UPDATE SET
             name = EXCLUDED.name, secret_hash = EXCLUDED.secret_hash, prefix = EXCLUDED.prefix,
             last_four = EXCLUDED.last_four, scopes = EXCLUDED.scopes, status = EXCLUDED.status,
             expires_at = EXCLUDED.expires_at, revoked_at = EXCLUDED.revoked_at,
             revocation_reason = EXCLUDED.revocation_reason, last_used_at = EXCLUDED.last_used_at`,
          [scope.tenantId, scope.environment, entity.id, entity.name, entity.secretHash, entity.prefix,
            entity.lastFour, entity.scopes, entity.status, entity.createdAt, entity.expiresAt,
            entity.revokedAt, entity.revocationReason, entity.lastUsedAt]
        );
        break;
      case 'mandates':
        await this.queryable.query(
          `INSERT INTO mandate.mandates
            (tenant_id, environment, id, status, principal_id, agent_id, purpose, resources,
             allowed_actions, denied_actions, approval_required_actions, constraints, valid_from,
             valid_until, max_uses, uses, version, created_at, revoked_at, revocation_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,0,$17,$18,$19)
           ON CONFLICT (tenant_id, environment, id) DO UPDATE SET
             status = EXCLUDED.status, resources = EXCLUDED.resources,
             allowed_actions = EXCLUDED.allowed_actions, denied_actions = EXCLUDED.denied_actions,
             approval_required_actions = EXCLUDED.approval_required_actions,
             constraints = EXCLUDED.constraints, valid_until = EXCLUDED.valid_until,
             max_uses = EXCLUDED.max_uses, uses = EXCLUDED.uses,
             version = mandate.mandates.version + 1, revoked_at = EXCLUDED.revoked_at,
             revocation_reason = EXCLUDED.revocation_reason`,
          [scope.tenantId, scope.environment, entity.id, entity.status, entity.principalId,
            entity.agentId, entity.purpose, json(entity.resources), json(entity.allowedActions),
            json(entity.deniedActions), json(entity.approvalRequiredActions), json(entity.constraints),
            entity.validFrom, entity.validUntil, entity.maxUses, entity.uses, entity.createdAt,
            entity.revokedAt, entity.revocationReason]
        );
        break;
      case 'approvals':
        await this.queryable.query(
          `INSERT INTO mandate.approvals
            (tenant_id, environment, id, mandate_id, agent_id, action, resource, summary, status,
             requested_at, expires_at, decided_at, decided_by, decision_reason,
             expired_at, expiration_reason, expiration_request_id,
             consumed_at, consumed_by_decision_id, version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,0)
           ON CONFLICT (tenant_id, environment, id) DO UPDATE SET
             status = EXCLUDED.status, decided_at = EXCLUDED.decided_at,
             decided_by = EXCLUDED.decided_by, decision_reason = EXCLUDED.decision_reason,
             expired_at = EXCLUDED.expired_at,
             expiration_reason = EXCLUDED.expiration_reason,
             expiration_request_id = EXCLUDED.expiration_request_id,
             consumed_at = EXCLUDED.consumed_at,
             consumed_by_decision_id = EXCLUDED.consumed_by_decision_id,
             version = mandate.approvals.version + 1`,
          [scope.tenantId, scope.environment, entity.id, entity.mandateId, entity.agentId,
            entity.action, entity.resource, entity.summary, entity.status, entity.requestedAt,
            entity.expiresAt, entity.decidedAt, entity.decidedBy, entity.decisionReason,
            entity.expiredAt ?? null, entity.expirationReason ?? null, entity.expirationRequestId ?? null,
            entity.consumedAt, entity.consumedByDecisionId]
        );
        break;
      case 'decisions':
        await this.queryable.query(
          `INSERT INTO mandate.authorization_decisions
            (tenant_id, environment, id, mandate_id, agent_id, action, resource, context, outcome,
             reason_code, reason, approval_id, evaluated_at, request_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [scope.tenantId, scope.environment, entity.id, entity.mandateId, entity.agentId,
            entity.action, entity.resource, json(entity.context ?? {}), entity.outcome,
            entity.reasonCode, entity.reason, entity.approvalId, entity.evaluatedAt,
            entity.requestId]
        );
        break;
      case 'receipts': {
        const { signature, ...payload } = entity;
        await this.queryable.query(
          `INSERT INTO mandate.receipts
            (tenant_id, environment, id, decision_id, mandate_id, key_id, algorithm, payload,
             signature, issued_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [scope.tenantId, scope.environment, entity.id, entity.decisionId, entity.mandateId,
            entity.keyId, entity.algorithm, json(payload), signature, entity.issuedAt]
        );
        break;
      }
      case 'auditEvents': {
        const result = await this.queryable.query(
          `INSERT INTO mandate.audit_events
            (tenant_id, environment, id, sequence, type, object_type, object_id, actor_type,
             actor_id, request_id, data, created_at)
           VALUES ($1,$2,$3,0,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING sequence`,
          [scope.tenantId, scope.environment, entity.id, entity.type, entity.objectType,
            entity.objectId, entity.actorType, entity.actorId, entity.requestId,
            json(entity.data ?? {}), entity.createdAt]
        );
        return { ...structuredClone(entity), sequence: Number(result.rows[0].sequence) };
      }
      case 'outboxMessages':
        await this.queryable.query(
          `INSERT INTO mandate.outbox_messages
            (tenant_id, environment, id, event_type, aggregate_type, aggregate_id, audit_event_id,
             payload, status, attempt_count, available_at, locked_by, locked_at, lock_expires_at,
             processed_at, last_error_code, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [scope.tenantId, scope.environment, entity.id, entity.eventType, entity.aggregateType,
            entity.aggregateId, entity.auditEventId, json(entity.payload), entity.status,
            entity.attemptCount ?? 0, entity.availableAt, entity.lockedBy ?? null,
            entity.lockedAt ?? null, entity.lockExpiresAt ?? null, entity.processedAt ?? null,
            entity.lastErrorCode ?? null, entity.createdAt]
        );
        break;
      default:
        throw new TypeError(`Unknown entity kind: ${kind}`);
    }
    return structuredClone(entity);
  }

  async appendAudit(owner, event) {
    return this.save('auditEvents', owner, event);
  }

  async enqueueOutbox(owner, message) {
    return this.save('outboxMessages', owner, message);
  }

  async idempotent(owner, scope, key, fingerprint, create) {
    const tenant = ownership(owner);
    if (!key) return structuredClone(await create());

    const existing = await this.queryable.query(
      `SELECT request_fingerprint, response_body
       FROM mandate.idempotency_records
       WHERE tenant_id = $1 AND environment = $2 AND scope = $3 AND idempotency_key = $4
       FOR UPDATE`,
      [tenant.tenantId, tenant.environment, scope, key]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_fingerprint !== fingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used with a different request payload.',
          409
        );
      }
      return structuredClone(existing.rows[0].response_body);
    }

    const value = await create();
    await this.queryable.query(
      `INSERT INTO mandate.idempotency_records
        (tenant_id, environment, scope, idempotency_key, request_fingerprint, response_status,
         response_headers, response_body, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,200,'{}'::jsonb,$6,now(),now() + interval '7 days')`,
      [tenant.tenantId, tenant.environment, scope, key, fingerprint, json(value)]
    );
    return structuredClone(value);
  }
}

export class PostgresStore extends PostgresView {
  constructor(pool, { maximumTransactionAttempts = 4 } = {}) {
    super(pool);
    this.pool = pool;
    this.maximumTransactionAttempts = maximumTransactionAttempts;
  }

  async transaction(work) {
    for (let attempt = 1; attempt <= this.maximumTransactionAttempts; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const result = await work(new PostgresView(client, { lockReads: true }));
        await client.query('COMMIT');
        return structuredClone(result);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (RETRYABLE_CODES.has(error.code) && attempt < this.maximumTransactionAttempts) continue;
        throw translatePostgresDomainError(error);
      } finally {
        client.release();
      }
    }
    throw new Error('PostgreSQL transaction retry limit exhausted.');
  }

  async ensureBootstrap({ tenantId, tenantName = 'Local tenant', environment, credential }) {
    const scope = ownership({ tenantId, environment });
    await this.transaction(async (transaction) => {
      await transaction.queryable.query(
        `INSERT INTO mandate.tenants (id, name, status, created_at, updated_at)
         VALUES ($1,$2,'ACTIVE',now(),now())
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
        [scope.tenantId, tenantName]
      );
      await transaction.queryable.query(
        `INSERT INTO mandate.api_credentials
          (tenant_id, environment, id, name, secret_hash, prefix, last_four, scopes, status,
           created_at, expires_at, revoked_at, revocation_reason, last_used_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9,$10,NULL,NULL,NULL)
         ON CONFLICT (tenant_id, environment, id) DO UPDATE SET
           name = EXCLUDED.name,
           secret_hash = CASE WHEN mandate.api_credentials.status = 'ACTIVE'
             THEN EXCLUDED.secret_hash ELSE mandate.api_credentials.secret_hash END,
           prefix = CASE WHEN mandate.api_credentials.status = 'ACTIVE'
             THEN EXCLUDED.prefix ELSE mandate.api_credentials.prefix END,
           last_four = CASE WHEN mandate.api_credentials.status = 'ACTIVE'
             THEN EXCLUDED.last_four ELSE mandate.api_credentials.last_four END,
           scopes = CASE WHEN mandate.api_credentials.status = 'ACTIVE'
             THEN EXCLUDED.scopes ELSE mandate.api_credentials.scopes END,
           expires_at = CASE WHEN mandate.api_credentials.status = 'ACTIVE'
             THEN EXCLUDED.expires_at ELSE mandate.api_credentials.expires_at END`,
        [scope.tenantId, scope.environment, credential.id, credential.name,
          credential.secretHash, credential.prefix, credential.lastFour, credential.scopes,
          credential.createdAt, credential.expiresAt]
      );
    });
  }

  async close() {
    await this.pool.end();
  }
}

export async function createPostgresPool({ connectionString, max = 10, ssl = false } = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required for PostgreSQL mode.');
  const module = await import('pg');
  const Pool = module.Pool ?? module.default?.Pool;
  if (!Pool) throw new Error('The pg package did not expose Pool.');
  return new Pool({ connectionString, max, ssl });
}
