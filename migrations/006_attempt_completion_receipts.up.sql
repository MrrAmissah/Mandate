BEGIN;

ALTER TABLE mandate.action_attempts
  ADD COLUMN execution_status text,
  ADD COLUMN input_hash text,
  ADD COLUMN output_hash text,
  ADD COLUMN tool text,
  ADD COLUMN provider text,
  ADD COLUMN model text,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN completion_request_id text,
  ADD COLUMN terminated_at timestamptz,
  ADD COLUMN termination_reason text,
  ADD COLUMN termination_request_id text;

ALTER TABLE mandate.action_attempts
  ADD CONSTRAINT action_attempts_execution_status_check
    CHECK (execution_status IS NULL OR execution_status IN ('SUCCEEDED', 'FAILED', 'PARTIAL')),
  ADD CONSTRAINT action_attempts_input_hash_check
    CHECK (input_hash IS NULL OR input_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT action_attempts_output_hash_check
    CHECK (output_hash IS NULL OR output_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT action_attempts_terminal_shape_check
    CHECK (
      (status = 'RESERVED'
        AND execution_status IS NULL AND input_hash IS NULL AND output_hash IS NULL
        AND tool IS NULL AND completed_at IS NULL AND completion_request_id IS NULL
        AND terminated_at IS NULL AND termination_reason IS NULL AND termination_request_id IS NULL)
      OR
      (status = 'COMPLETED'
        AND execution_status IS NOT NULL AND input_hash IS NOT NULL AND output_hash IS NOT NULL
        AND tool IS NOT NULL AND completed_at IS NOT NULL AND completion_request_id IS NOT NULL
        AND terminated_at IS NULL AND termination_reason IS NULL AND termination_request_id IS NULL)
      OR
      (status IN ('CANCELLED', 'EXPIRED')
        AND execution_status IS NULL AND input_hash IS NULL AND output_hash IS NULL
        AND tool IS NULL AND completed_at IS NULL AND completion_request_id IS NULL
        AND terminated_at IS NOT NULL AND termination_reason IS NOT NULL AND termination_request_id IS NOT NULL)
    );

ALTER TABLE mandate.receipts
  ADD COLUMN action_attempt_id text;

ALTER TABLE mandate.receipts
  ADD CONSTRAINT receipts_action_attempt_fk
  FOREIGN KEY (tenant_id, environment, action_attempt_id)
    REFERENCES mandate.action_attempts (tenant_id, environment, id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX receipts_action_attempt_unique_idx
  ON mandate.receipts (tenant_id, environment, action_attempt_id)
  WHERE action_attempt_id IS NOT NULL;

CREATE OR REPLACE FUNCTION mandate.assign_idempotency_http_metadata()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.scope IN ('create-mandate', 'create-approval', 'issue-receipt', 'reserve-action-attempt') THEN
    NEW.response_status := 201;
  ELSIF NEW.scope = 'authorize'
    OR NEW.scope LIKE 'revoke-mandate:%'
    OR NEW.scope LIKE 'decide-approval:%'
    OR NEW.scope LIKE 'complete-action-attempt:%'
    OR NEW.scope LIKE 'cancel-action-attempt:%' THEN
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

INSERT INTO mandate.schema_migrations (version) VALUES ('006_attempt_completion_receipts');

COMMIT;
