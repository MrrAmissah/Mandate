BEGIN;

CREATE TABLE mandate.outbox_attempts (
  tenant_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  id text NOT NULL CHECK (id ~ '^oba_[A-Za-z0-9_-]+$'),
  outbox_message_id text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  worker_id text NOT NULL CHECK (char_length(worker_id) BETWEEN 1 AND 200),
  outcome text NOT NULL CHECK (outcome IN (
    'SUCCEEDED',
    'FAILED',
    'DEAD_LETTER',
    'LEASE_EXPIRED',
    'LEASE_LOST'
  )),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,64}$'),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, environment, id),
  UNIQUE (tenant_id, environment, outbox_message_id, attempt_number, outcome),
  FOREIGN KEY (tenant_id, environment, outbox_message_id)
    REFERENCES mandate.outbox_messages (tenant_id, environment, id) ON DELETE RESTRICT,
  CHECK (completed_at >= started_at),
  CHECK (
    (outcome IN ('FAILED', 'DEAD_LETTER', 'LEASE_EXPIRED') AND error_code IS NOT NULL)
    OR (outcome IN ('SUCCEEDED', 'LEASE_LOST'))
  )
);

CREATE INDEX outbox_attempts_message_idx
  ON mandate.outbox_attempts (
    tenant_id,
    environment,
    outbox_message_id,
    attempt_number,
    created_at
  );

CREATE TRIGGER outbox_attempts_immutable
BEFORE UPDATE OR DELETE ON mandate.outbox_attempts
FOR EACH ROW EXECUTE FUNCTION mandate.reject_immutable_change();

INSERT INTO mandate.schema_migrations (version) VALUES ('002_outbox_attempts');

COMMIT;
