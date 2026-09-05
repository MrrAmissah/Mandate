BEGIN;

DROP INDEX IF EXISTS mandate.approvals_pending_inbox_order_idx;
DROP INDEX IF EXISTS mandate.approval_assignment_eligibility_inbox_idx;

COMMIT;
