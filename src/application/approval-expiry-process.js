import { hostname } from 'node:os';
import { ApprovalExpiryWorker } from './approval-expiry-worker.js';
import { createApprovalExpiryHealthServer } from './approval-expiry-health.js';
import { createPostgresPool, PostgresStore } from '../store/postgres-store.js';

const REQUIRED_MIGRATION = '014_approval_expiry';

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
    throw new Error('MANDATE_APPROVAL_EXPIRY_HEALTH_HOST must be a non-empty hostname or address without whitespace.');
  }
  return host;
}

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{2,80}$/.test(error.code)
    ? error.code
    : 'APPROVAL_EXPIRY_CYCLE_FAILED';
}

function log(logger, level, event) {
  const target = typeof logger?.[level] === 'function'
    ? logger[level].bind(logger)
    : logger.log.bind(logger);
  target(JSON.stringify(event));
}

function dateValue(value, name) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${name} must return a valid Date.`);
  }
  return value;
}

export function parseApprovalExpiryConfig(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for the approval expiry worker.');
  const environment = env.MANDATE_ENVIRONMENT;
  if (!['test', 'live'].includes(environment)) {
    throw new Error('MANDATE_ENVIRONMENT must be explicitly set to test or live.');
  }
  const tenantId = env.MANDATE_TENANT_ID || undefined;
  if (tenantId && !/^ten_[A-Za-z0-9_-]+$/.test(tenantId)) {
    throw new Error('MANDATE_TENANT_ID must use the ten_ prefix.');
  }
  const configuredWorkerId = env.MANDATE_APPROVAL_EXPIRY_WORKER_ID;
  if (environment === 'live' && !configuredWorkerId) {
    throw new Error('MANDATE_APPROVAL_EXPIRY_WORKER_ID is required in live environments.');
  }

  const pollIntervalMs = integer(env.MANDATE_APPROVAL_EXPIRY_POLL_INTERVAL_MS, 1000, {
    name: 'MANDATE_APPROVAL_EXPIRY_POLL_INTERVAL_MS', minimum: 100, maximum: 60000
  });
  const readinessStaleMs = integer(
    env.MANDATE_APPROVAL_EXPIRY_READINESS_STALE_MS,
    Math.max(5000, pollIntervalMs * 3),
    {
      name: 'MANDATE_APPROVAL_EXPIRY_READINESS_STALE_MS',
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
    workerId: configuredWorkerId ?? `approval-expiry:${hostname()}:${process.pid}`,
    pollIntervalMs,
    batchLimit: integer(env.MANDATE_APPROVAL_EXPIRY_BATCH_LIMIT, 100, {
      name: 'MANDATE_APPROVAL_EXPIRY_BATCH_LIMIT', minimum: 1, maximum: 1000
    }),
    readinessStaleMs,
    readinessFailureThreshold: integer(env.MANDATE_APPROVAL_EXPIRY_READINESS_FAILURE_THRESHOLD, 3, {
      name: 'MANDATE_APPROVAL_EXPIRY_READINESS_FAILURE_THRESHOLD', minimum: 1, maximum: 100
    }),
    healthHost: safeHost(env.MANDATE_APPROVAL_EXPIRY_HEALTH_HOST, '127.0.0.1'),
    healthPort: integer(env.MANDATE_APPROVAL_EXPIRY_HEALTH_PORT, 8790, {
      name: 'MANDATE_APPROVAL_EXPIRY_HEALTH_PORT', minimum: 1, maximum: 65535
    })
  });
}

export async function assertApprovalExpirySchema(pool) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema='mandate' AND table_name='schema_migrations'
     ) AS registry_exists`
  );
  if (!result.rows[0]?.registry_exists) {
    throw new Error('Mandate migration registry is unavailable. Run migrations with the deployment role before starting the worker.');
  }
  const migration = await pool.query(
    'SELECT 1 FROM mandate.schema_migrations WHERE version=$1',
    [REQUIRED_MIGRATION]
  );
  if (migration.rowCount !== 1) throw new Error(`Required migration ${REQUIRED_MIGRATION} is not applied.`);
}

