import { createHash, randomUUID } from 'node:crypto';
import { canonicalize } from '../crypto/canonical-json.js';
import { DomainError } from './errors.js';
import { assertObject, requiredString, sha256String } from './validate.js';

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
  if (!mandate || mandate.id !== decision.mandateId || mandate.status !== 'ACTIVE') {
    throw new DomainError('MANDATE_NOT_ACTIVE', 'The underlying mandate is no longer active.', 409);
  }

  const payload = {
    id: `rcpt_${randomUUID()}`,
    version: '1.0',
    keyId: signer.keyId,
    algorithm: signer.algorithm,
    decisionId: decision.id,
    mandateId: decision.mandateId,
    principalId: mandate.principalId,
    agentId: decision.agentId,
    action: decision.action,
    resource: decision.resource,
    executionStatus: requiredString(input.executionStatus, 'executionStatus').toUpperCase(),
    inputHash: sha256String(input.inputHash, 'inputHash'),
    outputHash: sha256String(input.outputHash, 'outputHash'),
    tool: requiredString(input.tool, 'tool'),
    provider: input.provider ? requiredString(input.provider, 'provider') : null,
    model: input.model ? requiredString(input.model, 'model') : null,
    approvalId: decision.approvalId,
    authorizedAt: decision.evaluatedAt ?? null,
    executedAt: now.toISOString(),
    issuedAt: now.toISOString()
  };

  if (!['SUCCEEDED', 'FAILED', 'PARTIAL'].includes(payload.executionStatus)) {
    throw new DomainError('INVALID_REQUEST', 'executionStatus must be SUCCEEDED, FAILED, or PARTIAL.');
  }

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

export async function verifyReceiptWithRegistry(receipt, signingKeys) {
  const parts = verificationParts(receipt);
  if (!parts || typeof signingKeys?.verifyPayload !== 'function') return false;
  return Boolean(await signingKeys.verifyPayload({
    keyId: parts.payload.keyId,
    algorithm: parts.payload.algorithm,
    payload: parts.payload,
    signature: parts.signature
  }));
}
