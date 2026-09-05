# Persistence and transaction contract

## Current status

PostgreSQL is an active runtime mode. Set `MANDATE_STORE=postgres`, configure `DATABASE_URL`, apply migrations with `npm run migrate`, and then start the API.

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

## Approval authority persistence

Migration `011_approval_assignments` makes human decision authority a durable tenant/environment-scoped model instead of caller-supplied text.

The authority graph is stored in separate tables:

- `approver_identities` — stable approver domain identities with active/disabled lifecycle;
- `approver_credential_bindings` — revocable bindings from authenticated API credentials to approver identities;
- `approver_groups` — named assignment groups;
- `approver_group_memberships` — history-preserving active/removed membership rows;
- `approval_assignments` — history-preserving assignment ownership for an approval;
- `approval_assignment_eligibility` — immutable approver snapshots for each assignment.

One pending approval may have at most one active assignment. Direct assignments snapshot one approver. Group assignments snapshot the group's active members at assignment time, so later membership additions cannot silently gain authority over an already-pending approval.

Reassignment terminates the old assignment and creates a fresh assignment plus eligibility snapshot. Cancellation records authenticated credential evidence on the approval and terminates the active assignment. Assignment and eligibility history is preserved rather than rewritten.

For new decisions, the runtime derives the approver identity from the authenticated credential and writes `decided_by_approver_id`. The pre-existing free-text `decided_by` column remains readable only for historical compatibility; it is not authoritative for new decisions.

Migration `012_approval_decision_credential_evidence` makes PostgreSQL independently verify the complete decision proof at commit. A deferred constraint trigger rejects `PENDING → APPROVED|REJECTED` unless:

1. the approval records an authenticated approver identity and decision timestamp;
2. that approver is active and included in the active assignment's immutable eligibility snapshot;
3. the same transaction contains an immutable `approval.decided` audit event for the same approval, approver, and assignment;
4. the audit event's `credentialId` resolves through an active credential-to-approver binding for that approver; and
5. the referenced API credential is active, unrevoked, and unexpired at decision time.

This makes the database the final arbiter even if application code attempts either the legacy free-text path or a superficially eligible decision that omits exact authenticated credential evidence.

## Approval inbox read model

The approval inbox does **not** introduce another durable inbox table or copy assignment ACLs into a second authority store. It is a derived read projection over the existing authority graph.

In PostgreSQL mode, the list query joins:

```text
api credential binding
  → approver identity
  → immutable assignment eligibility
  → current active approval assignment
  → pending approval
```

Every join retains tenant/environment ownership. The exact authenticated credential ID is part of the query, so a caller cannot ask the database to render another approver's inbox by supplying an approver identifier.

The list is ordered by `(approvals.requested_at, approvals.id)` and uses keyset pagination with a database-side `limit + 1` window. Migration `013_approval_inbox_indexes` adds:

- `approval_assignment_eligibility_inbox_idx (tenant_id, environment, approver_id, assignment_id)` for current-authority lookup; and
- `approvals_pending_inbox_order_idx (tenant_id, environment, requested_at, id) WHERE status = 'PENDING'` for bounded pending work ordering.

Migration 013 changes no authority state; it is an operational read-path migration. API readiness nevertheless requires it because the v0.9 inbox should not be served in production on a schema without the intended bounded access path. Backup/recovery trust-state verification continues to require migration 012 because the 013 objects are reconstructable indexes rather than additional durable authority records.

PostgreSQL `clock_timestamp()` determines whether a pending inbox item is actionable or overdue. The `ACTIONABLE` projection excludes overdue requests. `state=PENDING` can still expose an overdue request before the separate approval-expiry lifecycle materializes a terminal state, but the item is returned with `actionable=false`.

An inbox response is never write authority. Reassignment, cancellation, decision, credential revocation, or identity disablement can invalidate a previously returned row before the client acts. The mutation path re-resolves the authority graph and PostgreSQL remains the final arbiter.

## JSONB encoding

