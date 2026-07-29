import { API_SCOPES, requireScope } from '../auth/authentication.js';
import { verifyReceiptWithRegistry } from '../domain/receipts.js';
import { DomainError } from '../domain/errors.js';
import { createApp } from '../app.js';
import { readJson, resolveRequestId, sendJson } from './utils.js';

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

export function createRuntimeHandler(runtime) {
  if (!runtime?.signingKeys) throw new TypeError('A signing-key registry is required.');
  if (!runtime?.authenticator) throw new TypeError('An API authenticator is required.');
  const application = createApp(runtime);

  return async function runtimeHandler(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const method = request.method ?? 'GET';
    const isDiscovery = method === 'GET' && url.pathname === '/.well-known/mandate-keys';
    const isVerification = method === 'POST' && url.pathname === '/v1/receipts/verify';
    if (!isDiscovery && !isVerification) return application(request, response);

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
      requireScope(authentication, API_SCOPES.RECEIPTS_READ);
      const body = await readJson(request);
      return respond(200, {
        valid: await verifyReceiptWithRegistry(body.receipt, runtime.signingKeys),
        keyId: body.receipt?.keyId ?? null,
        algorithm: body.receipt?.algorithm ?? null
      });
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
