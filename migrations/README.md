# Database migrations

Mandate-API targets PostgreSQL. Migrations are ordered, immutable SQL pairs:

- `001_durable_core` creates the tenant-aware persistence model, idempotency records, audit events, and transactional outbox.
- `002_outbox_attempts` adds append-only outbox execution evidence.
- `003_idempotency_http_metadata` synchronizes committed replay status and stable response headers and rejects unknown mutation scopes.
- `004_signing_key_lifecycle` adds tenant/environment-scoped signing-key rotation and historical verification state.
- `005_action_attempt_reservations` adds single-use execution reservations.
- `006_attempt_completion_receipts` adds terminal attempt evidence and attempt-bound root receipts.
- `007_receipt_supersession` adds append-only signed receipt correction chains.
- `008_idempotency_retention` adds the scoped access index used by bounded replay-record cleanup.
- `009_outbox_worker_operations` adds status-specific scope/event indexes for bounded worker claims and backlog samples.
- `010_outbox_dead_letter_replays` adds immutable, idempotent, linear source-to-replacement replay records.

Each numbered migration has a matching `.up.sql` and `.down.sql` file. The baseline down migration removes the dedicated schema and is intended only for disposable development environments. Later down migrations remove only the objects owned by that migration.

## Rules

1. Never edit an applied migration. Add the next numbered migration.
2. Production rollback should normally be a forward corrective migration. Destructive down files exist for local verification only.
3. Apply migrations with `npm run migrate` using a dedicated database role before starting the API or maintenance processes.
4. The migration runner takes one 64-bit PostgreSQL advisory lock for the ordered migration sequence so concurrent deploys do not apply the same change independently.
5. Runtime and maintenance roles must not own the schema and must not be allowed to disable immutable-table triggers.
6. The idempotency cleanup command checks for migration 008 but never applies migrations.
7. The outbox worker checks migrations 002 and 009 but never applies migrations.
8. Dead-letter inspection and replay check migration 010 but never apply migrations.
9. Back up and test restore procedures before the first live environment.

PostgreSQL runtime and database integration tests are active. Deployment role separation, backup/restore, and forward-recovery runbooks remain production-hardening work.
