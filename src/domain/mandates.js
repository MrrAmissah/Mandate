import { randomUUID } from 'node:crypto';
import { DomainError } from './errors.js';
import { assertObject, optionalIsoDate, requiredString, stringArray } from './validate.js';

export function createMandate(input, now = new Date()) {
  assertObject(input);
  const validFrom = optionalIsoDate(input.validFrom, 'validFrom') ?? now.toISOString();
  const validUntil = optionalIsoDate(input.validUntil, 'validUntil');
  if (validUntil && Date.parse(validUntil) <= Date.parse(validFrom)) {
    throw new DomainError('INVALID_WINDOW', 'validUntil must be later than validFrom.');
  }

  const maxUses = input.maxUses ?? null;
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) {
    throw new DomainError('INVALID_REQUEST', 'maxUses must be a positive integer or null.');
  }

  const allowedActions = stringArray(input.allowedActions, 'allowedActions', { min: 1 });
  const deniedActions = stringArray(input.deniedActions ?? [], 'deniedActions');
  const approvalRequiredActions = stringArray(
    input.approvalRequiredActions ?? [],
    'approvalRequiredActions'
  );

  return {
    id: `mnd_${randomUUID()}`,
    status: 'ACTIVE',
    principalId: requiredString(input.principalId, 'principalId'),
    agentId: requiredString(input.agentId, 'agentId'),
    purpose: requiredString(input.purpose, 'purpose'),
    resources: stringArray(input.resources, 'resources', { min: 1 }),
    allowedActions,
    deniedActions,
    approvalRequiredActions,
    constraints: assertObject(input.constraints ?? {}, 'constraints'),
    validFrom,
    validUntil,
    maxUses,
    uses: 0,
    createdAt: now.toISOString(),
    revokedAt: null,
    revocationReason: null
  };
}

export function revokeMandate(mandate, reason, now = new Date()) {
  if (mandate.status === 'REVOKED') return mandate;
  return {
    ...mandate,
    status: 'REVOKED',
    revokedAt: now.toISOString(),
    revocationReason: requiredString(reason, 'reason')
  };
}
