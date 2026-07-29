import { timingSafeEqual } from 'node:crypto';
import { createMandate, revokeMandate } from './domain/mandates.js';
import { consumeApproval, createApprovalRequest, decideApproval } from './domain/approvals.js';
import { evaluateAuthorization, parseAuthorizationRequest } from './domain/authorization.js';
import { issueReceipt, verifyReceipt } from './domain/receipts.js';
import { DomainError } from './domain/errors.js';
import {
  readJson,
  requestFingerprint,
  resolveRequestId,
  routeMatch,
  sendJson
} from './http/utils.js';

function secureEquals(left, right) {
  const a = Buffer.from(left ?? '');
  const b = Buffer.from(right ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp({ store, signer, apiKey, now = () => new Date() }) {
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

      if (!apiKey || !secureEquals(request.headers['x-api-key'], apiKey)) {
        throw new DomainError('UNAUTHORIZED', 'A valid x-api-key header is required.', 401);
      }

      if (method === 'POST' && url.pathname === '/v1/mandates') {
        const body = await readJson(request);
        const mandate = store.idempotent(
          'create-mandate',
          request.headers['idempotency-key'],
          requestFingerprint({ method, pathname: url.pathname, body }),
          () => store.save('mandates', createMandate(body, now()))
        );
        return respond(201, mandate);
      }

      let params = routeMatch(url.pathname, '/v1/mandates/:id');
      if (method === 'GET' && params) {
        const mandate = store.get('mandates', params.id);
        if (!mandate) throw new DomainError('MANDATE_NOT_FOUND', 'The mandate does not exist.', 404);
        return respond(200, mandate);
      }

      params = routeMatch(url.pathname, '/v1/mandates/:id/revoke');
      if (method === 'POST' && params) {
        const mandate = store.get('mandates', params.id);
        if (!mandate) throw new DomainError('MANDATE_NOT_FOUND', 'The mandate does not exist.', 404);
        const body = await readJson(request);
        const revoked = store.idempotent(
          `revoke-mandate:${params.id}`,
          request.headers['idempotency-key'],
          requestFingerprint({ method, pathname: url.pathname, body }),
          () => store.save('mandates', revokeMandate(mandate, body.reason, now()))
        );
        return respond(200, revoked);
      }

      if (method === 'POST' && url.pathname === '/v1/approvals') {
        const body = await readJson(request);
        const mandate = store.get('mandates', body.mandateId);
        if (!mandate) throw new DomainError('MANDATE_NOT_FOUND', 'The mandate does not exist.', 404);
        const approval = store.idempotent(
          'create-approval',
          request.headers['idempotency-key'],
          requestFingerprint({ method, pathname: url.pathname, body }),
          () => store.save('approvals', createApprovalRequest(body, now()))
        );
        return respond(201, approval);
      }

      params = routeMatch(url.pathname, '/v1/approvals/:id/decide');
      if (method === 'POST' && params) {
        const approval = store.get('approvals', params.id);
        if (!approval) throw new DomainError('APPROVAL_NOT_FOUND', 'The approval request does not exist.', 404);
        const body = await readJson(request);
        const decided = store.idempotent(
          `decide-approval:${params.id}`,
          request.headers['idempotency-key'],
          requestFingerprint({ method, pathname: url.pathname, body }),
          () => store.save('approvals', decideApproval(approval, body, now()))
        );
        return respond(200, decided);
      }

      if (method === 'POST' && url.pathname === '/v1/authorize') {
        const body = await readJson(request);
        const fingerprint = requestFingerprint({ method, pathname: url.pathname, body });
        const decision = store.idempotent(
          'authorize',
          request.headers['idempotency-key'],
          fingerprint,
          () => {
            const requestInput = parseAuthorizationRequest(body);
            const mandate = store.get('mandates', requestInput.mandateId);
            const approval = requestInput.approvalId ? store.get('approvals', requestInput.approvalId) : null;
            const evaluated = evaluateAuthorization({ request: requestInput, mandate, approval, now: now() });
            store.save('decisions', evaluated);
            if (evaluated.outcome === 'ALLOW' && mandate) {
              store.save('mandates', { ...mandate, uses: mandate.uses + 1 });
              if (approval && evaluated.approvalId) {
                store.save('approvals', consumeApproval(approval, evaluated.id, now()));
              }
            }
            return evaluated;
          }
        );
        return respond(200, decision);
      }

      if (method === 'POST' && url.pathname === '/v1/receipts') {
        const body = await readJson(request);
        const receipt = store.idempotent(
          'issue-receipt',
          request.headers['idempotency-key'],
          requestFingerprint({ method, pathname: url.pathname, body }),
          () => {
            const decision = store.get('decisions', body.decisionId);
            const mandate = decision ? store.get('mandates', decision.mandateId) : null;
            return store.save('receipts', issueReceipt({ input: body, decision, mandate, signer, now: now() }));
          }
        );
        return respond(201, receipt);
      }

      params = routeMatch(url.pathname, '/v1/receipts/:id');
      if (method === 'GET' && params) {
        const receipt = store.get('receipts', params.id);
        if (!receipt) throw new DomainError('RECEIPT_NOT_FOUND', 'The receipt does not exist.', 404);
        return respond(200, receipt);
      }

      if (method === 'POST' && url.pathname === '/v1/receipts/verify') {
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
