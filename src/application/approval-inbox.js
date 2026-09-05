import { DomainError } from '../domain/errors.js';
import { resolveAuthenticatedApprover } from './approval-operations.js';

const INBOX_STATES = new Set(['ACTIONABLE', 'PENDING']);
const APPROVAL_ID = /^apr_[A-Za-z0-9_-]+$/;

function timestamp(value) {
  return value ? new Date(value).toISOString() : null;
}

function isPostgres(view) {
  return Boolean(view?.queryable && typeof view.queryable.query === 'function');
}

function scopedPrefix(ownership) {
  return `${ownership.tenantId}:${ownership.environment}:`;
}

function memoryMap(view, name) {
  const value = view?.state?.[name];
  if (!(value instanceof Map)) throw new TypeError(`Memory approval inbox requires ${name} state.`);
  return value;
}

function validateCursor(cursor) {
  if (!cursor) return null;
  if (!APPROVAL_ID.test(cursor.id) || Number.isNaN(Date.parse(cursor.at))) {
    throw new DomainError('INVALID_CURSOR', 'startingAfter is not a valid approval inbox cursor.');
  }
  return cursor;
}

export function parseApprovalInboxState(value) {
  const state = (value ?? 'ACTIONABLE').trim().toUpperCase();
  if (!INBOX_STATES.has(state)) {
    throw new DomainError('INVALID_INBOX_STATE', 'state must be ACTIONABLE or PENDING.');
  }
  return state;
}

function inboxItem({ approval, assignment, approver, now }) {
  const expiry = approval.expiresAt ? Date.parse(approval.expiresAt) : null;
  const observed = now instanceof Date ? now.getTime() : Date.parse(now);
  const pending = approval.status === 'PENDING';
  const overdue = pending && expiry !== null && observed >= expiry;
  return Object.freeze({
    id: approval.id,
    mandateId: approval.mandateId,
    agentId: approval.agentId,
    action: approval.action,
    resource: approval.resource,
    summary: approval.summary,
    status: approval.status,
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
    actionable: pending && !overdue,
    overdue,
    assignment: Object.freeze({
      id: assignment.id,
      sourceType: assignment.sourceType,
      assignedAt: assignment.assignedAt
    }),
    approver: Object.freeze({
      id: approver.id,
      displayName: approver.displayName
    })
  });
}

function inboxItemFromRow(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    mandateId: row.mandate_id,
    agentId: row.agent_id,
    action: row.action,
    resource: row.resource,
    summary: row.summary,
    status: row.status,
    requestedAt: timestamp(row.requested_at),
    expiresAt: timestamp(row.expires_at),
    actionable: row.actionable === true,
    overdue: row.overdue === true,
    assignment: Object.freeze({
      id: row.assignment_id,
      sourceType: row.assignment_source_type,
      assignedAt: timestamp(row.assignment_assigned_at)
    }),
    approver: Object.freeze({
      id: row.approver_id,
      displayName: row.approver_display_name
    })
  });
}

async function requireAuthenticatedApprover(view, ownership, authentication) {
  const approver = await resolveAuthenticatedApprover(view, ownership, authentication.credentialId);
  if (!approver) {
    throw new DomainError(
      'APPROVER_IDENTITY_REQUIRED',
      'The authenticated credential is not bound to an active approver identity.',
      403
    );
  }
  return approver;
}

export async function listApprovalInbox({
  view,
  ownership,
  authentication,
  state = 'ACTIONABLE',
  limit = 20,
  cursor = null,
  now = new Date()
}) {
  state = parseApprovalInboxState(state);
  cursor = validateCursor(cursor);
  const approver = await requireAuthenticatedApprover(view, ownership, authentication);

  if (isPostgres(view)) {
    const result = await view.queryable.query(
      `WITH observed AS (SELECT clock_timestamp() AS now_at)
       SELECT approval.id, approval.mandate_id, approval.agent_id, approval.action,
              approval.resource, approval.summary, approval.status, approval.requested_at,
              approval.expires_at,
              assignment.id AS assignment_id,
              assignment.source_type AS assignment_source_type,
              assignment.assigned_at AS assignment_assigned_at,
              identity.id AS approver_id,
              identity.display_name AS approver_display_name,
              (approval.status='PENDING' AND (approval.expires_at IS NULL OR approval.expires_at > observed.now_at)) AS actionable,
              (approval.status='PENDING' AND approval.expires_at IS NOT NULL AND approval.expires_at <= observed.now_at) AS overdue
       FROM mandate.approver_credential_bindings binding
       JOIN mandate.approver_identities identity
         ON identity.tenant_id=binding.tenant_id
        AND identity.environment=binding.environment
        AND identity.id=binding.approver_id
       JOIN mandate.approval_assignment_eligibility eligibility
         ON eligibility.tenant_id=identity.tenant_id
        AND eligibility.environment=identity.environment
        AND eligibility.approver_id=identity.id
       JOIN mandate.approval_assignments assignment
         ON assignment.tenant_id=eligibility.tenant_id
        AND assignment.environment=eligibility.environment
        AND assignment.id=eligibility.assignment_id
       JOIN mandate.approvals approval
         ON approval.tenant_id=assignment.tenant_id
        AND approval.environment=assignment.environment
        AND approval.id=assignment.approval_id
       CROSS JOIN observed
       WHERE binding.tenant_id=$1 AND binding.environment=$2 AND binding.credential_id=$3
         AND binding.status='ACTIVE' AND identity.status='ACTIVE'
         AND identity.id=$4
         AND assignment.status='ACTIVE'
         AND approval.status='PENDING'
         AND ($5='PENDING' OR approval.expires_at IS NULL OR approval.expires_at > observed.now_at)
         AND ($6::timestamptz IS NULL
           OR approval.requested_at > $6::timestamptz
           OR (approval.requested_at = $6::timestamptz AND approval.id > $7))
       ORDER BY approval.requested_at, approval.id
       LIMIT $8`,
      [
        ownership.tenantId,
        ownership.environment,
        authentication.credentialId,
        approver.id,
        state,
        cursor?.at ?? null,
        cursor?.id ?? '',
        limit + 1
      ]
    );
    return Object.freeze(result.rows.map(inboxItemFromRow));
  }

  const prefix = scopedPrefix(ownership);
  const eligibleAssignments = new Set();
  for (const [key, eligibility] of memoryMap(view, 'approvalAssignmentEligibility').entries()) {
    if (key.startsWith(prefix) && eligibility.approverId === approver.id) {
      eligibleAssignments.add(eligibility.assignmentId);
    }
  }

  const items = [];
  for (const [key, assignment] of memoryMap(view, 'approvalAssignments').entries()) {
    if (!key.startsWith(prefix) || assignment.status !== 'ACTIVE' || !eligibleAssignments.has(assignment.id)) continue;
    const approval = await view.get('approvals', ownership, assignment.approvalId);
    if (!approval || approval.status !== 'PENDING') continue;
    const item = inboxItem({ approval, assignment, approver, now });
    if (state === 'ACTIONABLE' && !item.actionable) continue;
    if (cursor && (
      item.requestedAt < cursor.at
      || (item.requestedAt === cursor.at && item.id <= cursor.id)
    )) continue;
    items.push(item);
  }
  items.sort((left, right) => left.requestedAt.localeCompare(right.requestedAt) || left.id.localeCompare(right.id));
  return Object.freeze(items.slice(0, limit + 1));
}

