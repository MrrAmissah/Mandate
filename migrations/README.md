# Database migrations

Mandate-API targets PostgreSQL. Migrations are ordered, immutable SQL pairs:

- `001_durable_core.up.sql` creates the first tenant-aware persistence model.
- `001_durable_core.down.sql` removes the dedicated `mandate` schema and is intended only for disposable development environments.
- `002_outbox_attempts.up.sql` adds append-only outbox execution evidence.
- `002_outbox_attempts.down.sql` removes only the outbox-attempt table and its migration registry row.

## Rules

1. Never edit an applied migration. Add the next numbered migration.
2. Production rollback should normally be a forward corrective migration. Destructive down files exist for local verification only.
3. Apply migrations with `npm run migrate` using a dedicated database role before starting the API process.
4. The migration runner takes one PostgreSQL advisory lock for the ordered migration sequence so concurrent deploys do not apply the same change independently.
5. The application role should not own the schema and should not be allowed to disable immutable-table triggers.
6. Back up and test restore procedures before the first live environment.

PostgreSQL runtime and database integration tests are active. Migration execution in a deployment platform, role separation, backup/restore, and forward-recovery runbooks remain production-hardening work.
