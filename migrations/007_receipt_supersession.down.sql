BEGIN;

DROP TRIGGER IF EXISTS receipts_immutable ON mandate.receipts;

DELETE FROM mandate.receipts
WHERE supersedes_receipt_id IS NOT NULL;

DROP INDEX IF EXISTS mandate.receipts_execution_chain_idx;
DROP INDEX IF EXISTS mandate.receipts_one_successor_idx;
DROP INDEX IF EXISTS mandate.receipts_root_attempt_unique_idx;
DROP INDEX IF EXISTS mandate.receipts_root_decision_unique_idx;

ALTER TABLE mandate.receipts
  DROP CONSTRAINT IF EXISTS receipts_supersedes_same_execution_fk,
  DROP CONSTRAINT IF EXISTS receipts_execution_identity_unique,
  DROP CONSTRAINT IF EXISTS receipts_supersession_shape,
  DROP COLUMN IF EXISTS supersession_reason,
  DROP COLUMN IF EXISTS supersedes_receipt_id;

ALTER TABLE mandate.receipts
  ADD CONSTRAINT receipts_tenant_id_environment_decision_id_key
    UNIQUE (tenant_id, environment, decision_id);

CREATE UNIQUE INDEX receipts_action_attempt_unique_idx
  ON mandate.receipts (tenant_id, environment, action_attempt_id)
  WHERE action_attempt_id IS NOT NULL;

CREATE TRIGGER receipts_immutable
BEFORE UPDATE OR DELETE ON mandate.receipts
FOR EACH ROW EXECUTE FUNCTION mandate.reject_immutable_change();

CREATE OR REPLACE FUNCTION mandate.assign_idempotency_http_metadata()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.scope IN ('create-mandate', 'create-approval', 'issue-receipt') THEN
    NEW.response_status := 201;
  ELSIF NEW.scope = 'authorize'
    OR NEW.scope = 'reserve-action-attempt'
    OR NEW.scope LIKE 'revoke-mandate:%'
    OR NEW.scope LIKE 'decide-approval:%'
    OR NEW.scope LIKE 'complete-action-attempt:%'
    OR NEW.scope LIKE 'cancel-action-attempt:%' THEN
    NEW.response_status := CASE
      WHEN NEW.scope = 'reserve-action-attempt' THEN 201
      ELSE 200
    END;
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

DELETE FROM mandate.schema_migrations WHERE version = '007_receipt_supersession';

COMMIT;
