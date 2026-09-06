BEGIN;

ALTER TABLE mandate.approvals
  ADD COLUMN expired_at timestamptz,
  ADD COLUMN expiration_reason text,
  ADD COLUMN expiration_request_id text,
  ADD CONSTRAINT approvals_expiry_evidence_shape CHECK (
    (status = 'EXPIRED'
      AND expired_at IS NOT NULL
      AND expiration_reason = 'DEADLINE_ELAPSED'
      AND expiration_request_id IS NOT NULL)
    OR
    (status <> 'EXPIRED'
      AND expired_at IS NULL
      AND expiration_reason IS NULL
      AND expiration_request_id IS NULL)
  );

ALTER TABLE mandate.approval_assignments
  DROP CONSTRAINT IF EXISTS approval_assignments_status_check,
  DROP CONSTRAINT IF EXISTS approval_assignments_check,
  ADD CONSTRAINT approval_assignments_status_check
    CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'CANCELLED', 'EXPIRED')),
  ADD CONSTRAINT approval_assignments_terminal_shape_check CHECK (
    (status = 'ACTIVE' AND ended_at IS NULL AND end_reason IS NULL)
    OR
    (status IN ('SUPERSEDED', 'CANCELLED', 'EXPIRED') AND ended_at IS NOT NULL AND end_reason IS NOT NULL)
  );

CREATE INDEX approvals_expiring_scope_idx
  ON mandate.approvals (environment, tenant_id, expires_at, id)
  WHERE status IN ('PENDING', 'APPROVED') AND expires_at IS NOT NULL;

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

  IF OLD.expired_at IS NOT NULL AND (
       NEW.expired_at IS DISTINCT FROM OLD.expired_at
       OR NEW.expiration_reason IS DISTINCT FROM OLD.expiration_reason
       OR NEW.expiration_request_id IS DISTINCT FROM OLD.expiration_request_id
     ) THEN
    RAISE EXCEPTION 'approval expiry evidence is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION mandate.validate_approval_assignment_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_approval mandate.approvals%ROWTYPE;
