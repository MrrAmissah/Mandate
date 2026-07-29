import { DomainError } from './errors.js';
import { assertObject, requiredString, sha256String } from './validate.js';

function assertReservableState(attempt, now) {
  if (!attempt) throw new DomainError('ACTION_ATTEMPT_NOT_FOUND', 'The action attempt does not exist.', 404);
  if (attempt.status !== 'RESERVED') {
    throw new DomainError(
      'ACTION_ATTEMPT_ALREADY_TERMINAL',
      'The action attempt is already terminal.',
      409,
      { status: attempt.status }
    );
  }
  if (Date.parse(attempt.expiresAt) <= now.getTime()) {
    throw new DomainError('ACTION_ATTEMPT_EXPIRED', 'The action attempt reservation has expired.', 409);
  }
}

export function parseAttemptCompletion(input) {
  assertObject(input);
  const executionStatus = requiredString(input.executionStatus, 'executionStatus').toUpperCase();
  if (!['SUCCEEDED', 'FAILED', 'PARTIAL'].includes(executionStatus)) {
    throw new DomainError('INVALID_REQUEST', 'executionStatus must be SUCCEEDED, FAILED, or PARTIAL.');
  }
  return Object.freeze({
    executionStatus,
    inputHash: sha256String(input.inputHash, 'inputHash'),
    outputHash: sha256String(input.outputHash, 'outputHash'),
    tool: requiredString(input.tool, 'tool'),
    provider: input.provider ? requiredString(input.provider, 'provider') : null,
    model: input.model ? requiredString(input.model, 'model') : null
  });
}

export function completeActionAttempt(attempt, input, requestId, now = new Date()) {
  assertReservableState(attempt, now);
  const completion = parseAttemptCompletion(input);
  return Object.freeze({
    ...attempt,
    status: 'COMPLETED',
    ...completion,
    completedAt: now.toISOString(),
    completionRequestId: requestId,
    terminatedAt: null,
    terminationReason: null,
    terminationRequestId: null,
    version: attempt.version + 1
  });
}

export function cancelActionAttempt(attempt, input, requestId, now = new Date()) {
  assertReservableState(attempt, now);
  assertObject(input);
  const reason = requiredString(input.reason, 'reason');
  return Object.freeze({
    ...attempt,
    status: 'CANCELLED',
    executionStatus: null,
    inputHash: null,
    outputHash: null,
    tool: null,
    provider: null,
    model: null,
    completedAt: null,
    completionRequestId: null,
    terminatedAt: now.toISOString(),
    terminationReason: reason,
    terminationRequestId: requestId,
    version: attempt.version + 1
  });
}
