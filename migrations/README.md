# Database migrations

Mandate-API targets PostgreSQL. Migrations are ordered, immutable SQL pairs:

- `001_durable_core.up.sql` creates the first tenant-aware persistence model.
- `001_durable_core.down.sql` removes the dedicated `mandate` schema and is intended only for disposable development environments.

## Rules

1. Never edit an applied migration. Add the next numbered migration.
2. Production rollback should normally be a forward corrective migration. The destructive down file exists for local verification only.
3. Apply migrations with a dedicated database role before starting the API process.
4. The application role should not own the schema and should not be allowed to disable immutable-table triggers.
5. Back up and test restore procedures before the first live environment.

Runtime PostgreSQL driver wiring and database integration tests are Phase 2B. The schema in Phase 2A defines the transaction and isolation contract without claiming that the current server has switched away from the reference memory store.
