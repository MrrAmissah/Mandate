import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiHealth } from '../src/application/api-health.js';
import { createPostgresPool } from '../src/store/postgres-store.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;

postgresTest('API readiness fails within its bound when the dedicated pool is exhausted', async () => {
  const pool = await createPostgresPool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 100
  });
  const heldClient = await pool.connect();
  try {
    const health = createApiHealth({ mode: 'postgres', pool, queryTimeoutMs: 100 });
    const started = Date.now();
    const result = await health.readiness();
    const elapsed = Date.now() - started;
    assert.equal(result.ready, false);
    assert.equal(result.reason, 'DATABASE_UNAVAILABLE');
    assert.ok(elapsed >= 75, `readiness failed too early: ${elapsed}ms`);
    assert.ok(elapsed < 1000, `readiness exceeded its acquisition bound: ${elapsed}ms`);
  } finally {
    heldClient.release();
    await pool.end();
  }
});
