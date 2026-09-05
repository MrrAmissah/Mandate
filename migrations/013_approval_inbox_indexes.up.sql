BEGIN;

CREATE INDEX approval_assignment_eligibility_inbox_idx
  ON mandate.approval_assignment_eligibility
    (tenant_id, environment, approver_id, assignment_id);

CREATE INDEX approvals_pending_inbox_order_idx
  ON mandate.approvals (tenant_id, environment, requested_at, id)
  WHERE status = 'PENDING';

INSERT INTO mandate.schema_migrations (version)
VALUES ('013_approval_inbox_indexes');

COMMIT;
