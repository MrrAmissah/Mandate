function timestamp(value) {
  return value ? new Date(value).toISOString() : null;
}

function isPostgres(value) {
  return Boolean(value?.queryable || value?.pool);
}

function queryable(value) {
  return value.queryable ?? value.pool;
}

function approvalFromExpiryRow(row) {
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

function validateScope(scope) {
  if (!scope || !['test', 'live'].includes(scope.environment)) {
    throw new TypeError('Approval expiry requires a test or live environment scope.');
  }
  if (scope.tenantId !== undefined && !/^ten_[A-Za-z0-9_-]+$/.test(scope.tenantId)) {
    throw new TypeError('tenantId must use the ten_ prefix.');
  }
  return scope;
}

export async function inspectApprovalExpiryBacklog(store, scope, { now = new Date() } = {}) {
  validateScope(scope);
  if (!isPostgres(store)) {
    const tenantId = scope.tenantId ?? store.defaultOwnership?.tenantId;
    if (!tenantId) throw new TypeError('Memory approval expiry backlog requires a tenantId.');
    const ownership = { tenantId, environment: scope.environment };
    const pending = (await store.list('approvals', ownership))
      .filter((approval) => approval.status === 'PENDING' && approval.expiresAt);
    const due = pending
      .filter((approval) => Date.parse(approval.expiresAt) <= now.getTime())
      .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt) || left.id.localeCompare(right.id));
    const oldestDueAt = due[0]?.expiresAt ?? null;
    return Object.freeze({
      pendingExpiringCount: pending.length,
      dueCount: due.length,
      oldestDueAt,
      oldestOverdueSeconds: oldestDueAt
        ? Math.max(0, Math.floor((now.getTime() - Date.parse(oldestDueAt)) / 1000))
        : 0,
      observedAt: now.toISOString()
    });
  }

  const result = await queryable(store).query(
    `WITH observed AS (SELECT clock_timestamp() AS observed_at)
     SELECT
       COUNT(approval.id)::integer AS pending_expiring_count,
       COUNT(approval.id) FILTER (WHERE approval.expires_at <= observed.observed_at)::integer AS due_count,
       MIN(approval.expires_at) FILTER (WHERE approval.expires_at <= observed.observed_at) AS oldest_due_at,
       COALESCE(
         FLOOR(EXTRACT(EPOCH FROM observed.observed_at -
           MIN(approval.expires_at) FILTER (WHERE approval.expires_at <= observed.observed_at))),
         0
       )::integer AS oldest_overdue_seconds,
       observed.observed_at
     FROM observed
     LEFT JOIN mandate.approvals approval
       ON approval.status = 'PENDING'
      AND approval.expires_at IS NOT NULL
      AND approval.environment = $1
      AND ($2::text IS NULL OR approval.tenant_id = $2)
     GROUP BY observed.observed_at`,
    [scope.environment, scope.tenantId ?? null]
  );
  const row = result.rows[0];
  return Object.freeze({
    pendingExpiringCount: Number(row.pending_expiring_count),
    dueCount: Number(row.due_count),
    oldestDueAt: timestamp(row.oldest_due_at),
    oldestOverdueSeconds: Number(row.oldest_overdue_seconds),
    observedAt: timestamp(row.observed_at)
  });
}

export async function expireNextApproval(transaction, scope, { requestId, now = new Date() }) {
  validateScope(scope);
  if (typeof requestId !== 'string' || !/^sys_approval_expiry_[A-Za-z0-9_-]+$/.test(requestId)) {
    throw new TypeError('A safe approval-expiry requestId is required.');
  }

  if (!isPostgres(transaction)) {
    const tenantId = scope.tenantId ?? transaction.defaultOwnership?.tenantId;
    if (!tenantId) throw new TypeError('Memory approval expiry requires a tenantId.');
    const ownership = { tenantId, environment: scope.environment };
    const candidate = (await transaction.list('approvals', ownership))
      .filter((approval) => approval.status === 'PENDING'
        && approval.expiresAt
        && Date.parse(approval.expiresAt) <= now.getTime())
      .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt) || left.id.localeCompare(right.id))[0];
    if (!candidate) return null;

    let assignment = null;
    for (const value of transaction.state?.approvalAssignments?.values?.() ?? []) {
      if (value.tenantId === ownership.tenantId
        && value.environment === ownership.environment
        && value.approvalId === candidate.id
        && value.status === 'ACTIVE') {
        assignment = structuredClone(value);
        break;
      }
    }

    const expiredAt = now.toISOString();
    const expired = {
      ...candidate,
      status: 'EXPIRED',
      expiredAt,
      expirationReason: 'DEADLINE_ELAPSED',
      expirationRequestId: requestId
    };
    await transaction.save('approvals', ownership, expired);

    if (assignment) {
      transaction.state.approvalAssignments.set(
        `${ownership.tenantId}:${ownership.environment}:${assignment.id}`,
        {
          ...assignment,
          status: 'EXPIRED',
          endedAt: expiredAt,
          endReason: 'APPROVAL_EXPIRED',
          version: assignment.version + 1
        }
      );
    }

    return {
      ownership,
      approval: expired,
      assignmentId: assignment?.id ?? null
    };
  }

  const result = await queryable(transaction).query(
    `WITH candidate AS (
       SELECT tenant_id, environment, id
       FROM mandate.approvals
       WHERE status = 'PENDING'
         AND expires_at IS NOT NULL
         AND expires_at <= clock_timestamp()
         AND environment = $1
         AND ($2::text IS NULL OR tenant_id = $2)
       ORDER BY expires_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     ), expired AS (
       UPDATE mandate.approvals approval
          SET status = 'EXPIRED',
              expired_at = clock_timestamp(),
              expiration_reason = 'DEADLINE_ELAPSED',
              expiration_request_id = $3,
              version = approval.version + 1
         FROM candidate
        WHERE approval.tenant_id = candidate.tenant_id
          AND approval.environment = candidate.environment
          AND approval.id = candidate.id
       RETURNING approval.*
     ), ended_assignment AS (
       UPDATE mandate.approval_assignments assignment
          SET status = 'EXPIRED',
              ended_at = expired.expired_at,
              end_reason = 'APPROVAL_EXPIRED',
              version = assignment.version + 1
         FROM expired
        WHERE assignment.tenant_id = expired.tenant_id
          AND assignment.environment = expired.environment
          AND assignment.approval_id = expired.id
          AND assignment.status = 'ACTIVE'
       RETURNING assignment.id
     )
     SELECT expired.*, ended_assignment.id AS assignment_id
       FROM expired
       LEFT JOIN ended_assignment ON TRUE`,
    [scope.environment, scope.tenantId ?? null, requestId]
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  return {
    ownership: { tenantId: row.tenant_id, environment: row.environment },
    approval: approvalFromExpiryRow(row),
    assignmentId: row.assignment_id ?? null
  };
}
