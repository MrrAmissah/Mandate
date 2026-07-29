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

  idempotent(scope, key, create) {
    if (!key) return create();
    const idempotencyKey = `${scope}:${key}`;
    if (this.idempotency.has(idempotencyKey)) {
      return structuredClone(this.idempotency.get(idempotencyKey));
    }
    const value = create();
    this.idempotency.set(idempotencyKey, structuredClone(value));
    return value;
  }
}
