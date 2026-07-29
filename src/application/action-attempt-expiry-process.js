import { hostname } from 'node:os';
import { ActionAttemptExpiryWorker } from './action-attempt-expiry-worker.js';
import { createPostgresPool, PostgresStore } from '../store/postgres-store.js';

const REQUIRED_MIGRATION = '006_attempt_completion_receipts';

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

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{2,80}$/.test(error.code)
    ? error.code
    : 'EXPIRY_CYCLE_FAILED';
}

function log(logger, level, event) {
  const target = typeof logger?.[level] === 'function'
    ? logger[level].bind(logger)
    : logger.log.bind(logger);
  target(JSON.stringify(event));
}

export function parseActionAttemptExpiryConfig(env = process.env) {
  const environment = env.MANDATE_ENVIRONMENT;
  if (!['test', 'live'].includes(environment)) {
    throw new Error('MANDATE_ENVIRONMENT must be explicitly set to test or live.');
  }
  const tenantId = env.MANDATE_TENANT_ID || undefined;
  if (tenantId && !/^ten_[A-Za-z0-9_-]+$/.test(tenantId)) {
    throw new Error('MANDATE_TENANT_ID must use the ten_ prefix.');
  }
  const configuredWorkerId = env.MANDATE_EXPIRY_WORKER_ID;
  if (environment === 'live' && !configuredWorkerId) {
    throw new Error('MANDATE_EXPIRY_WORKER_ID is required in live environments.');
  }

  return Object.freeze({
    databaseUrl: env.DATABASE_URL,
    databaseSsl: booleanValue(env.MANDATE_DATABASE_SSL, false),
    databasePoolMax: integer(env.MANDATE_DATABASE_POOL_MAX, 5, {
      name: 'MANDATE_DATABASE_POOL_MAX', minimum: 1, maximum: 100
    }),
    environment,
    tenantId,
    workerId: configuredWorkerId ?? `expiry:${hostname()}:${process.pid}`,
    pollIntervalMs: integer(env.MANDATE_EXPIRY_POLL_INTERVAL_MS, 1000, {
      name: 'MANDATE_EXPIRY_POLL_INTERVAL_MS', minimum: 100, maximum: 60000
    }),
    batchLimit: integer(env.MANDATE_EXPIRY_BATCH_LIMIT, 100, {
      name: 'MANDATE_EXPIRY_BATCH_LIMIT', minimum: 1, maximum: 1000
    })
  });
}

export async function assertActionAttemptExpirySchema(pool) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'mandate' AND table_name = 'schema_migrations'
     ) AS registry_exists`
  );
  if (!result.rows[0]?.registry_exists) {
    throw new Error('Mandate migration registry is unavailable. Run migrations with the deployment role before starting the worker.');
  }
  const migration = await pool.query(
    'SELECT 1 FROM mandate.schema_migrations WHERE version = $1',
    [REQUIRED_MIGRATION]
  );
  if (migration.rowCount !== 1) {
    throw new Error(`Required migration ${REQUIRED_MIGRATION} is not applied.`);
  }
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

export class ActionAttemptExpiryProcess {
  constructor({ worker, pollIntervalMs, batchLimit, logger = console, sleep = abortableSleep }) {
    if (!worker?.drain) throw new TypeError('An expiry worker is required.');
    if (typeof sleep !== 'function') throw new TypeError('sleep must be a function.');
    this.worker = worker;
    this.pollIntervalMs = pollIntervalMs;
    this.batchLimit = batchLimit;
    this.logger = logger;
    this.sleep = sleep;
    this.metrics = {
      cycles: 0,
      expiredTotal: 0,
      failures: 0,
      consecutiveFailures: 0,
      lastCycleAt: null,
      lastSuccessAt: null,
      lastErrorCode: null
    };
  }

  snapshot() {
    return Object.freeze({ ...this.metrics });
  }

  async runCycle(now = new Date()) {
    this.metrics.cycles += 1;
    this.metrics.lastCycleAt = now.toISOString();
    try {
      const result = await this.worker.drain({ limit: this.batchLimit });
      this.metrics.expiredTotal += result.expired.length;
      this.metrics.consecutiveFailures = 0;
      this.metrics.lastSuccessAt = now.toISOString();
      this.metrics.lastErrorCode = null;
      const event = {
        event: 'action_attempt_expiry.cycle',
        at: now.toISOString(),
        expired: result.expired.length,
        limitReached: result.limitReached,
        metrics: this.snapshot()
      };
      log(this.logger, 'log', event);
      return Object.freeze({ ...result, metrics: this.snapshot() });
    } catch (error) {
      const code = safeErrorCode(error);
      this.metrics.failures += 1;
      this.metrics.consecutiveFailures += 1;
      this.metrics.lastErrorCode = code;
      log(this.logger, 'error', {
        event: 'action_attempt_expiry.cycle_failed',
        at: now.toISOString(),
        errorCode: code,
        metrics: this.snapshot()
      });
      throw error;
    }
  }

  async run({ signal } = {}) {
    log(this.logger, 'log', {
      event: 'action_attempt_expiry.started',
      at: new Date().toISOString(),
      pollIntervalMs: this.pollIntervalMs,
      batchLimit: this.batchLimit
    });
    while (!signal?.aborted) {
      try {
        await this.runCycle();
      } catch {
        // The supervisor receives a safe structured failure while the bounded loop continues.
      }
      if (!signal?.aborted) await this.sleep(this.pollIntervalMs, signal);
    }
    log(this.logger, 'log', {
      event: 'action_attempt_expiry.stopped',
      at: new Date().toISOString(),
      metrics: this.snapshot()
    });
  }
}

export async function createActionAttemptExpiryRuntime({ env = process.env, logger = console } = {}) {
  const config = parseActionAttemptExpiryConfig(env);
  const pool = await createPostgresPool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    ssl: config.databaseSsl
  });
  try {
    await assertActionAttemptExpirySchema(pool);
    const store = new PostgresStore(pool);
    const worker = new ActionAttemptExpiryWorker({
      store,
      workerId: config.workerId,
      scope: { environment: config.environment, tenantId: config.tenantId }
    });
    return {
      config,
      process: new ActionAttemptExpiryProcess({
        worker,
        pollIntervalMs: config.pollIntervalMs,
        batchLimit: config.batchLimit,
        logger
      }),
      async close() { await store.close(); }
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
