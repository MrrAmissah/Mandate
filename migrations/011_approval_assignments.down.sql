BEGIN;

DROP TRIGGER IF EXISTS approvals_operational_transition_guard ON mandate.approvals;
DROP FUNCTION IF EXISTS mandate.guard_approval_operational_transition();
DROP TRIGGER IF EXISTS approval_assignment_eligibility_immutable ON mandate.approval_assignment_eligibility;

ALTER TABLE mandate.approvals
  DROP CONSTRAINT IF EXISTS approvals_cancelled_by_credential_fk,
  DROP CONSTRAINT IF EXISTS approvals_decided_by_approver_fk,
  DROP COLUMN IF EXISTS cancellation_reason,
  DROP COLUMN IF EXISTS cancelled_by_credential_id,
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS decided_by_approver_id;

DROP TABLE IF EXISTS mandate.approval_assignment_eligibility;
DROP TABLE IF EXISTS mandate.approval_assignments;
DROP TABLE IF EXISTS mandate.approver_group_memberships;
DROP TABLE IF EXISTS mandate.approver_groups;
DROP TABLE IF EXISTS mandate.approver_credential_bindings;
DROP TABLE IF EXISTS mandate.approver_identities;

DELETE FROM mandate.schema_migrations WHERE version = '011_approval_assignments';

COMMIT;
