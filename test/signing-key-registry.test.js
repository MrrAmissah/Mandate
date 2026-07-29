import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import { createStaticSigningKeyRegistry } from '../src/crypto/signing-key-registry.js';

const payload = { id: 'rcpt_test', version: '1.0', keyId: 'key_test_primary', algorithm: 'Ed25519' };

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
