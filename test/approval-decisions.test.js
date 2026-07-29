import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalRequest, decideApproval } from '../src/domain/approvals.js';

const now = new Date('2026-07-29T06:00:00.000Z');

test('approval decisions allow one-click approval without a reason', () => {
  const pending = createApprovalRequest({
    mandateId: 'mnd_example',
    agentId: 'agent_coder',
    action: 'repository.read',
    resource: 'github:owner/repository',
    summary: 'Approve repository inspection'
  }, now);

  const decided = decideApproval(pending, {
    decision: 'APPROVED',
    decidedBy: 'principal_owner'
  }, now);

  assert.equal(decided.status, 'APPROVED');
  assert.equal(decided.decisionReason, null);
});
