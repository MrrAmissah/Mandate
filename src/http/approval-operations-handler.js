import { recordSecurityEvent } from '../application/security-events.js';
import {
  addApproverGroupMember,
  bindApproverCredential,
  cancelApprovalOperation,
  createApprovalAssignment,
  createApproverGroup,
  createApproverIdentity,
  decideAssignedApproval,
  disableApproverIdentity,
  getActiveApprovalAssignment,
  listApproverGroups,
  listApproverIdentities,
  reassignApproval,
  removeApproverGroupMember,
  revokeApproverCredentialBinding
} from '../application/approval-operations.js';
import { API_SCOPES, ownershipFrom, requireScope } from '../auth/authentication.js';
import { createApprovalRequest, decideApproval } from '../domain/approvals.js';
import { DomainError } from '../domain/errors.js';
import {
  readJson,
  requestFingerprint,
  resolveRequestId,
  routeMatch,
  sendJson
} from './utils.js';

function approvalOperationsRoute(method, pathname) {
  if (pathname === '/v1/approver-identities' && ['GET', 'POST'].includes(method)) return true;
  if (method === 'POST' && routeMatch(pathname, '/v1/approver-identities/:id/disable')) return true;
  if (method === 'POST' && routeMatch(pathname, '/v1/approver-identities/:id/bindings')) return true;
  if (method === 'POST' && routeMatch(pathname, '/v1/approver-identities/:id/bindings/revoke')) return true;
  if (pathname === '/v1/approver-groups' && ['GET', 'POST'].includes(method)) return true;
  if (method === 'POST' && routeMatch(pathname, '/v1/approver-groups/:id/members')) return true;
  if (method === 'POST' && routeMatch(pathname, '/v1/approver-groups/:id/members/:approverId/remove')) return true;
  if (method === 'POST' && pathname === '/v1/approvals') return true;
  if (method === 'POST' && routeMatch(pathname, '/v1/approvals/:id/decide')) return true;
  if (method === 'POST' && routeMatch(pathname, '/v1/approvals/:id/reassign')) return true;
  if (method === 'POST' && routeMatch(pathname, '/v1/approvals/:id/cancel')) return true;
  return method === 'GET' && Boolean(routeMatch(pathname, '/v1/approvals/:id/assignment'));
}

async function idempotentMutation({ runtime, ownership, scope, key, fingerprint, execute }) {
  return runtime.store.transaction((transaction) => transaction.idempotent(
    ownership,
    scope,
    key,
    fingerprint,
    () => execute(transaction)
  ));
}

