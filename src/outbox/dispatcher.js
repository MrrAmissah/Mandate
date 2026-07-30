function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

function handlerEntries(handlers) {
  const entries = handlers instanceof Map ? [...handlers.entries()] : Object.entries(handlers ?? {});
  for (const [eventType, handler] of entries) {
    if (typeof eventType !== 'string' || eventType.length === 0 || typeof handler !== 'function') {
      throw new TypeError('Outbox handlers must map exact event type strings to functions.');
    }
  }
  return entries;
}

function workerScope(value) {
  if (!value || !['test', 'live'].includes(value.environment)) {
    throw new TypeError('An outbox dispatcher must declare a test/live environment scope.');
  }
  if (value.tenantId !== undefined && !/^ten_[A-Za-z0-9_-]+$/.test(value.tenantId)) {
    throw new TypeError('scope.tenantId must be an opaque ten_ identifier when provided.');
  }
  return Object.freeze({
    environment: value.environment,
    ...(value.tenantId === undefined ? {} : { tenantId: value.tenantId })
  });
}

async function observedTime(clock, name) {
  const value = await clock();
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${name} must return a valid timestamp.`);
  return parsed;
}

export function safeOutboxErrorCode(error) {
  const candidate = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  return /^[A-Z0-9_]{1,64}$/.test(candidate) ? candidate : 'HANDLER_FAILED';
}

export function retryDelayMs(attemptNumber, {
  baseDelayMs = 1_000,
  maximumDelayMs = 60_000
} = {}) {
  positiveInteger(attemptNumber, 'attemptNumber');
  positiveInteger(baseDelayMs, 'baseDelayMs');
  positiveInteger(maximumDelayMs, 'maximumDelayMs');
  return Math.min(maximumDelayMs, baseDelayMs * (2 ** Math.min(attemptNumber - 1, 30)));
}

export class OutboxDispatcher {
  constructor({
    queue,
    workerId,
    scope,
    handlers = {},
    now = () => new Date(),
    leaseMs = 30_000,
    maxAttempts = 5,
    baseDelayMs = 1_000,
    maximumDelayMs = 60_000
  }) {
    if (!queue || typeof queue.claim !== 'function') throw new TypeError('An outbox queue is required.');
    if (typeof workerId !== 'string' || workerId.length < 1 || workerId.length > 200) {
      throw new TypeError('workerId must contain between 1 and 200 characters.');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function.');
    positiveInteger(leaseMs, 'leaseMs');
    positiveInteger(maxAttempts, 'maxAttempts');
    positiveInteger(baseDelayMs, 'baseDelayMs');
    positiveInteger(maximumDelayMs, 'maximumDelayMs');

    this.queue = queue;
    this.workerId = workerId;
    this.scope = workerScope(scope);
    this.handlers = new Map(handlerEntries(handlers));
    this.now = now;
    this.leaseMs = leaseMs;
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this.maximumDelayMs = maximumDelayMs;
  }

  eventTypes() {
    return Object.freeze([...this.handlers.keys()]);
  }

  async pollOnce() {
    const eventTypes = [...this.handlers.keys()];
    if (eventTypes.length === 0) return { kind: 'IDLE', reason: 'NO_HANDLERS' };

    const claimedAt = await observedTime(this.now, 'outbox clock');
    const claimed = await this.queue.claim({
      workerId: this.workerId,
      scope: this.scope,
      eventTypes,
      now: claimedAt,
      leaseMs: this.leaseMs,
      maxAttempts: this.maxAttempts
    });
    if (!claimed) return { kind: 'IDLE', reason: 'NO_DUE_MESSAGES' };
    if (claimed.kind === 'DEAD_LETTERED') return claimed;

    const { message } = claimed;
    const handler = this.handlers.get(message.eventType);
    if (!handler) throw new Error(`No handler registered for claimed event type ${message.eventType}.`);

    try {
      await handler(message.payload, message);
      return this.queue.succeed(message, {
        workerId: this.workerId,
        now: await observedTime(this.now, 'outbox completion clock')
      });
    } catch (error) {
      const completedAt = await observedTime(this.now, 'outbox completion clock');
      const delay = retryDelayMs(message.attemptCount, {
        baseDelayMs: this.baseDelayMs,
        maximumDelayMs: this.maximumDelayMs
      });
      return this.queue.fail(message, {
        workerId: this.workerId,
        errorCode: safeOutboxErrorCode(error),
        retryAt: new Date(completedAt.getTime() + delay),
        maxAttempts: this.maxAttempts,
        now: completedAt
      });
    }
  }
}
