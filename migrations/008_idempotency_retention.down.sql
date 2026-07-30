BEGIN;

DELETE FROM mandate.schema_migrations WHERE version = '008_idempotency_retention';
DROP INDEX IF EXISTS mandate.idempotency_retention_scope_idx;

COMMIT;
