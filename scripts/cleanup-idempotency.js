import {
  assertIdempotencyRetentionSchema,
  cleanupExpiredIdempotencyRecords,
  parseIdempotencyRetentionConfig
} from '../src/application/idempotency-retention.js';
import { createPostgresPool } from '../src/store/postgres-store.js';

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{2,80}$/.test(error.code)
    ? error.code
    : 'IDEMPOTENCY_RETENTION_STARTUP_FAILED';
}

async function main() {
  const config = parseIdempotencyRetentionConfig();
  const pool = await createPostgresPool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    ssl: config.databaseSsl
  });
  try {
    await assertIdempotencyRetentionSchema(pool);
    const result = await cleanupExpiredIdempotencyRecords({
      pool,
      scope: config.scope,
      retentionSeconds: config.retentionSeconds,
      batchLimit: config.batchLimit,
      maximumBatches: config.maximumBatches
    });
    console.log(JSON.stringify({
      event: 'idempotency_retention.cleanup',
      at: new Date().toISOString(),
      environment: config.scope.environment,
      tenantId: config.scope.tenantId ?? null,
      retentionSeconds: config.retentionSeconds,
      batchLimit: config.batchLimit,
      maximumBatches: config.maximumBatches,
      deletedCount: result.deletedCount,
      batches: result.batches,
      limitReached: result.limitReached,
      backlog: result.backlog
    }));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    event: 'idempotency_retention.cleanup_failed',
    at: new Date().toISOString(),
    errorCode: safeErrorCode(error)
  }));
  process.exitCode = 1;
});
