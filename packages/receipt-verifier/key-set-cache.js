function timestamp(clock) {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(milliseconds)) throw new TypeError('clock must return a valid Date or millisecond timestamp.');
  return milliseconds;
}

function publicVerificationKey(value) {
  const key = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {
    keyId: key.keyId,
    algorithm: key.algorithm,
    publicKeyPem: key.publicKeyPem,
    status: key.status
  };
  for (const field of ['fingerprint', 'activatedAt', 'retiredAt']) {
    if (key[field] !== undefined) normalized[field] = key[field];
  }
  return Object.freeze(normalized);
}

function normalizeKeySet(value) {
  const keys = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray(value.keys)
      ? value.keys
      : null;
  if (!keys) throw new TypeError('key-set loader must return a key array or discovery response.');
  return Object.freeze({
    keys: Object.freeze(keys.map(publicVerificationKey))
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
  let unknownRefreshState = null;

  async function refresh() {
    if (refreshing) return refreshing;
    const refreshEpoch = epoch;
    const operation = (async () => {
      try {
        const loaded = normalizeKeySet(await load(Object.freeze({ scopeId })));
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

  function settledUnknownResult(state, receipt, verification) {
    if (state.outcome === 'unavailable') return unavailableResult(receipt);
    return verification;
  }

  function rememberMissingGeneration(record, expectedState = null) {
    if (cached?.generation !== record.generation) return;
    if (expectedState && unknownRefreshState !== expectedState && unknownRefreshState !== null) return;
    unknownRefreshState = {
      sourceGeneration: record.generation,
      promise: null,
      outcome: 'missing'
    };
  }

  async function refreshUnknownKey(receipt, initialVerification, sourceRecord) {
    const existing = unknownRefreshState;
    if (existing?.sourceGeneration === sourceRecord.generation) {
      if (!existing.promise) return settledUnknownResult(existing, receipt, initialVerification);
      const shared = await existing.promise;
      if (shared.unavailable) return unavailableResult(receipt);
      const sharedVerification = verifyReceipt(receipt, shared.record.keySet);
      if (sharedVerification.reason === keyNotFoundReason) {
        rememberMissingGeneration(shared.record, existing);
      }
      return sharedVerification;
    }

    const state = {
      sourceGeneration: sourceRecord.generation,
      promise: null,
      outcome: null
    };
    const operation = (async () => {
      try {
        return Object.freeze({ record: (await obtain(true)).record, unavailable: false });
      } catch {
        return Object.freeze({ record: null, unavailable: true });
      }
    })();
    state.promise = operation;
    unknownRefreshState = state;

    const refreshed = await operation;
    const verification = refreshed.unavailable
      ? null
      : verifyReceipt(receipt, refreshed.record.keySet);

    if (unknownRefreshState === state) {
      if (refreshed.unavailable) {
        unknownRefreshState = cached?.generation === sourceRecord.generation
          ? { sourceGeneration: sourceRecord.generation, promise: null, outcome: 'unavailable' }
          : null;
      } else if (verification.reason === keyNotFoundReason) {
        rememberMissingGeneration(refreshed.record, state);
      } else {
        unknownRefreshState = null;
      }
    }

    return refreshed.unavailable ? unavailableResult(receipt) : verification;
  }

  return Object.freeze({
    scopeId,

    async get(options = {}) {
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('get options must be an object.');
      }
      const { forceRefresh = false } = options;
      if (typeof forceRefresh !== 'boolean') {
        throw new TypeError('forceRefresh must be a boolean.');
      }
      return (await obtain(forceRefresh)).record.keySet;
    },

    async verify(receipt) {
      const preflight = verifyReceipt(receipt, { keys: [] });
      if (preflight.reason !== keyNotFoundReason) return preflight;

      let obtained;
      try {
        obtained = await obtain(false);
      } catch {
        return unavailableResult(receipt);
      }

      const verification = verifyReceipt(receipt, obtained.record.keySet);
      if (verification.reason !== keyNotFoundReason) return verification;

      if (obtained.refreshed) {
        rememberMissingGeneration(obtained.record);
        return verification;
      }

      return refreshUnknownKey(receipt, verification, obtained.record);
    },

    invalidate() {
      epoch += 1;
      cached = null;
      refreshing = null;
      unknownRefreshState = null;
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
