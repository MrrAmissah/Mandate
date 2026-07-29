import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createMandateKeySetCache,
  MandateKeySetUnavailableError
} from '../packages/receipt-verifier/index.js';

const fixtureUrl = new URL('./fixtures/receipt-verification/ed25519-v1.1.json', import.meta.url);

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('invalidation detaches a hung refresh and permits a new generation immediately', async () => {
  const data = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  const stale = deferred();
  let loads = 0;
  const cache = createMandateKeySetCache({
    scopeId: 'invalidation-recovery',
    load() {
      loads += 1;
      if (loads === 1) return stale.promise;
      return { keys: [data.verificationKey] };
    }
  });

  const staleRequest = cache.get();
  assert.equal(cache.snapshot().refreshing, true);
  cache.invalidate();
  assert.equal(cache.snapshot().refreshing, false);

  const recovered = await cache.get();
  assert.equal(loads, 2);
  assert.equal(recovered.keys[0].keyId, data.verificationKey.keyId);
  assert.equal((await cache.verify(data.receipt)).valid, true);

  stale.resolve({ keys: [] });
  await assert.rejects(staleRequest, (error) => error instanceof MandateKeySetUnavailableError);
  assert.equal(cache.snapshot().cached, true);
  assert.equal(cache.snapshot().generation, 1);
  assert.equal((await cache.verify(data.receipt)).valid, true);
  assert.equal(loads, 2);
});
