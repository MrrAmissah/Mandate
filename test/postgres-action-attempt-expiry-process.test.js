import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertActionAttemptExpirySchema
} from '../src/application/action-attempt-expiry-process.js';
import { applyMigrations } from '../src/store/postgres-migrations.js';
import { createPostgresPool } from '../src/store/postgres-store.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;

postgresTest('expiry process readiness requires the completed-attempt schema', async () => {
  const pool = await createPostgresPool({ connectionString: databaseUrl });
  try {
    await applyMigrations(pool, { logger: { log() {} } });
    await assert.doesNotReject(assertActionAttemptExpirySchema(pool));
  } finally {
    await pool.end();
  }
});

test('expiry process readiness fails closed without a migration registry', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('information_schema.tables')) {
        return { rows: [{ registry_exists: false }], rowCount: 1 };
      }
      throw new Error('unexpected query');
    }
  };
  await assert.rejects(
    assertActionAttemptExpirySchema(pool),
    /Run migrations with the deployment role before starting the worker/
  );
});

test('expiry process readiness fails closed when migration 006 is absent', async () => {
  let calls = 0;
  const pool = {
    async query(sql, values) {
      calls += 1;
      if (sql.includes('information_schema.tables')) {
        return { rows: [{ registry_exists: true }], rowCount: 1 };
      }
      assert.deepEqual(values, ['006_attempt_completion_receipts']);
      return { rows: [], rowCount: 0 };
    }
  };
  await assert.rejects(
    assertActionAttemptExpirySchema(pool),
    /Required migration 006_attempt_completion_receipts is not applied/
  );
  assert.equal(calls, 2);
});
