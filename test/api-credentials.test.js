import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCredentialUsable,
  createApiCredential,
  hashApiKey,
  revokeApiCredential,
  verifyApiKey
} from '../src/auth/api-credentials.js';
import { createStoredApiKeyAuthenticator } from '../src/auth/authentication.js';
import { MemoryStore } from '../src/store/memory-store.js';

const now = new Date('2026-07-29T06:00:00.000Z');

test('generated API credentials expose a secret once and store only its hash', () => {
  const { credential, secret } = createApiCredential({
    tenantId: 'ten_example',
    environment: 'test',
    name: 'CI credential',
    scopes: ['mandates:read', 'mandates:write']
  }, now);

  assert.match(secret, /^mnd_test_/);
  assert.equal(credential.secret, undefined);
  assert.equal(credential.secretHash, hashApiKey(secret));
  assert.equal(verifyApiKey(secret, credential.secretHash), true);
  assert.equal(verifyApiKey(`${secret}tampered`, credential.secretHash), false);
  assert.equal(credential.prefix, secret.slice(0, 14));
  assert.equal(credential.lastFour, secret.slice(-4));
});

test('revoked and expired credentials fail with the same safe authentication error', () => {
  const { credential } = createApiCredential({
    tenantId: 'ten_example',
    environment: 'live',
    name: 'Production credential',
    scopes: ['mandates:read'],
    expiresAt: '2026-07-30T06:00:00.000Z'
  }, now);

  assert.throws(
    () => assertCredentialUsable(revokeApiCredential(credential, 'Rotated', now), now),
    (error) => error.code === 'UNAUTHORIZED' && error.status === 401
  );
  assert.throws(
    () => assertCredentialUsable(credential, new Date('2026-07-30T06:00:00.000Z')),
    (error) => error.code === 'UNAUTHORIZED' && error.status === 401
  );
});

test('stored credential authentication resolves tenant, environment, and scopes', async () => {
  const store = new MemoryStore({ tenantId: 'ten_example', environment: 'test' });
  const { credential, secret } = createApiCredential({
    tenantId: 'ten_example',
    environment: 'test',
    name: 'Agent runtime',
    scopes: ['authorizations:write']
  }, now);
  store.save('apiCredentials', { tenantId: 'ten_example', environment: 'test' }, credential);

  const authenticator = createStoredApiKeyAuthenticator({
    store,
    hashApiKey,
    verifyApiKey,
    assertCredentialUsable,
    now: () => now
  });
  const context = await authenticator.authenticate(secret);

  assert.deepEqual(context, {
    tenantId: 'ten_example',
    environment: 'test',
    credentialId: credential.id,
    scopes: ['authorizations:write']
  });
});

test('stored authentication records last use and fails a revocation race', async () => {
  const store = new MemoryStore({ tenantId: 'ten_example', environment: 'test' });
  const { credential, secret } = createApiCredential({
    tenantId: 'ten_example',
    environment: 'test',
    name: 'Race-safe credential',
    scopes: ['mandates:read']
  }, now);
  const ownership = { tenantId: 'ten_example', environment: 'test' };
  store.save('apiCredentials', ownership, credential);

  const authenticator = createStoredApiKeyAuthenticator({
    store,
    hashApiKey,
    verifyApiKey,
    assertCredentialUsable,
    now: () => now
  });
  await authenticator.authenticate(secret);
  assert.equal(store.get('apiCredentials', ownership, credential.id).lastUsedAt, now.toISOString());

  const originalMark = store.markCredentialUsed.bind(store);
  store.markCredentialUsed = async (value, observedAt) => {
    store.save('apiCredentials', ownership, revokeApiCredential(value, 'Concurrent revocation', observedAt));
    return originalMark(value, observedAt);
  };
  await assert.rejects(
    authenticator.authenticate(secret),
    (error) => error.code === 'UNAUTHORIZED' && error.status === 401
  );
});
