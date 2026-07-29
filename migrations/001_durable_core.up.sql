BEGIN;

CREATE SCHEMA IF NOT EXISTS mandate;

CREATE TABLE mandate.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION mandate.reject_immutable_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'immutable table % cannot be updated or deleted', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TABLE mandate.tenants (
  id text PRIMARY KEY CHECK (id ~ '^ten_[A-Za-z0-9_-]+$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE mandate.api_credentials (
  tenant_id text NOT NULL REFERENCES mandate.tenants(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  id text NOT NULL CHECK (id ~ '^key_[A-Za-z0-9_-]+$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  secret_hash char(64) NOT NULL,
  prefix text NOT NULL CHECK (char_length(prefix) BETWEEN 8 AND 20),
  last_four char(4) NOT NULL,
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  revocation_reason text,
  last_used_at timestamptz,
  PRIMARY KEY (tenant_id, environment, id),
  UNIQUE (secret_hash),
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (
    (status = 'ACTIVE' AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR (status = 'REVOKED' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
  )
);

CREATE TABLE mandate.mandates (
  tenant_id text NOT NULL REFERENCES mandate.tenants(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  id text NOT NULL CHECK (id ~ '^mnd_[A-Za-z0-9_-]+$'),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  principal_id text NOT NULL,
  agent_id text NOT NULL,
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 1000),
  resources jsonb NOT NULL CHECK (jsonb_typeof(resources) = 'array'),
  allowed_actions jsonb NOT NULL CHECK (jsonb_typeof(allowed_actions) = 'array'),
  denied_actions jsonb NOT NULL CHECK (jsonb_typeof(denied_actions) = 'array'),
  approval_required_actions jsonb NOT NULL CHECK (jsonb_typeof(approval_required_actions) = 'array'),
  constraints jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(constraints) = 'object'),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  max_uses integer CHECK (max_uses IS NULL OR max_uses > 0),
  uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  PRIMARY KEY (tenant_id, environment, id),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (max_uses IS NULL OR uses <= max_uses)
);

CREATE INDEX mandates_tenant_created_idx
  ON mandate.mandates (tenant_id, environment, created_at, id);
CREATE INDEX mandates_active_agent_idx
  ON mandate.mandates (tenant_id, environment, agent_id, status)
  WHERE status = 'ACTIVE';

CREATE TABLE mandate.approvals (
  tenant_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  id text NOT NULL CHECK (id ~ '^apr_[A-Za-z0-9_-]+$'),
  mandate_id text NOT NULL,
  agent_id text NOT NULL,
  action text NOT NULL,
  resource text NOT NULL,
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 2000),
  status text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CONSUMED', 'EXPIRED', 'CANCELLED')),
  requested_at timestamptz NOT NULL,
  expires_at timestamptz,
  decided_at timestamptz,
  decided_by text,
  decision_reason text,
  consumed_at timestamptz,
  consumed_by_decision_id text,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (tenant_id, environment, id),
  FOREIGN KEY (tenant_id, environment, mandate_id)
    REFERENCES mandate.mandates (tenant_id, environment, id) ON DELETE RESTRICT,
  CHECK (expires_at IS NULL OR expires_at > requested_at),
  CHECK ((status = 'CONSUMED' AND consumed_at IS NOT NULL AND consumed_by_decision_id IS NOT NULL)
    OR status <> 'CONSUMED')
);

CREATE INDEX approvals_tenant_requested_idx
  ON mandate.approvals (tenant_id, environment, requested_at, id);
CREATE INDEX approvals_pending_expiry_idx
  ON mandate.approvals (expires_at)
  WHERE status = 'PENDING' AND expires_at IS NOT NULL;

CREATE TABLE mandate.authorization_decisions (
  tenant_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  id text NOT NULL CHECK (id ~ '^dec_[A-Za-z0-9_-]+$'),
  mandate_id text NOT NULL,
  agent_id text NOT NULL,
  action text NOT NULL,
  resource text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object'),
  outcome text NOT NULL CHECK (outcome IN ('ALLOW', 'DENY', 'REQUIRE_APPROVAL')),
  reason_code text NOT NULL,
  reason text NOT NULL,
  approval_id text,
  evaluated_at timestamptz NOT NULL,
  request_id text NOT NULL,
  PRIMARY KEY (tenant_id, environment, id),
  FOREIGN KEY (tenant_id, environment, mandate_id)
    REFERENCES mandate.mandates (tenant_id, environment, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, environment, approval_id)
    REFERENCES mandate.approvals (tenant_id, environment, id) ON DELETE RESTRICT
);

ALTER TABLE mandate.approvals
  ADD CONSTRAINT approvals_consumed_decision_fk
  FOREIGN KEY (tenant_id, environment, consumed_by_decision_id)
  REFERENCES mandate.authorization_decisions (tenant_id, environment, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX decisions_tenant_evaluated_idx
  ON mandate.authorization_decisions (tenant_id, environment, evaluated_at, id);
CREATE INDEX decisions_mandate_idx
  ON mandate.authorization_decisions (tenant_id, environment, mandate_id, evaluated_at);

CREATE TABLE mandate.receipts (
  tenant_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  id text NOT NULL CHECK (id ~ '^rcpt_[A-Za-z0-9_-]+$'),
  decision_id text NOT NULL,
  mandate_id text NOT NULL,
  key_id text NOT NULL,
  algorithm text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  signature text NOT NULL,
  issued_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, environment, id),
  UNIQUE (tenant_id, environment, decision_id),
  FOREIGN KEY (tenant_id, environment, decision_id)
    REFERENCES mandate.authorization_decisions (tenant_id, environment, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, environment, mandate_id)
    REFERENCES mandate.mandates (tenant_id, environment, id) ON DELETE RESTRICT
);

CREATE INDEX receipts_tenant_issued_idx
  ON mandate.receipts (tenant_id, environment, issued_at, id);

CREATE TABLE mandate.idempotency_records (
  tenant_id text NOT NULL REFERENCES mandate.tenants(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  scope text NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  request_fingerprint char(71) NOT NULL CHECK (request_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  response_status integer NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  response_headers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(response_headers) = 'object'),
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, environment, scope, idempotency_key),
  CHECK (expires_at > created_at)
);

CREATE INDEX idempotency_expiry_idx
  ON mandate.idempotency_records (expires_at);

CREATE TABLE mandate.audit_sequences (
  tenant_id text NOT NULL REFERENCES mandate.tenants(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  next_sequence bigint NOT NULL CHECK (next_sequence > 0),
  PRIMARY KEY (tenant_id, environment)
);

CREATE OR REPLACE FUNCTION mandate.assign_audit_sequence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO mandate.audit_sequences (tenant_id, environment, next_sequence)
  VALUES (NEW.tenant_id, NEW.environment, 1)
  ON CONFLICT (tenant_id, environment)
  DO UPDATE SET next_sequence = mandate.audit_sequences.next_sequence + 1
  RETURNING next_sequence INTO NEW.sequence;
  RETURN NEW;
END;
$$;

CREATE TABLE mandate.audit_events (
  tenant_id text NOT NULL REFERENCES mandate.tenants(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  id text NOT NULL CHECK (id ~ '^aud_[A-Za-z0-9_-]+$'),
  sequence bigint NOT NULL,
  type text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  request_id text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, environment, id),
  UNIQUE (tenant_id, environment, sequence)
);

CREATE INDEX audit_events_tenant_sequence_idx
  ON mandate.audit_events (tenant_id, environment, sequence);
CREATE INDEX audit_events_object_idx
  ON mandate.audit_events (tenant_id, environment, object_type, object_id, sequence);

CREATE TABLE mandate.outbox_messages (
  tenant_id text NOT NULL REFERENCES mandate.tenants(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  id text NOT NULL CHECK (id ~ '^out_[A-Za-z0-9_-]+$'),
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  audit_event_id text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'DEAD_LETTER')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL,
  locked_by text,
  locked_at timestamptz,
  lock_expires_at timestamptz,
  processed_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, environment, id),
  FOREIGN KEY (tenant_id, environment, audit_event_id)
    REFERENCES mandate.audit_events (tenant_id, environment, id) ON DELETE RESTRICT,
  CHECK ((status = 'PROCESSING' AND locked_by IS NOT NULL AND locked_at IS NOT NULL AND lock_expires_at IS NOT NULL)
    OR status <> 'PROCESSING'),
  CHECK (lock_expires_at IS NULL OR locked_at IS NULL OR lock_expires_at >= locked_at)
);

CREATE INDEX outbox_due_idx
  ON mandate.outbox_messages (available_at, created_at)
  WHERE status = 'PENDING';
CREATE INDEX outbox_stale_lease_idx
  ON mandate.outbox_messages (lock_expires_at)
  WHERE status = 'PROCESSING';

CREATE TRIGGER audit_events_assign_sequence
BEFORE INSERT ON mandate.audit_events
FOR EACH ROW EXECUTE FUNCTION mandate.assign_audit_sequence();

CREATE TRIGGER authorization_decisions_immutable
BEFORE UPDATE OR DELETE ON mandate.authorization_decisions
FOR EACH ROW EXECUTE FUNCTION mandate.reject_immutable_change();

CREATE TRIGGER receipts_immutable
BEFORE UPDATE OR DELETE ON mandate.receipts
FOR EACH ROW EXECUTE FUNCTION mandate.reject_immutable_change();

CREATE TRIGGER audit_events_immutable
BEFORE UPDATE OR DELETE ON mandate.audit_events
FOR EACH ROW EXECUTE FUNCTION mandate.reject_immutable_change();

INSERT INTO mandate.schema_migrations (version) VALUES ('001_durable_core');

COMMIT;
