import { createReservedActionAttempt, parseActionAttemptRequest } from '../domain/action-attempts.js';
import { DomainError } from '../domain/errors.js';
import {
  findActionAttemptByDecision,
  findReceiptByDecision,
  lockDecisionForAttempt,
  saveActionAttempt
} from '../store/action-attempts.js';

export async function reserveActionAttempt({
  transaction,
  ownership,
  authentication,
  input,
  requestId,
  now = new Date()
}) {
  const parsed = parseActionAttemptRequest(input);
  const decision = await lockDecisionForAttempt(transaction, ownership, parsed.decisionId);
  if (!decision) throw new DomainError('DECISION_NOT_FOUND', 'The authorization decision does not exist.', 404);

  const existing = await findActionAttemptByDecision(transaction, ownership, decision.id);
  if (existing) {
    throw new DomainError(
      'ACTION_ATTEMPT_ALREADY_RESERVED',
      'This authorization decision has already been reserved for execution.',
      409,
      { actionAttemptId: existing.id }
    );
  }

  if (await findReceiptByDecision(transaction, ownership, decision.id)) {
    throw new DomainError(
      'DECISION_ALREADY_RECEIPTED',
      'This authorization decision already has an execution receipt.',
      409
    );
  }

  const mandate = await transaction.get('mandates', ownership, decision.mandateId);
  return saveActionAttempt(transaction, ownership, createReservedActionAttempt({
    input: parsed,
    decision,
    mandate,
    authentication,
    requestId,
    now
  }));
}
