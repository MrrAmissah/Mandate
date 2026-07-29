import test from 'node:test';
import assert from 'node:assert/strict';
import { createMandate, revokeMandate } from '../src/domain/mandates.js';
import { evaluateAuthorization } from '../src/domain/authorization.js';
import { createApprovalRequest, decideApproval } from '../src/domain/approvals.js';

const fixedNow = new Date('2026-07-29T06:00:00.000Z');

function baseMandate(overrides = {}) {
  return createMandate({
    principalId: 'user_prince',
    agentId: 'agent_coder',
    purpose: 'Prepare a draft pull request',
    resources: ['github:MrrAmissah/demo*'],
    allowedActions: ['repository.read', 'branch.create', 'commit.create', 'pull_request.create_draft'],
    deniedActions: ['pull_request.merge', 'repository.settings.*'],
    approvalRequiredActions: ['commit.create'],
    validUntil: '2026-07-30T06:00:00.000Z',
    ...overrides
  }, fixedNow);
}

function request(mandate, overrides = {}) {
  return {
    mandateId: mandate.id,
    agentId: 'agent_coder',
    action: 'repository.read',
    resource: 'github:MrrAmissah/demo-api',
    approvalId: null,
    context: {},
    ...overrides
  };
}

test('explicit deny overrides every allow rule', () => {
  const mandate = baseMandate({ allowedActions: ['*'] });
  const decision = evaluateAuthorization({
    mandate,
    request: request(mandate, { action: 'pull_request.merge' }),
    now: fixedNow
  });
  assert.equal(decision.outcome, 'DENY');
  assert.equal(decision.reasonCode, 'EXPLICITLY_DENIED');
});

test('approval-gated action returns REQUIRE_APPROVAL without a valid approval', () => {
  const mandate = baseMandate();
  const decision = evaluateAuthorization({
    mandate,
    request: request(mandate, { action: 'commit.create' }),
    now: fixedNow
  });
  assert.equal(decision.outcome, 'REQUIRE_APPROVAL');
});

test('matching approved request unlocks the gated action', () => {
  const mandate = baseMandate();
  const pending = createApprovalRequest({
    mandateId: mandate.id,
    agentId: 'agent_coder',
    action: 'commit.create',
    resource: 'github:MrrAmissah/demo-api',
    summary: 'Commit the reviewed implementation',
    expiresAt: '2026-07-29T07:00:00.000Z'
  }, fixedNow);
  const approval = decideApproval(pending, {
    decision: 'APPROVED',
    decidedBy: 'user_prince',
    reason: 'Reviewed and approved'
  }, fixedNow);

  const decision = evaluateAuthorization({
    mandate,
    approval,
    request: request(mandate, { action: 'commit.create', approvalId: approval.id }),
    now: fixedNow
  });
  assert.equal(decision.outcome, 'ALLOW');
  assert.equal(decision.approvalId, approval.id);
});

test('revoked mandates deny future actions', () => {
  const mandate = revokeMandate(baseMandate(), 'Task cancelled', fixedNow);
  const decision = evaluateAuthorization({ mandate, request: request(mandate), now: fixedNow });
  assert.equal(decision.outcome, 'DENY');
  assert.equal(decision.reasonCode, 'MANDATE_REVOKED');
});

test('resource wildcards remain scoped to the delegated prefix', () => {
  const mandate = baseMandate();
  const decision = evaluateAuthorization({
    mandate,
    request: request(mandate, { resource: 'github:someone-else/production' }),
    now: fixedNow
  });
  assert.equal(decision.outcome, 'DENY');
  assert.equal(decision.reasonCode, 'RESOURCE_OUT_OF_SCOPE');
});
