<p align="center">
  <img src="./assets/mandate-logo.png" alt="Mandate-API logo" width="160" />
</p>

# Mandate-API

**Mandate-API is a provider-independent trust layer for AI agents: delegated authorization, approval gates, and cryptographically signed action receipts.**

It answers two questions ordinary application authorization does not answer well:

1. What may this specific agent do for this specific task, resource, and time window?
2. What verifiable evidence records the authority, decision, and execution outcome?

## Current milestone: exact idempotency replay

Phase 2D makes committed mutation retries deterministic across process and PostgreSQL restarts.

Implemented now:

- scoped mandates with expiry, revocation, resource boundaries, deny precedence, and use limits;
- deterministic `ALLOW`, `DENY`, and `REQUIRE_APPROVAL` decisions;
- exact, single-use human approvals;
- Ed25519-signed action receipts and verification;
- tenant and `test`/`live` environment isolation at the API/store boundary;
- route-level API credential scopes;
- high-entropy API credential generation with hash-only durable records;
- payload-bound idempotency;
- atomic domain, audit-event, and outbox writes;
- cursor-paginated mandate, approval, decision, and receipt collections;
- tenant-aware PostgreSQL persistence with immutable decisions, receipts, audit events, and outbox attempts;
- connection-pool runtime composition with one client per transaction;
- stored credential authentication with revocation-race protection;
- explicit JSONB serialization for arrays and structured payloads;
- ordered migrations protected by one 64-bit PostgreSQL advisory lock;
- exact-handler outbox claims using `FOR UPDATE SKIP LOCKED`;
- committed leases, stale-lease recovery, late-worker rejection, retry, and dead-letter transitions;
- canonical JSON response bytes;
- persisted original success status and stable application headers for supported idempotent mutations;
- retry-specific request IDs with byte-identical replayed bodies;
- real PostgreSQL restart, isolation, concurrency, receipt, approval, outbox, and idempotency replay tests.

Memory mode remains available for local experiments. Live environments require PostgreSQL, explicit scopes, a non-default API key, and persistent receipt-signing keys.

The outbox dispatcher is currently a library boundary. The API does not start a worker or register webhook, email, Slack, or connector handlers by default.

## Run locally

```bash
cp .env.example .env
export MANDATE_API_KEY=local-development-only
npm test
npm start
```

The API starts on `http://localhost:8787`.

## Core flow

```text
Principal defines authority
          ↓
Agent proposes an action
          ↓
Mandate-API authenticates the tenant and evaluates policy
          ↓
ALLOW / DENY / REQUIRE_APPROVAL
          ↓
Tool executes only after ALLOW
          ↓
Mandate-API issues a signed action receipt
```

## Example mandate

```json
{
  "principalId": "user_prince",
  "agentId": "agent_coder",
  "purpose": "Inspect a repository and open a draft pull request",
  "resources": ["github:MrrAmissah/demo-api"],
  "allowedActions": [
    "repository.read",
    "branch.create",
    "commit.create",
    "pull_request.create_draft"
  ],
  "deniedActions": [
    "pull_request.merge",
    "repository.settings.*"
  ],
  "approvalRequiredActions": ["commit.create"],
  "validUntil": "2030-01-01T00:00:00Z",
  "maxUses": 20
}
```

## API surface

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/.well-known/mandate-keys` | Public receipt verification keys |
| `POST`, `GET` | `/v1/mandates` | Create or list mandates |
| `GET` | `/v1/mandates/:id` | Retrieve a mandate |
| `POST` | `/v1/mandates/:id/revoke` | Revoke a mandate |
| `POST`, `GET` | `/v1/approvals` | Request or list approvals |
| `GET` | `/v1/approvals/:id` | Retrieve an approval |
| `POST` | `/v1/approvals/:id/decide` | Approve or reject |
| `POST` | `/v1/authorize` | Evaluate an agent action |
| `GET` | `/v1/decisions`, `/v1/decisions/:id` | List or retrieve immutable decisions |
| `POST`, `GET` | `/v1/receipts` | Issue or list signed receipts |
| `GET` | `/v1/receipts/:id` | Retrieve a receipt |
| `POST` | `/v1/receipts/verify` | Verify a receipt signature |

See [`openapi.yaml`](./openapi.yaml) for the current contract.

## Documentation

- [Product blueprint](./docs/PRODUCT_BLUEPRINT.md)
- [API conventions](./docs/API_CONVENTIONS.md)
- [Idempotency and HTTP replay](./docs/IDEMPOTENCY.md)
- [Target architecture](./docs/ARCHITECTURE.md)
- [Security model](./docs/SECURITY_MODEL.md)
- [Persistence and transaction contract](./docs/PERSISTENCE.md)
- [Transactional outbox execution](./docs/OUTBOX.md)
- [Delivery roadmap](./docs/ROADMAP.md)
- [Database migrations](./migrations/)
- [Project assets](./assets/)

## Security invariants

- Explicit deny rules override every allow rule.
- Cross-tenant access returns the same result as a missing object.
- An allowed decision, mandate-use increment, approval consumption, audit event, and outbox row belong to one transaction.
- The final mandate use and an approved approval can each be consumed only once under concurrency.
- Receipt issuance requires a stored `ALLOW` decision and an active underlying mandate.
- Receipt signatures cover every receipt field except the signature itself.
- Raw generated API credentials are displayed once and are not part of the durable credential record.
- Authorization decisions, receipts, audit events, and outbox attempts are immutable in PostgreSQL.
- An outbox worker may complete only the exact unexpired lease it owns.
- Unknown idempotency operation scopes are rejected instead of receiving guessed HTTP metadata.

## Not production-ready yet

PostgreSQL mode is restart-safe for the implemented state, but the platform is not yet ready for consequential live agent actions. Persistent signing-key rotation, worker-process composition, external delivery handlers, operational migration role separation, metrics, backup/restore, dead-letter operations, clock-skew policy, idempotency retention cleanup, and deployment runbooks remain open.
