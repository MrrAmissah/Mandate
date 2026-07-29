BEGIN;

CREATE OR REPLACE FUNCTION mandate.assign_idempotency_http_metadata()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.response_status := CASE
    WHEN NEW.scope IN ('create-mandate', 'create-approval', 'issue-receipt') THEN 201
    WHEN NEW.scope = 'authorize'
      OR NEW.scope LIKE 'revoke-mandate:%'
      OR NEW.scope LIKE 'decide-approval:%' THEN 200
    ELSE
      RAISE EXCEPTION 'unknown idempotency scope %', NEW.scope
        USING ERRCODE = '22023';
  END CASE;

  NEW.response_headers := jsonb_build_object(
    'content-type', 'application/json; charset=utf-8',
    'cache-control', 'no-store',
    'x-content-type-options', 'nosniff'
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS idempotency_http_metadata ON mandate.idempotency_records;
CREATE TRIGGER idempotency_http_metadata
BEFORE INSERT OR UPDATE OF scope, response_status, response_headers
ON mandate.idempotency_records
FOR EACH ROW EXECUTE FUNCTION mandate.assign_idempotency_http_metadata();

UPDATE mandate.idempotency_records
SET response_status = response_status,
    response_headers = response_headers;

INSERT INTO mandate.schema_migrations (version) VALUES ('003_idempotency_http_metadata');

COMMIT;
