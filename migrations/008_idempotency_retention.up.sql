BEGIN;

CREATE INDEX idempotency_retention_scope_idx
  ON mandate.idempotency_records
  (environment, tenant_id, expires_at, created_at, scope, idempotency_key);

INSERT INTO mandate.schema_migrations (version) VALUES ('008_idempotency_retention');

COMMIT;
