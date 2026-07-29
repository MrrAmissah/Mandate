import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../domain/errors.js';

const ENVIRONMENTS = new Set(['test', 'live']);

export function hashApiKey(secret) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new DomainError('INVALID_API_KEY', 'API keys must be at least 16 characters long.');
  }
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function verifyApiKey(secret, expectedHash) {
  try {
    const actual = Buffer.from(hashApiKey(secret), 'hex');
    const expected = Buffer.from(expectedHash ?? '', 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function createApiCredential(input, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DomainError('INVALID_REQUEST', 'Credential input must be an object.');
  }
  if (!ENVIRONMENTS.has(input.environment)) {
    throw new DomainError('INVALID_ENVIRONMENT', 'environment must be test or live.');
  }
  if (typeof input.tenantId !== 'string' || !/^ten_[A-Za-z0-9_-]+$/.test(input.tenantId)) {
    throw new DomainError('INVALID_REQUEST', 'tenantId must be an opaque ten_ identifier.');
  }
  if (typeof input.name !== 'string' || input.name.trim().length === 0 || input.name.length > 100) {
    throw new DomainError('INVALID_REQUEST', 'name must contain between 1 and 100 characters.');
  }
  if (!Array.isArray(input.scopes) || input.scopes.length === 0 || input.scopes.some((scope) => typeof scope !== 'string')) {
    throw new DomainError('INVALID_REQUEST', 'scopes must contain at least one string.');
  }

  const expiresAt = input.expiresAt ?? null;
  if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(now))) {
    throw new DomainError('INVALID_WINDOW', 'expiresAt must be a future ISO-8601 timestamp.');
  }

  const raw = randomBytes(32).toString('base64url');
  const secret = `mnd_${input.environment}_${raw}`;
  const credential = {
    id: `key_${randomUUID()}`,
    tenantId: input.tenantId,
    environment: input.environment,
    name: input.name.trim(),
    secretHash: hashApiKey(secret),
    prefix: secret.slice(0, 14),
    lastFour: secret.slice(-4),
    scopes: [...new Set(input.scopes)],
    status: 'ACTIVE',
    createdAt: now.toISOString(),
    expiresAt,
    revokedAt: null,
    revocationReason: null,
    lastUsedAt: null
  };

  return { credential, secret };
}

export function revokeApiCredential(credential, reason, now = new Date()) {
  if (credential.status === 'REVOKED') return credential;
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new DomainError('INVALID_REQUEST', 'A revocation reason is required.');
  }
  return {
    ...credential,
    status: 'REVOKED',
    revokedAt: now.toISOString(),
    revocationReason: reason.trim()
  };
}

export function assertCredentialUsable(credential, now = new Date()) {
  if (!credential || credential.status !== 'ACTIVE') {
    throw new DomainError('UNAUTHORIZED', 'A valid x-api-key header is required.', 401);
  }
  if (credential.expiresAt && Date.parse(now) >= Date.parse(credential.expiresAt)) {
    throw new DomainError('UNAUTHORIZED', 'A valid x-api-key header is required.', 401);
  }
  return credential;
}
