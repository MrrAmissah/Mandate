import { randomUUID } from 'node:crypto';
import { DomainError } from './errors.js';
import { assertObject, optionalIsoDate, requiredString } from './validate.js';

export function createApprovalRequest(input, now = new Date()) {
  assertObject(input);
  const expiresAt = optionalIsoDate(input.expiresAt, 'expiresAt');
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(now)) {
    throw new DomainError('INVALID_WINDOW', 'expiresAt must be in the future.');
  }
  return {
    id: `apr_${randomUUID()}`,
    mandateId: requiredString(input.mandateId, 'mandateId'),
    agentId: requiredString(input.agentId, 'agentId'),
    action: requiredString(input.action, 'action'),
    resource: requiredString(input.resource, 'resource'),
    summary: requiredString(input.summary, 'summary'),
    status: 'PENDING',
    requestedAt: now.toISOString(),
    expiresAt,
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    consumedAt: null,
    consumedByDecisionId: null
  };
}

export function decideApproval(approval, input, now = new Date()) {
  assertObject(input);
  if (approval.status !== 'PENDING') {
    throw new DomainError('APPROVAL_ALREADY_DECIDED', 'This approval request has already been decided.', 409);
  }
  if (approval.expiresAt && Date.parse(now) >= Date.parse(approval.expiresAt)) {
    throw new DomainError('APPROVAL_EXPIRED', 'This approval request has expired.', 409);
  }
  const decision = requiredString(input.decision, 'decision').toUpperCase();
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    throw new DomainError('INVALID_REQUEST', 'decision must be APPROVED or REJECTED.');
  }
  return {
    ...approval,
    status: decision,
    decidedAt: now.toISOString(),
    decidedBy: requiredString(input.decidedBy, 'decidedBy'),
    decisionReason: input.reason ? requiredString(input.reason, 'reason') : null
  };
}

export function consumeApproval(approval, decisionId, now = new Date()) {
  if (approval.status !== 'APPROVED') {
    throw new DomainError('APPROVAL_NOT_USABLE', 'Only an approved, unused approval can be consumed.', 409);
  }
  if (approval.expiresAt && Date.parse(now) >= Date.parse(approval.expiresAt)) {
    throw new DomainError('APPROVAL_EXPIRED', 'This approval request has expired.', 409);
  }
  return {
    ...approval,
    status: 'CONSUMED',
    consumedAt: now.toISOString(),
    consumedByDecisionId: requiredString(decisionId, 'decisionId')
  };
}
