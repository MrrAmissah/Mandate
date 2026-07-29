import { timingSafeEqual } from 'node:crypto';
import { createMandate, revokeMandate } from './domain/mandates.js';
import { createApprovalRequest, decideApproval } from './domain/approvals.js';
import { evaluateAuthorization, parseAuthorizationRequest } from './domain/authorization.js';
import { issueReceipt, verifyReceipt } from './domain/receipts.js';
import { DomainError } from './domain/errors.js';
import { readJson, routeMatch, sendJson } from './http/utils.js';

function secureEquals(left, right) {
  const a = Buffer.from(left ?? '');
  const b = Buffer.from(right ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp({ store, signer, apiKey, now = () => new Date() }) {
  return async function handler(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const method = request.method ?? 'GET';

    try {
      if (method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, { status: 'ok', service: 'mandate-agent-trust-api' });
      }

      if (method === 'GET' && url.pathname === '/.well-known/mandate-keys') {
        return sendJson(response, 200, {
          keys: [{ keyId: signer.keyId, algorithm: signer.algorithm, publicKeyPem: signer.publicKeyPem }]
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
          () => store.save('mandates', createMandate(body, now()))
        );
        return sendJson(response, 201, mandate);
      }

      let params = routeMatch(url.pathname, '/v1/mandates/:id');
      if (method === 'GET' && params) {
        const mandate = store.get('mandates', params.id);
        if (!mandate) throw new DomainError('MANDATE_NOT_FOUND', 'The mandate does not exist.', 404);
        return sendJson(response, 200, mandate);
      }

      params = routeMatch(url.pathname, '/v1/mandates/:id/revoke');
      if (method === 'POST' && params) {
        const mandate = store.get('mandates', params.id);
        if (!mandate) throw new DomainError('MANDATE_NOT_FOUND', 'The mandate does not exist.', 404);
        const body = await readJson(request);
        const revoked = store.save('mandates', revokeMandate(mandate, body.reason, now()));
        return sendJson(response, 200, revoked);
      }

      if (method === 'POST' && url.pathname === '/v1/approvals') {
        const body = await readJson(request);
        const mandate = store.get('mandates', body.mandateId);
        if (!mandate) throw new DomainError('MANDATE_NOT_FOUND', 'The mandate does not exist.', 404);
        const approval = store.idempotent(
          'create-approval',
          request.headers['idempotency-key'],
          () => store.save('approvals', createApprovalRequest(body, now()))
        );
        return sendJson(response, 201, approval);
      }

      params = routeMatch(url.pathname, '/v1/approvals/:id/decide');
      if (method === 'POST' && params) {
        const approval = store.get('approvals', params.id);
        if (!approval) throw new DomainError('APPROVAL_NOT_FOUND', 'The approval request does not exist.', 404);
        const body = await readJson(request);
        const decided = store.save('approvals', decideApproval(approval, body, now()));
        return sendJson(response, 200, decided);
      }

      if (method === 'POST' && url.pathname === '/v1/authorize') {
        const requestInput = parseAuthorizationRequest(await readJson(request));
        const mandate = store.get('mandates', requestInput.mandateId);
        const approval = requestInput.approvalId ? store.get('approvals', requestInput.approvalId) : null;
        const decision = evaluateAuthorization({ request: requestInput, mandate, approval, now: now() });
        store.save('decisions', decision);
        if (decision.outcome === 'ALLOW' && mandate) {
          store.save('mandates', { ...mandate, uses: mandate.uses + 1 });
        }
        return sendJson(response, 200, decision);
      }

      if (method === 'POST' && url.pathname === '/v1/receipts') {
        const body = await readJson(request);
        const decision = store.get('decisions', body.decisionId);
        const mandate = decision ? store.get('mandates', decision.mandateId) : null;
        const receipt = store.idempotent(
          'issue-receipt',
          request.headers['idempotency-key'],
          () => store.save('receipts', issueReceipt({ input: body, decision, mandate, signer, now: now() }))
        );
        return sendJson(response, 201, receipt);
      }

      params = routeMatch(url.pathname, '/v1/receipts/:id');
      if (method === 'GET' && params) {
        const receipt = store.get('receipts', params.id);
        if (!receipt) throw new DomainError('RECEIPT_NOT_FOUND', 'The receipt does not exist.', 404);
        return sendJson(response, 200, receipt);
      }

      if (method === 'POST' && url.pathname === '/v1/receipts/verify') {
        const body = await readJson(request);
        return sendJson(response, 200, { valid: verifyReceipt(body.receipt, signer) });
      }

      throw new DomainError('NOT_FOUND', 'Route not found.', 404);
    } catch (error) {
      if (error instanceof DomainError) {
        return sendJson(response, error.status, {
          error: { code: error.code, message: error.message, details: error.details ?? null }
        });
      }
      console.error(error);
      return sendJson(response, 500, {
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' }
      });
    }
  };
}
