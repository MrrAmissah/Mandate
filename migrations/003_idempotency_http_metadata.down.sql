BEGIN;
DROP TRIGGER IF EXISTS idempotency_http_metadata ON mandate.idempotency_records;
DROP FUNCTION IF EXISTS mandate.assign_idempotency_http_metadata();
DELETE FROM mandate.schema_migrations WHERE version = '003_idempotency_http_metadata';
COMMIT;
