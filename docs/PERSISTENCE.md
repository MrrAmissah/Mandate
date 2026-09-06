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

Transactions run at `SERIALIZABLE` isolation and retry bounded serialization, deadlock, and first-writer uniqueness races. A failure at any point rolls back every step. Approval consumption is additionally protected by migration 014: if an `APPROVED` approval reaches `expires_at` before commit, PostgreSQL rejects `APPROVED → CONSUMED` even when an application host supplies an earlier local timestamp.

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

## Approval deadline persistence

Migration `014_approval_expiry` makes approval deadlines durable and database-authoritative rather than a UI/inbox observation.

It adds immutable approval evidence:

- `expired_at`;
- `expiration_reason`, currently exactly `DEADLINE_ELAPSED` for worker materialization;
- `expiration_request_id`, tying the state transition to the immutable system audit/outbox record.

`approval_assignments.status` also gains `EXPIRED`. When the worker expires an approval, any current active assignment is terminated in the same transaction with `ended_at` and `end_reason = 'APPROVAL_EXPIRED'`.

The expirable set is deliberately **both** `PENDING` and `APPROVED` approvals with `expires_at`. This matters because an approval can be validly approved before its deadline yet remain unconsumed when the deadline passes. The partial index

```text
approvals_expiring_scope_idx
(environment, tenant_id, expires_at, id)
WHERE status IN ('PENDING', 'APPROVED') AND expires_at IS NOT NULL
```

supports bounded deadline-order claims.

The approval-expiry worker selects the earliest due row in scope using PostgreSQL `clock_timestamp()` plus `FOR UPDATE SKIP LOCKED`, changes it to `EXPIRED`, terminates an active assignment, and appends `approval.expired` audit/outbox evidence in one serializable transaction. The audit record includes the approval's `previousStatus`, deadline, materialization time, reason, and assignment ID when one existed.

A deferred database transition guard independently enforces precedence:

- `PENDING → APPROVED|REJECTED` cannot commit after the deadline;
- `PENDING → CANCELLED` cannot commit after the deadline;
- a new active assignment cannot be created for an overdue approval;
- `APPROVED → CONSUMED` cannot commit after the deadline;
- only overdue `PENDING` or `APPROVED` approvals with complete immutable system evidence may become `EXPIRED`;
- an expired approval cannot retain an `ACTIVE` assignment.

Application timestamps therefore cannot override database time. Concurrent expiry workers and mutation requests serialize on the approval row; one legal state transition wins and every losing path observes or receives the resulting conflict.

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

Migration 013 changes no authority state; it is an operational read-path migration. API readiness now requires migration 014, which implies the inbox indexes are present and also ensures deadline enforcement exists before the API advertises current approval behavior.

PostgreSQL time determines whether a pending inbox item is actionable or overdue. The `ACTIONABLE` projection excludes overdue requests. `state=PENDING` can still expose an overdue request before the approval-expiry worker materializes `EXPIRED`, but the item is returned with `actionable=false`. The response is never write authority.

## JSONB encoding

The PostgreSQL adapter serializes every JSONB-bound value explicitly. This is required for JavaScript arrays because `node-postgres` otherwise treats them as PostgreSQL array literals rather than JSON arrays. Real database tests cover mandate action/resource array round trips together with decision, audit, outbox, and idempotency JSON payloads.

## Idempotency

An idempotency record is scoped by tenant, environment, operation scope, and caller key. It stores the canonical request fingerprint, logical response body, original success status, and stable application headers. Reusing a key with different input is a conflict. The domain state, audit event, outbox message, and idempotency record commit in the same transaction.

All JSON responses use canonical serialization, so the first committed response and a replay loaded from PostgreSQL produce byte-identical bodies even though `jsonb` does not preserve object insertion order.

A restart test proves that replay after closing and recreating the connection pool returns the original status, canonical body bytes, and stable headers without duplicating state, audit events, or outbox messages. `X-Request-Id` intentionally identifies the current retry rather than replaying the first attempt's diagnostic ID.

Migration `003_idempotency_http_metadata` derives status and stable header metadata from the exact supported mutation scope and rejects unknown scopes instead of guessing. Migration 011 extends that exact mapping for approver creation/binding, group membership, assignment/reassignment, decision, cancellation, and approver lifecycle operations.

The approval inbox and expiry worker do not create caller idempotency records. Expiry uses a generated `sys_approval_expiry_*` request ID as immutable system evidence and relies on the row/state transition for one-winner behavior.

See [Idempotency and HTTP replay](./IDEMPOTENCY.md) for the complete contract.

## Immutable records

Authorization decisions, signed receipts, audit events, outbox attempts, dead-letter replay records, and approval-assignment eligibility snapshots are insert-only. Terminal approver binding/membership/assignment history and approval decision/cancellation/expiry evidence cannot be rewritten after termination.

The immutable `approval.decided` audit event is part of the credential-backed approval proof checked by migration 012. The immutable `approval.expired` audit event is part of the deadline proof checked by migration 014. Neither is merely an observability record.

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

Database backup manifests and restore verification require migration `014_approval_expiry`. The critical-state manifest includes approver identities, credential bindings, groups, memberships, assignments, assignment eligibility, approval deadline evidence, immutable audit evidence, and API-credential lifecycle state alongside mandates, approvals, decisions, receipts, idempotency, signing keys, and outbox state.

Migration 013 remains reconstructable index state, but migration 014 changes durable approval rows and transition semantics, so a pre-014 backup is not accepted as current recovery proof for a post-4C runtime.

## Database-role separation

Production role policy separates migration authority from six runtime/operations identities:

- API;
- action-attempt expiry;
- approval expiry;
- outbox;
- maintenance;
- operator.

The approval-expiry role has only the tables necessary to inspect/update approvals and assignments and append audit/outbox evidence. It cannot mutate action attempts. Conversely, the action-attempt expiry role cannot mutate approvals or approval assignments. Runtime roles cannot migrate, own protected schema objects, inherit broad roles, or obtain default grants.

## Outbox

The outbox row is inserted with the domain transaction. External delivery is not performed inside the authorization request. The execution layer supports environment-scoped claims, leases, stale recovery, bounded retries, dead-letter transitions, and immutable attempt evidence. Approval expiry also emits its notification/resumption signal through this same transactional outbox rather than calling external integrations inside the expiry transaction.
