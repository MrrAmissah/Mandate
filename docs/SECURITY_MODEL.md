# Security model

## 1. Security objective

Mandate-API must prevent an agent, client, tenant, or attacker from expanding delegated authority beyond the exact scope approved by the principal.

## 2. Primary threats

### Confused deputy

A valid client causes an agent or tool adapter to act on a resource outside the principal's intended scope.

Controls: exact agent binding, canonical resources, explicit action allowlists, deny precedence, tenant isolation, and context-bound decisions.

### Approval authority spoofing

A caller submits an arbitrary human identifier or uses a valid API credential that was never authorized to decide the approval.

Controls: durable approver identities, explicit credential-to-approver bindings, a dedicated `approvals:decide` scope, active assignment ownership, immutable assignment-time eligibility snapshots, server-derived decision attribution, database-enforced eligibility, and immutable terminal decision evidence. Caller-supplied `decidedBy` is not accepted by the v0.8.0 approval decision contract.

### Approval privilege expansion

A group is changed after a sensitive request is assigned and a newly added member silently gains authority over that already-pending request.

Controls: group eligibility is snapshotted when the assignment is created. Later membership additions affect future assignments only. Emergency authority removal is performed by disabling the approver identity or credential binding, or by explicitly cancelling/reassigning the pending approval.

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

Controls: tenant included in every query, tenant-scoped uniqueness, cross-tenant `404`, authorization scopes, and isolation tests.

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

Approval operations deliberately separate three authorities:

- `approvers:write` administers approver identities, credential bindings, groups, and memberships;
- `approvals:write` requests, reassigns, and cancels approvals;
- `approvals:decide` permits an authenticated credential to attempt a decision, which succeeds only when that credential resolves to an active approver identity contained in the active assignment's snapshotted eligibility set.

Implemented API scopes include:

```text
mandates:read
mandates:write
authorizations:read
authorizations:write
approvals:read
approvals:write
approvals:decide
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

Decision attribution is derived from authentication and persisted as `decided_by_approver_id`; the legacy free-text `decided_by` field is retained only for compatibility with pre-v0.8 historical rows and is not authoritative for new decisions. PostgreSQL uses a deferred constraint trigger to reject a `PENDING → APPROVED|REJECTED` commit unless the deciding approver is active and eligible under the active assignment.

## 5. Data minimization

Mandate-API stores policy-relevant metadata and hashes by default. It should not store full prompts, email bodies, repository files, or tool outputs unless a tenant deliberately uses a future encrypted evidence feature.

## 6. Cryptography

- Ed25519 remains the preferred initial receipt-signing algorithm.
- Canonical payload bytes are versioned and covered completely by the signature.
- Private keys never appear in API responses, logs, database plaintext, or source control.
- Key rotation preserves old public keys for verification.
- Hashes use SHA-256 initially and include an algorithm prefix.
- Webhook signatures use a separate tenant endpoint secret and timestamped HMAC construction.

## 7. Retention and deletion

Tenants may configure retention for operational objects, but security audit records, approval authority history, assignment snapshots, and receipts require explicit legal/product policy. Deletion must not leave unverifiable dangling references without a tombstone or retained minimal metadata.

## 8. Security test gates

Before public preview, automated tests must cover:

- cross-tenant reads and mutations;
- API-key revocation and rotation;
- mandate expiry and revocation races;
- last-use concurrency;
- approval double-consumption;
- caller inability to spoof approval decision identity;
- unassigned and ineligible approval decisions;
- assignment-time group snapshots and late-member rejection;
- approver/binding disable behavior;
- cancellation and reassignment precedence;
- concurrent approval decisions with exactly one terminal winner;
- PostgreSQL rejection of legacy free-text decision commits without authenticated approver evidence;
- immutable assignment eligibility and terminal authority history;
- authorization replay;
- idempotency concurrency and substitution;
- resource wildcard edge cases;
- malformed and oversized requests;
- receipt canonicalization and tampering;
- signing-key rotation and unknown keys;
- webhook signature validation and replay window when webhooks are introduced;
- failure behavior when storage or signing dependencies are unavailable.
