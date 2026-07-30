import { createServer } from 'node:http';

const SERVICE = 'mandate-outbox-worker';

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

export function renderOutboxWorkerMetrics(outboxProcess, now = new Date()) {
  const snapshot = outboxProcess.snapshot();
  const readiness = outboxProcess.readiness(now);
  const lastSuccessSeconds = snapshot.lastSuccessAt ? Date.parse(snapshot.lastSuccessAt) / 1000 : 0;
  const backlogObservedSeconds = snapshot.backlogObservedAt ? Date.parse(snapshot.backlogObservedAt) / 1000 : 0;
  return [
    '# HELP mandate_outbox_cycles_total Completed outbox worker cycles.',
    '# TYPE mandate_outbox_cycles_total counter',
    `mandate_outbox_cycles_total ${finite(snapshot.cycles)}`,
    '# HELP mandate_outbox_processed_total Messages processed successfully.',
    '# TYPE mandate_outbox_processed_total counter',
    `mandate_outbox_processed_total ${finite(snapshot.processedTotal)}`,
    '# HELP mandate_outbox_retry_scheduled_total Handler failures scheduled for retry.',
    '# TYPE mandate_outbox_retry_scheduled_total counter',
    `mandate_outbox_retry_scheduled_total ${finite(snapshot.retryScheduledTotal)}`,
    '# HELP mandate_outbox_dead_lettered_total Messages moved to dead letter.',
    '# TYPE mandate_outbox_dead_lettered_total counter',
    `mandate_outbox_dead_lettered_total ${finite(snapshot.deadLetteredTotal)}`,
    '# HELP mandate_outbox_lease_lost_total Handler completions rejected after lease loss.',
    '# TYPE mandate_outbox_lease_lost_total counter',
    `mandate_outbox_lease_lost_total ${finite(snapshot.leaseLostTotal)}`,
    '# HELP mandate_outbox_failures_total Failed worker cycles.',
    '# TYPE mandate_outbox_failures_total counter',
    `mandate_outbox_failures_total ${finite(snapshot.failures)}`,
    '# HELP mandate_outbox_limit_reached_total Cycles that exhausted their configured work bound.',
    '# TYPE mandate_outbox_limit_reached_total counter',
    `mandate_outbox_limit_reached_total ${finite(snapshot.limitReachedTotal)}`,
    '# HELP mandate_outbox_consecutive_failures Current consecutive failed cycles.',
    '# TYPE mandate_outbox_consecutive_failures gauge',
    `mandate_outbox_consecutive_failures ${finite(snapshot.consecutiveFailures)}`,
    '# HELP mandate_outbox_due_sample Current capped sample of due messages.',
    '# TYPE mandate_outbox_due_sample gauge',
    `mandate_outbox_due_sample ${finite(snapshot.dueSampleCount)}`,
    '# HELP mandate_outbox_stale_sample Current capped sample of stale processing leases.',
    '# TYPE mandate_outbox_stale_sample gauge',
    `mandate_outbox_stale_sample ${finite(snapshot.staleSampleCount)}`,
    '# HELP mandate_outbox_dead_letter_sample Current capped sample of dead-letter messages.',
    '# TYPE mandate_outbox_dead_letter_sample gauge',
    `mandate_outbox_dead_letter_sample ${finite(snapshot.deadLetterSampleCount)}`,
    '# HELP mandate_outbox_has_due Whether at least one due message exists in the bounded sample.',
    '# TYPE mandate_outbox_has_due gauge',
    `mandate_outbox_has_due ${snapshot.hasDue ? 1 : 0}`,
    '# HELP mandate_outbox_has_stale Whether at least one stale lease exists in the bounded sample.',
    '# TYPE mandate_outbox_has_stale gauge',
    `mandate_outbox_has_stale ${snapshot.hasStale ? 1 : 0}`,
    '# HELP mandate_outbox_has_dead_letter Whether at least one dead-letter message exists in the bounded sample.',
    '# TYPE mandate_outbox_has_dead_letter gauge',
    `mandate_outbox_has_dead_letter ${snapshot.hasDeadLetter ? 1 : 0}`,
    '# HELP mandate_outbox_backlog_observed_unixtime_seconds Database observation timestamp.',
    '# TYPE mandate_outbox_backlog_observed_unixtime_seconds gauge',
    `mandate_outbox_backlog_observed_unixtime_seconds ${finite(backlogObservedSeconds)}`,
    '# HELP mandate_outbox_last_success_unixtime_seconds Last fully successful cycle timestamp.',
    '# TYPE mandate_outbox_last_success_unixtime_seconds gauge',
    `mandate_outbox_last_success_unixtime_seconds ${finite(lastSuccessSeconds)}`,
    '# HELP mandate_outbox_ready Whether the worker is ready.',
    '# TYPE mandate_outbox_ready gauge',
    `mandate_outbox_ready ${readiness.ready ? 1 : 0}`,
    ''
  ].join('\n');
}

export function createOutboxWorkerHealthServer({
  outboxProcess,
  host = '127.0.0.1',
  port = 8789,
  clock = () => new Date()
}) {
  if (!outboxProcess?.snapshot || !outboxProcess?.readiness) {
    throw new TypeError('An observable outbox process is required.');
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
        status: 'ok', service: SERVICE, at: now.toISOString()
      });
    }
    if (url.pathname === '/health/ready') {
      const readiness = outboxProcess.readiness(now);
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
        renderOutboxWorkerMetrics(outboxProcess, now),
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
        await new Promise((resolveStart, reject) => {
          const onError = (error) => {
            server.off('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            server.off('error', onError);
            resolveStart();
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
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });
}
