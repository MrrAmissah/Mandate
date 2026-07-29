import { applyMigrations } from '../src/store/postgres-migrations.js';
import { createPostgresPool } from '../src/store/postgres-store.js';

const pool = await createPostgresPool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.MANDATE_DATABASE_SSL === 'true'
});

try {
  await applyMigrations(pool);
} finally {
  await pool.end();
}