The PostgreSQL adapter serializes every JSONB-bound value explicitly. This is required for JavaScript arrays because `node-postgres` otherwise treats them as PostgreSQL array literals rather than JSON arrays. Real database tests cover mandate action/resource array round trips together with decision, audit, outbox, and idempotency JSON payloads.

## Idempotency

An idempotency record is scoped by tenant, environment, operation scope, and caller key. It stores the canonical request fingerprint, logical response body, original success status, and stable application headers. Reusing a key with different input is a conflict. The domain state, audit event, outbox message, and idempotency record commit in the same transaction.

All JSON responses use canonical serialization, so the first committed response and a replay loaded from PostgreSQL produce byte-identical bodies even though `jsonb` does not preserve object insertion order.

A restart test proves that replay after closing and recreating the connection pool returns the original status, canonical body bytes, and stable headers without duplicating state, audit events, or outbox messages. `X-Request-Id` intentionally identifies the current retry rather than replaying the first attempt's diagnostic ID.

Migration `003_idempotency_http_metadata` derives status and stable header metadata from the exact supported mutation scope and rejects unknown scopes instead of guessing. Migration 011 extends that exact mapping for approver creation/binding, group membership, assignment/reassignment, decision, cancellation, and approver lifecycle operations.

The approval inbox is read-only and does not create idempotency records.

See [Idempotency and HTTP replay](./IDEMPOTENCY.md) for the complete contract.

## Immutable records

Authorization decisions, signed receipts, audit events, outbox attempts, dead-letter replay records, and approval-assignment eligibility snapshots are insert-only. Terminal approver binding/membership/assignment history and approval decision/cancellation evidence cannot be rewritten after termination.

The immutable `approval.decided` audit event is part of the credential-backed approval proof checked by migration 012. It is not merely an observability record.

A decision preserves the requested `mandateId` even when policy returns `MANDATE_NOT_FOUND`; that field is therefore not a mandate foreign key, while receipt issuance still requires a real allowed decision and active mandate. PostgreSQL triggers reject protected update/delete attempts.

## Credential storage

Raw API credentials are never written to PostgreSQL. Bootstrap composition derives and stores only:

- SHA-256 lookup hash of the configured high-entropy secret;
- safe prefix and last four characters;
- exact scopes;
- tenant and environment ownership;
- active/revoked status and lifecycle timestamps.

Successful authentication advances `lastUsedAt` atomically. If revocation or expiry wins between credential lookup and the atomic update, authentication fails with the same safe `401` used for an unknown key.

An API credential may be bound to a durable approver identity, but that binding does not redefine the credential as the human identity. Future OIDC/SSO can add another binding mechanism without rewriting approval history.

Authority-selector requests are also fail-closed: a JSON body containing both `bindCurrentCredential` and `credentialId` is rejected before authority resolution rather than silently choosing one field.

## Bootstrap behavior

At startup in PostgreSQL mode, Mandate-API ensures the configured tenant and credential ID exist under a serialized bootstrap lock. Configuration can rotate the secret and scopes while the stored credential is active. A revoked bootstrap credential is not silently reactivated; recovery requires a deliberate new credential ID or database administration procedure.

Memory-mode runtime bootstrap also stores a real credential record so approval binding tests exercise the same identity lifecycle rather than a special fake path.

## Recovery-critical trust state

Database backup manifests and restore verification require migration `012_approval_decision_credential_evidence` and include approver identities, credential bindings, groups, memberships, assignments, assignment eligibility, immutable audit evidence, and API-credential lifecycle state alongside mandates, approvals, decisions, receipts, idempotency, signing keys, and outbox state. The real PostgreSQL recovery drill creates and restores an actual pending group assignment to prove authority continuity rather than only verifying empty-table counts.

Migration 013 adds only reconstructable indexes and therefore does not change the recovery-critical data manifest. After restore, the normal migration path recreates those index objects before API readiness can succeed.

## Outbox

The outbox row is inserted with the domain transaction. External delivery is not performed inside the authorization request. The execution layer supports environment-scoped claims, leases, stale recovery, bounded retries, dead-letter transitions, and immutable attempt evidence. No external handler or continuously running worker is registered by default.
