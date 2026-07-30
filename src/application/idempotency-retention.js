const MINIMUM_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const MAXIMUM_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const REQUIRED_MIGRATION = '008_idempotency_retention';

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

function validateScope(scope) {
  if (!scope || !['test', 'live'].includes(scope.environment)) {
    throw new TypeError('Idempotency cleanup requires a test or live environment scope.');
  }
  if (scope.tenantId !== undefined && !/^ten_[A-Za-z0-9_-]+$/.test(scope.tenantId)) {
    throw new TypeError('tenantId must use the ten_ prefix.');
  }
  return Object.freeze({ environment: scope.environment, tenantId: scope.tenantId });
}

function validateRetentionSeconds(value) {
  return integer(value, MINIMUM_RETENTION_SECONDS, {
    name: 'retentionSeconds',
    minimum: MINIMUM_RETENTION_SECONDS,
    maximum: MAXIMUM_RETENTION_SECONDS
  });
}

function validateBatchLimit(value) {
  return integer(value, 500, { name: 'batchLimit', minimum: 1, maximum: 5000 });
}

function validateMaximumBatches(value) {
  return integer(value, 20, { name: 'maximumBatches', minimum: 1, maximum: 1000 });
}

function validateSampleLimit(value) {
  return integer(value, 500, { name: 'sampleLimit', minimum: 1, maximum: 5000 });
}

function timestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('PostgreSQL returned an invalid timestamp.');
  return date.toISOString();
}

export const IDEMPOTENCY_RETENTION_MINIMUM_SECONDS = MINIMUM_RETENTION_SECONDS;
export const IDEMPOTENCY_RETENTION_MAXIMUM_SECONDS = MAXIMUM_RETENTION_SECONDS;

export function parseIdempotencyRetentionConfig(env = process.env) {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for idempotency retention cleanup.');
  }
  const environment = env.MANDATE_ENVIRONMENT;
  if (!['test', 'live'].includes(environment)) {
    throw new Error('MANDATE_ENVIRONMENT must be explicitly set to test or live.');
  }
  const tenantId = env.MANDATE_TENANT_ID || undefined;
  if (tenantId && !/^ten_[A-Za-z0-9_-]+$/.test(tenantId)) {
    throw new Error('MANDATE_TENANT_ID must use the ten_ prefix.');
  }

  return Object.freeze({
    databaseUrl: env.DATABASE_URL,
    databaseSsl: booleanValue(env.MANDATE_DATABASE_SSL, false),
    databasePoolMax: integer(env.MANDATE_DATABASE_POOL_MAX, 2, {
      name: 'MANDATE_DATABASE_POOL_MAX', minimum: 1, maximum: 100
    }),
    scope: Object.freeze({ environment, tenantId }),
    retentionSeconds: integer(
      env.MANDATE_IDEMPOTENCY_RETENTION_SECONDS,
      MINIMUM_RETENTION_SECONDS,
      {
        name: 'MANDATE_IDEMPOTENCY_RETENTION_SECONDS',
        minimum: MINIMUM_RETENTION_SECONDS,
        maximum: MAXIMUM_RETENTION_SECONDS
      }
    ),
    batchLimit: integer(env.MANDATE_IDEMPOTENCY_CLEANUP_BATCH_LIMIT, 500, {
      name: 'MANDATE_IDEMPOTENCY_CLEANUP_BATCH_LIMIT', minimum: 1, maximum: 5000
    }),
    maximumBatches: integer(env.MANDATE_IDEMPOTENCY_CLEANUP_MAX_BATCHES, 20, {
      name: 'MANDATE_IDEMPOTENCY_CLEANUP_MAX_BATCHES', minimum: 1, maximum: 1000
    })
  });
}

