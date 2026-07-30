import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OutboxDispatcher } from '../outbox/dispatcher.js';
import { PostgresOutboxQueue } from '../outbox/postgres-outbox-queue.js';
import { createPostgresPool } from '../store/postgres-store.js';
import { createOutboxWorkerHealthServer } from './outbox-worker-health.js';

const REQUIRED_MIGRATIONS = Object.freeze([
  '002_outbox_attempts',
  '009_outbox_worker_operations'
]);

function integer(value, fallback, { name, minimum, maximum }) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function booleanValue(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('Boolean environment values must be true or false.');
}

function safeHost(value, fallback) {
  const host = value ?? fallback;
  if (typeof host !== 'string' || host.length < 1 || host.length > 255 || /\s/.test(host)) {
    throw new Error('MANDATE_OUTBOX_HEALTH_HOST must be a non-empty hostname or address without whitespace.');
  }
  return host;
}

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{2,80}$/.test(error.code)
    ? error.code
    : 'OUTBOX_CYCLE_FAILED';
}

function log(logger, level, event) {
  const target = typeof logger?.[level] === 'function'
    ? logger[level].bind(logger)
    : logger.log.bind(logger);
  target(JSON.stringify(event));
}

function dateValue(value, name) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${name} must be a valid timestamp.`);
  return parsed;
}

function localModuleUrl(value, cwd = process.cwd()) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) {
    throw new Error('MANDATE_OUTBOX_HANDLER_MODULE must name one local JavaScript module.');
  }
  let url;
  try {
    url = new URL(value);
    if (url.protocol !== 'file:') throw new Error('Only local file handler modules are supported.');
  } catch (error) {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) throw error;
    url = pathToFileURL(resolve(cwd, value));
  }
  return url;
}

function handlerEntries(candidate) {
  const entries = candidate instanceof Map ? [...candidate.entries()] : Object.entries(candidate ?? {});
  if (entries.length === 0) throw new Error('The outbox handler module must export at least one exact event handler.');
  for (const [eventType, handler] of entries) {
    if (
      typeof eventType !== 'string' ||
      eventType.length < 1 ||
      eventType.length > 255 ||
      eventType.includes('*') ||
      typeof handler !== 'function'
    ) {
      throw new Error('Outbox handlers must map exact non-wildcard event type strings to functions.');
    }
  }
  return new Map(entries);
}

export async function loadOutboxHandlers(moduleSpecifier, { cwd = process.cwd(), importer = (url) => import(url) } = {}) {
  if (typeof importer !== 'function') throw new TypeError('handler importer must be a function.');
  const url = localModuleUrl(moduleSpecifier, cwd);
  const loaded = await importer(url.href);
  return handlerEntries(loaded.handlers ?? loaded.default);
}

export function parseOutboxWorkerConfig(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for the outbox worker.');
  const environment = env.MANDATE_ENVIRONMENT;
  if (!['test', 'live'].includes(environment)) {
    throw new Error('MANDATE_ENVIRONMENT must be explicitly set to test or live.');
  }
  const tenantId = env.MANDATE_TENANT_ID || undefined;
  if (tenantId && !/^ten_[A-Za-z0-9_-]+$/.test(tenantId)) {
    throw new Error('MANDATE_TENANT_ID must use the ten_ prefix.');
  }
  if (!env.MANDATE_OUTBOX_HANDLER_MODULE) {
    throw new Error('MANDATE_OUTBOX_HANDLER_MODULE is required.');
  }
  const configuredWorkerId = env.MANDATE_OUTBOX_WORKER_ID;
  if (environment === 'live' && !configuredWorkerId) {
    throw new Error('MANDATE_OUTBOX_WORKER_ID is required in live environments.');
  }

  const pollIntervalMs = integer(env.MANDATE_OUTBOX_POLL_INTERVAL_MS, 1000, {
    name: 'MANDATE_OUTBOX_POLL_INTERVAL_MS', minimum: 100, maximum: 60000
  });
  const readinessStaleMs = integer(
    env.MANDATE_OUTBOX_READINESS_STALE_MS,
    Math.max(5000, pollIntervalMs * 3),
    {
      name: 'MANDATE_OUTBOX_READINESS_STALE_MS',
      minimum: pollIntervalMs * 2,
      maximum: 3600000
    }
  );

  return Object.freeze({
    databaseUrl: env.DATABASE_URL,
    databaseSsl: booleanValue(env.MANDATE_DATABASE_SSL, false),
    databasePoolMax: integer(env.MANDATE_DATABASE_POOL_MAX, 5, {
      name: 'MANDATE_DATABASE_POOL_MAX', minimum: 1, maximum: 100
    }),
    environment,
    tenantId,
    workerId: configuredWorkerId ?? `outbox:${hostname()}:${process.pid}`,
    handlerModule: env.MANDATE_OUTBOX_HANDLER_MODULE,
    pollIntervalMs,
    cycleLimit: integer(env.MANDATE_OUTBOX_CYCLE_LIMIT, 100, {
      name: 'MANDATE_OUTBOX_CYCLE_LIMIT', minimum: 1, maximum: 5000
    }),
    leaseMs: integer(env.MANDATE_OUTBOX_LEASE_MS, 30000, {
      name: 'MANDATE_OUTBOX_LEASE_MS', minimum: 1000, maximum: 900000
    }),
    maxAttempts: integer(env.MANDATE_OUTBOX_MAX_ATTEMPTS, 5, {
      name: 'MANDATE_OUTBOX_MAX_ATTEMPTS', minimum: 1, maximum: 100
    }),
    baseDelayMs: integer(env.MANDATE_OUTBOX_BASE_DELAY_MS, 1000, {
      name: 'MANDATE_OUTBOX_BASE_DELAY_MS', minimum: 100, maximum: 3600000
    }),
    maximumDelayMs: integer(env.MANDATE_OUTBOX_MAXIMUM_DELAY_MS, 60000, {
      name: 'MANDATE_OUTBOX_MAXIMUM_DELAY_MS', minimum: 100, maximum: 86400000
    }),
    readinessStaleMs,
    readinessFailureThreshold: integer(env.MANDATE_OUTBOX_READINESS_FAILURE_THRESHOLD, 3, {
      name: 'MANDATE_OUTBOX_READINESS_FAILURE_THRESHOLD', minimum: 1, maximum: 100
    }),
    healthHost: safeHost(env.MANDATE_OUTBOX_HEALTH_HOST, '127.0.0.1'),
    healthPort: integer(env.MANDATE_OUTBOX_HEALTH_PORT, 8789, {
      name: 'MANDATE_OUTBOX_HEALTH_PORT', minimum: 1, maximum: 65535
    })
  });
}

export async function assertOutboxWorkerSchema(pool) {
  const registry = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'mandate' AND table_name = 'schema_migrations'
     ) AS registry_exists`
  );
  if (!registry.rows[0]?.registry_exists) {
    throw new Error('Mandate migration registry is unavailable. Run migrations with the deployment role before starting the worker.');
  }
  for (const version of REQUIRED_MIGRATIONS) {
    const migration = await pool.query(
      'SELECT 1 FROM mandate.schema_migrations WHERE version = $1',
      [version]
    );
    if (migration.rowCount !== 1) throw new Error(`Required migration ${version} is not applied.`);
  }
}

