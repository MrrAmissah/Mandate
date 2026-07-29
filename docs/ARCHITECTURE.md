# Target architecture

## 1. Design principles

- default deny;
- deterministic policy evaluation;
- immutable security decisions;
- transactional state transitions;
- explicit tenant and environment boundaries;
- cryptographic receipts with rotatable keys;
- append-only audit history;
- provider-independent core with thin adapters;
- no model call in the authorization critical path;
- graceful degradation that fails closed for protected actions.

## 2. Logical components

```text
Client / Agent Runtime
        |
        v
API Edge
  authentication, tenant resolution, limits, request IDs
        |
        v
Application Services
  Mandates | Authorizations | Approvals | Attempts | Receipts
        |
        +----------------------+
        v                      v
Policy Engine              Signing Service
        |                      |
        +----------+-----------+
                   v
             PostgreSQL
  state, revisions, idempotency, audit events, outbox
                   |
                   v
            Async Workers
  webhooks, expiry, retention, exports, connector verification
```

## 3. API edge

Responsibilities:

- TLS termination in the deployment platform;
- credential parsing and authentication;
- tenant and environment resolution;
- request-size and rate limits;
- request ID validation;
- API-version routing;
- consistent error mapping;
- no direct domain-state mutation.

## 4. Application services

Each service owns its state transitions but shares a transaction boundary through repositories or a unit of work.

### Mandate service

Creates, activates, revokes, expires, and queries mandates. Compiles stored patterns into an evaluation-ready representation where useful.

### Authorization service

Runs the deterministic policy order, consumes approval and use capacity atomically, writes the decision, and emits an audit/outbox event in one database transaction.

### Approval service

Creates exact review payloads, enforces approver policy, records decisions, expires requests, and guarantees single-use consumption by default.

### Action-attempt service

Reserves a decision for one intended execution, tracks execution lifecycle, enforces retry policy, and prevents receipt duplication.

### Receipt service

Validates execution evidence, builds a canonical receipt payload, requests a signature, stores the immutable receipt, and exposes verification.

### Audit service

Records normalized security events with tenant sequence numbers, actor details, object references, request ID, and redacted metadata.

## 5. Policy engine

The policy engine is a pure deterministic module. Given the same mandate revision, request, context snapshot, approval state, and evaluation time, it produces the same preliminary result.

It must not:

- query external services;
- call a language model;
- mutate state;
- silently ignore unknown constraints;
- perform network I/O.

State reservation and immutable decision writing happen around the pure evaluation inside a transaction.

## 6. Persistence model

Initial production datastore: PostgreSQL.

Core tables:

- `tenants`
- `api_credentials`
- `principals`
- `agents`
- `mandates`
- `mandate_revisions`
- `approvals`
- `authorization_decisions`
- `action_attempts`
- `receipts`
- `signing_keys`
- `idempotency_records`
- `audit_events`
- `outbox_messages`
- `webhook_endpoints`
- `webhook_deliveries`

Important constraints:

- tenant ID included in every private primary or unique access path;
- uniqueness for idempotency scope and key;
- immutable decision and receipt rows;
- approval consumption references exactly one decision;
- action attempt reserves a decision according to its reuse policy;
- mandate use counts changed in the same transaction as an allowed decision;
- outbox event inserted in the same transaction as its domain transition.

## 7. Signing keys

Developer mode may generate ephemeral Ed25519 keys. Production uses a managed key provider or protected persistent key material.

Required lifecycle:

```text
PENDING -> ACTIVE -> RETIRING -> RETIRED -> COMPROMISED
```

Verification remains possible with retired public keys. A compromised key is published as such; existing receipts are not silently rewritten.

Public discovery should converge on JWKS-compatible output while retaining receipt algorithm and key ID inside every signed payload.

## 8. Audit and outbox

Every security-relevant transaction writes:

1. current domain state;
2. immutable audit event; and
3. outbox message for external delivery.

Workers claim outbox rows with leases, retry transient failures, dead-letter exhausted deliveries, and preserve attempt history.

## 9. Deployment shape

The first deployable version may run as one stateless API service plus one worker process sharing PostgreSQL. Logical module boundaries should be maintained before splitting services.

```text
mandate-api       HTTP and synchronous domain operations
mandate-worker    webhooks, expiry, retention, and verification jobs
postgres          durable source of truth
managed KMS       receipt signing keys
```

## 10. Observability

Minimum telemetry:

- request count, latency, and status by operation;
- authorization outcomes and reason codes;
- approval age and decision latency;
- transaction conflicts and idempotency replays;
- signing failures;
- webhook queue depth and delivery outcomes;
- database pool and transaction health;
- tenant-scoped audit search without exposing payload secrets.

Logs must be structured and include request ID, tenant ID, environment, operation, and object IDs. Secrets, full authorization headers, private keys, raw prompts, and arbitrary tool payloads must not be logged.

## 11. Failure behavior

| Failure | Required behavior |
|---|---|
| Database unavailable | Protected action cannot be authorized |
| Signing service unavailable | Authorization may complete; receipt issuance fails safely and can retry through an attempt record |
| Webhook destination unavailable | Domain transaction succeeds; delivery retries asynchronously |
| Unknown constraint | Deny with explicit reason |
| Stale mandate revision | Reject or evaluate only the revision explicitly referenced by the request |
| Concurrent last use | Exactly one transaction may consume it |
| Concurrent approval use | Exactly one decision may consume it |
