import { randomUUID } from 'node:crypto';
import { DomainError } from './errors.js';
import { assertObject, requiredString } from './validate.js';

const DEFAULT_RESERVATION_SECONDS = 300;
const MIN_RESERVATION_SECONDS = 30;
const MAX_RESERVATION_SECONDS = 900;

function reservationSeconds(value) {
  const seconds = value ?? DEFAULT_RESERVATION_SECONDS;
  if (!Number.isInteger(seconds) || seconds < MIN_RESERVATION_SECONDS || seconds > MAX_RESERVATION_SECONDS) {
    throw new DomainError(
      'INVALID_RESERVATION_WINDOW',
      `expiresInSeconds must be an integer between ${MIN_RESERVATION_SECONDS} and ${MAX_RESERVATION_SECONDS}.`,
      400
    );
  }
  return seconds;
}

export function parseActionAttemptRequest(input) {
  assertObject(input);
  return Object.freeze({
    decisionId: requiredString(input.decisionId, 'decisionId'),
    expiresInSeconds: reservationSeconds(input.expiresInSeconds)
  });
}

export function createReservedActionAttempt({
  input,
  decision,
  mandate,
  authentication,
  requestId,
  now = new Date()
}) {
  const parsed = parseActionAttemptRequest(input);
  if (!decision || decision.id !== parsed.decisionId) {
    throw new DomainError('DECISION_NOT_FOUND', 'The authorization decision does not exist.', 404);
  }
  if (decision.outcome !== 'ALLOW') {
    throw new DomainError(
      'DECISION_NOT_ALLOWED',
      'Only an ALLOW decision can be reserved for execution.',
      409
    );
  }
  if (!mandate || mandate.id !== decision.mandateId || mandate.status !== 'ACTIVE') {
    throw new DomainError('MANDATE_NOT_ACTIVE', 'The underlying mandate is no longer active.', 409);
  }
  if (mandate.validUntil && Date.parse(mandate.validUntil) <= now.getTime()) {
    throw new DomainError('MANDATE_NOT_ACTIVE', 'The underlying mandate is no longer active.', 409);
  }

  const reservedAt = now.toISOString();
  return Object.freeze({
    id: `att_${randomUUID()}`,
    decisionId: decision.id,
    mandateId: decision.mandateId,
    agentId: decision.agentId,
    action: decision.action,
    resource: decision.resource,
    status: 'RESERVED',
    reservedByCredentialId: authentication.credentialId,
    reservedAt,
    expiresAt: new Date(now.getTime() + parsed.expiresInSeconds * 1000).toISOString(),
    requestId,
    version: 0
  });
}
