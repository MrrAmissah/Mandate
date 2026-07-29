import { completeActionAttempt, cancelActionAttempt } from '../domain/action-attempt-transitions.js';
import { issueReceipt } from '../domain/receipts.js';
import { DomainError } from '../domain/errors.js';
import { assertObject, requiredString } from '../domain/validate.js';
import {
  findReceiptByAttempt,
  findReceiptByDecision,
  lockActionAttempt,
  saveReceiptForAttempt,
  updateActionAttempt
} from '../store/action-attempts.js';

export async function completeAttempt({ transaction, ownership, attemptId, input, requestId, now = new Date() }) {
  const attempt = await lockActionAttempt(transaction, ownership, attemptId);
  return updateActionAttempt(
    transaction,
    ownership,
    completeActionAttempt(attempt, input, requestId, now)
  );
}

export async function cancelAttempt({ transaction, ownership, attemptId, input, requestId, now = new Date() }) {
  const attempt = await lockActionAttempt(transaction, ownership, attemptId);
  return updateActionAttempt(
    transaction,
    ownership,
    cancelActionAttempt(attempt, input, requestId, now)
  );
}

export async function issueAttemptReceipt({
  transaction,
  ownership,
  input,
  signer,
  now = new Date()
}) {
  assertObject(input);
  const actionAttemptId = requiredString(input.actionAttemptId, 'actionAttemptId');
  const attempt = await lockActionAttempt(transaction, ownership, actionAttemptId);
  if (!attempt) throw new DomainError('ACTION_ATTEMPT_NOT_FOUND', 'The action attempt does not exist.', 404);
  if (attempt.status !== 'COMPLETED') {
    throw new DomainError(
      'ACTION_ATTEMPT_NOT_COMPLETED',
      'A receipt can only be issued for a completed action attempt.',
      409,
      { status: attempt.status }
    );
  }
  if (await findReceiptByAttempt(transaction, ownership, actionAttemptId)
    || await findReceiptByDecision(transaction, ownership, attempt.decisionId)) {
    throw new DomainError('RECEIPT_ALREADY_EXISTS', 'This action attempt already has a receipt.', 409);
  }

  const decision = await transaction.get('decisions', ownership, attempt.decisionId);
  const mandate = decision
    ? await transaction.get('mandates', ownership, decision.mandateId)
    : null;
  const receipt = issueReceipt({
    input: {
      actionAttemptId,
      executionStatus: attempt.executionStatus,
      inputHash: attempt.inputHash,
      outputHash: attempt.outputHash,
      tool: attempt.tool,
      provider: attempt.provider,
      model: attempt.model,
      executedAt: attempt.completedAt
    },
    decision,
    mandate,
    signer,
    now
  });
  return saveReceiptForAttempt(transaction, ownership, receipt);
}
