BEGIN;

DROP TABLE IF EXISTS mandate.action_attempts;

CREATE OR REPLACE FUNCTION mandate.assign_idempotency_http_metadata()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.scope IN ('create-mandate', 'create-approval', 'issue-receipt') THEN
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

DELETE FROM mandate.schema_migrations WHERE version = '005_action_attempt_reservations';

COMMIT;
