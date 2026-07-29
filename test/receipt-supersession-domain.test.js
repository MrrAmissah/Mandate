import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import {
  issueReceipt,
  issueSupersedingReceipt,
  verifyReceipt
} from '../src/domain/receipts.js';

const hashes = {
  inputHash: `sha256:${'1'.repeat(64)}`,
  outputHash: `sha256:${'2'.repeat(64)}`
};

function rootReceipt(signer) {
  return issueReceipt({
    input: {
      actionAttemptId: 'att_supersession_domain',
      executionStatus: 'SUCCEEDED',
      ...hashes,
      tool: 'github.create_commit',
      provider: 'github',
      model: 'agent-v1',
      executedAt: '2026-07-29T18:00:00.000Z'
    },
    decision: {
      id: 'dec_supersession_domain',
      mandateId: 'mnd_supersession_domain',
      agentId: 'agent_supersession',
      action: 'repository.write',
      resource: 'github:MrrAmissah/Mandate',
      outcome: 'ALLOW',
      approvalId: null,
      evaluatedAt: '2026-07-29T17:59:00.000Z'
    },
    mandate: {
      id: 'mnd_supersession_domain',
      principalId: 'principal_supersession',
      status: 'ACTIVE'
    },
    signer,
    now: new Date('2026-07-29T18:01:00.000Z')
  });
}

const immutableEvidenceFields = [
  'decisionId',
  'mandateId',
  'actionAttemptId',
  'principalId',
  'agentId',
  'action',
  'resource',
  'executionStatus',
  'inputHash',
  'outputHash',
  'tool',
  'provider',
  'model',
  'approvalId',
  'authorizedAt',
  'executedAt'
];

test('receipt supersession preserves execution evidence and signs a v1.2 chain node', () => {
  const originalSigner = createReceiptSigner({ keyId: 'key_supersession_original' });
  const currentSigner = createReceiptSigner({ keyId: 'key_supersession_current' });
  const original = rootReceipt(originalSigner);

  const successor = issueSupersedingReceipt({
    receipt: original,
    reason: '  Rotate the receipt onto the current signing key.  ',
    signer: currentSigner,
    now: new Date('2026-07-29T18:02:00.000Z')
  });

  assert.equal(successor.version, '1.2');
  assert.equal(successor.supersedesReceiptId, original.id);
  assert.equal(successor.supersessionReason, 'Rotate the receipt onto the current signing key.');
  assert.equal(successor.keyId, currentSigner.keyId);
  assert.notEqual(successor.id, original.id);
  for (const field of immutableEvidenceFields) {
    assert.deepEqual(successor[field], original[field], field);
  }
  assert.equal(verifyReceipt(original, originalSigner), true);
  assert.equal(verifyReceipt(successor, currentSigner), true);
  assert.equal(verifyReceipt({ ...successor, supersessionReason: 'tampered' }, currentSigner), false);
  assert.equal(verifyReceipt({ ...successor, supersedesReceiptId: 'rcpt_other' }, currentSigner), false);
});

test('successors form a direct linear chain without copying predecessor correction metadata', () => {
  const signer = createReceiptSigner({ keyId: 'key_supersession_chain' });
  const root = rootReceipt(signer);
  const first = issueSupersedingReceipt({ receipt: root, reason: 'First correction', signer });
  const second = issueSupersedingReceipt({ receipt: first, reason: 'Second correction', signer });

  assert.equal(first.supersedesReceiptId, root.id);
  assert.equal(second.supersedesReceiptId, first.id);
  assert.equal(second.supersessionReason, 'Second correction');
  assert.equal(Object.hasOwn(second, 'previousSupersessionReason'), false);
  for (const field of immutableEvidenceFields) {
    assert.deepEqual(second[field], root[field], field);
  }
});

test('legacy receipts and Unicode reason bounds fail or succeed consistently', () => {
  const signer = createReceiptSigner({ keyId: 'key_supersession_rejections' });
  const root = rootReceipt(signer);
  const legacy = {
    ...root,
    version: '1.0',
    actionAttemptId: null
  };

  assert.throws(
    () => issueSupersedingReceipt({ receipt: legacy, reason: 'Not supported', signer }),
    (error) => error.code === 'RECEIPT_NOT_SUPERSEDABLE' && error.status === 409
  );

  const validEmojiReason = '😀'.repeat(600);
  const unicodeSuccessor = issueSupersedingReceipt({
    receipt: root,
    reason: validEmojiReason,
    signer
  });
  assert.equal(unicodeSuccessor.supersessionReason, validEmojiReason);
  assert.equal(verifyReceipt(unicodeSuccessor, signer), true);

  for (const reason of ['x'.repeat(1001), '😀'.repeat(1001)]) {
    assert.throws(
      () => issueSupersedingReceipt({ receipt: root, reason, signer }),
      (error) => error.code === 'INVALID_REQUEST'
    );
  }
});
