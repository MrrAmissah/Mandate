import { createApprovalInboxHandler } from './approval-inbox-handler.js';
import { createRuntimeHandler } from './runtime-handler.js';
import { resolveRequestId, sendJson } from './utils.js';

const HEALTH_PATHS = new Set(['/health', '/health/live', '/health/ready']);

export function createServerHandler(runtime) {
  if (!runtime?.health?.liveness || !runtime?.health?.readiness) {
    throw new TypeError('API liveness and readiness are required.');
  }
  const application = createApprovalInboxHandler(runtime, createRuntimeHandler(runtime));

  return async function serverHandler(request, response) {
    const method = request.method ?? 'GET';
    const url = new URL(request.url, 'http://localhost');
    if (method !== 'GET' || !HEALTH_PATHS.has(url.pathname)) {
      return application(request, response);
    }

    const requestId = resolveRequestId(request.headers['x-request-id']);
    const respond = (status, body) => sendJson(response, status, body, { 'x-request-id': requestId });

    if (url.pathname === '/health/ready') {
      const readiness = await runtime.health.readiness();
      return respond(readiness.ready ? 200 : 503, { ...readiness, requestId });
    }
    return respond(200, { ...runtime.health.liveness(), requestId });
  };
}
