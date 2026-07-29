function timestamp(value) {
  return value ? new Date(value).toISOString() : null;
}

function attemptFromRow(row) {
  return row && {
    id: row.id,
    decisionId: row.decision_id,
    mandateId: row.mandate_id,
    agentId: row.agent_id,
    action: row.action,
    resource: row.resource,
    status: row.status,
    reservedByCredentialId: row.reserved_by_credential_id,
    reservedAt: timestamp(row.reserved_at),
    expiresAt: timestamp(row.expires_at),
    requestId: row.request_id,
    executionStatus: row.execution_status ?? null,
    inputHash: row.input_hash ?? null,
    outputHash: row.output_hash ?? null,
    tool: row.tool ?? null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    completedAt: timestamp(row.completed_at),
    completionRequestId: row.completion_request_id ?? null,
    terminatedAt: timestamp(row.terminated_at),
    terminationReason: row.termination_reason ?? null,
    terminationRequestId: row.termination_request_id ?? null,
    version: Number(row.version)
  };
}

function isPostgres(value) {
  return Boolean(value?.queryable || value?.pool);
}

function queryable(value) {
  return value.queryable ?? value.pool;
}

export async function lockDecisionForAttempt(transaction, ownership, decisionId) {
  if (!transaction?.queryable) return transaction.get('decisions', ownership, decisionId);
  const result = await transaction.queryable.query(
    `SELECT id FROM mandate.authorization_decisions
     WHERE tenant_id = $1 AND environment = $2 AND id = $3
     FOR UPDATE`,
    [ownership.tenantId, ownership.environment, decisionId]
  );
  if (result.rowCount === 0) return null;
  return transaction.get('decisions', ownership, decisionId);
}

export async function lockActionAttempt(transaction, ownership, attemptId) {
  if (!transaction?.queryable) return transaction.get('actionAttempts', ownership, attemptId);
  const result = await transaction.queryable.query(
    `SELECT * FROM mandate.action_attempts
     WHERE tenant_id = $1 AND environment = $2 AND id = $3
     FOR UPDATE`,
    [ownership.tenantId, ownership.environment, attemptId]
  );
  return attemptFromRow(result.rows[0]);
}

export async function findActionAttemptByDecision(store, ownership, decisionId) {
  if (!isPostgres(store)) {
    return (await store.list('actionAttempts', ownership)).find((attempt) => attempt.decisionId === decisionId) ?? null;
  }
  const result = await queryable(store).query(
    `SELECT * FROM mandate.action_attempts
     WHERE tenant_id = $1 AND environment = $2 AND decision_id = $3`,
    [ownership.tenantId, ownership.environment, decisionId]
  );
  return attemptFromRow(result.rows[0]);
}

export async function findReceiptByDecision(store, ownership, decisionId) {
  if (!isPostgres(store)) {
    return (await store.list('receipts', ownership)).find((receipt) => receipt.decisionId === decisionId) ?? null;
  }
  const result = await queryable(store).query(
    `SELECT id FROM mandate.receipts
     WHERE tenant_id = $1 AND environment = $2 AND decision_id = $3`,
    [ownership.tenantId, ownership.environment, decisionId]
  );
  return result.rows[0] ?? null;
}

export async function findReceiptByAttempt(store, ownership, attemptId) {
  if (!isPostgres(store)) {
    return (await store.list('receipts', ownership)).find((receipt) => receipt.actionAttemptId === attemptId) ?? null;
  }
  const result = await queryable(store).query(
    `SELECT id FROM mandate.receipts
     WHERE tenant_id = $1 AND environment = $2 AND action_attempt_id = $3`,
    [ownership.tenantId, ownership.environment, attemptId]
  );
  return result.rows[0] ?? null;
}

