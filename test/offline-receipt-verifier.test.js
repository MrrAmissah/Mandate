import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import {
  canonicalize as offlineCanonicalize,
  RECEIPT_VERIFICATION_REASONS,
  verifyMandateReceipt
} from '../packages/receipt-verifier/index.js';
import { canonicalize as serverCanonicalize } from '../src/crypto/canonical-json.js';
import { verifyReceiptWithRegistry } from '../src/domain/receipts.js';

const fixtureUrl = new URL('./fixtures/receipt-verification/ed25519-v1.1.json', import.meta.url);
const tamperUrl = new URL('./fixtures/receipt-verification/tamper-cases.json', import.meta.url);

async function fixture() {
  return JSON.parse(await readFile(fixtureUrl, 'utf8'));
}

function keySet(key, overrides = {}) {
  return { keys: [{ ...key, ...overrides }] };
}

function independentRegistry(key) {
  return {
    async verifyPayload({ keyId, algorithm, payload, signature }) {
      if (keyId !== key.keyId || algorithm !== key.algorithm) return false;
      if (!['ACTIVE', 'RETIRED'].includes(key.status)) return false;
      const publicKey = createPublicKey(key.publicKeyPem);
      if (publicKey.asymmetricKeyType !== 'ed25519') return false;
      try {
        return verify(
          null,
          Buffer.from(serverCanonicalize(payload)),
          publicKey,
          Buffer.from(signature, 'base64url')
        );
      } catch {
        return false;
      }
    }
  };
}

test('offline package and server use the exact conformance canonical payload', async () => {
  const data = await fixture();
  const { signature, ...payload } = data.receipt;
  assert.equal(offlineCanonicalize(payload), data.canonicalPayload);
  assert.equal(serverCanonicalize(payload), data.canonicalPayload);
  assert.equal(signature.length > 0, true);
});

test('active and retired public keys verify the conformance receipt offline', async () => {
  const data = await fixture();
  assert.deepEqual(verifyMandateReceipt(data.receipt, keySet(data.verificationKey)), {
    valid: true,
    reason: RECEIPT_VERIFICATION_REASONS.VALID,
    keyId: data.receipt.keyId,
    algorithm: 'Ed25519'
  });
  assert.equal(
    verifyMandateReceipt(data.receipt, keySet(data.verificationKey, {
      status: 'RETIRED',
      retiredAt: '2026-07-29T13:00:00.000Z'
    })).valid,
    true
  );
  assert.equal(
    await verifyReceiptWithRegistry(data.receipt, independentRegistry(data.verificationKey)),
    true
  );
});

test('revoked, missing, duplicate, and unsupported keys fail with stable reasons', async () => {
  const data = await fixture();
  assert.equal(
    verifyMandateReceipt(data.receipt, keySet(data.verificationKey, { status: 'REVOKED' })).reason,
    RECEIPT_VERIFICATION_REASONS.KEY_NOT_VERIFIABLE
  );
  assert.equal(
    verifyMandateReceipt(data.receipt, { keys: [] }).reason,
    RECEIPT_VERIFICATION_REASONS.KEY_NOT_FOUND
  );
  assert.equal(
    verifyMandateReceipt(data.receipt, {
      keys: [data.verificationKey, { ...data.verificationKey }]
    }).reason,
    RECEIPT_VERIFICATION_REASONS.INVALID_KEY
  );
  assert.equal(
    verifyMandateReceipt({ ...data.receipt, algorithm: 'RS256' }, keySet(data.verificationKey)).reason,
    RECEIPT_VERIFICATION_REASONS.UNSUPPORTED_ALGORITHM
  );
});

test('malformed and non-Ed25519 public keys fail closed', async () => {
  const data = await fixture();
  assert.equal(
    verifyMandateReceipt(data.receipt, keySet(data.verificationKey, {
      publicKeyPem: 'not a public key'
    })).reason,
    RECEIPT_VERIFICATION_REASONS.INVALID_KEY
  );

  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString();
  assert.equal(
    verifyMandateReceipt(data.receipt, keySet(data.verificationKey, {
      publicKeyPem: rsa
    })).reason,
    RECEIPT_VERIFICATION_REASONS.INVALID_KEY
  );
});

test('missing receipt signature metadata fails as an invalid receipt', async () => {
  const data = await fixture();
  const { signature, ...unsigned } = data.receipt;
  assert.equal(signature.length > 0, true);
  assert.equal(
    verifyMandateReceipt(unsigned, keySet(data.verificationKey)).reason,
    RECEIPT_VERIFICATION_REASONS.INVALID_RECEIPT
  );
  assert.equal(
    verifyMandateReceipt(null, keySet(data.verificationKey)).reason,
    RECEIPT_VERIFICATION_REASONS.INVALID_RECEIPT
  );
});

test('the public tamper corpus fails both offline and independent server verification', async (context) => {
  const data = await fixture();
  const cases = JSON.parse(await readFile(tamperUrl, 'utf8'));
  for (const tamper of cases) {
    await context.test(tamper.name, async () => {
      const receipt = { ...data.receipt, [tamper.field]: tamper.value };
      const offline = verifyMandateReceipt(receipt, keySet(data.verificationKey));
      assert.equal(offline.valid, false);
      assert.equal(offline.reason, tamper.expectedReason);
      assert.equal(
        await verifyReceiptWithRegistry(receipt, independentRegistry(data.verificationKey)),
        false
      );
    });
  }
});

test('raw key arrays and discovery response objects have identical semantics', async () => {
  const data = await fixture();
  const key = { ...data.verificationKey, status: 'RETIRED' };
  assert.deepEqual(
    verifyMandateReceipt(data.receipt, [key]),
    verifyMandateReceipt(data.receipt, { keys: [key], requestId: 'req_discovery' })
  );
});
