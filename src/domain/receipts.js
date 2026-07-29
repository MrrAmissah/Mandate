import { createHash, randomUUID } from 'node:crypto';
import { canonicalize } from '../crypto/canonical-json.js';
import { DomainError } from './errors.js';
import { assertObject, requiredString, sha256String } from './validate.js';

const EXECUTION_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'PARTIAL']);
const SUPERSEDABLE_VERSIONS = new Set(['1.1', '1.2']);

function executionStatus(value) {
  const normalized = requiredString(value, 'executionStatus').toUpperCase();
  if (!EXECUTION_STATUSES.has(normalized)) {
    throw new DomainError('INVALID_REQUEST', 'executionStatus must be SUCCEEDED, FAILED, or PARTIAL.');
  }
  return normalized;
}

function optionalSignedString(value, name) {
  return value === null || value === undefined ? null : requiredString(value, name);
}

export function hashJson(value) {
  const digest = createHash('sha256').update(canonicalize(value)).digest('hex');
  return `sha256:${digest}`;
}

export function issueReceipt({ input, decision, mandate, signer, now = new Date() }) {
  assertObject(input);
  if (!decision) throw new DomainError('DECISION_NOT_FOUND', 'The authorization decision does not exist.', 404);
  if (decision.outcome !== 'ALLOW') {
    throw new DomainError('DECISION_NOT_ALLOWED', 'A receipt can only be issued for an ALLOW decision.', 409);
  }
  if (!mandate || mandate.id !== decision.mandateId) {
    throw new DomainError('MANDATE_NOT_FOUND', 'The underlying mandate does not exist.', 404);
  }
  const actionAttemptId = input.actionAttemptId
    ? requiredString(input.actionAttemptId, 'actionAttemptId')
    : null;
  if (!actionAttemptId && mandate.status !== 'ACTIVE') {
    throw new DomainError('MANDATE_NOT_ACTIVE', 'The underlying mandate is no longer active.', 409);
  }

  const payload = {
    id: `rcpt_${randomUUID()}`,
    version: actionAttemptId ? '1.1' : '1.0',
    keyId: signer.keyId,
    algorithm: signer.algorithm,
    decisionId: decision.id,
    mandateId: decision.mandateId,
    actionAttemptId,
    principalId: mandate.principalId,
    agentId: decision.agentId,
    action: decision.action,
    resource: decision.resource,
    executionStatus: executionStatus(input.executionStatus),
    inputHash: sha256String(input.inputHash, 'inputHash'),
    outputHash: sha256String(input.outputHash, 'outputHash'),
    tool: requiredString(input.tool, 'tool'),
    provider: input.provider ? requiredString(input.provider, 'provider') : null,
    model: input.model ? requiredString(input.model, 'model') : null,
    approvalId: decision.approvalId,
    authorizedAt: decision.evaluatedAt ?? null,
    executedAt: input.executedAt ? requiredString(input.executedAt, 'executedAt') : now.toISOString(),
    issuedAt: now.toISOString()
  };

  return { ...payload, signature: signer.signPayload(payload) };
}

export function issueSupersedingReceipt({ receipt, reason, signer, now = new Date() }) {
  assertObject(receipt, 'receipt');
  if (!SUPERSEDABLE_VERSIONS.has(receipt.version) || !receipt.actionAttemptId) {
    throw new DomainError(
      'RECEIPT_NOT_SUPERSEDABLE',
      'Only execution receipts with an action attempt can be superseded.',
      409
    );
  }

  const supersessionReason = requiredString(reason, 'reason');
  if (supersessionReason.length > 1000) {
    throw new DomainError('INVALID_REQUEST', 'reason must not exceed 1000 characters.');
  }

  const payload = {
    id: `rcpt_${randomUUID()}`,
    version: '1.2',
    keyId: signer.keyId,
    algorithm: signer.algorithm,
    decisionId: requiredString(receipt.decisionId, 'receipt.decisionId'),
    mandateId: requiredString(receipt.mandateId, 'receipt.mandateId'),
    actionAttemptId: requiredString(receipt.actionAttemptId, 'receipt.actionAttemptId'),
    principalId: requiredString(receipt.principalId, 'receipt.principalId'),
    agentId: requiredString(receipt.agentId, 'receipt.agentId'),
    action: requiredString(receipt.action, 'receipt.action'),
    resource: requiredString(receipt.resource, 'receipt.resource'),
    executionStatus: executionStatus(receipt.executionStatus),
    inputHash: sha256String(receipt.inputHash, 'receipt.inputHash'),
    outputHash: sha256String(receipt.outputHash, 'receipt.outputHash'),
    tool: requiredString(receipt.tool, 'receipt.tool'),
    provider: optionalSignedString(receipt.provider, 'receipt.provider'),
    model: optionalSignedString(receipt.model, 'receipt.model'),
    approvalId: receipt.approvalId ?? null,
    authorizedAt: receipt.authorizedAt ?? null,
    executedAt: requiredString(receipt.executedAt, 'receipt.executedAt'),
    issuedAt: now.toISOString(),
    supersedesReceiptId: requiredString(receipt.id, 'receipt.id'),
    supersessionReason
  };

  return { ...payload, signature: signer.signPayload(payload) };
}

function verificationParts(receipt) {
  assertObject(receipt, 'receipt');
  const { signature, ...payload } = receipt;
  if (typeof signature !== 'string' || signature.length === 0) return null;
  if (typeof payload.keyId !== 'string' || typeof payload.algorithm !== 'string') return null;
  return { payload, signature };
}

export function verifyReceipt(receipt, signer) {
  const parts = verificationParts(receipt);
  if (!parts) return false;
  if (parts.payload.keyId !== signer.keyId || parts.payload.algorithm !== signer.algorithm) return false;
  return signer.verifyPayload(parts.payload, parts.signature);
}

export async function verifyReceiptWithRegistry(receipt, signingKeys, verificationContext = {}) {
  const parts = verificationParts(receipt);
  if (!parts || typeof signingKeys?.verifyPayload !== 'function') return false;
  return Boolean(await signingKeys.verifyPayload({
    ...verificationContext,
    keyId: parts.payload.keyId,
    algorithm: parts.payload.algorithm,
    payload: parts.payload,
    signature: parts.signature
  }));
}