function abortableSleep(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export class ApprovalExpiryProcess {
  constructor({ worker, pollIntervalMs, batchLimit, readinessStaleMs, readinessFailureThreshold,
    logger = console, sleep = abortableSleep, clock = () => new Date() }) {
    if (!worker?.drain || !worker?.backlog) throw new TypeError('An observable approval expiry worker is required.');
    if (typeof sleep !== 'function' || typeof clock !== 'function') throw new TypeError('sleep and clock must be functions.');
    if (!Number.isInteger(readinessStaleMs) || readinessStaleMs < pollIntervalMs * 2) {
      throw new TypeError('readinessStaleMs must be at least two polling intervals.');
    }
    if (!Number.isInteger(readinessFailureThreshold) || readinessFailureThreshold < 1) {
      throw new TypeError('readinessFailureThreshold must be a positive integer.');
    }
    this.worker = worker;
    this.pollIntervalMs = pollIntervalMs;
    this.batchLimit = batchLimit;
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
      cycles: 0, expiredTotal: 0, failures: 0, limitReachedTotal: 0,
      consecutiveFailures: 0, lastCycleAt: null, lastSuccessAt: null,
      lastErrorCode: null, backlogExpiring: 0, backlogDue: 0,
      oldestDueAt: null, oldestOverdueSeconds: 0, backlogObservedAt: null
    };
  }

  snapshot() {
    return Object.freeze({ ...this.metrics, running: this.running, shuttingDown: this.shuttingDown,
      startedAt: this.startedAt, stoppedAt: this.stoppedAt });
  }

  readiness(now = this.clock()) {
    const checkedAt = dateValue(now, 'readiness clock').toISOString();
    const common = { checkedAt, lastSuccessAt: this.metrics.lastSuccessAt,
      consecutiveFailures: this.metrics.consecutiveFailures };
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
    const observedNow = dateValue(now, 'cycle clock');
    this.metrics.cycles += 1;
    this.metrics.lastCycleAt = observedNow.toISOString();
    let expiredInCycle = 0;
    try {
      const result = await this.worker.drain({ limit: this.batchLimit });
      expiredInCycle = result.expired.length;
      this.metrics.expiredTotal += expiredInCycle;
      if (result.limitReached) this.metrics.limitReachedTotal += 1;
      const backlog = await this.worker.backlog();
      const completedAt = dateValue(this.clock(), 'process clock');
      this.metrics.backlogExpiring = backlog.expiringCount;
      this.metrics.backlogDue = backlog.dueCount;
      this.metrics.oldestDueAt = backlog.oldestDueAt;
      this.metrics.oldestOverdueSeconds = backlog.oldestOverdueSeconds;
      this.metrics.backlogObservedAt = backlog.observedAt;
      this.metrics.consecutiveFailures = 0;
      this.metrics.lastSuccessAt = completedAt.toISOString();
      this.metrics.lastErrorCode = null;
      log(this.logger, 'log', {
        event: 'approval_expiry.cycle', at: completedAt.toISOString(),
        startedAt: observedNow.toISOString(), expired: expiredInCycle,
        limitReached: result.limitReached, backlog, metrics: this.snapshot()
      });
      return Object.freeze({ ...result, backlog, metrics: this.snapshot() });
    } catch (error) {
      const code = safeErrorCode(error);
      this.metrics.failures += 1;
      this.metrics.consecutiveFailures += 1;
      this.metrics.lastErrorCode = code;
      log(this.logger, 'error', {
        event: 'approval_expiry.cycle_failed', at: observedNow.toISOString(),
        errorCode: code, expired: expiredInCycle, metrics: this.snapshot()
      });
      throw error;
    }
  }

  async run({ signal } = {}) {
    if (this.running) throw new Error('The approval expiry process is already running.');
    const startedAt = dateValue(this.clock(), 'process clock').toISOString();
    this.running = true;
    this.shuttingDown = Boolean(signal?.aborted);
    this.startedAt = startedAt;
    this.stoppedAt = null;
    const onAbort = () => { this.shuttingDown = true; };
    signal?.addEventListener('abort', onAbort, { once: true });
    log(this.logger, 'log', {
      event: 'approval_expiry.started', at: startedAt, pollIntervalMs: this.pollIntervalMs,
      batchLimit: this.batchLimit, readinessStaleMs: this.readinessStaleMs,
      readinessFailureThreshold: this.readinessFailureThreshold
    });
    try {
      while (!signal?.aborted) {
        try { await this.runCycle(); } catch { /* structured failure state is retained */ }
        if (!signal?.aborted) await this.sleep(this.pollIntervalMs, signal);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.shuttingDown = true;
      this.running = false;
      this.stoppedAt = dateValue(this.clock(), 'process clock').toISOString();
      log(this.logger, 'log', { event: 'approval_expiry.stopped', at: this.stoppedAt, metrics: this.snapshot() });
    }
  }
}

export async function createApprovalExpiryRuntime({ env = process.env, logger = console } = {}) {
  const config = parseApprovalExpiryConfig(env);
  const pool = await createPostgresPool({ connectionString: config.databaseUrl,
    max: config.databasePoolMax, ssl: config.databaseSsl });
  try {
    await assertApprovalExpirySchema(pool);
    const store = new PostgresStore(pool);
    const worker = new ApprovalExpiryWorker({
      store,
      workerId: config.workerId,
      scope: { environment: config.environment, tenantId: config.tenantId }
    });
    const expiryProcess = new ApprovalExpiryProcess({
      worker, pollIntervalMs: config.pollIntervalMs, batchLimit: config.batchLimit,
      readinessStaleMs: config.readinessStaleMs,
      readinessFailureThreshold: config.readinessFailureThreshold, logger
    });
    const health = createApprovalExpiryHealthServer({
      expiryProcess, host: config.healthHost, port: config.healthPort
    });
    return { config, process: expiryProcess, health, async close() { await store.close(); } };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
