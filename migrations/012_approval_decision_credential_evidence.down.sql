BEGIN;

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

DELETE FROM mandate.schema_migrations
WHERE version = '012_approval_decision_credential_evidence';

COMMIT;
