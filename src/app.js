import { createStaticApiKeyAuthenticator, API_SCOPES, ownershipFrom, requireScope } from './auth/authentication.js';
import { recordSecurityEvent } from './application/security-events.js';
import { createMandate, revokeMandate } from './domain/mandates.js';
import { consumeApproval, createApprovalRequest, decideApproval } from './domain/approvals.js';
import { evaluateAuthorization, parseAuthorizationRequest } from './domain/authorization.js';
import { issueReceipt, verifyReceipt } from './domain/receipts.js';
import { DomainError } from './domain/errors.js';
import { paginate, parsePageRequest } from './http/pagination.js';
import {
  readJson,
  requestFingerprint,
  resolveRequestId,
  routeMatch,
  sendJson
} from './http/utils.js';

function configuredAuthenticator({ authenticator, apiKey }) {
  return authenticator ?? createStaticApiKeyAuthenticator({ apiKey });
}

async function idempotentMutation({
  store,
  ownership,
  scope,
  key,
  fingerprint,
  execute
}) {
  return store.transaction(async (transaction) => transaction.idempotent(
    ownership,
    scope,
    key,
    fingerprint,
    () => execute(transaction)
  ));
}

async function listResponse(store, ownership, kind, url, timestampField) {
  const page = parsePageRequest(url);
  return paginate(await store.list(kind, ownership), { ...page, timestampField });
}

