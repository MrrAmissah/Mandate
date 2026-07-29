import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createMandateKeySetCache,
  MandateKeySetUnavailableError,
  RECEIPT_VERIFICATION_REASONS
} from '../packages/receipt-verifier/index.js';

const fixtureUrl = new URL('./fixtures/receipt-verification/ed25519-v1.1.json', import.meta.url);

async function fixture() {
  return JSON.parse(await readFile(fixtureUrl, 'utf8'));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('cold verification loads once and timestamps freshness after loading completes', async () => {
  const data = await fixture();
  let now = Date.parse('2026-07-29T12:00:00.000Z');
  let loads = 0;
  const cache = createMandateKeySetCache({
    scopeId: 'https://mandate.example/live/.well-known/mandate-keys',
    maxAgeMs: 300000,
    clock: () => now,
    async load({ scopeId }) {
      loads += 1;
      assert.equal(scopeId, cache.scopeId);
      now += 10000;
      return { keys: [data.verificationKey], requestId: 'req_discovery' };
    }
  });

  const first = await cache.verify(data.receipt);
  assert.equal(first.valid, true);
  assert.equal(loads, 1);
  assert.deepEqual(cache.snapshot(), {
    scopeId: cache.scopeId,
    generation: 1,
    loadedAt: '2026-07-29T12:00:10.000Z',
    expiresAt: '2026-07-29T12:05:10.000Z',
    refreshing: false,
    cached: true
  });

  now += 1000;
  assert.equal((await cache.verify(data.receipt)).valid, true);
  assert.equal(loads, 1);
});

test('an unknown key refreshes once only when the first attempt used an existing cache entry', async () => {
  const data = await fixture();
  let loads = 0;
  const cache = createMandateKeySetCache({
    scopeId: 'tenant-live',
    maxAgeMs: 300000,
    load() {
      loads += 1;
      return loads === 1 ? { keys: [] } : { keys: [data.verificationKey] };
    }
  });

  await cache.get();
  assert.equal(loads, 1);
  const result = await cache.verify(data.receipt);
  assert.equal(result.valid, true);
  assert.equal(loads, 2);

  const coldMissing = createMandateKeySetCache({
    scopeId: 'tenant-live-missing',
    load() {
      loads += 1;
      return { keys: [] };
    }
  });
  const before = loads;
  assert.equal((await coldMissing.verify(data.receipt)).reason, RECEIPT_VERIFICATION_REASONS.KEY_NOT_FOUND);
  assert.equal(loads, before + 1);
});

test('concurrent refreshes are single-flight and return an immutable cloned key set', async () => {
  const data = await fixture();
  const pending = deferred();
  let loads = 0;
  const source = { ...data.verificationKey };
  const cache = createMandateKeySetCache({
    scopeId: 'tenant-test',
    load() {
      loads += 1;
      return pending.promise;
    }
  });

  const first = cache.get();
  const second = cache.get({ forceRefresh: true });
  assert.equal(loads, 1);
  pending.resolve({ keys: [source] });
  const [firstSet, secondSet] = await Promise.all([first, second]);
  assert.equal(firstSet, secondSet);
  assert.equal(Object.isFrozen(firstSet), true);
  assert.equal(Object.isFrozen(firstSet.keys), true);
  assert.equal(Object.isFrozen(firstSet.keys[0]), true);

  source.status = 'REVOKED';
  assert.equal(firstSet.keys[0].status, 'ACTIVE');
});

test('expired cache data is never used when refresh fails', async () => {
  const data = await fixture();
  let now = 1000;
  let fail = false;
  const cache = createMandateKeySetCache({
    scopeId: 'strict-expiry',
    maxAgeMs: 1000,
    clock: () => now,
    load() {
      if (fail) throw new Error('sensitive transport detail');
      return { keys: [data.verificationKey] };
    }
  });

  assert.equal((await cache.verify(data.receipt)).valid, true);
  now = 2001;
  fail = true;
  const result = await cache.verify(data.receipt);
  assert.deepEqual(result, {
    valid: false,
    reason: RECEIPT_VERIFICATION_REASONS.KEY_SET_UNAVAILABLE,
    keyId: data.receipt.keyId,
    algorithm: data.receipt.algorithm
  });
  await assert.rejects(cache.get(), (error) => {
    assert.equal(error instanceof MandateKeySetUnavailableError, true);
    assert.equal(error.code, 'KEY_SET_UNAVAILABLE');
    assert.doesNotMatch(error.message, /sensitive transport detail/);
    return true;
  });
});

test('malformed receipts and unsupported algorithms do not invoke the loader', async () => {
  const data = await fixture();
  let loads = 0;
  const cache = createMandateKeySetCache({
    scopeId: 'preflight',
    load() {
      loads += 1;
      return { keys: [data.verificationKey] };
    }
  });

  assert.equal((await cache.verify(null)).reason, RECEIPT_VERIFICATION_REASONS.INVALID_RECEIPT);
  assert.equal(
    (await cache.verify({ ...data.receipt, algorithm: 'RS256' })).reason,
    RECEIPT_VERIFICATION_REASONS.UNSUPPORTED_ALGORITHM
  );
  assert.equal(loads, 0);
});

test('invalidating an active refresh prevents stale completion from repopulating the cache', async () => {
  const data = await fixture();
  const pending = deferred();
  const cache = createMandateKeySetCache({
    scopeId: 'invalidate-race',
    load() { return pending.promise; }
  });

  const loading = cache.get();
  assert.equal(cache.snapshot().refreshing, true);
  cache.invalidate();
  pending.resolve({ keys: [data.verificationKey] });

  await assert.rejects(loading, (error) => error instanceof MandateKeySetUnavailableError);
  assert.deepEqual(cache.snapshot(), {
    scopeId: 'invalidate-race',
    generation: 0,
    loadedAt: null,
    expiresAt: null,
    refreshing: false,
    cached: false
  });
});

test('invalid loader output fails with a bounded unavailable error', async () => {
  const cache = createMandateKeySetCache({
    scopeId: 'invalid-loader',
    load() { return { notKeys: true }; }
  });
  await assert.rejects(cache.get(), (error) => {
    assert.equal(error instanceof MandateKeySetUnavailableError, true);
    assert.equal(error.code, 'KEY_SET_UNAVAILABLE');
    return true;
  });
});
