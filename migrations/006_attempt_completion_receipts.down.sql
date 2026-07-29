BEGIN;

DROP INDEX IF EXISTS mandate.receipts_action_attempt_unique_idx;
ALTER TABLE mandate.receipts DROP CONSTRAINT IF EXISTS receipts_action_attempt_fk;
ALTER TABLE mandate.receipts DROP COLUMN IF EXISTS action_attempt_id;

ALTER TABLE mandate.action_attempts
  DROP CONSTRAINT IF EXISTS action_attempts_terminal_shape_check,
  DROP CONSTRAINT IF EXISTS action_attempts_output_hash_check,
  DROP CONSTRAINT IF EXISTS action_attempts_input_hash_check,
  DROP CONSTRAINT IF EXISTS action_attempts_execution_status_check,
  DROP COLUMN IF EXISTS termination_request_id,
  DROP COLUMN IF EXISTS termination_reason,
  DROP COLUMN IF EXISTS terminated_at,
  DROP COLUMN IF EXISTS completion_request_id,
  DROP COLUMN IF EXISTS completed_at,
  DROP COLUMN IF EXISTS model,
  DROP COLUMN IF EXISTS provider,
  DROP COLUMN IF EXISTS tool,
  DROP COLUMN IF EXISTS output_hash,
  DROP COLUMN IF EXISTS input_hash,
  DROP COLUMN IF EXISTS execution_status;

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

DELETE FROM mandate.schema_migrations WHERE version = '006_attempt_completion_receipts';

COMMIT;