export function createApp({ store, signer, apiKey, authenticator, now = () => new Date() }) {
  const apiAuthenticator = configuredAuthenticator({ authenticator, apiKey });

  return async function handler(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const method = request.method ?? 'GET';
    const requestId = resolveRequestId(request.headers['x-request-id']);
    const respond = (status, body, extraHeaders = {}) => sendJson(response, status, body, {
      'x-request-id': requestId,
      ...extraHeaders
    });

    try {
      if (method === 'GET' && url.pathname === '/health') {
        return respond(200, { status: 'ok', service: 'mandate-api', requestId });
      }

      if (method === 'GET' && url.pathname === '/.well-known/mandate-keys') {
        return respond(200, {
          keys: [{ keyId: signer.keyId, algorithm: signer.algorithm, publicKeyPem: signer.publicKeyPem }],
          requestId
        });
      }

      const authentication = await apiAuthenticator.authenticate(request.headers['x-api-key']);
      const ownership = ownershipFrom(authentication);

      if (method === 'POST' && url.pathname === '/v1/mandates') {
        requireScope(authentication, API_SCOPES.MANDATES_WRITE);
        const body = await readJson(request);
        const mandate = await idempotentMutation({
          store,
          ownership,
          scope: 'create-mandate',
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const created = await transaction.save('mandates', ownership, createMandate(body, now()));
            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              requestId,
              type: 'mandate.created',
              objectType: 'mandate',
              objectId: created.id,
              now: now()
            });
            return created;
          }
        });
        return respond(201, mandate);
      }

      if (method === 'GET' && url.pathname === '/v1/mandates') {
        requireScope(authentication, API_SCOPES.MANDATES_READ);
        return respond(200, await listResponse(store, ownership, 'mandates', url, 'createdAt'));
      }

      let params = routeMatch(url.pathname, '/v1/mandates/:id');
      if (method === 'GET' && params) {
        requireScope(authentication, API_SCOPES.MANDATES_READ);
        const mandate = await store.get('mandates', ownership, params.id);
        if (!mandate) throw new DomainError('MANDATE_NOT_FOUND', 'The mandate does not exist.', 404);
        return respond(200, mandate);
      }

      params = routeMatch(url.pathname, '/v1/mandates/:id/revoke');
      if (method === 'POST' && params) {
        requireScope(authentication, API_SCOPES.MANDATES_WRITE);
        const body = await readJson(request);
        const revoked = await idempotentMutation({
          store,
          ownership,
          scope: `revoke-mandate:${params.id}`,
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const mandate = await transaction.get('mandates', ownership, params.id);
            if (!mandate) throw new DomainError('MANDATE_NOT_FOUND', 'The mandate does not exist.', 404);
            const result = await transaction.save('mandates', ownership, revokeMandate(mandate, body.reason, now()));
            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              requestId,
              type: 'mandate.revoked',
              objectType: 'mandate',
              objectId: result.id,
              data: { reason: result.revocationReason },
              now: now()
            });
            return result;
          }
        });
        return respond(200, revoked);
      }

      if (method === 'POST' && url.pathname === '/v1/approvals') {
        requireScope(authentication, API_SCOPES.APPROVALS_WRITE);
        const body = await readJson(request);
        const approval = await idempotentMutation({
          store,
          ownership,
          scope: 'create-approval',
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const mandate = await transaction.get('mandates', ownership, body.mandateId);
            if (!mandate) throw new DomainError('MANDATE_NOT_FOUND', 'The mandate does not exist.', 404);
            const created = await transaction.save('approvals', ownership, createApprovalRequest(body, now()));
            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              requestId,
              type: 'approval.requested',
              objectType: 'approval',
              objectId: created.id,
              data: { mandateId: created.mandateId },
              now: now()
            });
            return created;
          }
        });
        return respond(201, approval);
      }

      if (method === 'GET' && url.pathname === '/v1/approvals') {
        requireScope(authentication, API_SCOPES.APPROVALS_READ);
        return respond(200, await listResponse(store, ownership, 'approvals', url, 'requestedAt'));
      }

      params = routeMatch(url.pathname, '/v1/approvals/:id');
      if (method === 'GET' && params) {
        requireScope(authentication, API_SCOPES.APPROVALS_READ);
        const approval = await store.get('approvals', ownership, params.id);
        if (!approval) throw new DomainError('APPROVAL_NOT_FOUND', 'The approval request does not exist.', 404);
        return respond(200, approval);
      }

      params = routeMatch(url.pathname, '/v1/approvals/:id/decide');
      if (method === 'POST' && params) {
        requireScope(authentication, API_SCOPES.APPROVALS_WRITE);
        const body = await readJson(request);
        const decided = await idempotentMutation({
          store,
          ownership,
          scope: `decide-approval:${params.id}`,
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const approval = await transaction.get('approvals', ownership, params.id);
            if (!approval) throw new DomainError('APPROVAL_NOT_FOUND', 'The approval request does not exist.', 404);
            const result = await transaction.save('approvals', ownership, decideApproval(approval, body, now()));
            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              requestId,
              type: 'approval.decided',
              objectType: 'approval',
              objectId: result.id,
              data: { decision: result.status, decidedBy: result.decidedBy },
              now: now()
            });
            return result;
          }
        });
        return respond(200, decided);
      }

      if (method === 'POST' && url.pathname === '/v1/authorize') {
        requireScope(authentication, API_SCOPES.AUTHORIZATIONS_WRITE);
        const body = await readJson(request);
        const decision = await idempotentMutation({
          store,
          ownership,
          scope: 'authorize',
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const requestInput = parseAuthorizationRequest(body);
            const mandate = await transaction.get('mandates', ownership, requestInput.mandateId);
            const approval = requestInput.approvalId
              ? await transaction.get('approvals', ownership, requestInput.approvalId)
              : null;
            const evaluated = {
              ...evaluateAuthorization({ request: requestInput, mandate, approval, now: now() }),
              requestId
            };
            await transaction.save('decisions', ownership, evaluated);

            if (evaluated.outcome === 'ALLOW' && mandate) {
              await transaction.save('mandates', ownership, { ...mandate, uses: mandate.uses + 1 });
              if (approval && evaluated.approvalId) {
                await transaction.save('approvals', ownership, consumeApproval(approval, evaluated.id, now()));
              }
            }

            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              requestId,
              type: 'authorization.evaluated',
              objectType: 'authorization_decision',
              objectId: evaluated.id,
              data: {
                mandateId: evaluated.mandateId,
                outcome: evaluated.outcome,
                reasonCode: evaluated.reasonCode
              },
              now: now()
            });
            return evaluated;
          }
        });
        return respond(200, decision);
      }

      if (method === 'GET' && url.pathname === '/v1/decisions') {
        requireScope(authentication, API_SCOPES.AUTHORIZATIONS_READ);
        return respond(200, await listResponse(store, ownership, 'decisions', url, 'evaluatedAt'));
      }

      params = routeMatch(url.pathname, '/v1/decisions/:id');
      if (method === 'GET' && params) {
        requireScope(authentication, API_SCOPES.AUTHORIZATIONS_READ);
        const decision = await store.get('decisions', ownership, params.id);
        if (!decision) throw new DomainError('DECISION_NOT_FOUND', 'The authorization decision does not exist.', 404);
        return respond(200, decision);
      }

      if (method === 'POST' && url.pathname === '/v1/receipts') {
        requireScope(authentication, API_SCOPES.RECEIPTS_WRITE);
        const body = await readJson(request);
        const receipt = await idempotentMutation({
          store,
          ownership,
          scope: 'issue-receipt',
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const decision = await transaction.get('decisions', ownership, body.decisionId);
            const mandate = decision
              ? await transaction.get('mandates', ownership, decision.mandateId)
              : null;
            const issued = await transaction.save(
              'receipts',
              ownership,
              issueReceipt({ input: body, decision, mandate, signer, now: now() })
            );
            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              requestId,
              type: 'receipt.issued',
              objectType: 'receipt',
              objectId: issued.id,
              data: { decisionId: issued.decisionId, executionStatus: issued.executionStatus },
              now: now()
            });
            return issued;
          }
        });
        return respond(201, receipt);
      }

      if (method === 'GET' && url.pathname === '/v1/receipts') {
        requireScope(authentication, API_SCOPES.RECEIPTS_READ);
        return respond(200, await listResponse(store, ownership, 'receipts', url, 'issuedAt'));
      }

      params = routeMatch(url.pathname, '/v1/receipts/:id');
      if (method === 'GET' && params) {
        requireScope(authentication, API_SCOPES.RECEIPTS_READ);
        const receipt = await store.get('receipts', ownership, params.id);
        if (!receipt) throw new DomainError('RECEIPT_NOT_FOUND', 'The receipt does not exist.', 404);
        return respond(200, receipt);
      }

      if (method === 'POST' && url.pathname === '/v1/receipts/verify') {
        requireScope(authentication, API_SCOPES.RECEIPTS_READ);
        const body = await readJson(request);
        return respond(200, {
          valid: verifyReceipt(body.receipt, signer),
          keyId: body.receipt?.keyId ?? null,
          algorithm: body.receipt?.algorithm ?? null
        });
      }

      throw new DomainError('NOT_FOUND', 'Route not found.', 404);
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
