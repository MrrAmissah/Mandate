<p align="center">
  <img src="./assets/mandate-logo.png" alt="Mandate-API logo" width="160" />
</p>

# Mandate-API

**Mandate-API is a provider-independent trust layer for AI agents: delegated authorization, approval gates, and signed action receipts.**

Mandate-API answers two questions that ordinary application authorization does not answer well:

1. What may this specific agent do for this specific task, resource, and time window?
2. What verifiable evidence proves which authority allowed the action and what the agent executed?

## Current milestone: API foundation

The merged domain kernel proves the trust boundary. The current foundation phase hardens API invariants and defines the complete v1 product, architecture, security model, and delivery roadmap before durable persistence is introduced.

- Scoped mandates for an agent, principal, actions, resources, validity window, and use limit
- Explicit deny rules that override broad allows
- Human approval escalation for selected actions
- Revocation and expiry checks
- Deterministic ALLOW, DENY, or REQUIRE_APPROVAL decisions
- Ed25519-signed action receipts
- Public verification-key endpoint
- Payload-bound idempotency for state-changing operations
- Single-use approval consumption
- Request IDs and consistent error correlation
- Canonical JSON hashing for receipts and request fingerprints
- Zero runtime dependencies
- Automated domain, cryptographic, and HTTP tests

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
Principal creates mandate
          ↓
Agent proposes action
          ↓
Policy engine evaluates scope
          ↓
ALLOW / DENY / REQUIRE_APPROVAL
          ↓
Tool executes only after ALLOW
          ↓
Mandate issues signed action receipt
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
| `GET` | `/.well-known/mandate-keys` | Public receipt verification key |
| `POST` | `/v1/mandates` | Create a mandate |
| `GET` | `/v1/mandates/:id` | Read a mandate |
| `POST` | `/v1/mandates/:id/revoke` | Revoke a mandate |
| `POST` | `/v1/approvals` | Request human approval |
| `POST` | `/v1/approvals/:id/decide` | Approve or reject |
| `POST` | `/v1/authorize` | Evaluate an agent action |
| `POST` | `/v1/receipts` | Issue a signed execution receipt |
| `GET` | `/v1/receipts/:id` | Retrieve a receipt |
| `POST` | `/v1/receipts/verify` | Verify a receipt signature |

See [`openapi.yaml`](./openapi.yaml) for the implemented contract and [`docs/`](./docs/) for the target v1 platform design.

## Documentation

- [Product blueprint](./docs/PRODUCT_BLUEPRINT.md)
- [API conventions](./docs/API_CONVENTIONS.md)
- [Target architecture](./docs/ARCHITECTURE.md)
- [Security model](./docs/SECURITY_MODEL.md)
- [Delivery roadmap](./docs/ROADMAP.md)
- [Project assets](./assets/)

## Security decisions already made

- Deny rules take precedence over allow rules.
- Receipt issuance requires a stored ALLOW decision.
- A receipt cannot be issued after the mandate has been revoked.
- Approval matching binds mandate, agent, action, and resource.
- Receipt signatures cover every receipt field except the signature itself.
- The development key is ephemeral; production must use persistent managed keys.

## Not production-ready yet

The in-memory store is intentional for Milestone 0. It must be replaced before deployment with durable PostgreSQL storage and transactional use-count enforcement. Authentication is currently a single service API key and must become tenant-aware credentials.

## Next milestone

The next implementation phase is the durable multi-tenant core: PostgreSQL persistence, test/live environments, scoped and rotatable credentials, atomic counters and approval consumption, append-only audit events, and a transactional outbox. The complete sequence and exit gates are maintained in the [delivery roadmap](./docs/ROADMAP.md).
