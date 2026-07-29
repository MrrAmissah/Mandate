BEGIN;
DELETE FROM mandate.schema_migrations WHERE version = '002_outbox_attempts';
DROP TABLE IF EXISTS mandate.outbox_attempts;
COMMIT;
