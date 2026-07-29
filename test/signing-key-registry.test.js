import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import {
  createStaticSigningKeyRegistry,
  PostgresSigningKeyRegistry
} from '../src/crypto/signing-key-registry.js';

const payload = { id: 'rcpt_test', version: '1.0', keyId: 'key_test_primary', algorithm: 'Ed25519' };

function retryingPool({ signer, code }) {
  let connections = 0;
  return {
    get connections() { return connections; },
    async connect() {
      connections += 1;
      const currentAttempt = connections;
      return {
        async query(sql) {
          if (sql === 'BEGIN' || sql.startsWith('SET TRANSACTION') || sql === 'COMMIT' || sql === 'ROLLBACK') {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes('SELECT * FROM mandate.signing_keys')) {
            if (currentAttempt === 1) {
              const error = new Error(`retry ${code}`);
              error.code = code;
              throw error;
            }
            return { rowCount: 0, rows: [] };
          }
          if (sql.startsWith('UPDATE mandate.signing_keys')) return { rowCount: 0, rows: [] };
          if (sql.startsWith('INSERT INTO mandate.signing_keys')) {
            return {
              rowCount: 1,
              rows: [{
                key_id: signer.keyId,
                algorithm: signer.algorithm,
                public_key_pem: signer.publicKeyPem,
                fingerprint: `sha256:${'0'.repeat(64)}`,
                status: 'ACTIVE',
                activated_at: new Date('2026-07-29T00:00:00.000Z'),
                retired_at: null,
                revoked_at: null,
                revocation_reason: null
              }]
            };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
        release() {}
      };
    }
  };
}

test('static signing registry verifies the configured key and rejects other identities', async () => {
  const signer = createReceiptSigner({ keyId: 'key_test_primary' });
  const registry = createStaticSigningKeyRegistry(signer);
  const signature = signer.signPayload(payload);
  assert.equal(await registry.verifyPayload({ ...payload, payload, signature }), true);
  assert.equal(await registry.verifyPayload({ ...payload, keyId: 'key_other', payload, signature }), false);
  const keys = await registry.listDiscoverable();
  assert.equal(keys.length, 1);
  assert.equal(keys[0].keyId, signer.keyId);
  assert.equal(keys[0].status, 'ACTIVE');
  assert.match(keys[0].fingerprint, /^sha256:[0-9a-f]{64}$/);
});

test('static registry fails closed when runtime key material changes under one key ID', async () => {
  const signer = createReceiptSigner({ keyId: 'key_test_primary' });
  const registry = createStaticSigningKeyRegistry(signer);
  const replacement = createReceiptSigner({ keyId: 'key_test_primary' });
  await assert.rejects(registry.registerActive(replacement), /STATIC_SIGNING_KEY_MISMATCH/);
});

test('signing registries reject non-Ed25519 public key material', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => createStaticSigningKeyRegistry({
    keyId: 'key_rsa_invalid',
    algorithm: 'Ed25519',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    verifyPayload() { return false; }
  }), /Only Ed25519 public keys are supported/);
});

for (const code of ['40001', '40P01', '23505']) {
  test(`PostgreSQL signing-key registration retries ${code} transaction conflicts`, async () => {
    const signer = createReceiptSigner({ keyId: `key_retry_${code}` });
    const pool = retryingPool({ signer, code });
    const registry = new PostgresSigningKeyRegistry(
      pool,
      { tenantId: 'ten_retry', environment: 'test' },
      { maximumTransactionAttempts: 2, retryDelay: async () => {} }
    );
    const registered = await registry.registerActive(signer);
    assert.equal(registered.keyId, signer.keyId);
    assert.equal(pool.connections, 2);
  });
}
