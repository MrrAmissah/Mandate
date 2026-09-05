# Security model

## 1. Security objective

Mandate-API must prevent an agent, client, tenant, or attacker from expanding delegated authority beyond the exact scope approved by the principal.

## 2. Primary threats

### Confused deputy

A valid client causes an agent or tool adapter to act on a resource outside the principal's intended scope.

Controls: exact agent binding, canonical resources, explicit action allowlists, deny precedence, tenant isolation, and context-bound decisions.

### Approval authority spoofing

A caller submits an arbitrary human identifier or uses a valid API credential that was never authorized to decide the approval.

Controls: durable approver identities, explicit credential-to-approver bindings, a dedicated `approvals:decide` scope, active assignment ownership, immutable assignment-time eligibility snapshots, server-derived decision attribution, immutable `approval.decided` audit evidence, and PostgreSQL commit-time verification of the exact active credential binding. Caller-supplied `decidedBy` is not accepted by the v0.9.0 approval decision contract.

### Approval-inbox privilege confusion

A caller with broad administrative approval-read access attempts to treat the tenant approval collection as proof that it may act as a human approver, or requests another approver's work by guessing an approval ID.

Controls: the inbox has a separate `approval_inbox:read` scope and derives its current subject from the authenticated credential. Visibility additionally requires an active credential binding, active approver identity, current active assignment, immutable assignment-time eligibility, and a durable `PENDING` approval. `GET /v1/approval-inbox/{id}` returns the same not-found shape when the item is outside current approver authority. Administrative `approvals:read` is not sufficient.

### Stale approval-inbox authority

An approval is reassigned, decided, cancelled, or becomes overdue after a client has rendered it from a previous inbox response and the client attempts to act on the stale view.

Controls: the inbox is explicitly a derived read model, not an authorization token. Reassignment removes old assignment authority from future reads; terminal states are excluded. `ACTIONABLE` excludes overdue requests using PostgreSQL time, while `PENDING` may expose overdue-but-unmaterialized records only with `actionable=false`. The decision endpoint resolves live identity/assignment eligibility again, and PostgreSQL independently validates the terminal transition at commit.

### Approval privilege expansion

A group is changed after a sensitive request is assigned and a newly added member silently gains authority over that already-pending request.

Controls: group eligibility is snapshotted when the assignment is created. Later membership additions affect future assignments only. Emergency authority removal is performed by disabling the approver identity or credential binding, or by explicitly cancelling/reassigning the pending approval.

### Ambiguous authority input

A request supplies both a current-credential selector and a different explicit credential ID, hoping one layer validates one field while another layer acts on the other.

Controls: JSON ingress rejects requests that contain both `bindCurrentCredential` and `credentialId` before authority resolution or idempotency execution. The API never silently ignores one authority selector in favor of the other.

### Approval replay

One human approval is reused for multiple actions.

Controls: approval-to-request binding, single-use consumption, transaction locking, expiry/cancellation state, immutable consumption reference, and one active assignment per pending approval.

### Authorization replay

One `ALLOW` decision is reused to execute multiple independent actions.

Controls: action-attempt reservation, decision reuse policy, idempotency, and short authorization validity windows.

### Idempotency substitution

An attacker reuses an idempotency key with a different request.

Controls: canonical payload fingerprint, tenant/operation scoping, atomic insert, and `409 IDEMPOTENCY_CONFLICT`.

### Tenant data leakage

A credential accesses another tenant's object by guessing its ID.

Controls: tenant included in every query, tenant-scoped uniqueness, cross-tenant `404`, authorization scopes, and isolation tests. Approval-inbox queries additionally join tenant/environment on every binding, identity, eligibility, assignment, and approval relation rather than filtering only at the final object.

### Receipt forgery or ambiguity

A receipt is modified, signed with an unknown key, or interpreted differently by two verifiers.

Controls: deterministic canonicalization, versioned payload schema, key ID and algorithm binding, managed keys, immutable storage, and public key discovery.

### Prompt injection through tool content

Retrieved content instructs an agent to call a tool outside user intent.

Controls: Mandate-API never trusts retrieved instructions as authority. Tool calls remain bound to a pre-existing mandate, canonical action, resource, and optional constraints. A future tool-call firewall may inspect intent mismatch as an additional layer.

### Secret leakage

Credentials, key material, or tool payloads enter logs or receipts.

Controls: structured allowlisted logging, secret redaction, hashes rather than raw execution payloads, protected key management, and payload size limits.

## 3. Authentication and authorization

API credentials authenticate the calling application. They do not become human approver identities merely because they are valid credentials.

Approval operations deliberately separate four authorities:

- `approvers:write` administers approver identities, credential bindings, groups, and memberships;
- `approvals:write` requests, reassigns, and cancels approvals;
- `approvals:decide` permits an authenticated credential to attempt a decision, which succeeds only when that credential resolves to an active approver identity contained in the active assignment's snapshotted eligibility set;
- `approval_inbox:read` permits a current-authority approver inbox projection and does not grant broad tenant approval administration.

`approvals:read` remains a separate administrative read authority. Possessing either read scope does not imply `approvals:decide`.

Implemented API scopes include:

