import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import { PostgresSigningKeyRegistry } from '../src/crypto/signing-key-registry.js';
import { applyMigrations } from '../src/store/postgres-migrations.js';
import { createPostgresPool } from '../src/store/postgres-store.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;

postgresTest('PostgreSQL signing-key rotation preserves historical verification and blocks key-id reuse', async () => {
  const pool = await createPostgresPool({ connectionString: databaseUrl });
  const tenantId = `ten_keys_${randomUUID().replaceAll('-', '')}`;
  const ownership = { tenantId, environment: 'test' };
  try {
    await applyMigrations(pool, { logger: { log() {} } });
    const now = new Date();
    await pool.query(
      `INSERT INTO mandate.tenants (id, name, status, created_at, updated_at)
       VALUES ($1, $2, 'ACTIVE', $3, $3)`,
      [tenantId, 'Signing key test tenant', now.toISOString()]
    );
    const first = createReceiptSigner({ keyId: 'key_rotation_first' });
    const second = createReceiptSigner({ keyId: 'key_rotation_second' });
    const registry = new PostgresSigningKeyRegistry(pool, ownership);
    await registry.registerActive(first);
    const oldPayload = { id: 'rcpt_old', keyId: first.keyId, algorithm: first.algorithm };
    const oldSignature = first.signPayload(oldPayload);
    await registry.registerActive(second);
    const keys = await registry.listDiscoverable();
    assert.deepEqual(keys.map((key) => [key.keyId, key.status]), [
      ['key_rotation_second', 'ACTIVE'],
      ['key_rotation_first', 'RETIRED']
    ]);
    assert.equal(await registry.verifyPayload({
      keyId: first.keyId, algorithm: first.algorithm, payload: oldPayload, signature: oldSignature
    }), true);
    const replacement = createReceiptSigner({ keyId: first.keyId });
    await assert.rejects(registry.registerActive(replacement), /SIGNING_KEY_ID_REUSE/);
  } finally {
    await pool.query('DELETE FROM mandate.signing_keys WHERE tenant_id = $1', [tenantId]).catch(() => {});
    await pool.query('DELETE FROM mandate.tenants WHERE id = $1', [tenantId]).catch(() => {});
    await pool.end();
  }
});