BEGIN
  SELECT * INTO source_approval
    FROM mandate.approvals
   WHERE tenant_id = NEW.tenant_id
     AND environment = NEW.environment
     AND id = NEW.approval_id;

  IF source_approval.id IS NULL
     OR source_approval.status <> 'PENDING'
     OR (source_approval.expires_at IS NOT NULL AND source_approval.expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'approval is unavailable for a new active assignment';
  END IF;

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

CREATE OR REPLACE FUNCTION mandate.validate_approval_operational_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_approval mandate.approvals%ROWTYPE;
  matched_assignment_id text;
  expired_assignment_id text;
BEGIN
  IF NEW.status = 'EXPIRED' AND OLD.status IN ('PENDING', 'APPROVED') THEN
    SELECT * INTO current_approval
      FROM mandate.approvals
     WHERE tenant_id = NEW.tenant_id
       AND environment = NEW.environment
       AND id = NEW.id;

    IF current_approval.expires_at IS NULL
       OR current_approval.expires_at > clock_timestamp()
       OR current_approval.expired_at IS NULL
       OR current_approval.expired_at < current_approval.expires_at
       OR current_approval.expiration_reason <> 'DEADLINE_ELAPSED'
       OR current_approval.expiration_request_id IS NULL THEN
      RAISE EXCEPTION 'approval expiry requires a reached deadline and immutable expiry evidence';
    END IF;

    SELECT assignment.id INTO expired_assignment_id
      FROM mandate.approval_assignments assignment
     WHERE assignment.tenant_id = NEW.tenant_id
       AND assignment.environment = NEW.environment
       AND assignment.approval_id = NEW.id
       AND assignment.status = 'EXPIRED'
       AND assignment.ended_at = current_approval.expired_at
       AND assignment.end_reason = 'APPROVAL_EXPIRED'
     ORDER BY assignment.assigned_at DESC, assignment.id
     LIMIT 1;

    IF EXISTS (
      SELECT 1 FROM mandate.approval_assignments assignment
       WHERE assignment.tenant_id = NEW.tenant_id
         AND assignment.environment = NEW.environment
         AND assignment.approval_id = NEW.id
         AND assignment.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'expired approval cannot retain an active assignment';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM mandate.audit_events event
       WHERE event.tenant_id = NEW.tenant_id
         AND event.environment = NEW.environment
         AND event.type = 'approval.expired'
         AND event.object_type = 'approval'
         AND event.object_id = NEW.id
         AND event.actor_type = 'SYSTEM'
         AND event.request_id = current_approval.expiration_request_id
         AND event.data ->> 'previousStatus' = OLD.status
         AND event.data ->> 'reason' = 'DEADLINE_ELAPSED'
         AND event.data ->> 'expiresAt' = to_char(current_approval.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         AND event.data ->> 'expiredAt' = to_char(current_approval.expired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         AND (
           (expired_assignment_id IS NULL AND event.data ->> 'assignmentId' IS NULL)
           OR event.data ->> 'assignmentId' = expired_assignment_id
         )
    ) THEN
      RAISE EXCEPTION 'approval expiry requires immutable system audit evidence';
    END IF;

  ELSIF OLD.status = 'PENDING' AND NEW.status IN ('APPROVED', 'REJECTED', 'CANCELLED') THEN
    SELECT * INTO current_approval
      FROM mandate.approvals
     WHERE tenant_id = NEW.tenant_id
       AND environment = NEW.environment
       AND id = NEW.id;

    IF NEW.status IN ('APPROVED', 'REJECTED') THEN
      IF current_approval.expires_at IS NOT NULL AND current_approval.expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION 'approval decision cannot commit after expiry deadline';
      END IF;
      IF current_approval.decided_at IS NULL OR current_approval.decided_by_approver_id IS NULL THEN
        RAISE EXCEPTION 'approval decision requires authenticated approver identity';
      END IF;

      SELECT assignment.id INTO matched_assignment_id
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
       LIMIT 1;

      IF matched_assignment_id IS NULL THEN
        RAISE EXCEPTION 'approval decision approver is not eligible for active assignment';
      END IF;

      IF NOT EXISTS (
        SELECT 1
          FROM mandate.audit_events event
          JOIN mandate.approver_credential_bindings binding
            ON binding.tenant_id = event.tenant_id
           AND binding.environment = event.environment
           AND binding.approver_id = event.actor_id
           AND binding.credential_id = event.data ->> 'credentialId'
          JOIN mandate.api_credentials credential
            ON credential.tenant_id = binding.tenant_id
           AND credential.environment = binding.environment
           AND credential.id = binding.credential_id
         WHERE event.tenant_id = NEW.tenant_id
           AND event.environment = NEW.environment
           AND event.type = 'approval.decided'
           AND event.object_type = 'approval'
           AND event.object_id = NEW.id
           AND event.actor_type = 'APPROVER'
           AND event.actor_id = current_approval.decided_by_approver_id
           AND event.data ->> 'approverId' = current_approval.decided_by_approver_id
           AND event.data ->> 'assignmentId' = matched_assignment_id
           AND binding.status = 'ACTIVE'
           AND credential.status = 'ACTIVE'
           AND credential.revoked_at IS NULL
           AND (credential.expires_at IS NULL OR credential.expires_at > current_approval.decided_at)
      ) THEN
        RAISE EXCEPTION 'approval decision requires authenticated credential evidence';
      END IF;
    ELSE
      IF current_approval.expires_at IS NOT NULL AND current_approval.expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION 'approval cancellation cannot commit after expiry deadline';
      END IF;
      IF current_approval.cancelled_at IS NULL
         OR current_approval.cancelled_by_credential_id IS NULL
         OR current_approval.cancellation_reason IS NULL THEN
        RAISE EXCEPTION 'approval cancellation requires immutable operator evidence';
      END IF;
    END IF;

  ELSIF OLD.status = 'APPROVED' AND NEW.status = 'CONSUMED' THEN
    SELECT * INTO current_approval
      FROM mandate.approvals
     WHERE tenant_id = NEW.tenant_id
       AND environment = NEW.environment
       AND id = NEW.id;
    IF current_approval.expires_at IS NOT NULL AND current_approval.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'approval consumption cannot commit after expiry deadline';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

INSERT INTO mandate.schema_migrations (version)
VALUES ('014_approval_expiry');

COMMIT;
