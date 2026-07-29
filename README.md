<p align="center">
  <img src="./assets/mandate-logo.png" alt="Mandate-API logo" width="160" />
</p>

# Mandate-API

**Mandate-API is a provider-independent trust layer for AI agents: delegated authorization, approval gates, and cryptographically signed action receipts.**

It answers two questions ordinary application authorization does not answer well:

1. What may this specific agent do for this specific task, resource, and time window?
2. What verifiable evidence records the authority, decision, and execution outcome?

## Current milestone: durable-core foundation

Phase 2A establishes the transaction and persistence contract without falsely claiming that the runtime is already production-durable.

Implemented now:

- scoped mandates with expiry, revocation, resource boundaries, deny precedence, and use limits;
- deterministic `ALLOW`, `DENY`, and `REQUIRE_APPROVAL` decisions;
- exact, single-use human approvals;
- Ed25519-signed action receipts and verification;
- tenant and `test`/`live` environment isolation at the API/store boundary;
- route-level API credential scopes;
- high-entropy API credential generation with hash-only durable records;
- payload-bound idempotency;
- atomic domain, audit-event, and outbox writes in the reference transaction store;
- cursor-paginated mandate, approval, decision, and receipt collections;
- a tenant-aware PostgreSQL migration with immutable decisions, receipts, and audit events;
- concurrency tests proving one winner for the final mandate use and one-time approval consumption.

The default server still uses the in-memory reference store. PostgreSQL driver wiring and real database integration tests are the Phase 2B gate.

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
- [Target architecture](./docs/ARCHITECTURE.md)
- [Security model](./docs/SECURITY_MODEL.md)
- [Persistence and transaction contract](./docs/PERSISTENCE.md)
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
- Authorization decisions, receipts, and audit events are immutable in the PostgreSQL schema.

## Not production-ready yet

The schema and transaction contract are implemented, but the current server is still backed by process memory and an ephemeral signing key unless configured otherwise. It is not restart-safe, horizontally scalable, or suitable for consequential live agent actions.

Phase 2B must wire PostgreSQL, execute migrations in CI, add restart and multi-process concurrency tests, and make hashed stored credentials the default runtime authentication path before the durable-core milestone can close.
