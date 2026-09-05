BEGIN;

CREATE TABLE mandate.approver_identities (
  tenant_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  id text NOT NULL CHECK (id ~ '^apv_[A-Za-z0-9_-]+$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at timestamptz NOT NULL,
  disabled_at timestamptz,
  disable_reason text,
  PRIMARY KEY (tenant_id, environment, id),
  FOREIGN KEY (tenant_id) REFERENCES mandate.tenants(id) ON DELETE RESTRICT,
  CHECK (
    (status = 'ACTIVE' AND disabled_at IS NULL AND disable_reason IS NULL)
    OR
    (status = 'DISABLED' AND disabled_at IS NOT NULL AND disable_reason IS NOT NULL)
  )
);

CREATE INDEX approver_identities_status_idx
  ON mandate.approver_identities (tenant_id, environment, status, created_at, id);

CREATE TABLE mandate.approver_credential_bindings (
  tenant_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  id text NOT NULL CHECK (id ~ '^apb_[A-Za-z0-9_-]+$'),
  approver_id text NOT NULL,
  credential_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  bound_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  PRIMARY KEY (tenant_id, environment, id),
  FOREIGN KEY (tenant_id, environment, approver_id)
    REFERENCES mandate.approver_identities (tenant_id, environment, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, environment, credential_id)
    REFERENCES mandate.api_credentials (tenant_id, environment, id) ON DELETE RESTRICT,
  CHECK (
    (status = 'ACTIVE' AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR
    (status = 'REVOKED' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX approver_credential_bindings_active_credential_idx
  ON mandate.approver_credential_bindings (tenant_id, environment, credential_id)
  WHERE status = 'ACTIVE';
CREATE INDEX approver_credential_bindings_approver_idx
  ON mandate.approver_credential_bindings (tenant_id, environment, approver_id, status, bound_at, id);

CREATE TABLE mandate.approver_groups (
  tenant_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  id text NOT NULL CHECK (id ~ '^apg_[A-Za-z0-9_-]+$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at timestamptz NOT NULL,
  disabled_at timestamptz,
  disable_reason text,
  PRIMARY KEY (tenant_id, environment, id),
  FOREIGN KEY (tenant_id) REFERENCES mandate.tenants(id) ON DELETE RESTRICT,
  CHECK (
    (status = 'ACTIVE' AND disabled_at IS NULL AND disable_reason IS NULL)
    OR
    (status = 'DISABLED' AND disabled_at IS NOT NULL AND disable_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX approver_groups_active_name_idx
  ON mandate.approver_groups (tenant_id, environment, name)
  WHERE status = 'ACTIVE';

CREATE TABLE mandate.approver_group_memberships (
  tenant_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  id text NOT NULL CHECK (id ~ '^agm_[A-Za-z0-9_-]+$'),
  group_id text NOT NULL,
  approver_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'REMOVED')),
  added_at timestamptz NOT NULL,
  removed_at timestamptz,
  removal_reason text,
  PRIMARY KEY (tenant_id, environment, id),
  FOREIGN KEY (tenant_id, environment, group_id)
    REFERENCES mandate.approver_groups (tenant_id, environment, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, environment, approver_id)
    REFERENCES mandate.approver_identities (tenant_id, environment, id) ON DELETE RESTRICT,
  CHECK (
    (status = 'ACTIVE' AND removed_at IS NULL AND removal_reason IS NULL)
    OR
    (status = 'REMOVED' AND removed_at IS NOT NULL AND removal_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX approver_group_memberships_active_member_idx
  ON mandate.approver_group_memberships (tenant_id, environment, group_id, approver_id)
  WHERE status = 'ACTIVE';
CREATE INDEX approver_group_memberships_group_idx
  ON mandate.approver_group_memberships (tenant_id, environment, group_id, status, added_at, id);

CREATE TABLE mandate.approval_assignments (
  tenant_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  id text NOT NULL CHECK (id ~ '^apa_[A-Za-z0-9_-]+$'),
  approval_id text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('APPROVER', 'GROUP')),
  source_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'CANCELLED')),
  assigned_by_credential_id text NOT NULL,
  assigned_at timestamptz NOT NULL,
  ended_at timestamptz,
  end_reason text,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (tenant_id, environment, id),
  FOREIGN KEY (tenant_id, environment, approval_id)
    REFERENCES mandate.approvals (tenant_id, environment, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, environment, assigned_by_credential_id)
    REFERENCES mandate.api_credentials (tenant_id, environment, id) ON DELETE RESTRICT,
  CHECK (
    (status = 'ACTIVE' AND ended_at IS NULL AND end_reason IS NULL)
    OR
    (status IN ('SUPERSEDED', 'CANCELLED') AND ended_at IS NOT NULL AND end_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX approval_assignments_one_active_idx
  ON mandate.approval_assignments (tenant_id, environment, approval_id)
  WHERE status = 'ACTIVE';
CREATE INDEX approval_assignments_history_idx
  ON mandate.approval_assignments (tenant_id, environment, approval_id, assigned_at, id);

CREATE TABLE mandate.approval_assignment_eligibility (
  tenant_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  assignment_id text NOT NULL,
  approver_id text NOT NULL,
  snapshot_source_group_id text,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, environment, assignment_id, approver_id),
  FOREIGN KEY (tenant_id, environment, assignment_id)
    REFERENCES mandate.approval_assignments (tenant_id, environment, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, environment, approver_id)
    REFERENCES mandate.approver_identities (tenant_id, environment, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, environment, snapshot_source_group_id)
    REFERENCES mandate.approver_groups (tenant_id, environment, id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION mandate.guard_approval_authority_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'approver_identities' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'approver identity provenance is immutable';
    END IF;
    IF OLD.status = 'DISABLED' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'disabled approver identity is immutable';
    END IF;
    IF OLD.status = 'ACTIVE' AND NEW.status NOT IN ('ACTIVE', 'DISABLED') THEN
      RAISE EXCEPTION 'invalid approver identity transition';
    END IF;
  ELSIF TG_TABLE_NAME = 'approver_credential_bindings' THEN
    IF NEW.approver_id IS DISTINCT FROM OLD.approver_id
       OR NEW.credential_id IS DISTINCT FROM OLD.credential_id
       OR NEW.bound_at IS DISTINCT FROM OLD.bound_at THEN
      RAISE EXCEPTION 'approver credential binding provenance is immutable';
    END IF;
    IF OLD.status = 'REVOKED' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'revoked approver credential binding is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'approver_groups' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'approver group provenance is immutable';
    END IF;
    IF OLD.status = 'DISABLED' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'disabled approver group is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'approver_group_memberships' THEN
    IF NEW.group_id IS DISTINCT FROM OLD.group_id
       OR NEW.approver_id IS DISTINCT FROM OLD.approver_id
       OR NEW.added_at IS DISTINCT FROM OLD.added_at THEN
      RAISE EXCEPTION 'approver group membership provenance is immutable';
    END IF;
    IF OLD.status = 'REMOVED' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'removed approver group membership is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'approval_assignments' THEN
    IF NEW.approval_id IS DISTINCT FROM OLD.approval_id
       OR NEW.source_type IS DISTINCT FROM OLD.source_type
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.assigned_by_credential_id IS DISTINCT FROM OLD.assigned_by_credential_id
       OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at THEN
      RAISE EXCEPTION 'approval assignment provenance is immutable';
    END IF;
    IF OLD.status <> 'ACTIVE' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'terminal approval assignment is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER approver_identities_history_guard
BEFORE UPDATE ON mandate.approver_identities
FOR EACH ROW EXECUTE FUNCTION mandate.guard_approval_authority_history();
CREATE TRIGGER approver_credential_bindings_history_guard
BEFORE UPDATE ON mandate.approver_credential_bindings
FOR EACH ROW EXECUTE FUNCTION mandate.guard_approval_authority_history();
CREATE TRIGGER approver_groups_history_guard
BEFORE UPDATE ON mandate.approver_groups
FOR EACH ROW EXECUTE FUNCTION mandate.guard_approval_authority_history();
CREATE TRIGGER approver_group_memberships_history_guard
BEFORE UPDATE ON mandate.approver_group_memberships
FOR EACH ROW EXECUTE FUNCTION mandate.guard_approval_authority_history();
CREATE TRIGGER approval_assignments_history_guard
BEFORE UPDATE ON mandate.approval_assignments
FOR EACH ROW EXECUTE FUNCTION mandate.guard_approval_authority_history();

CREATE OR REPLACE FUNCTION mandate.validate_approval_assignment_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_type = 'APPROVER' THEN
    IF NOT EXISTS (
      SELECT 1 FROM mandate.approver_identities identity
       WHERE identity.tenant_id = NEW.tenant_id
         AND identity.environment = NEW.environment
         AND identity.id = NEW.source_id
         AND identity.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'approval assignment source approver is unavailable';
    END IF;
  ELSIF NEW.source_type = 'GROUP' THEN
    IF NOT EXISTS (
      SELECT 1 FROM mandate.approver_groups approver_group
       WHERE approver_group.tenant_id = NEW.tenant_id
         AND approver_group.environment = NEW.environment
         AND approver_group.id = NEW.source_id
         AND approver_group.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'approval assignment source group is unavailable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER approval_assignments_source_guard
BEFORE INSERT ON mandate.approval_assignments
FOR EACH ROW EXECUTE FUNCTION mandate.validate_approval_assignment_source();

CREATE OR REPLACE FUNCTION mandate.validate_approval_assignment_eligibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  assignment mandate.approval_assignments%ROWTYPE;
BEGIN
  SELECT * INTO assignment
    FROM mandate.approval_assignments
   WHERE tenant_id = NEW.tenant_id
     AND environment = NEW.environment
     AND id = NEW.assignment_id;

  IF assignment.id IS NULL OR assignment.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'approval assignment is unavailable for eligibility snapshot';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM mandate.approver_identities identity
     WHERE identity.tenant_id = NEW.tenant_id
       AND identity.environment = NEW.environment
       AND identity.id = NEW.approver_id
       AND identity.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'approval eligibility approver is unavailable';
  END IF;

  IF assignment.source_type = 'APPROVER' THEN
    IF NEW.approver_id <> assignment.source_id OR NEW.snapshot_source_group_id IS NOT NULL THEN
      RAISE EXCEPTION 'direct approval assignment eligibility does not match its source approver';
    END IF;
  ELSIF assignment.source_type = 'GROUP' THEN
    IF NEW.snapshot_source_group_id IS DISTINCT FROM assignment.source_id THEN
      RAISE EXCEPTION 'group approval assignment eligibility does not match its source group';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM mandate.approver_group_memberships membership
       WHERE membership.tenant_id = NEW.tenant_id
         AND membership.environment = NEW.environment
         AND membership.group_id = assignment.source_id
         AND membership.approver_id = NEW.approver_id
         AND membership.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'approval eligibility approver was not an active source-group member';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER approval_assignment_eligibility_source_guard
BEFORE INSERT ON mandate.approval_assignment_eligibility
FOR EACH ROW EXECUTE FUNCTION mandate.validate_approval_assignment_eligibility();

CREATE TRIGGER approval_assignment_eligibility_immutable
BEFORE UPDATE OR DELETE ON mandate.approval_assignment_eligibility
FOR EACH ROW EXECUTE FUNCTION mandate.reject_immutable_change();

ALTER TABLE mandate.approvals
  ADD COLUMN decided_by_approver_id text,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancelled_by_credential_id text,
  ADD COLUMN cancellation_reason text,
  ADD CONSTRAINT approvals_decided_by_approver_fk
    FOREIGN KEY (tenant_id, environment, decided_by_approver_id)
    REFERENCES mandate.approver_identities (tenant_id, environment, id) ON DELETE RESTRICT,
  ADD CONSTRAINT approvals_cancelled_by_credential_fk
    FOREIGN KEY (tenant_id, environment, cancelled_by_credential_id)
    REFERENCES mandate.api_credentials (tenant_id, environment, id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION mandate.guard_approval_evidence_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.decided_by_approver_id IS NOT NULL
     AND NEW.decided_by_approver_id IS DISTINCT FROM OLD.decided_by_approver_id THEN
    RAISE EXCEPTION 'approval decision approver identity is immutable';
  END IF;

  IF OLD.cancelled_at IS NOT NULL AND (
       NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
       OR NEW.cancelled_by_credential_id IS DISTINCT FROM OLD.cancelled_by_credential_id
       OR NEW.cancellation_reason IS DISTINCT FROM OLD.cancellation_reason
     ) THEN
    RAISE EXCEPTION 'approval cancellation evidence is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER approvals_evidence_immutability_guard
BEFORE UPDATE ON mandate.approvals
FOR EACH ROW EXECUTE FUNCTION mandate.guard_approval_evidence_immutability();

CREATE OR REPLACE FUNCTION mandate.validate_approval_operational_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_approval mandate.approvals%ROWTYPE;
BEGIN
  IF OLD.status = 'PENDING' AND NEW.status IN ('APPROVED', 'REJECTED', 'CANCELLED') THEN
    SELECT * INTO current_approval
      FROM mandate.approvals
     WHERE tenant_id = NEW.tenant_id
       AND environment = NEW.environment
       AND id = NEW.id;

    IF NEW.status IN ('APPROVED', 'REJECTED') THEN
      IF current_approval.decided_at IS NULL OR current_approval.decided_by_approver_id IS NULL THEN
        RAISE EXCEPTION 'approval decision requires authenticated approver identity';
      END IF;
      IF NOT EXISTS (
        SELECT 1
          FROM mandate.approval_assignments assignment
          JOIN mandate.approval_assignment_eligibility eligibility
            ON eligibility.tenant_id = assignment.tenant_id
           AND eligibility.environment = assignment.environment
           AND eligibility.assignment_id = assignment.id
          JOIN mandate.approver_identities identity
            ON identity.tenant_id = eligibility.tenant_id
           AND identity.environment = eligibility.environment
           AND identity.id = eligibility.approver_id
         WHERE assignment.tenant_id = NEW.tenant_id
           AND assignment.environment = NEW.environment
           AND assignment.approval_id = NEW.id
           AND assignment.status = 'ACTIVE'
           AND eligibility.approver_id = current_approval.decided_by_approver_id
           AND identity.status = 'ACTIVE'
      ) THEN
        RAISE EXCEPTION 'approval decision approver is not eligible for active assignment';
      END IF;
    ELSIF NEW.status = 'CANCELLED' THEN
      IF current_approval.cancelled_at IS NULL
         OR current_approval.cancelled_by_credential_id IS NULL
         OR current_approval.cancellation_reason IS NULL THEN
        RAISE EXCEPTION 'approval cancellation requires immutable operator evidence';
      END IF;
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER approvals_operational_transition_guard
AFTER UPDATE ON mandate.approvals
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION mandate.validate_approval_operational_transition();

CREATE OR REPLACE FUNCTION mandate.assign_idempotency_http_metadata()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.scope IN ('create-mandate', 'create-approval', 'issue-receipt', 'create-approver-identity', 'create-approver-group')
    OR NEW.scope LIKE 'supersede-receipt:%'
    OR NEW.scope LIKE 'bind-approver-credential:%'
    OR NEW.scope LIKE 'add-approver-group-member:%' THEN
    NEW.response_status := 201;
  ELSIF NEW.scope = 'authorize'
    OR NEW.scope = 'reserve-action-attempt'
    OR NEW.scope LIKE 'revoke-mandate:%'
    OR NEW.scope LIKE 'decide-approval:%'
    OR NEW.scope LIKE 'reassign-approval:%'
    OR NEW.scope LIKE 'cancel-approval:%'
    OR NEW.scope LIKE 'disable-approver:%'
    OR NEW.scope LIKE 'revoke-approver-binding:%'
    OR NEW.scope LIKE 'remove-approver-group-member:%'
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

INSERT INTO mandate.schema_migrations (version) VALUES ('011_approval_assignments');

COMMIT;
