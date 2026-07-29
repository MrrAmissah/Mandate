import { DomainError } from '../domain/errors.js';

export class MemoryStore {
  mandates = new Map();
  approvals = new Map();
  decisions = new Map();
  receipts = new Map();
  idempotency = new Map();

  save(kind, entity) {
    this[kind].set(entity.id, structuredClone(entity));
    return structuredClone(entity);
  }

  get(kind, id) {
    const entity = this[kind].get(id);
    return entity ? structuredClone(entity) : null;
  }

  idempotent(scope, key, fingerprint, create) {
    if (!key) return create();
    const idempotencyKey = `${scope}:${key}`;
    const existing = this.idempotency.get(idempotencyKey);
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
    const value = create();
    this.idempotency.set(idempotencyKey, {
      fingerprint,
      value: structuredClone(value)
    });
    return structuredClone(value);
  }
}
