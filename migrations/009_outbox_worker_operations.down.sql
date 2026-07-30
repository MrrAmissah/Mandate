BEGIN;

DELETE FROM mandate.schema_migrations WHERE version = '009_outbox_worker_operations';
DROP INDEX IF EXISTS mandate.outbox_worker_dead_letter_idx;
DROP INDEX IF EXISTS mandate.outbox_worker_processing_idx;
DROP INDEX IF EXISTS mandate.outbox_worker_pending_idx;

COMMIT;
