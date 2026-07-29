<p align="center">
  <img src="./assets/mandate-logo.png" alt="Mandate-API logo" width="160" />
</p>

# Mandate-API

**Mandate-API is a provider-independent trust layer for AI agents: delegated authorization, approval gates, single-use execution reservations, and cryptographically signed action receipts.**

It answers three questions ordinary application authorization does not answer well:

1. What may this specific agent do for this task, resource, and time window?
2. Which caller acquired the one execution opportunity represented by an authorization decision?
3. What verifiable evidence records the authority, execution, and outcome?

## Current milestone: single-use execution reservations

Phase 3A prevents an `ALLOW` decision from functioning as an indefinitely reusable execution token.

Implemented now:

- scoped mandates with expiry, revocation, resource boundaries, deny precedence, and use limits;
- deterministic `ALLOW`, `DENY`, and `REQUIRE_APPROVAL` decisions;
- exact, single-use human approvals;
- one action-attempt reservation per allowed decision;
- bounded reservation windows and dedicated attempt scopes;
- Ed25519-signed action receipts;
- persistent signing-key rotation, retirement, revocation, discovery, and historical verification;
- tenant and `test`/`live` isolation;
- high-entropy API credentials with hash-only durable records;
- payload-bound idempotency with exact committed HTTP replay;
- atomic domain, audit-event, and outbox writes;
- cursor-paginated resource collections;
- tenant-aware PostgreSQL persistence;
- serializable transactions and one-winner concurrency tests;
- leased outbox claims, retries, stale-lease recovery, and dead-letter transitions;
- real PostgreSQL restart, isolation, concurrency, receipt, approval, outbox, key-rotation, and replay tests.

Memory mode remains available for local experiments. Live environments require PostgreSQL, explicit scopes, a non-default API key, an explicit persistent key ID, and persistent receipt-signing keys.

The outbox dispatcher remains a library boundary. The API does not automatically register webhook, email, Slack, or connector handlers.

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
Mandate-API evaluates policy
          ↓
ALLOW / DENY / REQUIRE_APPROVAL
          ↓
Caller reserves the ALLOW decision once
          ↓
Tool executes within the reservation window
          ↓
Mandate-API records completion and signs a receipt
```

Attempt completion and receipt binding are Phase 3B. A current `RESERVED` attempt is not proof that execution started or succeeded.

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
| `GET` | `/.well-known/mandate-keys` | Active and retired public verification keys |
| `POST`, `GET` | `/v1/mandates` | Create or list mandates |
| `GET` | `/v1/mandates/:id` | Retrieve a mandate |
| `POST` | `/v1/mandates/:id/revoke` | Revoke a mandate |
| `POST`, `GET` | `/v1/approvals` | Request or list approvals |
| `GET` | `/v1/approvals/:id` | Retrieve an approval |
| `POST` | `/v1/approvals/:id/decide` | Approve or reject |
| `POST` | `/v1/authorize` | Evaluate an agent action |
| `GET` | `/v1/decisions`, `/v1/decisions/:id` | List or retrieve immutable decisions |
| `POST`, `GET` | `/v1/action-attempts` | Reserve or list execution attempts |
| `GET` | `/v1/action-attempts/:id` | Retrieve an action attempt |
| `POST`, `GET` | `/v1/receipts` | Issue or list signed receipts |
| `GET` | `/v1/receipts/:id` | Retrieve a receipt |
| `POST` | `/v1/receipts/verify` | Verify using active or retired registered keys |

See [`openapi.yaml`](./openapi.yaml) for the stable core contract and [`openapi/action-attempts.yaml`](./openapi/action-attempts.yaml) for the Phase 3A resource contract.

## Documentation

- [Product blueprint](./docs/PRODUCT_BLUEPRINT.md)
- [API conventions](./docs/API_CONVENTIONS.md)
- [Action attempts](./docs/ACTION_ATTEMPTS.md)
- [Receipt verification](./docs/RECEIPT_VERIFICATION.md)
- [Signing-key operations](./docs/SIGNING_KEYS.md)
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
- Cross-tenant access is indistinguishable from a missing object.
- An allowed decision, mandate-use increment, approval consumption, audit event, and outbox row belong to one transaction.
- The final mandate use and an approved approval can each be consumed only once under concurrency.
- One allowed decision can be reserved by at most one action attempt.
- A reservation is not execution success and cannot itself prove a tool outcome.
- Receipt signatures cover every receipt field except the signature itself.
- Active and retired keys verify historical receipts; revoked keys do not.
- Raw generated API credentials are displayed once and are not stored durably.
- Authorization decisions, receipts, audit events, and outbox attempts are immutable in PostgreSQL.
- An outbox worker may complete only the exact unexpired lease it owns.
- Unknown idempotency operation scopes are rejected instead of receiving guessed HTTP metadata.

## Not production-ready yet

PostgreSQL mode is restart-safe for the implemented state, but the platform is not yet ready for consequential autonomous actions. Attempt completion and receipt binding, expiry processing, external delivery handlers, operational migration-role separation, metrics, backup/restore, dead-letter operations, clock-skew policy, idempotency retention cleanup, and deployment runbooks remain open.
