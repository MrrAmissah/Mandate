BEGIN;
DELETE FROM mandate.schema_migrations WHERE version = '004_signing_key_lifecycle';
DROP TABLE mandate.signing_keys;
COMMIT;
