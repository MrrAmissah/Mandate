<p align="center">

  <img src="./assets/mandate-logo.PNG" alt="Mandate-API logo" width="160" />

</p>

# Mandate-API

**Delegated authorization, approval gates, and signed action receipts for AI agents.**

Mandate answers two questions that ordinary application authorization does not answer well:

1. What may this specific agent do for this specific task, resource, and time window?
2. What verifiable evidence proves which authority allowed the action and what the agent executed?

## Current milestone: domain kernel

This first version deliberately focuses on the trust boundary rather than a dashboard or model integration.

- Scoped mandates for an agent, principal, actions, resources, validity window, and use limit
- Explicit deny rules that override broad allows
- Human approval escalation for selected actions
- Revocation and expiry checks
- Deterministic ALLOW, DENY, or REQUIRE_APPROVAL decisions
- Ed25519-signed action receipts
- Public verification-key endpoint
- Idempotency support for mandate, approval, and receipt creation
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

See [`openapi.yaml`](./openapi.yaml) for the contract draft.

## Security decisions already made

- Deny rules take precedence over allow rules.
- Receipt issuance requires a stored ALLOW decision.
- A receipt cannot be issued after the mandate has been revoked.
- Approval matching binds mandate, agent, action, and resource.
- Receipt signatures cover every receipt field except the signature itself.
- The development key is ephemeral; production must use persistent managed keys.

## Not production-ready yet

The in-memory store is intentional for Milestone 0. It must be replaced before deployment with durable PostgreSQL storage and transactional use-count enforcement. Authentication is currently a single service API key and must become tenant-aware credentials.

## Next milestones

1. PostgreSQL persistence and append-only audit events
2. Tenant/API-key identities with hashed credentials and rotation
3. Atomic authorization/use accounting and replay prevention
4. Managed signing keys with rotation and historical verification
5. Approval delivery adapters and durable workflow resumption
6. SDKs and middleware for MCP, A2A, GitHub, Gmail, and browser tools
7. Policy simulation, trace ingestion, and tool-call firewall rules
