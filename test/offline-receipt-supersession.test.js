import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import { issueReceipt, issueSupersedingReceipt } from '../src/domain/receipts.js';
import { verifyMandateReceipt } from '../packages/receipt-verifier/index.js';

function verificationKey(signer, status = 'ACTIVE') {
  return {
    keyId: signer.keyId,
    algorithm: signer.algorithm,
    publicKeyPem: signer.publicKeyPem,
    status
  };
}

test('offline verification covers signed v1.2 predecessor references and reasons', () => {
  const rootSigner = createReceiptSigner({ keyId: 'key_offline_supersession_root' });
  const successorSigner = createReceiptSigner({ keyId: 'key_offline_supersession_current' });
  const root = issueReceipt({
    input: {
      actionAttemptId: 'att_offline_supersession',
      executionStatus: 'SUCCEEDED',
      inputHash: `sha256:${'1'.repeat(64)}`,
      outputHash: `sha256:${'2'.repeat(64)}`,
      tool: 'github.create_commit',
      executedAt: '2026-07-29T18:00:00.000Z'
    },
    decision: {
      id: 'dec_offline_supersession',
      mandateId: 'mnd_offline_supersession',
      agentId: 'agent_offline_supersession',
      action: 'repository.write',
      resource: 'github:MrrAmissah/Mandate',
      outcome: 'ALLOW',
      approvalId: null,
      evaluatedAt: '2026-07-29T17:59:00.000Z'
    },
    mandate: {
      id: 'mnd_offline_supersession',
      principalId: 'principal_offline_supersession',
      status: 'ACTIVE'
    },
    signer: rootSigner,
    now: new Date('2026-07-29T18:01:00.000Z')
  });
  const successor = issueSupersedingReceipt({
    receipt: root,
    reason: 'Reissue under the current signing key.',
    signer: successorSigner,
    now: new Date('2026-07-29T18:02:00.000Z')
  });
  const keys = {
    keys: [verificationKey(rootSigner, 'RETIRED'), verificationKey(successorSigner)]
  };

  assert.equal(verifyMandateReceipt(root, keys).valid, true);
  assert.equal(verifyMandateReceipt(successor, keys).valid, true);
  assert.equal(
    verifyMandateReceipt({ ...successor, supersessionReason: 'changed' }, keys).reason,
    'INVALID_SIGNATURE'
  );
  assert.equal(
    verifyMandateReceipt({ ...successor, supersedesReceiptId: 'rcpt_changed' }, keys).reason,
    'INVALID_SIGNATURE'
  );
});
