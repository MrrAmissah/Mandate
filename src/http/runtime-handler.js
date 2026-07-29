import { recordSecurityEvent } from '../application/security-events.js';
import { reserveActionAttempt } from '../application/action-attempt-service.js';
import { API_SCOPES, ownershipFrom, requireScope } from '../auth/authentication.js';
import { verifyReceiptWithRegistry } from '../domain/receipts.js';
import { DomainError } from '../domain/errors.js';
import { createApp } from '../app.js';
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

function isActionAttemptRoute(method, pathname) {
  return (pathname === '/v1/action-attempts' && ['GET', 'POST'].includes(method))
    || (method === 'GET' && Boolean(routeMatch(pathname, '/v1/action-attempts/:id')));
}

export function createRuntimeHandler(runtime) {
  if (!runtime?.signingKeys) throw new TypeError('A signing-key registry is required.');
  if (!runtime?.authenticator) throw new TypeError('An API authenticator is required.');
  const application = createApp(runtime);

  return async function runtimeHandler(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const method = request.method ?? 'GET';
    const isDiscovery = method === 'GET' && url.pathname === '/.well-known/mandate-keys';
    const isVerification = method === 'POST' && url.pathname === '/v1/receipts/verify';
    const handlesActionAttempt = isActionAttemptRoute(method, url.pathname);
    if (!isDiscovery && !isVerification && !handlesActionAttempt) return application(request, response);

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
        const attempt = await runtime.store.transaction(async (transaction) => transaction.idempotent(
          ownership,
          'reserve-action-attempt',
          request.headers['idempotency-key'],
          requestFingerprint({ method, pathname: url.pathname, body }),
          async () => {
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
        ));
        return respond(201, attempt);
      }

      if (method === 'GET' && url.pathname === '/v1/action-attempts') {
        requireScope(authentication, API_SCOPES.ACTION_ATTEMPTS_READ);
        return respond(200, paginate(
          await listActionAttempts(runtime.store, ownership),
          { ...parsePageRequest(url), timestampField: 'reservedAt' }
        ));
      }

      const params = routeMatch(url.pathname, '/v1/action-attempts/:id');
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
