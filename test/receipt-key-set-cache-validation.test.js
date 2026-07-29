import test from 'node:test';
import assert from 'node:assert/strict';
import { createMandateKeySetCache } from '../packages/receipt-verifier/index.js';

test('receipt key cache validates scope, loader, lifetime, and clock boundaries', () => {
  assert.throws(() => createMandateKeySetCache({
    scopeId: '',
    load() { return { keys: [] }; }
  }), /scopeId must be a non-empty string/);
  assert.throws(() => createMandateKeySetCache({
    scopeId: 'scope',
    load: null
  }), /load must be a function/);
  assert.throws(() => createMandateKeySetCache({
    scopeId: 'scope',
    maxAgeMs: 999,
    load() { return { keys: [] }; }
  }), /maxAgeMs must be an integer between 1000 and 3600000/);
  assert.throws(() => createMandateKeySetCache({
    scopeId: 'scope',
    clock: null,
    load() { return { keys: [] }; }
  }), /clock must be a function/);
});

test('receipt key cache rejects non-boolean refresh options and freezes loader context', async () => {
  let observedContext;
  const cache = createMandateKeySetCache({
    scopeId: 'scope-validation',
    load(context) {
      observedContext = context;
      return { keys: [] };
    }
  });

  await assert.rejects(cache.get({ forceRefresh: 'false' }), /forceRefresh must be a boolean/);
  await assert.rejects(cache.get(null), /get options must be an object/);
  await cache.get();
  assert.deepEqual(observedContext, { scopeId: 'scope-validation' });
  assert.equal(Object.isFrozen(observedContext), true);
});

test('receipt key cache rejects invalid clock output before loading', async () => {
  let loads = 0;
  const cache = createMandateKeySetCache({
    scopeId: 'scope-clock',
    clock: () => Number.NaN,
    load() {
      loads += 1;
      return { keys: [] };
    }
  });
  await assert.rejects(cache.get(), /clock must return a valid Date or millisecond timestamp/);
  assert.equal(loads, 0);
});
