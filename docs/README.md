# Mandate-API documentation

| Document | Purpose |
|---|---|
| [Product blueprint](./PRODUCT_BLUEPRINT.md) | Product boundary, actors, objects, state machines, and success criteria |
| [API conventions](./API_CONVENTIONS.md) | Stable HTTP, versioning, idempotency, errors, pagination, and webhook behavior |
| [Idempotency replay](./IDEMPOTENCY.md) | Canonical bytes, persisted HTTP metadata, retry request IDs, conflicts, and retention |
| [Target architecture](./ARCHITECTURE.md) | Components, persistence, signing, audit, deployment, and failure behavior |
| [Security model](./SECURITY_MODEL.md) | Threats, controls, approval identity/assignment authority, cryptography, retention, and test gates |
| [Persistence contract](./PERSISTENCE.md) | Tenant ownership, PostgreSQL schema, approval authority snapshots, transactions, idempotency, audit, credentials, and outbox |
| [Transactional outbox](./OUTBOX.md) | Claims, leases, retry, dead-letter, attempt evidence, replay controls, and handler requirements |
| [Signing key operations](./SIGNING_KEYS.md) | Persistent Ed25519 key registration, rotation, revocation, and startup invariants |
| [Receipt verification](./RECEIPT_VERIFICATION.md) | Public key discovery and rotation-safe verification behavior |
| [Action attempts](./ACTION_ATTEMPTS.md) | Single-use decision reservations, terminal execution evidence, and receipt binding |
| [Action-attempt expiry](./ACTION_ATTEMPT_EXPIRY.md) | Database-time expiry, multi-worker claims, observability, and system audit evidence |
| [Production deployment](./PRODUCTION_DEPLOYMENT.md) | Provider-neutral image, process, database-role, health and reference Compose contract |
| [Production operations](./PRODUCTION_OPERATIONS.md) | Supervision, resource/log bounds, alert baselines, escalation, rollout and rollback |
| [Database recovery](./DATABASE_RECOVERY.md) | Snapshot-consistent backup, disposable restore drills and application-level continuity proof |
| [Delivery roadmap](./ROADMAP.md) | Sequenced implementation phases and exit criteria |

The OpenAPI contract at [`../openapi.yaml`](../openapi.yaml) documents the stable HTTP surface, including the v0.8 approval identity, group, assignment, cancellation, and authenticated decision boundaries. Worker-only operational boundaries are documented alongside their implementation. These documents distinguish current behavior from future additions and keep provider-specific deployment choices outside the core runtime.