export async function saveActionAttempt(store, ownership, attempt) {
  if (!isPostgres(store)) return store.save('actionAttempts', ownership, attempt);
  const result = await queryable(store).query(
    `INSERT INTO mandate.action_attempts
      (tenant_id, environment, id, decision_id, mandate_id, agent_id, action, resource, status,
       reserved_by_credential_id, reserved_at, expires_at, request_id, version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [ownership.tenantId, ownership.environment, attempt.id, attempt.decisionId, attempt.mandateId,
      attempt.agentId, attempt.action, attempt.resource, attempt.status,
      attempt.reservedByCredentialId, attempt.reservedAt, attempt.expiresAt,
      attempt.requestId, attempt.version]
  );
  return attemptFromRow(result.rows[0]);
}

export async function updateActionAttempt(store, ownership, attempt) {
  if (!isPostgres(store)) return store.save('actionAttempts', ownership, attempt);
  const result = await queryable(store).query(
    `UPDATE mandate.action_attempts
     SET status = $4, execution_status = $5, input_hash = $6, output_hash = $7,
         tool = $8, provider = $9, model = $10, completed_at = $11,
         completion_request_id = $12, terminated_at = $13, termination_reason = $14,
         termination_request_id = $15, version = $16
     WHERE tenant_id = $1 AND environment = $2 AND id = $3
       AND version = $17
     RETURNING *`,
    [ownership.tenantId, ownership.environment, attempt.id, attempt.status,
      attempt.executionStatus, attempt.inputHash, attempt.outputHash, attempt.tool,
      attempt.provider, attempt.model, attempt.completedAt, attempt.completionRequestId,
      attempt.terminatedAt, attempt.terminationReason, attempt.terminationRequestId,
      attempt.version, attempt.version - 1]
  );
  if (result.rowCount !== 1) throw new Error('ACTION_ATTEMPT_VERSION_CONFLICT');
  return attemptFromRow(result.rows[0]);
}

export async function saveReceiptForAttempt(store, ownership, receipt) {
  if (!isPostgres(store)) return store.save('receipts', ownership, receipt);
  const { signature, ...payload } = receipt;
  const result = await queryable(store).query(
    `INSERT INTO mandate.receipts
      (tenant_id, environment, id, decision_id, mandate_id, action_attempt_id, key_id,
       algorithm, payload, signature, issued_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING payload, signature`,
    [ownership.tenantId, ownership.environment, receipt.id, receipt.decisionId,
      receipt.mandateId, receipt.actionAttemptId, receipt.keyId, receipt.algorithm,
      JSON.stringify(payload), signature, receipt.issuedAt]
  );
  return { ...result.rows[0].payload, signature: result.rows[0].signature };
}

export async function getActionAttempt(store, ownership, attemptId) {
  if (!isPostgres(store)) return store.get('actionAttempts', ownership, attemptId);
  const result = await queryable(store).query(
    `SELECT * FROM mandate.action_attempts
     WHERE tenant_id = $1 AND environment = $2 AND id = $3`,
    [ownership.tenantId, ownership.environment, attemptId]
  );
  return attemptFromRow(result.rows[0]);
}

export async function listActionAttempts(store, ownership) {
  if (!isPostgres(store)) return store.list('actionAttempts', ownership);
  const result = await queryable(store).query(
    `SELECT * FROM mandate.action_attempts
     WHERE tenant_id = $1 AND environment = $2
     ORDER BY reserved_at, id`,
    [ownership.tenantId, ownership.environment]
  );
  return result.rows.map(attemptFromRow);
}

export async function expireNextActionAttempt(transaction, scope, { requestId, now = new Date() }) {
  if (!isPostgres(transaction)) {
    const tenantId = scope.tenantId ?? transaction.defaultOwnership?.tenantId;
    if (!tenantId) throw new TypeError('Memory expiry requires a tenantId.');
    const ownership = { tenantId, environment: scope.environment };
    const candidate = (await transaction.list('actionAttempts', ownership))
      .filter((attempt) => attempt.status === 'RESERVED' && Date.parse(attempt.expiresAt) <= now.getTime())
      .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt) || left.id.localeCompare(right.id))[0];
    if (!candidate) return null;
    const expired = await updateActionAttempt(transaction, ownership, {
      ...candidate,
      status: 'EXPIRED',
      executionStatus: null,
      inputHash: null,
      outputHash: null,
      tool: null,
      provider: null,
      model: null,
      completedAt: null,
      completionRequestId: null,
      terminatedAt: now.toISOString(),
      terminationReason: 'RESERVATION_EXPIRED',
      terminationRequestId: requestId,
      version: candidate.version + 1
    });
    return { ownership, attempt: expired };
  }

  const result = await queryable(transaction).query(
    `WITH candidate AS (
       SELECT tenant_id, environment, id
       FROM mandate.action_attempts
       WHERE status = 'RESERVED'
         AND expires_at <= clock_timestamp()
         AND environment = $1
         AND ($2::text IS NULL OR tenant_id = $2)
       ORDER BY expires_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE mandate.action_attempts AS attempt
     SET status = 'EXPIRED',
         terminated_at = clock_timestamp(),
         termination_reason = 'RESERVATION_EXPIRED',
         termination_request_id = $3,
         version = attempt.version + 1
     FROM candidate
     WHERE attempt.tenant_id = candidate.tenant_id
       AND attempt.environment = candidate.environment
       AND attempt.id = candidate.id
     RETURNING attempt.*`,
    [scope.environment, scope.tenantId ?? null, requestId]
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  return {
    ownership: { tenantId: row.tenant_id, environment: row.environment },
    attempt: attemptFromRow(row)
  };
}
