import { randomUUID } from 'node:crypto';
import { matchesAny } from './patterns.js';
import { assertObject, requiredString } from './validate.js';

function decisionBase(request, mandate, now) {
  return {
    id: `dec_${randomUUID()}`,
    mandateId: mandate?.id ?? request.mandateId,
    agentId: request.agentId,
    action: request.action,
    resource: request.resource,
    context: structuredClone(request.context ?? {}),
    evaluatedAt: now.toISOString()
  };
}

function deny(base, reasonCode, reason) {
  return { ...base, outcome: 'DENY', reasonCode, reason, approvalId: null };
}

export function parseAuthorizationRequest(input) {
  assertObject(input);
  return {
    mandateId: requiredString(input.mandateId, 'mandateId'),
    agentId: requiredString(input.agentId, 'agentId'),
    action: requiredString(input.action, 'action'),
    resource: requiredString(input.resource, 'resource'),
    approvalId: input.approvalId ? requiredString(input.approvalId, 'approvalId') : null,
    context: assertObject(input.context ?? {}, 'context')
  };
}

/**
 * Policy order is intentionally explicit:
 * invalid state -> identity -> time/use limits -> resource -> explicit deny
 * -> allow -> approval requirement -> allow.
 */
export function evaluateAuthorization({ request, mandate, approval = null, now = new Date() }) {
  const base = decisionBase(request, mandate, now);

  if (!mandate) return deny(base, 'MANDATE_NOT_FOUND', 'The mandate does not exist.');
  if (mandate.status === 'REVOKED') return deny(base, 'MANDATE_REVOKED', 'The mandate has been revoked.');
  if (mandate.status !== 'ACTIVE') return deny(base, 'MANDATE_INACTIVE', 'The mandate is not active.');
  if (request.agentId !== mandate.agentId) return deny(base, 'AGENT_MISMATCH', 'The requesting agent is not the delegated agent.');
  if (Date.parse(now) < Date.parse(mandate.validFrom)) return deny(base, 'MANDATE_NOT_YET_VALID', 'The mandate is not valid yet.');
  if (mandate.validUntil && Date.parse(now) >= Date.parse(mandate.validUntil)) {
    return deny(base, 'MANDATE_EXPIRED', 'The mandate has expired.');
  }
  if (mandate.maxUses !== null && mandate.uses >= mandate.maxUses) {
    return deny(base, 'USE_LIMIT_REACHED', 'The mandate has reached its use limit.');
  }
  if (!matchesAny(mandate.resources, request.resource)) {
    return deny(base, 'RESOURCE_OUT_OF_SCOPE', 'The resource is outside the delegated scope.');
  }
  if (matchesAny(mandate.deniedActions, request.action)) {
    return deny(base, 'EXPLICITLY_DENIED', 'An explicit deny rule matched this action.');
  }
  if (!matchesAny(mandate.allowedActions, request.action)) {
    return deny(base, 'ACTION_NOT_ALLOWED', 'No allow rule matched this action.');
  }

  if (matchesAny(mandate.approvalRequiredActions, request.action)) {
    const approvalIsValid = approval &&
      approval.status === 'APPROVED' &&
      approval.mandateId === mandate.id &&
      approval.agentId === request.agentId &&
      approval.action === request.action &&
      approval.resource === request.resource &&
      (!approval.expiresAt || Date.parse(now) < Date.parse(approval.expiresAt));

    if (!approvalIsValid) {
      return {
        ...base,
        outcome: 'REQUIRE_APPROVAL',
        reasonCode: 'HUMAN_APPROVAL_REQUIRED',
        reason: 'This delegated action requires a matching, unexpired human approval.',
        approvalId: approval?.id ?? null
      };
    }
  }

  return {
    ...base,
    outcome: 'ALLOW',
    reasonCode: 'POLICY_SATISFIED',
    reason: 'The request satisfies the active mandate.',
    approvalId: approval?.id ?? null
  };
}
