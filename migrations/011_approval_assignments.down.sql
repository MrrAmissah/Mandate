BEGIN;

DROP TRIGGER IF EXISTS approvals_operational_transition_guard ON mandate.approvals;
DROP FUNCTION IF EXISTS mandate.validate_approval_operational_transition();
DROP TRIGGER IF EXISTS approvals_evidence_immutability_guard ON mandate.approvals;
DROP FUNCTION IF EXISTS mandate.guard_approval_evidence_immutability();
DROP TRIGGER IF EXISTS approval_assignment_eligibility_immutable ON mandate.approval_assignment_eligibility;
DROP TRIGGER IF EXISTS approval_assignment_eligibility_source_guard ON mandate.approval_assignment_eligibility;
DROP FUNCTION IF EXISTS mandate.validate_approval_assignment_eligibility();
DROP TRIGGER IF EXISTS approval_assignments_source_guard ON mandate.approval_assignments;
DROP FUNCTION IF EXISTS mandate.validate_approval_assignment_source();
DROP TRIGGER IF EXISTS approval_assignments_history_guard ON mandate.approval_assignments;
DROP TRIGGER IF EXISTS approver_group_memberships_history_guard ON mandate.approver_group_memberships;
DROP TRIGGER IF EXISTS approver_groups_history_guard ON mandate.approver_groups;
DROP TRIGGER IF EXISTS approver_credential_bindings_history_guard ON mandate.approver_credential_bindings;
DROP TRIGGER IF EXISTS approver_identities_history_guard ON mandate.approver_identities;
DROP FUNCTION IF EXISTS mandate.guard_approval_authority_history();

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
