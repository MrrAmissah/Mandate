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
    decisionReason: null
  };
}

export function decideApproval(approval, input, now = new Date()) {
  assertObject(input);
  if (approval.status !== 'PENDING') {
    throw new DomainError('APPROVAL_ALREADY_DECIDED', 'This approval request has already been decided.', 409);
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
    decisionReason: requiredString(input.reason, 'reason')
  };
}
