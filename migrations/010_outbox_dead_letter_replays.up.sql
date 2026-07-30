BEGIN;

CREATE TABLE mandate.outbox_dead_letter_replays (
  tenant_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  id text NOT NULL CHECK (id ~ '^odr_[A-Za-z0-9_-]+$'),
  source_message_id text NOT NULL,
  replay_message_id text NOT NULL,
  operator_audit_event_id text NOT NULL,
  operator_id text NOT NULL CHECK (char_length(operator_id) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^sha256:[0-9a-f]{64}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  request_id text NOT NULL CHECK (request_id ~ '^req_[A-Za-z0-9_-]+$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, environment, id),
  UNIQUE (tenant_id, environment, source_message_id),
  UNIQUE (tenant_id, environment, replay_message_id),
  UNIQUE (tenant_id, environment, operator_audit_event_id),
  UNIQUE (tenant_id, environment, idempotency_key_hash),
  FOREIGN KEY (tenant_id, environment, source_message_id)
    REFERENCES mandate.outbox_messages (tenant_id, environment, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, environment, replay_message_id)
    REFERENCES mandate.outbox_messages (tenant_id, environment, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, environment, operator_audit_event_id)
    REFERENCES mandate.audit_events (tenant_id, environment, id) ON DELETE RESTRICT,
  CHECK (source_message_id <> replay_message_id)
);

CREATE INDEX outbox_dead_letter_replays_created_idx
  ON mandate.outbox_dead_letter_replays
  (environment, tenant_id, created_at, id);

CREATE TRIGGER outbox_dead_letter_replays_immutable
BEFORE UPDATE OR DELETE ON mandate.outbox_dead_letter_replays
FOR EACH ROW EXECUTE FUNCTION mandate.reject_immutable_change();

INSERT INTO mandate.schema_migrations (version) VALUES ('010_outbox_dead_letter_replays');

COMMIT;
