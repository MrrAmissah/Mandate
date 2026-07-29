# Persistence and transaction contract

## Current status

Phase 2B wires PostgreSQL as an active runtime mode. Set `MANDATE_STORE=postgres`, configure `DATABASE_URL`, apply migrations with `npm run migrate`, and then start the API.

Memory mode remains available for local experimentation and fast domain tests. It is not restart-safe and is rejected in a live environment.

## Ownership boundary

Every private record is addressed through:

```text
(tenant_id, environment, public_id)
```

`environment` is exactly `test` or `live`. An object that exists for one tenant or environment is intentionally indistinguishable from a missing object to another tenant.

## Runtime transaction rule

Every PostgreSQL transaction uses one checked-out pool client from `BEGIN` through `COMMIT` or `ROLLBACK`. Domain queries never jump between pooled clients while a transaction is active.

The authorization transaction:

1. serializes the selected mandate row;
2. loads and serializes the exact approval when supplied;
3. evaluates the pure policy engine;
4. inserts the immutable decision;
5. increments mandate use only for `ALLOW`;
6. consumes a matching approval only for `ALLOW`;
7. inserts an immutable audit event;
8. inserts the corresponding outbox message; and
9. commits all changes together.

Transactions run at `SERIALIZABLE` isolation and retry bounded serialization, deadlock, and first-writer uniqueness races. A failure at any point rolls back every step. Real PostgreSQL tests prove that concurrent requests for the final mandate use produce exactly one `ALLOW`.

## JSONB encoding

The PostgreSQL adapter serializes every JSONB-bound value explicitly. This is required for JavaScript arrays because `node-postgres` otherwise treats them as PostgreSQL array literals rather than JSON arrays. Real database tests cover mandate action/resource array round trips together with decision, audit, outbox, and idempotency JSON payloads.

## Idempotency

An idempotency record is scoped by tenant, environment, operation scope, and caller key. It stores the canonical request fingerprint and response body. Reusing a key with different input is a conflict. The domain state, audit event, outbox message, and idempotency record commit in the same transaction.

A restart test proves that replay after closing and recreating the connection pool returns the original resource without duplicating state, audit events, or outbox messages.

Response-status and header replay remain a follow-up hardening item; the current routes have deterministic success status codes, while every retry receives its own current `X-Request-Id` header.

## Immutable records

Authorization decisions, signed receipts, and audit events are insert-only. A decision preserves the requested `mandateId` even when policy returns `MANDATE_NOT_FOUND`; that field is therefore not a mandate foreign key, while receipt issuance still requires a real allowed decision and active mandate. PostgreSQL triggers reject update and delete attempts.

## Credential storage

Raw API credentials are never written to PostgreSQL. Bootstrap composition derives and stores only:

- SHA-256 lookup hash of the configured high-entropy secret;
- safe prefix and last four characters;
- exact scopes;
- tenant and environment ownership;
- active/revoked status and lifecycle timestamps.

Successful authentication advances `lastUsedAt` atomically. If revocation or expiry wins between credential lookup and the atomic update, authentication fails with the same safe `401` used for an unknown key.

## Bootstrap behavior

At startup in PostgreSQL mode, Mandate-API ensures the configured tenant and credential ID exist. Configuration can rotate the secret and scopes while the stored credential is active. A revoked bootstrap credential is not silently reactivated; recovery requires a deliberate new credential ID or database administration procedure.

## Outbox

The outbox row is inserted with the domain transaction. External delivery is not performed inside the authorization request. Claim/lease/retry/dead-letter worker execution is the next persistence subphase.
