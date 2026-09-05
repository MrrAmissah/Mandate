import {
  getApprovalInboxItem,
  listApprovalInbox,
  parseApprovalInboxState
} from '../application/approval-inbox.js';
import { API_SCOPES, ownershipFrom, requireScope } from '../auth/authentication.js';
import { DomainError } from '../domain/errors.js';
import { pageWindow, parsePageRequest } from './pagination.js';
import { resolveRequestId, routeMatch, sendJson } from './utils.js';

function approvalInboxRoute(method, pathname) {
  if (method !== 'GET') return false;
  if (pathname === '/v1/approval-inbox') return true;
  return Boolean(routeMatch(pathname, '/v1/approval-inbox/:id'));
}

export function createApprovalInboxHandler(runtime, fallback) {
  if (!runtime?.store || !runtime?.authenticator) {
    throw new TypeError('Approval inbox requires a store and authenticator.');
  }
  if (typeof fallback !== 'function') throw new TypeError('Approval inbox requires a fallback handler.');

  return async function approvalInboxHandler(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const method = request.method ?? 'GET';
    if (!approvalInboxRoute(method, url.pathname)) return fallback(request, response);

    const requestId = resolveRequestId(request.headers['x-request-id']);
    const respond = (status, body) => sendJson(response, status, body, { 'x-request-id': requestId });

    try {
      const authentication = await runtime.authenticator.authenticate(request.headers['x-api-key']);
      const ownership = ownershipFrom(authentication);
      requireScope(authentication, API_SCOPES.APPROVAL_INBOX_READ);

      if (url.pathname === '/v1/approval-inbox') {
        const page = parsePageRequest(url);
        const state = parseApprovalInboxState(url.searchParams.get('state'));
        const items = await listApprovalInbox({
          view: runtime.store,
          ownership,
          authentication,
          state,
          limit: page.limit,
          cursor: page.cursor,
          now: new Date()
        });
        return respond(200, {
          ...pageWindow(items, { limit: page.limit, timestampField: 'requestedAt' }),
          state
        });
      }

      const params = routeMatch(url.pathname, '/v1/approval-inbox/:id');
      const item = await getApprovalInboxItem({
        view: runtime.store,
        ownership,
        authentication,
        approvalId: params.id,
        now: new Date()
      });
      return respond(200, item);
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
