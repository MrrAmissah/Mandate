import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import { createMandate } from '../src/domain/mandates.js';
import { issueReceipt, verifyReceipt } from '../src/domain/receipts.js';

const now = new Date('2026-07-29T06:00:00.000Z');

test('receipt signatures verify and fail after tampering', () => {
  const signer = createReceiptSigner({ keyId: 'test-key' });
  const mandate = createMandate({
    principalId: 'user_prince',
    agentId: 'agent_coder',
    purpose: 'Create a draft PR',
    resources: ['github:MrrAmissah/demo-api'],
    allowedActions: ['pull_request.create_draft']
  }, now);
  const decision = {
    id: 'dec_test',
    mandateId: mandate.id,
    agentId: mandate.agentId,
    action: 'pull_request.create_draft',
    resource: 'github:MrrAmissah/demo-api',
    outcome: 'ALLOW',
    approvalId: null
  };
  const hash = `sha256:${'a'.repeat(64)}`;
  const receipt = issueReceipt({
    decision,
    mandate,
    signer,
    now,
    input: {
      executionStatus: 'SUCCEEDED',
      inputHash: hash,
      outputHash: hash,
      tool: 'github.create_pull_request',
      provider: 'github'
    }
  });

  assert.equal(verifyReceipt(receipt, signer), true);
  assert.equal(verifyReceipt({ ...receipt, resource: 'github:other/repo' }, signer), false);
});
