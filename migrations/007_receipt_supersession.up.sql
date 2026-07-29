BEGIN;

ALTER TABLE mandate.receipts
  DROP CONSTRAINT receipts_tenant_id_environment_decision_id_key;

DROP INDEX IF EXISTS mandate.receipts_action_attempt_unique_idx;

ALTER TABLE mandate.receipts
  ADD COLUMN supersedes_receipt_id text,
  ADD COLUMN supersession_reason text;

ALTER TABLE mandate.receipts
  ADD CONSTRAINT receipts_supersession_shape CHECK (
    (
      supersedes_receipt_id IS NULL
      AND supersession_reason IS NULL
      AND NOT (payload ? 'supersedesReceiptId')
      AND NOT (payload ? 'supersessionReason')
      AND (payload ->> 'decisionId') IS NOT DISTINCT FROM decision_id
      AND (payload ->> 'mandateId') IS NOT DISTINCT FROM mandate_id
      AND (payload ->> 'actionAttemptId') IS NOT DISTINCT FROM action_attempt_id
      AND (
        (action_attempt_id IS NULL AND (payload ->> 'version') IS NOT DISTINCT FROM '1.0')
        OR
        (action_attempt_id IS NOT NULL AND (payload ->> 'version') IS NOT DISTINCT FROM '1.1')
      )
    )
    OR (
      supersedes_receipt_id IS NOT NULL
      AND action_attempt_id IS NOT NULL
      AND supersession_reason IS NOT NULL
      AND char_length(supersession_reason) BETWEEN 1 AND 1000
      AND supersedes_receipt_id <> id
      AND (payload ->> 'version') IS NOT DISTINCT FROM '1.2'
      AND (payload ->> 'supersedesReceiptId') IS NOT DISTINCT FROM supersedes_receipt_id
      AND (payload ->> 'supersessionReason') IS NOT DISTINCT FROM supersession_reason
      AND (payload ->> 'decisionId') IS NOT DISTINCT FROM decision_id
      AND (payload ->> 'mandateId') IS NOT DISTINCT FROM mandate_id
      AND (payload ->> 'actionAttemptId') IS NOT DISTINCT FROM action_attempt_id
    )
  ),
  ADD CONSTRAINT receipts_execution_identity_unique
    UNIQUE (tenant_id, environment, id, decision_id, action_attempt_id),
  ADD CONSTRAINT receipts_supersedes_same_execution_fk
    FOREIGN KEY (
      tenant_id,
      environment,
      supersedes_receipt_id,
      decision_id,
      action_attempt_id
    )
    REFERENCES mandate.receipts (
      tenant_id,
      environment,
      id,
      decision_id,
      action_attempt_id
    )
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX receipts_root_decision_unique_idx
  ON mandate.receipts (tenant_id, environment, decision_id)
  WHERE supersedes_receipt_id IS NULL;

CREATE UNIQUE INDEX receipts_root_attempt_unique_idx
  ON mandate.receipts (tenant_id, environment, action_attempt_id)
  WHERE supersedes_receipt_id IS NULL AND action_attempt_id IS NOT NULL;

CREATE UNIQUE INDEX receipts_one_successor_idx
  ON mandate.receipts (tenant_id, environment, supersedes_receipt_id)
  WHERE supersedes_receipt_id IS NOT NULL;

CREATE INDEX receipts_execution_chain_idx
  ON mandate.receipts (tenant_id, environment, action_attempt_id, issued_at, id)
  WHERE action_attempt_id IS NOT NULL;

CREATE OR REPLACE FUNCTION mandate.assign_idempotency_http_metadata()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.scope IN ('create-mandate', 'create-approval', 'issue-receipt')
    OR NEW.scope LIKE 'supersede-receipt:%' THEN
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

INSERT INTO mandate.schema_migrations (version) VALUES ('007_receipt_supersession');

COMMIT;
