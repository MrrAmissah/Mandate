import { readFile } from 'node:fs/promises';

export async function applyMigrations(pool, { logger = console } = {}) {
  const client = await pool.connect();
  try {
    const present = await client.query("SELECT to_regclass('mandate.schema_migrations') AS table_name");
    if (present.rows[0].table_name) {
      const applied = await client.query(
        "SELECT 1 FROM mandate.schema_migrations WHERE version = '001_durable_core'"
      );
      if (applied.rowCount > 0) {
        logger.log('Migration 001_durable_core already applied.');
        return { applied: [] };
      }
      throw new Error('mandate schema exists without the expected baseline migration.');
    }

    const sql = await readFile(
      new URL('../../migrations/001_durable_core.up.sql', import.meta.url),
      'utf8'
    );
    await client.query(sql);
    logger.log('Applied migration 001_durable_core.');
    return { applied: ['001_durable_core'] };
  } finally {
    client.release();
  }
}