export async function assertIdempotencyRetentionSchema(pool) {
  if (!pool?.query) throw new TypeError('A PostgreSQL pool is required.');
  const registry = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'mandate' AND table_name = 'schema_migrations'
     ) AS registry_exists`
  );
  if (!registry.rows[0]?.registry_exists) {
    throw new Error('Mandate migration registry is unavailable. Run migrations with the deployment role before cleanup.');
  }
  const migration = await pool.query(
    'SELECT 1 FROM mandate.schema_migrations WHERE version = $1',
    [REQUIRED_MIGRATION]
  );
  if (migration.rowCount !== 1) {
    throw new Error(`Required migration ${REQUIRED_MIGRATION} is not applied.`);
  }
}

export async function inspectIdempotencyRetentionBacklog(
  pool,
  scope,
  {
    retentionSeconds = MINIMUM_RETENTION_SECONDS,
    sampleLimit = 500
  } = {}
) {
  if (!pool?.query) throw new TypeError('A PostgreSQL pool is required.');
  const owner = validateScope(scope);
  const retention = validateRetentionSeconds(retentionSeconds);
  const limit = validateSampleLimit(sampleLimit);
  const result = await pool.query(
    `WITH observed AS MATERIALIZED (
       SELECT clock_timestamp() AS observed_at
     ), expired_sample AS MATERIALIZED (
       SELECT records.expires_at
       FROM mandate.idempotency_records records
       CROSS JOIN observed
       WHERE records.environment = $1
         AND ($2::text IS NULL OR records.tenant_id = $2)
         AND records.expires_at <= observed.observed_at
       ORDER BY records.tenant_id, records.expires_at, records.created_at,
                records.scope, records.idempotency_key
       LIMIT $4
     ), eligible_sample AS MATERIALIZED (
       SELECT records.expires_at
       FROM mandate.idempotency_records records
       CROSS JOIN observed
       WHERE records.environment = $1
         AND ($2::text IS NULL OR records.tenant_id = $2)
         AND records.expires_at <= observed.observed_at
         AND records.created_at <= observed.observed_at
           - ($3::double precision * interval '1 second')
       ORDER BY records.tenant_id, records.expires_at, records.created_at,
                records.scope, records.idempotency_key
       LIMIT $4
     )
     SELECT
       (SELECT count(*) FROM expired_sample) AS expired_sample_count,
       (SELECT count(*) FROM eligible_sample) AS eligible_sample_count,
       EXISTS (SELECT 1 FROM eligible_sample) AS has_eligible,
       (SELECT min(expires_at) FROM eligible_sample) AS oldest_eligible_at,
       observed.observed_at
     FROM observed`,
    [owner.environment, owner.tenantId ?? null, retention, limit]
  );
  const row = result.rows[0];
  return Object.freeze({
    environment: owner.environment,
    tenantId: owner.tenantId ?? null,
    retentionSeconds: retention,
    sampleLimit: limit,
    expiredSampleCount: Number(row?.expired_sample_count ?? 0),
    eligibleSampleCount: Number(row?.eligible_sample_count ?? 0),
    hasEligible: row?.has_eligible === true,
    oldestEligibleAt: timestamp(row?.oldest_eligible_at),
    observedAt: timestamp(row?.observed_at)
  });
}

export async function deleteExpiredIdempotencyBatch(
  pool,
  scope,
  {
    retentionSeconds = MINIMUM_RETENTION_SECONDS,
    batchLimit = 500
  } = {}
) {
  if (!pool?.connect) throw new TypeError('A PostgreSQL connection pool is required.');
  const owner = validateScope(scope);
  const retention = validateRetentionSeconds(retentionSeconds);
  const limit = validateBatchLimit(batchLimit);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `WITH observed AS MATERIALIZED (
         SELECT clock_timestamp() AS observed_at
       ), candidates AS (
         SELECT records.tenant_id, records.environment, records.scope, records.idempotency_key
         FROM mandate.idempotency_records records
         CROSS JOIN observed
         WHERE records.environment = $1
           AND ($2::text IS NULL OR records.tenant_id = $2)
           AND records.expires_at <= observed.observed_at
           AND records.created_at <= observed.observed_at
             - ($3::double precision * interval '1 second')
         ORDER BY records.tenant_id, records.expires_at, records.created_at,
                  records.scope, records.idempotency_key
         FOR UPDATE OF records SKIP LOCKED
         LIMIT $4
       )
       DELETE FROM mandate.idempotency_records target
       USING candidates
       WHERE target.tenant_id = candidates.tenant_id
         AND target.environment = candidates.environment
         AND target.scope = candidates.scope
         AND target.idempotency_key = candidates.idempotency_key`,
      [owner.environment, owner.tenantId ?? null, retention, limit]
    );
    await client.query('COMMIT');
    return Object.freeze({ deletedCount: result.rowCount });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function cleanupExpiredIdempotencyRecords({
  pool,
  scope,
  retentionSeconds = MINIMUM_RETENTION_SECONDS,
  batchLimit = 500,
  maximumBatches = 20
}) {
  const owner = validateScope(scope);
  const retention = validateRetentionSeconds(retentionSeconds);
  const limit = validateBatchLimit(batchLimit);
  const maxBatches = validateMaximumBatches(maximumBatches);
  let deletedCount = 0;
  let batches = 0;

  while (batches < maxBatches) {
    const result = await deleteExpiredIdempotencyBatch(pool, owner, {
      retentionSeconds: retention,
      batchLimit: limit
    });
    batches += 1;
    deletedCount += result.deletedCount;
    if (result.deletedCount < limit) break;
  }

  const backlog = await inspectIdempotencyRetentionBacklog(pool, owner, {
    retentionSeconds: retention,
    sampleLimit: limit
  });
  return Object.freeze({
    deletedCount,
    batches,
    limitReached: backlog.hasEligible,
    backlog
  });
}
