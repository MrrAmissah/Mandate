BEGIN;

CREATE TABLE mandate.action_attempts (
  tenant_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  id text NOT NULL CHECK (id ~ '^att_[A-Za-z0-9_-]+$'),
  decision_id text NOT NULL,
  mandate_id text NOT NULL,
  agent_id text NOT NULL,
  action text NOT NULL,
  resource text NOT NULL,
  status text NOT NULL CHECK (status IN ('RESERVED', 'COMPLETED', 'CANCELLED', 'EXPIRED')),
  reserved_by_credential_id text NOT NULL,
  reserved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  request_id text NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (tenant_id, environment, id),
  UNIQUE (tenant_id, environment, decision_id),
  FOREIGN KEY (tenant_id, environment, decision_id)
    REFERENCES mandate.authorization_decisions (tenant_id, environment, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, environment, mandate_id)
    REFERENCES mandate.mandates (tenant_id, environment, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, environment, reserved_by_credential_id)
    REFERENCES mandate.api_credentials (tenant_id, environment, id) ON DELETE RESTRICT,
  CHECK (expires_at > reserved_at)
);

CREATE INDEX action_attempts_tenant_reserved_idx
  ON mandate.action_attempts (tenant_id, environment, reserved_at, id);
CREATE INDEX action_attempts_expiry_idx
  ON mandate.action_attempts (status, expires_at)
  WHERE status = 'RESERVED';

CREATE OR REPLACE FUNCTION mandate.assign_idempotency_http_metadata()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.scope IN ('create-mandate', 'create-approval', 'issue-receipt', 'reserve-action-attempt') THEN
    NEW.response_status := 201;
  ELSIF NEW.scope = 'authorize'
    OR NEW.scope LIKE 'revoke-mandate:%'
    OR NEW.scope LIKE 'decide-approval:%' THEN
    NEW.response_status := 200;
  ELSE
    RAISE EXCEPTION 'unknown idempotency scope %', NEW.scope
      USING ERRCODE = '22023';
  END IF;

  NEW.response_headers := jsonb_build_object(
    'content-type', 'application/json; charset=utf-8',
    'cache-control', 'no-store',
    'x-content-type-options', 'nosniff'
  );

  RETURN NEW;
END;
$$;

INSERT INTO mandate.schema_migrations (version) VALUES ('005_action_attempt_reservations');

COMMIT;