export function createApprovalOperationsHandler(runtime, fallback) {
  if (!runtime?.store || !runtime?.authenticator) throw new TypeError('Approval operations require a store and authenticator.');
  if (typeof fallback !== 'function') throw new TypeError('Approval operations require a fallback handler.');

  return async function approvalOperationsHandler(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const method = request.method ?? 'GET';
    if (!approvalOperationsRoute(method, url.pathname)) return fallback(request, response);

    const requestId = resolveRequestId(request.headers['x-request-id']);
    const respond = (status, body) => sendJson(response, status, body, { 'x-request-id': requestId });

    try {
      const authentication = await runtime.authenticator.authenticate(request.headers['x-api-key']);
      const ownership = ownershipFrom(authentication);

      if (method === 'GET' && url.pathname === '/v1/approver-identities') {
        requireScope(authentication, API_SCOPES.APPROVERS_READ);
        return respond(200, { data: await listApproverIdentities(runtime.store, ownership) });
      }

      if (method === 'POST' && url.pathname === '/v1/approver-identities') {
        requireScope(authentication, API_SCOPES.APPROVERS_WRITE);
        const body = await readJson(request);
        const created = await idempotentMutation({
          runtime,
          ownership,
          scope: 'create-approver-identity',
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const identity = await createApproverIdentity({
              view: transaction, ownership, authentication, input: body, now: new Date()
            });
            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              requestId,
              type: 'approver.identity_created',
              objectType: 'approver_identity',
              objectId: identity.id,
              data: { bindingCreated: Boolean(identity.binding) }
            });
            if (identity.binding) {
              await recordSecurityEvent({
                transaction,
                ownership,
                authentication,
                requestId,
                type: 'approver.credential_bound',
                objectType: 'approver_identity',
                objectId: identity.id,
                data: { credentialId: identity.binding.credentialId }
              });
            }
            return identity;
          }
        });
        return respond(201, created);
      }

      let params = routeMatch(url.pathname, '/v1/approver-identities/:id/disable');
      if (method === 'POST' && params) {
        requireScope(authentication, API_SCOPES.APPROVERS_WRITE);
        const body = await readJson(request);
        const result = await idempotentMutation({
          runtime,
          ownership,
          scope: `disable-approver:${params.id}`,
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const identity = await disableApproverIdentity({
              view: transaction, ownership, approverId: params.id, reason: body.reason, now: new Date()
            });
            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              requestId,
              type: 'approver.identity_disabled',
              objectType: 'approver_identity',
              objectId: identity.id,
              data: { reason: identity.disableReason }
            });
            return identity;
          }
        });
        return respond(200, result);
      }

      params = routeMatch(url.pathname, '/v1/approver-identities/:id/bindings/revoke');
      if (method === 'POST' && params) {
        requireScope(authentication, API_SCOPES.APPROVERS_WRITE);
        const body = await readJson(request);
        const result = await idempotentMutation({
          runtime,
          ownership,
          scope: `revoke-approver-binding:${params.id}`,
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const binding = await revokeApproverCredentialBinding({
              view: transaction,
              ownership,
              approverId: params.id,
              credentialId: body.credentialId,
              reason: body.reason,
              now: new Date()
            });
            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              requestId,
              type: 'approver.credential_binding_revoked',
              objectType: 'approver_identity',
              objectId: params.id,
              data: { credentialId: binding.credentialId }
            });
            return binding;
          }
        });
        return respond(200, result);
      }

      params = routeMatch(url.pathname, '/v1/approver-identities/:id/bindings');
      if (method === 'POST' && params) {
        requireScope(authentication, API_SCOPES.APPROVERS_WRITE);
        const body = await readJson(request);
        const result = await idempotentMutation({
          runtime,
          ownership,
          scope: `bind-approver-credential:${params.id}`,
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const binding = await bindApproverCredential({
              view: transaction,
              ownership,
              approverId: params.id,
              credentialId: body.bindCurrentCredential === true ? authentication.credentialId : body.credentialId,
              now: new Date()
            });
            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              requestId,
              type: 'approver.credential_bound',
              objectType: 'approver_identity',
              objectId: params.id,
              data: { credentialId: binding.credentialId }
            });
            return binding;
          }
        });
        return respond(201, result);
      }

      if (method === 'GET' && url.pathname === '/v1/approver-groups') {
        requireScope(authentication, API_SCOPES.APPROVERS_READ);
        return respond(200, { data: await listApproverGroups(runtime.store, ownership) });
      }

      if (method === 'POST' && url.pathname === '/v1/approver-groups') {
        requireScope(authentication, API_SCOPES.APPROVERS_WRITE);
        const body = await readJson(request);
        const result = await idempotentMutation({
          runtime,
          ownership,
          scope: 'create-approver-group',
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const group = await createApproverGroup({ view: transaction, ownership, input: body, now: new Date() });
            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              requestId,
              type: 'approver.group_created',
              objectType: 'approver_group',
              objectId: group.id,
              data: { name: group.name }
            });
            return group;
          }
        });
        return respond(201, result);
      }

      params = routeMatch(url.pathname, '/v1/approver-groups/:id/members/:approverId/remove');
      if (method === 'POST' && params) {
        requireScope(authentication, API_SCOPES.APPROVERS_WRITE);
        const body = await readJson(request);
        const result = await idempotentMutation({
          runtime,
          ownership,
          scope: `remove-approver-group-member:${params.id}:${params.approverId}`,
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const membership = await removeApproverGroupMember({
              view: transaction,
              ownership,
              groupId: params.id,
              approverId: params.approverId,
              reason: body.reason,
              now: new Date()
            });
            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              requestId,
              type: 'approver.group_member_removed',
              objectType: 'approver_group',
              objectId: params.id,
              data: { approverId: params.approverId }
            });
            return membership;
          }
        });
        return respond(200, result);
      }

      params = routeMatch(url.pathname, '/v1/approver-groups/:id/members');
      if (method === 'POST' && params) {
        requireScope(authentication, API_SCOPES.APPROVERS_WRITE);
        const body = await readJson(request);
        const result = await idempotentMutation({
          runtime,
          ownership,
          scope: `add-approver-group-member:${params.id}`,
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const membership = await addApproverGroupMember({
              view: transaction, ownership, groupId: params.id, approverId: body.approverId, now: new Date()
            });
            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              requestId,
              type: 'approver.group_member_added',
              objectType: 'approver_group',
              objectId: params.id,
              data: { approverId: membership.approverId }
            });
            return membership;
          }
        });
        return respond(201, result);
      }

      if (method === 'POST' && url.pathname === '/v1/approvals') {
        requireScope(authentication, API_SCOPES.APPROVALS_WRITE);
        const body = await readJson(request);
        if (!body.assignment) throw new DomainError('APPROVAL_ASSIGNMENT_REQUIRED', 'An approval assignment is required.');
        const result = await idempotentMutation({
          runtime,
          ownership,
          scope: 'create-approval',
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const mandate = await transaction.get('mandates', ownership, body.mandateId);
            if (!mandate) throw new DomainError('MANDATE_NOT_FOUND', 'The mandate does not exist.', 404);
            const approval = await transaction.save('approvals', ownership, createApprovalRequest(body, new Date()));
            const assignment = await createApprovalAssignment({
              view: transaction,
              ownership,
              approvalId: approval.id,
              assignment: body.assignment,
              authentication,
              now: new Date()
            });
            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              requestId,
              type: 'approval.requested',
              objectType: 'approval',
              objectId: approval.id,
              data: {
                mandateId: approval.mandateId,
                assignmentId: assignment.id,
                assignmentSourceType: assignment.sourceType,
                assignmentSourceId: assignment.sourceId
              }
            });
            return { ...approval, assignment };
          }
        });
        return respond(201, result);
      }

      params = routeMatch(url.pathname, '/v1/approvals/:id/decide');
      if (method === 'POST' && params) {
        requireScope(authentication, API_SCOPES.APPROVALS_DECIDE);
        const body = await readJson(request);
        const result = await idempotentMutation({
          runtime,
          ownership,
          scope: `decide-approval:${params.id}`,
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const approval = await transaction.get('approvals', ownership, params.id);
            if (!approval) throw new DomainError('APPROVAL_NOT_FOUND', 'The approval request does not exist.', 404);
            const decided = await decideAssignedApproval({
              view: transaction,
              ownership,
              approval,
              input: body,
              authentication,
              decide: decideApproval,
              now: new Date()
            });
            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              actorType: 'APPROVER',
              actorId: decided.approver.id,
              requestId,
              type: 'approval.decided',
              objectType: 'approval',
              objectId: params.id,
              data: {
                decision: decided.approval.status,
                approverId: decided.approver.id,
                credentialId: authentication.credentialId,
                assignmentId: decided.assignment.id
              }
            });
            return decided.approval;
          }
        });
        return respond(200, result);
      }

      params = routeMatch(url.pathname, '/v1/approvals/:id/reassign');
      if (method === 'POST' && params) {
        requireScope(authentication, API_SCOPES.APPROVALS_WRITE);
        const body = await readJson(request);
        const result = await idempotentMutation({
          runtime,
          ownership,
          scope: `reassign-approval:${params.id}`,
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const approval = await transaction.get('approvals', ownership, params.id);
            if (!approval) throw new DomainError('APPROVAL_NOT_FOUND', 'The approval request does not exist.', 404);
            const reassigned = await reassignApproval({
              view: transaction, ownership, approval, input: body, authentication, now: new Date()
            });
            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              requestId,
              type: 'approval.reassigned',
              objectType: 'approval',
              objectId: params.id,
              data: {
                previousAssignmentId: reassigned.previousAssignmentId,
                assignmentId: reassigned.assignment.id,
                assignmentSourceType: reassigned.assignment.sourceType,
                assignmentSourceId: reassigned.assignment.sourceId
              }
            });
            return { approvalId: params.id, ...reassigned };
          }
        });
        return respond(200, result);
      }

      params = routeMatch(url.pathname, '/v1/approvals/:id/cancel');
      if (method === 'POST' && params) {
        requireScope(authentication, API_SCOPES.APPROVALS_WRITE);
        const body = await readJson(request);
        const result = await idempotentMutation({
          runtime,
          ownership,
          scope: `cancel-approval:${params.id}`,
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const approval = await transaction.get('approvals', ownership, params.id);
            if (!approval) throw new DomainError('APPROVAL_NOT_FOUND', 'The approval request does not exist.', 404);
            const cancelled = await cancelApprovalOperation({
              view: transaction, ownership, approval, input: body, authentication, now: new Date()
            });
            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              requestId,
              type: 'approval.cancelled',
              objectType: 'approval',
              objectId: params.id,
              data: { reason: cancelled.cancellationReason }
            });
            return cancelled;
          }
        });
        return respond(200, result);
      }

      params = routeMatch(url.pathname, '/v1/approvals/:id/assignment');
      if (method === 'GET' && params) {
        requireScope(authentication, API_SCOPES.APPROVALS_READ);
        const approval = await runtime.store.get('approvals', ownership, params.id);
        if (!approval) throw new DomainError('APPROVAL_NOT_FOUND', 'The approval request does not exist.', 404);
        const assignment = await getActiveApprovalAssignment(runtime.store, ownership, params.id);
        if (!assignment) throw new DomainError('APPROVAL_UNASSIGNED', 'The approval has no active assignment.', 404);
        return respond(200, assignment);
      }

      return fallback(request, response);
    } catch (error) {
      if (error instanceof DomainError) {
        return respond(error.status, {
          error: {
            code: error.code,
            message: error.message,
            details: error.details ?? null,
            requestId
          }
        });
      }
      console.error(error);
      return respond(500, {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred.',
          requestId
        }
      });
    }
  };
}
