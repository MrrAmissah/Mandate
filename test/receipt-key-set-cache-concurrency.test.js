import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createMandateKeySetCache,
  RECEIPT_VERIFICATION_REASONS
} from '../packages/receipt-verifier/index.js';

const fixtureUrl = new URL('./fixtures/receipt-verification/ed25519-v1.1.json', import.meta.url);

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function waitFor(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition was not reached');
}

test('a mixed shared refresh preserves missing-key suppression for the refreshed generation', async () => {
  const data = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  const pending = deferred();
  let loads = 0;
  const cache = createMandateKeySetCache({
    scopeId: 'mixed-unknown-refresh',
    load() {
      loads += 1;
      if (loads === 1) return { keys: [] };
      return pending.promise;
    }
  });

  await cache.get();
  const validAfterRefresh = cache.verify(data.receipt);
  const stillUnknownAfterRefresh = cache.verify({
    ...data.receipt,
    keyId: 'key_not_in_refreshed_generation'
  });
  await waitFor(() => loads === 2);

  pending.resolve({ keys: [data.verificationKey] });
  assert.equal((await validAfterRefresh).valid, true);
  assert.equal(
    (await stillUnknownAfterRefresh).reason,
    RECEIPT_VERIFICATION_REASONS.KEY_NOT_FOUND
  );

  assert.equal(
    (await cache.verify({ ...data.receipt, keyId: 'another_random_unknown_key' })).reason,
    RECEIPT_VERIFICATION_REASONS.KEY_NOT_FOUND
  );
  assert.equal(loads, 2);
});
