BEGIN;

DROP INDEX IF EXISTS mandate.approvals_pending_inbox_order_idx;
DROP INDEX IF EXISTS mandate.approval_assignment_eligibility_inbox_idx;

DELETE FROM mandate.schema_migrations
WHERE version = '013_approval_inbox_indexes';

COMMIT;
