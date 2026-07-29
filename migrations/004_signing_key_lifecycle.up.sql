BEGIN;

CREATE TABLE mandate.signing_keys (
  tenant_id text NOT NULL,
  environment text NOT NULL,
  key_id text NOT NULL,
  algorithm text NOT NULL,
  public_key_pem text NOT NULL,
  fingerprint text NOT NULL,
  status text NOT NULL,
  activated_at timestamptz NOT NULL,
  retired_at timestamptz,
  revoked_at timestamptz,
  revocation_reason text,
  PRIMARY KEY (tenant_id, environment, key_id),
  FOREIGN KEY (tenant_id) REFERENCES mandate.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT signing_keys_environment CHECK (environment IN ('test','live')),
  CONSTRAINT signing_keys_algorithm CHECK (algorithm = 'Ed25519'),
  CONSTRAINT signing_keys_status CHECK (status IN ('ACTIVE','RETIRED','REVOKED')),
  CONSTRAINT signing_keys_key_id CHECK (key_id ~ '^key_[A-Za-z0-9_-]{3,120}$'),
  CONSTRAINT signing_keys_fingerprint CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT signing_keys_lifecycle CHECK (
    (status = 'ACTIVE' AND retired_at IS NULL AND revoked_at IS NULL) OR
    (status = 'RETIRED' AND retired_at IS NOT NULL AND revoked_at IS NULL) OR
    (status = 'REVOKED' AND revoked_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX signing_keys_one_active_algorithm
  ON mandate.signing_keys (tenant_id, environment, algorithm)
  WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX signing_keys_material_unique
  ON mandate.signing_keys (tenant_id, environment, fingerprint);

INSERT INTO mandate.schema_migrations(version) VALUES ('004_signing_key_lifecycle');
COMMIT;
