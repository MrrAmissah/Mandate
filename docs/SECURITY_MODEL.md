# Security model

## 1. Security objective

Mandate-API must prevent an agent, client, tenant, or attacker from expanding delegated authority beyond the exact scope approved by the principal.

## 2. Primary threats

### Confused deputy

A valid client causes an agent or tool adapter to act on a resource outside the principal's intended scope.

Controls: exact agent binding, canonical resources, explicit action allowlists, deny precedence, tenant isolation, and context-bound decisions.

### Approval replay

One human approval is reused for multiple actions.

Controls: approval-to-request fingerprint binding, single-use consumption, transaction locking, expiry, and immutable consumption reference.

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

API credentials authenticate the calling application, not the agent or principal by themselves. The caller must supply stable external principal and agent identities that the tenant has registered or attested.

Credential scopes will separate operations such as:

```text
mandates:read
mandates:write
authorizations:write
approvals:read
approvals:decide
receipts:issue
receipts:verify
audit:read
webhooks:write
```

High-risk operations may require separate credentials or interactive OAuth later.

## 4. Data minimization

Mandate-API stores policy-relevant metadata and hashes by default. It should not store full prompts, email bodies, repository files, or tool outputs unless a tenant deliberately uses a future encrypted evidence feature.

## 5. Cryptography

- Ed25519 remains the preferred initial receipt-signing algorithm.
- Canonical payload bytes are versioned and covered completely by the signature.
- Private keys never appear in API responses, logs, database plaintext, or source control.
- Key rotation preserves old public keys for verification.
- Hashes use SHA-256 initially and include an algorithm prefix.
- Webhook signatures use a separate tenant endpoint secret and timestamped HMAC construction.

## 6. Retention and deletion

Tenants may configure retention for operational objects, but security audit records and receipts require explicit legal/product policy. Deletion must not leave unverifiable dangling references without a tombstone or retained minimal metadata.

## 7. Security test gates

Before public preview, automated tests must cover:

- cross-tenant reads and mutations;
- API-key revocation and rotation;
- mandate expiry and revocation races;
- last-use concurrency;
- approval double-consumption;
- authorization replay;
- idempotency concurrency and substitution;
- resource wildcard edge cases;
- malformed and oversized requests;
- receipt canonicalization and tampering;
- signing-key rotation and unknown keys;
- webhook signature validation and replay window;
- failure behavior when storage or signing dependencies are unavailable.
