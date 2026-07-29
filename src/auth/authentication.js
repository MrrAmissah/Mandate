import { timingSafeEqual } from 'node:crypto';
import { DomainError } from '../domain/errors.js';

export const API_SCOPES = Object.freeze({
  MANDATES_READ: 'mandates:read',
  MANDATES_WRITE: 'mandates:write',
  APPROVALS_READ: 'approvals:read',
  APPROVALS_WRITE: 'approvals:write',
  AUTHORIZATIONS_READ: 'authorizations:read',
  AUTHORIZATIONS_WRITE: 'authorizations:write',
  RECEIPTS_READ: 'receipts:read',
  RECEIPTS_WRITE: 'receipts:write'
});

function secureEquals(left, right) {
  const a = Buffer.from(left ?? '');
  const b = Buffer.from(right ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeEnvironment(value) {
  const environment = value ?? 'test';
  if (!['test', 'live'].includes(environment)) {
    throw new TypeError('environment must be test or live.');
  }
  return environment;
}

export function createStaticApiKeyAuthenticator({
  apiKey,
  tenantId = 'ten_local',
  environment = 'test',
  credentialId = 'key_local',
  scopes = ['*']
}) {
  const normalizedEnvironment = normalizeEnvironment(environment);
  const normalizedScopes = Object.freeze([...new Set(scopes)]);

  return {
    async authenticate(secret) {
      if (!apiKey || !secureEquals(secret, apiKey)) {
        throw new DomainError('UNAUTHORIZED', 'A valid x-api-key header is required.', 401);
      }
      return Object.freeze({
        tenantId,
        environment: normalizedEnvironment,
        credentialId,
        scopes: normalizedScopes
      });
    }
  };
}

export function requireScope(authentication, scope) {
  if (authentication.scopes.includes('*') || authentication.scopes.includes(scope)) return;
  throw new DomainError(
    'MISSING_SCOPE',
    `The API credential is missing the required ${scope} scope.`,
    403,
    { requiredScope: scope }
  );
}

export function ownershipFrom(authentication) {
  return Object.freeze({
    tenantId: authentication.tenantId,
    environment: authentication.environment
  });
}

export function createStoredApiKeyAuthenticator({ store, hashApiKey, verifyApiKey, assertCredentialUsable, now = () => new Date() }) {
  return {
    async authenticate(secret) {
      let secretHash;
      try {
        secretHash = hashApiKey(secret);
      } catch {
        throw new DomainError('UNAUTHORIZED', 'A valid x-api-key header is required.', 401);
      }
      const credential = assertCredentialUsable(await store.findCredentialBySecretHash(secretHash), now());
      if (!verifyApiKey(secret, credential.secretHash)) {
        throw new DomainError('UNAUTHORIZED', 'A valid x-api-key header is required.', 401);
      }
      return Object.freeze({
        tenantId: credential.tenantId,
        environment: credential.environment,
        credentialId: credential.id,
        scopes: Object.freeze([...credential.scopes])
      });
    }
  };
}
