BEGIN;

CREATE INDEX outbox_worker_pending_idx
  ON mandate.outbox_messages
  (environment, tenant_id, event_type, available_at, created_at, id)
  WHERE status = 'PENDING';

CREATE INDEX outbox_worker_processing_idx
  ON mandate.outbox_messages
  (environment, tenant_id, event_type, lock_expires_at, created_at, id)
  WHERE status = 'PROCESSING';

CREATE INDEX outbox_worker_dead_letter_idx
  ON mandate.outbox_messages
  (environment, tenant_id, event_type, processed_at, created_at, id)
  WHERE status = 'DEAD_LETTER';

INSERT INTO mandate.schema_migrations (version) VALUES ('009_outbox_worker_operations');

COMMIT;