export async function getApprovalInboxItem({ view, ownership, authentication, approvalId, now = new Date() }) {
  if (!APPROVAL_ID.test(approvalId)) {
    throw new DomainError('APPROVAL_INBOX_ITEM_NOT_FOUND', 'The approval inbox item does not exist.', 404);
  }
  const approver = await requireAuthenticatedApprover(view, ownership, authentication);

  if (isPostgres(view)) {
    const result = await view.queryable.query(
      `WITH observed AS (SELECT clock_timestamp() AS now_at)
       SELECT approval.id, approval.mandate_id, approval.agent_id, approval.action,
              approval.resource, approval.summary, approval.status, approval.requested_at,
              approval.expires_at,
              assignment.id AS assignment_id,
              assignment.source_type AS assignment_source_type,
              assignment.assigned_at AS assignment_assigned_at,
              identity.id AS approver_id,
              identity.display_name AS approver_display_name,
              (approval.status='PENDING' AND (approval.expires_at IS NULL OR approval.expires_at > observed.now_at)) AS actionable,
              (approval.status='PENDING' AND approval.expires_at IS NOT NULL AND approval.expires_at <= observed.now_at) AS overdue
       FROM mandate.approver_credential_bindings binding
       JOIN mandate.approver_identities identity
         ON identity.tenant_id=binding.tenant_id
        AND identity.environment=binding.environment
        AND identity.id=binding.approver_id
       JOIN mandate.approval_assignment_eligibility eligibility
         ON eligibility.tenant_id=identity.tenant_id
        AND eligibility.environment=identity.environment
        AND eligibility.approver_id=identity.id
       JOIN mandate.approval_assignments assignment
         ON assignment.tenant_id=eligibility.tenant_id
        AND assignment.environment=eligibility.environment
        AND assignment.id=eligibility.assignment_id
       JOIN mandate.approvals approval
         ON approval.tenant_id=assignment.tenant_id
        AND approval.environment=assignment.environment
        AND approval.id=assignment.approval_id
       CROSS JOIN observed
       WHERE binding.tenant_id=$1 AND binding.environment=$2 AND binding.credential_id=$3
         AND binding.status='ACTIVE' AND identity.status='ACTIVE'
         AND identity.id=$4
         AND assignment.status='ACTIVE'
         AND approval.id=$5
       LIMIT 1`,
      [ownership.tenantId, ownership.environment, authentication.credentialId, approver.id, approvalId]
    );
    const item = inboxItemFromRow(result.rows[0]);
    if (!item) throw new DomainError('APPROVAL_INBOX_ITEM_NOT_FOUND', 'The approval inbox item does not exist.', 404);
    return item;
  }

  let assignment = null;
  for (const value of memoryMap(view, 'approvalAssignments').values()) {
    if (value.tenantId === ownership.tenantId && value.environment === ownership.environment
      && value.approvalId === approvalId && value.status === 'ACTIVE') {
      assignment = value;
      break;
    }
  }
  if (!assignment) throw new DomainError('APPROVAL_INBOX_ITEM_NOT_FOUND', 'The approval inbox item does not exist.', 404);

  let eligible = false;
  for (const value of memoryMap(view, 'approvalAssignmentEligibility').values()) {
    if (value.tenantId === ownership.tenantId && value.environment === ownership.environment
      && value.assignmentId === assignment.id && value.approverId === approver.id) {
      eligible = true;
      break;
    }
  }
  if (!eligible) throw new DomainError('APPROVAL_INBOX_ITEM_NOT_FOUND', 'The approval inbox item does not exist.', 404);
  const approval = await view.get('approvals', ownership, approvalId);
  if (!approval) throw new DomainError('APPROVAL_INBOX_ITEM_NOT_FOUND', 'The approval inbox item does not exist.', 404);
  return inboxItem({ approval, assignment, approver, now });
}
