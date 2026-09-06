import { createServer } from 'node:http';

const SERVICE = 'mandate-approval-expiry';

function send(response, requestMethod, status, body, contentType) {
  const payload = Buffer.from(body);
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  if (requestMethod === 'HEAD') return response.end();
  response.end(payload);
}

function sendJson(response, requestMethod, status, value) {
  send(response, requestMethod, status, `${JSON.stringify(value)}\n`, 'application/json; charset=utf-8');
}

function finite(value) {
  return Number.isFinite(value) ? value : 0;
}

export function renderApprovalExpiryMetrics(expiryProcess, now = new Date()) {
  const snapshot = expiryProcess.snapshot();
  const readiness = expiryProcess.readiness(now);
  const lastSuccessSeconds = snapshot.lastSuccessAt ? Date.parse(snapshot.lastSuccessAt) / 1000 : 0;
  const backlogObservedSeconds = snapshot.backlogObservedAt ? Date.parse(snapshot.backlogObservedAt) / 1000 : 0;
  return [
    '# HELP mandate_approval_expiry_cycles_total Completed worker cycles.',
    '# TYPE mandate_approval_expiry_cycles_total counter',
    `mandate_approval_expiry_cycles_total ${finite(snapshot.cycles)}`,
    '# HELP mandate_approval_expiry_expired_total Pending or approved approvals materialized as expired.',
    '# TYPE mandate_approval_expiry_expired_total counter',
    `mandate_approval_expiry_expired_total ${finite(snapshot.expiredTotal)}`,
    '# HELP mandate_approval_expiry_failures_total Failed worker cycles.',
    '# TYPE mandate_approval_expiry_failures_total counter',
    `mandate_approval_expiry_failures_total ${finite(snapshot.failures)}`,
    '# HELP mandate_approval_expiry_limit_reached_total Cycles that reached the configured batch bound.',
    '# TYPE mandate_approval_expiry_limit_reached_total counter',
    `mandate_approval_expiry_limit_reached_total ${finite(snapshot.limitReachedTotal)}`,
    '# HELP mandate_approval_expiry_consecutive_failures Current consecutive failed cycles.',
    '# TYPE mandate_approval_expiry_consecutive_failures gauge',
    `mandate_approval_expiry_consecutive_failures ${finite(snapshot.consecutiveFailures)}`,
    '# HELP mandate_approval_expiry_backlog_expiring Pending or approved approvals with a deadline in worker scope.',
    '# TYPE mandate_approval_expiry_backlog_expiring gauge',
    `mandate_approval_expiry_backlog_expiring ${finite(snapshot.backlogExpiring)}`,
    '# HELP mandate_approval_expiry_backlog_due Expirable approvals whose deadline has elapsed.',
    '# TYPE mandate_approval_expiry_backlog_due gauge',
    `mandate_approval_expiry_backlog_due ${finite(snapshot.backlogDue)}`,
    '# HELP mandate_approval_expiry_oldest_overdue_seconds Age of the oldest overdue expirable approval.',
    '# TYPE mandate_approval_expiry_oldest_overdue_seconds gauge',
    `mandate_approval_expiry_oldest_overdue_seconds ${finite(snapshot.oldestOverdueSeconds)}`,
    '# HELP mandate_approval_expiry_backlog_observed_unixtime_seconds Database observation timestamp.',
    '# TYPE mandate_approval_expiry_backlog_observed_unixtime_seconds gauge',
    `mandate_approval_expiry_backlog_observed_unixtime_seconds ${finite(backlogObservedSeconds)}`,
    '# HELP mandate_approval_expiry_last_success_unixtime_seconds Last fully successful cycle timestamp.',
    '# TYPE mandate_approval_expiry_last_success_unixtime_seconds gauge',
    `mandate_approval_expiry_last_success_unixtime_seconds ${finite(lastSuccessSeconds)}`,
    '# HELP mandate_approval_expiry_ready Whether the worker is ready to process expiry work.',
    '# TYPE mandate_approval_expiry_ready gauge',
    `mandate_approval_expiry_ready ${readiness.ready ? 1 : 0}`,
    ''
  ].join('\n');
}

export function createApprovalExpiryHealthServer({
  expiryProcess,
  host = '127.0.0.1',
  port = 8790,
  clock = () => new Date()
}) {
  if (!expiryProcess?.snapshot || !expiryProcess?.readiness) {
    throw new TypeError('An observable approval expiry process is required.');
  }
  if (typeof host !== 'string' || host.length < 1 || host.length > 255 || /\s/.test(host)) {
    throw new TypeError('health host must be a non-empty hostname or address without whitespace.');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('health port must be an integer between 0 and 65535.');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');

  const server = createServer((request, response) => {
    const method = request.method ?? 'GET';
    if (!['GET', 'HEAD'].includes(method)) {
      response.setHeader('allow', 'GET, HEAD');
      return sendJson(response, method, 405, { error: 'method_not_allowed' });
    }

    let url;
    try {
      url = new URL(request.url ?? '/', 'http://health.local');
    } catch {
      return sendJson(response, method, 400, { error: 'bad_request' });
    }
    const now = clock();

    if (url.pathname === '/health/live') {
      return sendJson(response, method, 200, {
        status: 'ok',
        service: SERVICE,
        at: now.toISOString()
      });
    }

    if (url.pathname === '/health/ready') {
      const readiness = expiryProcess.readiness(now);
      return sendJson(response, method, readiness.ready ? 200 : 503, {
        status: readiness.ready ? 'ready' : 'not_ready',
        service: SERVICE,
        reason: readiness.reason,
        checkedAt: readiness.checkedAt,
        lastSuccessAt: readiness.lastSuccessAt,
        consecutiveFailures: readiness.consecutiveFailures
      });
    }

    if (url.pathname === '/metrics') {
      return send(
        response,
        method,
        200,
        renderApprovalExpiryMetrics(expiryProcess, now),
        'text/plain; version=0.0.4; charset=utf-8'
      );
    }

    return sendJson(response, method, 404, { error: 'not_found' });
  });

  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return Object.freeze({
    async start() {
      if (!server.listening) {
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            server.off('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            server.off('error', onError);
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, host);
        });
      }
      const address = server.address();
      return typeof address === 'object' && address
        ? Object.freeze({ host: address.address, port: address.port })
        : Object.freeze({ host, port });
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}
