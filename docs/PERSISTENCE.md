# Persistence and transaction contract

## Current status

Phase 2A defines and tests the persistence contract. The default server still uses the in-memory reference store. It is not restart-safe and must not be deployed as a durable authorization service.

Phase 2B will wire the PostgreSQL driver, run the migration in CI against a real database, and replace the default runtime store.

## Ownership boundary

Every private record is addressed through:

```text
(tenant_id, environment, public_id)
```

`environment` is exactly `test` or `live`. An object that exists for one tenant or environment is intentionally indistinguishable from a missing object to another tenant.

## Required authorization transaction

One authorization transaction must:

1. lock or otherwise serialize the selected mandate revision;
2. load the exact approval when supplied;
3. evaluate the pure policy engine;
4. insert the immutable decision;
5. increment mandate use only for `ALLOW`;
6. consume a matching approval only for `ALLOW`;
7. insert an immutable audit event;
8. insert the corresponding outbox message; and
9. commit all changes together.

A failure at any point rolls back every step. Concurrent requests for the final mandate use or the same approval may produce only one allowed decision.

## Idempotency

An idempotency record is scoped by tenant, environment, operation scope, and caller key. It stores the canonical request fingerprint and exact response. Reusing a key with different input is a conflict. The domain state, audit event, outbox message, and idempotency response must commit in the same transaction.

## Immutable records

Authorization decisions, signed receipts, and audit events are insert-only. PostgreSQL triggers reject update and delete attempts. Corrections are represented by new records that reference or supersede the original; history is never rewritten.

## Credential storage

Raw API credentials are displayed once. Durable records contain only:

- SHA-256 lookup hash of a high-entropy secret;
- safe prefix and last four characters;
- exact scopes;
- tenant and environment ownership;
- active/revoked status and lifecycle timestamps.

Authentication errors do not reveal whether a credential was unknown, expired, or revoked.

## Outbox

The outbox row is inserted with the domain transaction. Workers will later claim due rows with a lease, commit before network I/O, retry transient failures, and dead-letter exhausted messages. External delivery is never performed inside the authorization transaction.
