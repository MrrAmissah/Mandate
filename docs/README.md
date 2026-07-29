# Mandate-API documentation

| Document | Purpose |
|---|---|
| [Product blueprint](./PRODUCT_BLUEPRINT.md) | Product boundary, actors, objects, state machines, and success criteria |
| [API conventions](./API_CONVENTIONS.md) | Stable HTTP, versioning, idempotency, errors, pagination, and webhook behavior |
| [Idempotency replay](./IDEMPOTENCY.md) | Canonical bytes, persisted HTTP metadata, retry request IDs, conflicts, and retention |
| [Target architecture](./ARCHITECTURE.md) | Components, persistence, signing, audit, deployment, and failure behavior |
| [Security model](./SECURITY_MODEL.md) | Threats, controls, cryptography, retention, and test gates |
| [Persistence contract](./PERSISTENCE.md) | Tenant ownership, PostgreSQL schema, transactions, idempotency, audit, credentials, and outbox |
| [Transactional outbox](./OUTBOX.md) | Claims, leases, retry, dead-letter, attempt evidence, and handler requirements |
| [Delivery roadmap](./ROADMAP.md) | Sequenced implementation phases and exit criteria |

The OpenAPI contract at [`../openapi.yaml`](../openapi.yaml) documents the currently implemented surface. These documents describe the intended complete v1 platform and clearly distinguish current behavior from future additions.