```text
mandates:read
mandates:write
authorizations:read
authorizations:write
approvals:read
approvals:write
approvals:decide
approval_inbox:read
approvers:read
approvers:write
action_attempts:read
action_attempts:write
receipts:read
receipts:write
```

Future SSO/OIDC may add another binding mechanism to the same durable approver identity. It must not redefine an API credential itself as the human identity.

## 4. Approval authority lifecycle

An approver identity is tenant/environment scoped and may be disabled without rewriting historical decisions. Credential bindings and group memberships preserve lifecycle history instead of deleting prior authority records.

A direct assignment snapshots one approver. A group assignment snapshots the group's active members at assignment time. Eligibility rows are append-only/immutable. Reassignment terminates the previous assignment and creates a new snapshot rather than mutating the old one.

Decision attribution is derived from authentication and persisted as `decided_by_approver_id`; the legacy free-text `decided_by` field is retained only for compatibility with pre-v0.8 historical rows and is not authoritative for new decisions.

Migration `011_approval_assignments` establishes the durable identity, binding, group, assignment, eligibility and cancellation model. Migration `012_approval_decision_credential_evidence` strengthens the PostgreSQL final arbiter: a deferred constraint trigger rejects `PENDING → APPROVED|REJECTED` unless the deciding approver is active and eligible under the active assignment **and** the same transaction contains an immutable `approval.decided` audit event whose credential ID resolves through an active credential-to-approver binding and an active, unrevoked, unexpired API credential at decision time. Application code therefore cannot make a terminal approval durable merely by writing an approver ID.

## 5. Approval inbox security model

The v0.9 inbox is intentionally not stored as another authority table. It is derived from the durable authority graph so there is no secondary inbox ACL to drift from assignment truth.

A list or item is visible only when:

1. the authenticated credential has `approval_inbox:read`;
2. that exact credential has an active binding to an active approver identity;
3. the approver identity appears in the immutable eligibility rows of an `ACTIVE` assignment;
4. that assignment is the current active assignment for the approval; and
5. the approval itself is durably `PENDING`.

The PostgreSQL list performs a bounded `limit + 1` keyset query ordered by `(requested_at, id)`. Migration `013_approval_inbox_indexes` adds an approver-first eligibility index and a pending-approval ordering index. API readiness requires migration 013, so production does not advertise the inbox on a schema missing that bounded-read posture.

`ACTIONABLE` is a convenience projection, not a new approval state. PostgreSQL `clock_timestamp()` determines whether a pending request is overdue. An overdue request can appear under `state=PENDING` for inspection while the later expiry process has not materialized a terminal state, but it is returned with `actionable=false` and cannot gain authority from that response. The decision write path remains authoritative and will continue to be hardened by the approval-expiry lifecycle in Phase 4C.

## 6. Data minimization

Mandate-API stores policy-relevant metadata and hashes by default. It should not store full prompts, email bodies, repository files, or tool outputs unless a tenant deliberately uses a future encrypted evidence feature.

Inbox responses expose only the approval fields required to understand the requested action plus the current assignment source and current approver identity. They do not expose unrelated tenant approvals, credential secrets, group membership history, or immutable audit bodies.

## 7. Cryptography

- Ed25519 remains the preferred initial receipt-signing algorithm.
- Canonical payload bytes are versioned and covered completely by the signature.
- Private keys never appear in API responses, logs, database plaintext, or source control.
- Key rotation preserves old public keys for verification.
- Hashes use SHA-256 initially and include an algorithm prefix.
- Webhook signatures use a separate tenant endpoint secret and timestamped HMAC construction.

## 8. Retention and deletion

Tenants may configure retention for operational objects, but security audit records, approval authority history, assignment snapshots, and receipts require explicit legal/product policy. Deletion must not leave unverifiable dangling references without a tombstone or retained minimal metadata.

The inbox itself adds no durable record and therefore has no independent retention policy; it reflects retained approval and authority state.

## 9. Security test gates

Before public preview, automated tests must cover:

- cross-tenant reads and mutations;
- API-key revocation and rotation;
- mandate expiry and revocation races;
- last-use concurrency;
- approval double-consumption;
- caller inability to spoof approval decision identity;
- ambiguous credential-binding selector rejection;
- unassigned and ineligible approval decisions;
- assignment-time group snapshots and late-member rejection;
- approver/binding disable behavior;
- cancellation and reassignment precedence;
- concurrent approval decisions with exactly one terminal winner;
- PostgreSQL rejection of legacy free-text decision commits without authenticated approver evidence;
- PostgreSQL rejection of apparently eligible decisions that omit exact credential-backed audit evidence;
- immutable assignment eligibility and terminal authority history;
- dedicated inbox scope enforcement separate from `approvals:read`;
- inbox denial for unbound credentials and ineligible approvers;
- tenant/current-authority-safe inbox item 404 behavior;
- reassignment removing prior inbox visibility;
- terminal approvals disappearing from the inbox;
- overdue pending approvals never appearing as actionable;
- bounded keyset pagination and migration-013 index presence in real PostgreSQL;
- authorization replay;
- idempotency concurrency and substitution;
- resource wildcard edge cases;
- malformed and oversized requests;
- receipt canonicalization and tampering;
- signing-key rotation and unknown keys;
- webhook signature validation and replay window when webhooks are introduced;
- failure behavior when storage or signing dependencies are unavailable.
