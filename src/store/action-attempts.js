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
