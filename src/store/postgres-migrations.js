import { readFile } from 'node:fs/promises';

const MIGRATIONS = Object.freeze([
  { version: '001_durable_core', file: new URL('../../migrations/001_durable_core.up.sql', import.meta.url) },
  { version: '002_outbox_attempts', file: new URL('../../migrations/002_outbox_attempts.up.sql', import.meta.url) },
  { version: '003_idempotency_http_metadata', file: new URL('../../migrations/003_idempotency_http_metadata.up.sql', import.meta.url) },
  { version: '004_signing_key_lifecycle', file: new URL('../../migrations/004_signing_key_lifecycle.up.sql', import.meta.url) },
  { version: '005_action_attempt_reservations', file: new URL('../../migrations/005_action_attempt_reservations.up.sql', import.meta.url) },
  { version: '006_attempt_completion_receipts', file: new URL('../../migrations/006_attempt_completion_receipts.up.sql', import.meta.url) },
  { version: '007_receipt_supersession', file: new URL('../../migrations/007_receipt_supersession.up.sql', import.meta.url) },
  { version: '008_idempotency_retention', file: new URL('../../migrations/008_idempotency_retention.up.sql', import.meta.url) },
  { version: '009_outbox_worker_operations', file: new URL('../../migrations/009_outbox_worker_operations.up.sql', import.meta.url) }
]);

const MIGRATION_LOCK = 'mandate:migrations';

async function schemaState(client) {
  const result = await client.query(`
    SELECT
      EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'mandate') AS schema_exists,
      to_regclass('mandate.schema_migrations') AS migrations_table
  `);
  return result.rows[0];
}

export async function applyMigrations(pool, { logger = console } = {}) {
  const client = await pool.connect();
  const applied = [];
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [MIGRATION_LOCK]);
    locked = true;
    let state = await schemaState(client);
    if (state.schema_exists && !state.migrations_table) throw new Error('mandate schema exists without the migration registry.');
    for (const migration of MIGRATIONS) {
      state = await schemaState(client);
      if (!state.migrations_table) {
        if (migration.version !== '001_durable_core') throw new Error('The durable-core baseline must be applied before later migrations.');
      } else {
        const existing = await client.query('SELECT 1 FROM mandate.schema_migrations WHERE version = $1', [migration.version]);
        if (existing.rowCount > 0) continue;
      }
      const sql = await readFile(migration.file, 'utf8');
      await client.query(sql);
      applied.push(migration.version);
      logger.log(`Applied migration ${migration.version}.`);
    }
    if (applied.length === 0) logger.log('Database migrations are current.');
    return { applied };
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}
