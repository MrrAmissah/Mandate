const REQUIRED_MIGRATION = '010_outbox_dead_letter_replays';

function integer(value, fallback, { name, minimum, maximum }) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Health clock must return a valid date.');
  return date.toISOString();
}

export function parseApiHealthConfig(env = process.env) {
  return Object.freeze({
    queryTimeoutMs: integer(env.MANDATE_API_READINESS_TIMEOUT_MS, 2000, {
      name: 'MANDATE_API_READINESS_TIMEOUT_MS',
      minimum: 100,
      maximum: 10000
    })
  });
}

export function createApiHealth({ mode, pool, queryTimeoutMs = 2000, clock = () => new Date() }) {
  if (!['memory', 'postgres'].includes(mode)) throw new TypeError('API health mode must be memory or postgres.');
  if (mode === 'postgres' && typeof pool?.query !== 'function') {
    throw new TypeError('PostgreSQL API health requires a queryable pool.');
  }
  if (!Number.isInteger(queryTimeoutMs) || queryTimeoutMs < 100 || queryTimeoutMs > 10000) {
    throw new TypeError('queryTimeoutMs must be an integer between 100 and 10000.');
  }

  let shuttingDown = false;

  return Object.freeze({
    beginShutdown() {
      shuttingDown = true;
    },

    liveness() {
      return Object.freeze({
        live: true,
        status: 'ok',
        service: 'mandate-api',
        checkedAt: timestamp(clock())
      });
    },

    async readiness() {
      const checkedAt = timestamp(clock());
      if (shuttingDown) {
        return Object.freeze({
          ready: false,
          reason: 'SHUTTING_DOWN',
          mode,
          checkedAt
        });
      }
      if (mode === 'memory') {
        return Object.freeze({
          ready: true,
          reason: 'READY_REFERENCE_STORE',
          mode,
          checkedAt
        });
      }

      try {
        const result = await pool.query({
          text: `SELECT
                   clock_timestamp() AS observed_at,
                   EXISTS (
                     SELECT 1
                     FROM mandate.schema_migrations
                     WHERE version = $1
                   ) AS migration_ready`,
          values: [REQUIRED_MIGRATION],
          query_timeout: queryTimeoutMs
        });
        const row = result.rows[0];
        if (!row?.migration_ready) {
          return Object.freeze({
            ready: false,
            reason: 'MIGRATION_NOT_READY',
            mode,
            requiredMigration: REQUIRED_MIGRATION,
            checkedAt
          });
        }
        return Object.freeze({
          ready: true,
          reason: 'READY',
          mode,
          requiredMigration: REQUIRED_MIGRATION,
          databaseObservedAt: timestamp(row.observed_at),
          checkedAt
        });
      } catch {
        return Object.freeze({
          ready: false,
          reason: 'DATABASE_UNAVAILABLE',
          mode,
          requiredMigration: REQUIRED_MIGRATION,
          checkedAt
        });
      }
    }
  });
}

export const apiHealthContract = Object.freeze({ requiredMigration: REQUIRED_MIGRATION });
