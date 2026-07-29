function timestamp(clock) {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(milliseconds)) throw new TypeError('clock must return a valid Date or millisecond timestamp.');
  return milliseconds;
}

function normalizeKeySet(value) {
  const keys = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray(value.keys)
      ? value.keys
      : null;
  if (!keys) throw new TypeError('key-set loader must return a key array or discovery response.');
  return Object.freeze({
    keys: Object.freeze(keys.map((key) => Object.freeze({ ...key })))
  });
}

export class MandateKeySetUnavailableError extends Error {
  constructor() {
    super('The Mandate verification key set is unavailable.');
    this.name = 'MandateKeySetUnavailableError';
    this.code = 'KEY_SET_UNAVAILABLE';
  }
}

export function createStrictKeySetCache({
  scopeId,
  load,
  maxAgeMs = 300000,
  clock = () => Date.now(),
  verifyReceipt,
  keyNotFoundReason,
  unavailableResult
}) {
  if (typeof scopeId !== 'string' || scopeId.length < 1 || scopeId.length > 1000) {
    throw new TypeError('scopeId must be a non-empty string of at most 1000 characters.');
  }
  if (typeof load !== 'function') throw new TypeError('load must be a function.');
  if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1000 || maxAgeMs > 3600000) {
    throw new TypeError('maxAgeMs must be an integer between 1000 and 3600000.');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
  if (typeof verifyReceipt !== 'function') throw new TypeError('verifyReceipt must be a function.');
  if (typeof keyNotFoundReason !== 'string' || keyNotFoundReason.length === 0) {
    throw new TypeError('keyNotFoundReason must be a non-empty string.');
  }
  if (typeof unavailableResult !== 'function') throw new TypeError('unavailableResult must be a function.');

  let cached = null;
  let refreshing = null;
  let epoch = 0;
  let generation = 0;

  async function refresh() {
    if (refreshing) return refreshing;
    const refreshEpoch = epoch;
    const operation = (async () => {
      try {
        const loaded = normalizeKeySet(await load({ scopeId }));
        const loadedAtMs = timestamp(clock);
        if (refreshEpoch !== epoch) throw new MandateKeySetUnavailableError();
        generation += 1;
        const record = Object.freeze({
          keySet: loaded,
          loadedAtMs,
          expiresAtMs: loadedAtMs + maxAgeMs,
          generation
        });
        cached = record;
        return record;
      } catch (error) {
        if (error instanceof MandateKeySetUnavailableError) throw error;
        throw new MandateKeySetUnavailableError();
      }
    })();
    refreshing = operation;
    try {
      return await operation;
    } finally {
      if (refreshing === operation) refreshing = null;
    }
  }

  async function obtain(forceRefresh = false) {
    const nowMs = timestamp(clock);
    if (!forceRefresh && cached && nowMs < cached.expiresAtMs) {
      return Object.freeze({ record: cached, refreshed: false });
    }
    return Object.freeze({ record: await refresh(), refreshed: true });
  }

  return Object.freeze({
    scopeId,

    async get({ forceRefresh = false } = {}) {
      return (await obtain(Boolean(forceRefresh))).record.keySet;
    },

    async verify(receipt) {
      let obtained;
      try {
        obtained = await obtain(false);
      } catch {
        return unavailableResult(receipt);
      }

      let verification = verifyReceipt(receipt, obtained.record.keySet);
      if (verification.reason !== keyNotFoundReason || obtained.refreshed) return verification;

      try {
        const refreshed = await obtain(true);
        verification = verifyReceipt(receipt, refreshed.record.keySet);
        return verification;
      } catch {
        return unavailableResult(receipt);
      }
    },

    invalidate() {
      epoch += 1;
      cached = null;
    },

    snapshot() {
      return Object.freeze({
        scopeId,
        generation: cached?.generation ?? generation,
        loadedAt: cached ? new Date(cached.loadedAtMs).toISOString() : null,
        expiresAt: cached ? new Date(cached.expiresAtMs).toISOString() : null,
        refreshing: Boolean(refreshing),
        cached: Boolean(cached)
      });
    }
  });
}
