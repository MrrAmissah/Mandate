import { DomainError } from '../domain/errors.js';

const ENTITY_KINDS = Object.freeze([
  'apiCredentials',
  'mandates',
  'approvals',
  'decisions',
  'receipts',
  'auditEvents',
  'outboxMessages'
]);

function newState() {
  return {
    apiCredentials: new Map(),
    mandates: new Map(),
    approvals: new Map(),
    decisions: new Map(),
    receipts: new Map(),
    auditEvents: new Map(),
    outboxMessages: new Map(),
    idempotency: new Map(),
    auditSequences: new Map()
  };
}

function cloneMap(map) {
  return new Map([...map.entries()].map(([key, value]) => [key, structuredClone(value)]));
}

function cloneState(state) {
  return {
    ...Object.fromEntries(ENTITY_KINDS.map((kind) => [kind, cloneMap(state[kind])])),
    idempotency: cloneMap(state.idempotency),
    auditSequences: cloneMap(state.auditSequences)
  };
}

function normalizeOwnership(value, fallback) {
  const ownership = value ?? fallback;
  if (
    !ownership ||
    typeof ownership.tenantId !== 'string' ||
    !/^ten_[A-Za-z0-9_-]+$/.test(ownership.tenantId) ||
    !['test', 'live'].includes(ownership.environment)
  ) {
    throw new TypeError('A valid tenantId and test/live ownership scope is required.');
  }
  return ownership;
}

function entityKey(ownership, id) {
  return `${ownership.tenantId}:${ownership.environment}:${id}`;
}

function idempotencyKey(ownership, scope, key) {
  return `${ownership.tenantId}:${ownership.environment}:${scope}:${key}`;
}

class MemoryView {
  constructor(state, defaultOwnership) {
    this.state = state;
    this.defaultOwnership = defaultOwnership;
  }

  #parseSaveArguments(ownershipOrEntity, maybeEntity) {
    if (maybeEntity === undefined) {
      return {
        ownership: normalizeOwnership(null, this.defaultOwnership),
        entity: ownershipOrEntity
      };
    }
    return {
      ownership: normalizeOwnership(ownershipOrEntity, this.defaultOwnership),
      entity: maybeEntity
    };
  }

  #parseGetArguments(ownershipOrId, maybeId) {
    if (maybeId === undefined) {
      return {
        ownership: normalizeOwnership(null, this.defaultOwnership),
        id: ownershipOrId
      };
    }
    return {
      ownership: normalizeOwnership(ownershipOrId, this.defaultOwnership),
      id: maybeId
    };
  }

  save(kind, ownershipOrEntity, maybeEntity) {
    if (!ENTITY_KINDS.includes(kind)) throw new TypeError(`Unknown entity kind: ${kind}`);
    const { ownership, entity } = this.#parseSaveArguments(ownershipOrEntity, maybeEntity);
    this.state[kind].set(entityKey(ownership, entity.id), structuredClone(entity));
    return structuredClone(entity);
  }

  get(kind, ownershipOrId, maybeId) {
    if (!ENTITY_KINDS.includes(kind)) throw new TypeError(`Unknown entity kind: ${kind}`);
    const { ownership, id } = this.#parseGetArguments(ownershipOrId, maybeId);
    const entity = this.state[kind].get(entityKey(ownership, id));
    return entity ? structuredClone(entity) : null;
  }

  list(kind, ownership = this.defaultOwnership) {
    if (!ENTITY_KINDS.includes(kind)) throw new TypeError(`Unknown entity kind: ${kind}`);
    const normalized = normalizeOwnership(ownership, this.defaultOwnership);
    const prefix = `${normalized.tenantId}:${normalized.environment}:`;
    return [...this.state[kind].entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => structuredClone(value));
  }

  findCredentialBySecretHash(secretHash) {
    for (const value of this.state.apiCredentials.values()) {
      if (value.secretHash === secretHash) return structuredClone(value);
    }
    return null;
  }

  async idempotent(ownershipOrScope, scopeOrKey, keyOrFingerprint, fingerprintOrCreate, maybeCreate) {
    let ownership;
    let scope;
    let key;
    let fingerprint;
    let create;

    if (maybeCreate === undefined) {
      ownership = normalizeOwnership(null, this.defaultOwnership);
      scope = ownershipOrScope;
      key = scopeOrKey;
      fingerprint = keyOrFingerprint;
      create = fingerprintOrCreate;
    } else {
      ownership = normalizeOwnership(ownershipOrScope, this.defaultOwnership);
      scope = scopeOrKey;
      key = keyOrFingerprint;
      fingerprint = fingerprintOrCreate;
      create = maybeCreate;
    }

    if (!key) return structuredClone(await create());
    const compoundKey = idempotencyKey(ownership, scope, key);
    const existing = this.state.idempotency.get(compoundKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used with a different request payload.',
          409
        );
      }
      return structuredClone(existing.value);
    }

    const value = await create();
    this.state.idempotency.set(compoundKey, {
      fingerprint,
      value: structuredClone(value)
    });
    return structuredClone(value);
  }

  appendAudit(ownership, event) {
    const normalized = normalizeOwnership(ownership, this.defaultOwnership);
    const sequenceKey = `${normalized.tenantId}:${normalized.environment}`;
    const sequence = (this.state.auditSequences.get(sequenceKey) ?? 0) + 1;
    this.state.auditSequences.set(sequenceKey, sequence);
    return this.save('auditEvents', normalized, {
      ...event,
      sequence
    });
  }

  enqueueOutbox(ownership, message) {
    return this.save('outboxMessages', normalizeOwnership(ownership, this.defaultOwnership), message);
  }
}

export class MemoryStore extends MemoryView {
  #tail = Promise.resolve();

  constructor({ tenantId = 'ten_local', environment = 'test' } = {}) {
    const state = newState();
    const defaultOwnership = Object.freeze({ tenantId, environment });
    super(state, defaultOwnership);
    this.state = state;
  }

  async transaction(work) {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => {
      release = resolve;
    });

    await previous;
    const candidate = cloneState(this.state);
    const transaction = new MemoryView(candidate, this.defaultOwnership);

    try {
      const result = await work(transaction);
      this.state = candidate;
      return structuredClone(result);
    } finally {
      release();
    }
  }
}