function abortableSleep(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolveSleep) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolveSleep();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export class OutboxWorkerProcess {
  constructor({
    dispatcher,
    queue,
    pollIntervalMs,
    cycleLimit,
    readinessStaleMs,
    readinessFailureThreshold,
    logger = console,
    sleep = abortableSleep,
    clock = () => new Date()
  }) {
    if (!dispatcher?.pollOnce || !dispatcher?.eventTypes) throw new TypeError('An outbox dispatcher is required.');
    if (!queue?.inspectBacklog) throw new TypeError('An observable outbox queue is required.');
    if (!Number.isInteger(cycleLimit) || cycleLimit < 1) throw new TypeError('cycleLimit must be positive.');
    if (!Number.isInteger(readinessStaleMs) || readinessStaleMs < pollIntervalMs * 2) {
      throw new TypeError('readinessStaleMs must be at least two polling intervals.');
    }
    if (!Number.isInteger(readinessFailureThreshold) || readinessFailureThreshold < 1) {
      throw new TypeError('readinessFailureThreshold must be positive.');
    }
    this.dispatcher = dispatcher;
    this.queue = queue;
    this.pollIntervalMs = pollIntervalMs;
    this.cycleLimit = cycleLimit;
    this.readinessStaleMs = readinessStaleMs;
    this.readinessFailureThreshold = readinessFailureThreshold;
    this.logger = logger;
    this.sleep = sleep;
    this.clock = clock;
    this.running = false;
    this.shuttingDown = false;
    this.startedAt = null;
    this.stoppedAt = null;
    this.metrics = {
      cycles: 0,
      processedTotal: 0,
      retryScheduledTotal: 0,
      deadLetteredTotal: 0,
      leaseLostTotal: 0,
      idleCycles: 0,
      failures: 0,
      limitReachedTotal: 0,
      consecutiveFailures: 0,
      lastCycleAt: null,
      lastSuccessAt: null,
      lastErrorCode: null,
      dueSampleCount: 0,
      staleSampleCount: 0,
      deadLetterSampleCount: 0,
      hasDue: false,
      hasStale: false,
      hasDeadLetter: false,
      backlogObservedAt: null
    };
  }

  snapshot() {
    return Object.freeze({
      ...this.metrics,
      running: this.running,
      shuttingDown: this.shuttingDown,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      eventTypes: this.dispatcher.eventTypes()
    });
  }

  readiness(now = this.clock()) {
    const checkedAt = dateValue(now, 'readiness clock').toISOString();
    const common = {
      checkedAt,
      lastSuccessAt: this.metrics.lastSuccessAt,
      consecutiveFailures: this.metrics.consecutiveFailures
    };
    if (this.shuttingDown) return Object.freeze({ ready: false, reason: 'SHUTTING_DOWN', ...common });
    if (!this.running || !this.metrics.lastSuccessAt) return Object.freeze({ ready: false, reason: 'STARTING', ...common });
    if (this.metrics.consecutiveFailures >= this.readinessFailureThreshold) {
      return Object.freeze({ ready: false, reason: 'CYCLE_FAILURES', ...common });
    }
    if (Date.parse(checkedAt) - Date.parse(this.metrics.lastSuccessAt) > this.readinessStaleMs) {
      return Object.freeze({ ready: false, reason: 'STALE', ...common });
    }
    return Object.freeze({ ready: true, reason: 'READY', ...common });
  }

  async runCycle(now = this.clock()) {
    const startedAt = dateValue(now, 'cycle clock');
    this.metrics.cycles += 1;
    this.metrics.lastCycleAt = startedAt.toISOString();
    const outcomes = {
      processed: 0,
      retryScheduled: 0,
      deadLettered: 0,
      leaseLost: 0,
      worked: 0
    };
    try {
      for (let index = 0; index < this.cycleLimit; index += 1) {
        const result = await this.dispatcher.pollOnce();
        if (result.kind === 'IDLE') break;
        outcomes.worked += 1;
        if (result.kind === 'PROCESSED') outcomes.processed += 1;
        else if (result.kind === 'RETRY_SCHEDULED') outcomes.retryScheduled += 1;
        else if (result.kind === 'DEAD_LETTERED') outcomes.deadLettered += 1;
        else if (result.kind === 'LEASE_LOST') outcomes.leaseLost += 1;
      }

      const backlog = await this.queue.inspectBacklog({
        scope: this.dispatcher.scope,
        eventTypes: this.dispatcher.eventTypes(),
        sampleLimit: this.cycleLimit
      });
      const limitReached = outcomes.worked === this.cycleLimit && (backlog.hasDue || backlog.hasStale);
      const completedAt = dateValue(this.clock(), 'process clock');
      this.metrics.processedTotal += outcomes.processed;
      this.metrics.retryScheduledTotal += outcomes.retryScheduled;
      this.metrics.deadLetteredTotal += outcomes.deadLettered;
      this.metrics.leaseLostTotal += outcomes.leaseLost;
      if (outcomes.worked === 0) this.metrics.idleCycles += 1;
      if (limitReached) this.metrics.limitReachedTotal += 1;
      this.metrics.consecutiveFailures = 0;
      this.metrics.lastSuccessAt = completedAt.toISOString();
      this.metrics.lastErrorCode = null;
      this.metrics.dueSampleCount = backlog.dueSampleCount;
      this.metrics.staleSampleCount = backlog.staleSampleCount;
      this.metrics.deadLetterSampleCount = backlog.deadLetterSampleCount;
      this.metrics.hasDue = backlog.hasDue;
      this.metrics.hasStale = backlog.hasStale;
      this.metrics.hasDeadLetter = backlog.hasDeadLetter;
      this.metrics.backlogObservedAt = backlog.observedAt;
      log(this.logger, 'log', {
        event: 'outbox_worker.cycle',
        at: completedAt.toISOString(),
        startedAt: startedAt.toISOString(),
        outcomes,
        limitReached,
        backlog,
        metrics: this.snapshot()
      });
      return Object.freeze({ outcomes: Object.freeze(outcomes), limitReached, backlog, metrics: this.snapshot() });
    } catch (error) {
      const code = safeErrorCode(error);
      this.metrics.failures += 1;
      this.metrics.consecutiveFailures += 1;
      this.metrics.lastErrorCode = code;
      log(this.logger, 'error', {
        event: 'outbox_worker.cycle_failed',
        at: startedAt.toISOString(),
        errorCode: code,
        outcomes,
        metrics: this.snapshot()
      });
      throw error;
    }
  }

  async run({ signal } = {}) {
    if (this.running) throw new Error('The outbox worker process is already running.');
    const startedAt = dateValue(this.clock(), 'process clock').toISOString();
    this.running = true;
    this.shuttingDown = Boolean(signal?.aborted);
    this.startedAt = startedAt;
    this.stoppedAt = null;
    const onAbort = () => { this.shuttingDown = true; };
    signal?.addEventListener('abort', onAbort, { once: true });
    log(this.logger, 'log', {
      event: 'outbox_worker.started',
      at: startedAt,
      pollIntervalMs: this.pollIntervalMs,
      cycleLimit: this.cycleLimit,
      eventTypes: this.dispatcher.eventTypes(),
      readinessStaleMs: this.readinessStaleMs,
      readinessFailureThreshold: this.readinessFailureThreshold
    });
    try {
      while (!signal?.aborted) {
        try {
          await this.runCycle();
        } catch {
          // Structured failure state is retained while the bounded loop continues.
        }
        if (!signal?.aborted) await this.sleep(this.pollIntervalMs, signal);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.shuttingDown = true;
      this.running = false;
      this.stoppedAt = dateValue(this.clock(), 'process clock').toISOString();
      log(this.logger, 'log', {
        event: 'outbox_worker.stopped',
        at: this.stoppedAt,
        metrics: this.snapshot()
      });
    }
  }
}

export async function createOutboxWorkerRuntime({ env = process.env, logger = console } = {}) {
  const config = parseOutboxWorkerConfig(env);
  const handlers = await loadOutboxHandlers(config.handlerModule);
  const pool = await createPostgresPool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    ssl: config.databaseSsl
  });
  try {
    await assertOutboxWorkerSchema(pool);
    const queue = new PostgresOutboxQueue(pool);
    const dispatcher = new OutboxDispatcher({
      queue,
      workerId: config.workerId,
      scope: { environment: config.environment, tenantId: config.tenantId },
      handlers,
      now: () => queue.databaseNow(),
      leaseMs: config.leaseMs,
      maxAttempts: config.maxAttempts,
      baseDelayMs: config.baseDelayMs,
      maximumDelayMs: config.maximumDelayMs
    });
    const outboxProcess = new OutboxWorkerProcess({
      dispatcher,
      queue,
      pollIntervalMs: config.pollIntervalMs,
      cycleLimit: config.cycleLimit,
      readinessStaleMs: config.readinessStaleMs,
      readinessFailureThreshold: config.readinessFailureThreshold,
      logger
    });
    const health = createOutboxWorkerHealthServer({
      outboxProcess,
      host: config.healthHost,
      port: config.healthPort
    });
    return {
      config,
      process: outboxProcess,
      health,
      async close() { await pool.end(); }
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
