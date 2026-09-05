import { recordSecurityEvent } from '../application/security-events.js';
import { reserveActionAttempt } from '../application/action-attempt-service.js';
import {
  cancelAttempt,
  completeAttempt,
  issueAttemptReceipt
} from '../application/attempt-lifecycle-service.js';
import { supersedeReceipt } from '../application/receipt-supersession-service.js';
import { API_SCOPES, ownershipFrom, requireScope } from '../auth/authentication.js';
import { verifyReceiptWithRegistry } from '../domain/receipts.js';
import { DomainError } from '../domain/errors.js';
import { createApp } from '../app.js';
import { createApprovalOperationsHandler } from './approval-operations-handler.js';
import { paginate, parsePageRequest } from './pagination.js';
import {
  readJson,
  requestFingerprint,
  resolveRequestId,
  routeMatch,
  sendJson
} from './utils.js';
import { getActionAttempt, listActionAttempts } from '../store/action-attempts.js';

function publicVerificationKey(key) {
  return {
    keyId: key.keyId,
    algorithm: key.algorithm,
    publicKeyPem: key.publicKeyPem,
    fingerprint: key.fingerprint,
    status: key.status,
    activatedAt: key.activatedAt,
    retiredAt: key.retiredAt
  };
}

function actionAttemptRoute(method, pathname) {
  if (pathname === '/v1/action-attempts' && ['GET', 'POST'].includes(method)) return true;
  if (method === 'GET' && routeMatch(pathname, '/v1/action-attempts/:id')) return true;
  if (method === 'POST' && routeMatch(pathname, '/v1/action-attempts/:id/complete')) return true;
  return method === 'POST' && Boolean(routeMatch(pathname, '/v1/action-attempts/:id/cancel'));
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

export function createRuntimeHandler(runtime) {
  if (!runtime?.signingKeys) throw new TypeError('A signing-key registry is required.');
  if (!runtime?.authenticator) throw new TypeError('An API authenticator is required.');
  const application = createApprovalOperationsHandler(runtime, createApp(runtime));

  return async function runtimeHandler(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const method = request.method ?? 'GET';
    const isDiscovery = method === 'GET' && url.pathname === '/.well-known/mandate-keys';
    const isVerification = method === 'POST' && url.pathname === '/v1/receipts/verify';
    const isReceiptIssuance = method === 'POST' && url.pathname === '/v1/receipts';
    const receiptSupersession = method === 'POST'
      ? routeMatch(url.pathname, '/v1/receipts/:id/supersede')
      : null;
    const handlesActionAttempt = actionAttemptRoute(method, url.pathname);
    if (!isDiscovery && !isVerification && !isReceiptIssuance && !receiptSupersession && !handlesActionAttempt) {
      return application(request, response);
    }

    const requestId = resolveRequestId(request.headers['x-request-id']);
    const respond = (status, body, extraHeaders = {}) => sendJson(response, status, body, {
      'x-request-id': requestId,
      ...extraHeaders
    });

    try {
      if (isDiscovery) {
        const keys = await runtime.signingKeys.listDiscoverable();
        return respond(200, {
          keys: keys.map(publicVerificationKey),
          requestId
        }, {
          'cache-control': 'public, max-age=300'
        });
      }

      const authentication = await runtime.authenticator.authenticate(request.headers['x-api-key']);
      const ownership = ownershipFrom(authentication);

      if (isVerification) {
        requireScope(authentication, API_SCOPES.RECEIPTS_READ);
        const body = await readJson(request);
        return respond(200, {
          valid: await verifyReceiptWithRegistry(body.receipt, runtime.signingKeys),
          keyId: body.receipt?.keyId ?? null,
          algorithm: body.receipt?.algorithm ?? null
        });
      }

      if (method === 'POST' && url.pathname === '/v1/action-attempts') {
        requireScope(authentication, API_SCOPES.ACTION_ATTEMPTS_WRITE);
        const body = await readJson(request);
        const attempt = await idempotentMutation({
          runtime,
          ownership,
          scope: 'reserve-action-attempt',
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const reserved = await reserveActionAttempt({
              transaction,
              ownership,
              authentication,
              input: body,
              requestId,
              now: new Date()
            });
            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              requestId,
              type: 'action_attempt.reserved',
              objectType: 'action_attempt',
              objectId: reserved.id,
              data: {
                decisionId: reserved.decisionId,
                mandateId: reserved.mandateId,
                expiresAt: reserved.expiresAt
              }
            });
            return reserved;
          }
        });
        return respond(201, attempt);
      }

      let params = routeMatch(url.pathname, '/v1/action-attempts/:id/complete');
      if (method === 'POST' && params) {
        requireScope(authentication, API_SCOPES.ACTION_ATTEMPTS_WRITE);
        const body = await readJson(request);
        const attempt = await idempotentMutation({
          runtime,
          ownership,
          scope: `complete-action-attempt:${params.id}`,
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const completed = await completeAttempt({
              transaction,
              ownership,
              authentication,
              attemptId: params.id,
              input: body,
              requestId,
              now: new Date()
            });
            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              requestId,
              type: 'action_attempt.completed',
              objectType: 'action_attempt',
              objectId: completed.id,
              data: {
                decisionId: completed.decisionId,
                executionStatus: completed.executionStatus,
                completedAt: completed.completedAt
              }
            });
            return completed;
          }
        });
        return respond(200, attempt);
      }

      params = routeMatch(url.pathname, '/v1/action-attempts/:id/cancel');
      if (method === 'POST' && params) {
        requireScope(authentication, API_SCOPES.ACTION_ATTEMPTS_WRITE);
        const body = await readJson(request);
        const attempt = await idempotentMutation({
          runtime,
          ownership,
          scope: `cancel-action-attempt:${params.id}`,
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const cancelled = await cancelAttempt({
              transaction,
              ownership,
              authentication,
              attemptId: params.id,
              input: body,
              requestId,
              now: new Date()
            });
            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              requestId,
              type: 'action_attempt.cancelled',
              objectType: 'action_attempt',
              objectId: cancelled.id,
              data: {
                decisionId: cancelled.decisionId,
                reason: cancelled.terminationReason,
                terminatedAt: cancelled.terminatedAt
              }
            });
            return cancelled;
          }
        });
        return respond(200, attempt);
      }

      if (isReceiptIssuance) {
        requireScope(authentication, API_SCOPES.RECEIPTS_WRITE);
        const body = await readJson(request);
        const receipt = await idempotentMutation({
          runtime,
          ownership,
          scope: 'issue-receipt',
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const issued = await issueAttemptReceipt({
              transaction,
              ownership,
              input: body,
              signer: runtime.signer,
              signingKeys: runtime.signingKeys,
              now: new Date()
            });
            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              requestId,
              type: 'receipt.issued',
              objectType: 'receipt',
              objectId: issued.id,
              data: {
                decisionId: issued.decisionId,
                actionAttemptId: issued.actionAttemptId,
                executionStatus: issued.executionStatus
              }
            });
            return issued;
          }
        });
        return respond(201, receipt);
      }

      if (receiptSupersession) {
        requireScope(authentication, API_SCOPES.RECEIPTS_WRITE);
        const body = await readJson(request);
        const receipt = await idempotentMutation({
          runtime,
          ownership,
          scope: `supersede-receipt:${receiptSupersession.id}`,
          key: request.headers['idempotency-key'],
          fingerprint: requestFingerprint({ method, pathname: url.pathname, body }),
          execute: async (transaction) => {
            const successor = await supersedeReceipt({
              transaction,
              ownership,
              receiptId: receiptSupersession.id,
              input: body,
              signer: runtime.signer,
              signingKeys: runtime.signingKeys,
              now: new Date()
            });
            await recordSecurityEvent({
              transaction,
              ownership,
              authentication,
              requestId,
              type: 'receipt.superseded',
              objectType: 'receipt',
              objectId: successor.id,
              data: {
                supersedesReceiptId: successor.supersedesReceiptId,
                decisionId: successor.decisionId,
                actionAttemptId: successor.actionAttemptId,
                keyId: successor.keyId
              }
            });
            return successor;
          }
        });
        return respond(201, receipt);
      }

      if (method === 'GET' && url.pathname === '/v1/action-attempts') {
        requireScope(authentication, API_SCOPES.ACTION_ATTEMPTS_READ);
        return respond(200, paginate(
          await listActionAttempts(runtime.store, ownership),
          { ...parsePageRequest(url), timestampField: 'reservedAt' }
        ));
      }

      params = routeMatch(url.pathname, '/v1/action-attempts/:id');
      if (method === 'GET' && params) {
        requireScope(authentication, API_SCOPES.ACTION_ATTEMPTS_READ);
        const attempt = await getActionAttempt(runtime.store, ownership, params.id);
        if (!attempt) throw new DomainError('ACTION_ATTEMPT_NOT_FOUND', 'The action attempt does not exist.', 404);
        return respond(200, attempt);
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
