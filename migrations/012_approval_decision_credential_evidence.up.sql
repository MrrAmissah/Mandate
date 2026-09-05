BEGIN;

CREATE OR REPLACE FUNCTION mandate.validate_approval_operational_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_approval mandate.approvals%ROWTYPE;
  matched_assignment_id text;
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

INSERT INTO mandate.schema_migrations (version)
VALUES ('012_approval_decision_credential_evidence');

COMMIT;
