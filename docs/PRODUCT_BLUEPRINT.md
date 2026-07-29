# Mandate-API product blueprint

## 1. Product definition

Mandate-API is a provider-independent control plane for software agents that take real actions.

It gives an application a standard way to:

1. delegate narrowly scoped authority to an agent;
2. evaluate every proposed action against that authority;
3. pause consequential actions for human approval;
4. revoke or expire authority immediately;
5. issue a signed receipt after execution; and
6. retain an append-only audit trail explaining what happened.

Mandate-API is not an agent framework, an identity provider, a model gateway, or a general policy language. It sits between those systems and the tools an agent wants to use.

## 2. Core promise

For every protected action, Mandate-API should be able to answer:

- **Who delegated the authority?**
- **Which agent received it?**
- **What action and resource were in scope?**
- **Which rules allowed or denied the request?**
- **Was human approval required, granted, and consumed?**
- **What tool execution was reported?**
- **Can the resulting receipt be cryptographically verified?**
- **Can the complete lifecycle be audited later?**

## 3. Trust boundary

The service is authoritative for:

- mandate lifecycle and scope;
- policy evaluation results;
- approval lifecycle and consumption;
- receipt signing and signature verification;
- audit-event ordering within a tenant;
- API-client authentication and tenant isolation.

The service is not automatically authoritative for whether an external tool truly performed the claimed action. A basic receipt attests that Mandate-API signed the submitted execution evidence. Stronger connector attestations and callback verification are future capabilities.

## 4. Actors

| Actor | Meaning |
|---|---|
| Tenant | Organization or project that owns data and credentials |
| Principal | Human or service that delegates authority |
| Agent | Runtime identity proposing protected actions |
| Approver | Human or service permitted to decide approval requests |
| API client | Application authenticated to Mandate-API |
| Tool adapter | Integration that executes or verifies an external action |
| Verifier | Party checking a signed action receipt |

A principal, agent, approver, and API client may map to the same real system, but they remain separate domain roles.

## 5. Domain objects

### Tenant

Top-level isolation boundary. Every private resource belongs to exactly one tenant.

### API credential

A hashed and rotatable credential associated with a tenant, environment, scopes, creation metadata, and revocation state.

### Principal

The delegating identity. Mandate-API stores its stable external identifier and optional issuer, but does not initially manage login sessions for principals.

### Agent

The exact runtime identity receiving authority. An agent identifier must not be inferred from a model name. Multiple runtimes using the same model remain distinct agents.

### Mandate

A time-bounded and resource-bounded delegation from a principal to an agent.

Required properties:

- principal and agent identifiers;
- explicit purpose;
- allowed resource patterns;
- allowed action patterns;
- explicit deny patterns;
- approval-required patterns;
- validity window;
- optional use limit;
- optional structured constraints;
- lifecycle status and revision.

### Authorization decision

Immutable result of evaluating one proposed action against one exact mandate revision and context snapshot.

Outcomes:

- `ALLOW`
- `DENY`
- `REQUIRE_APPROVAL`

A decision records reason codes, matched rules, evaluation timestamp, request fingerprint, and approval linkage.

### Approval request

A reviewable request bound to one tenant, mandate, agent, action, resource, and request fingerprint.

Default behavior is single-use. An approved request becomes `CONSUMED` after the first matching successful authorization decision.

### Action attempt

Future durable representation of an intended execution. It connects an authorization decision to execution start, completion, retry, and receipt issuance. It prevents a single decision from being reused for multiple independent executions unless explicitly permitted.

### Action receipt

Signed, immutable statement connecting delegated authority, an authorization decision, optional approval, tool metadata, execution status, timestamps, and hashes of execution inputs and outputs.

### Audit event

Append-only event emitted for every security-relevant transition. Audit events are not editable domain records and must remain queryable after source objects expire or are deleted under normal retention rules.

### Webhook endpoint and delivery

Tenant-owned callback configuration plus immutable delivery attempts, signatures, retry state, and response metadata.

## 6. State machines

### Mandate

```text
DRAFT -> ACTIVE -> REVOKED
            |
            +------> EXPIRED
            |
            +------> EXHAUSTED
```

Milestone 0 creates mandates directly as `ACTIVE`. `DRAFT` and explicit activation are later additions.

### Approval

```text
PENDING -> APPROVED -> CONSUMED
    |          |
    |          +----> EXPIRED
    +----> REJECTED
    +----> EXPIRED
    +----> CANCELLED
```

### Authorization decision

Decisions are immutable terminal records:

```text
ALLOW | DENY | REQUIRE_APPROVAL
```

### Action attempt

```text
PENDING -> RUNNING -> SUCCEEDED
                  |-> FAILED
                  |-> PARTIAL
                  |-> CANCELLED
                  |-> TIMED_OUT
```

### Receipt

```text
ISSUED -> SUPERSEDED
       -> REVOKED_ATTESTATION
```

A receipt signature never changes. Corrections create a new receipt linked to the original.

## 7. Policy semantics

Evaluation order is deterministic and default-deny:

1. tenant and credential validity;
2. mandate existence and lifecycle;
3. agent identity match;
4. validity window and use limits;
5. resource-scope match;
6. explicit deny match;
7. allow match;
8. structured constraints;
9. approval requirement and approval validity;
10. atomic use reservation;
11. immutable decision creation.

An explicit deny always overrides an allow. Unknown constraints fail closed unless a mandate explicitly opts into a future compatibility mode.

## 8. Resource and action naming

Resources use provider-prefixed canonical identifiers:

```text
github:MrrAmissah/Mandate
github:MrrAmissah/Mandate/pull/42
gmail:account/user@example.com/thread/abc123
vercel:team/team_123/project/prj_456
http:api.example.com/v1/orders/ord_123
```

Actions use stable dot-separated verbs:

```text
repository.read
branch.create
commit.create
pull_request.create_draft
pull_request.merge
email.read
email.send
deployment.create
deployment.promote
```

Provider-specific adapters may expose aliases, but stored decisions use canonical action names.

## 9. Public API families

Final v1 surface is organized by resource rather than by provider:

```text
/v1/mandates
/v1/authorizations
/v1/approvals
/v1/action-attempts
/v1/receipts
/v1/audit-events
/v1/webhook-endpoints
/v1/signing-keys
/v1/api-keys
```

Provider adapters and SDK middleware translate external tool calls into these core resources.

## 10. Environments

Every tenant may operate separate environments:

- `test`
- `live`

Credentials, mandates, approvals, receipts, signing keys, webhooks, and audit streams never cross environments. Test mode should be visually and programmatically distinguishable in IDs and API responses.

## 11. Non-goals for v1

- autonomous execution of arbitrary tools;
- storing complete prompts or model transcripts by default;
- becoming an OAuth identity provider;
- evaluating natural-language policies directly in the critical path;
- blockchain anchoring as a requirement;
- claiming that a caller-submitted execution result is independently verified;
- a general-purpose Cedar, Rego, or XACML replacement.

## 12. Success criteria

Mandate-API v1 is ready for an external developer preview when it provides:

- durable multi-tenant storage;
- tenant-scoped and rotatable API keys;
- atomic authorization decisions and counters;
- single-use approval consumption;
- persistent signing keys with rotation;
- complete OpenAPI documentation and examples;
- webhook delivery with signatures and retries;
- an official JavaScript/TypeScript SDK;
- an end-to-end reference adapter;
- audit export and retention controls;
- security tests for tenant isolation, replay, concurrency, and key rotation.
