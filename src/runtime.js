import { createApiCredentialRecord, assertCredentialUsable, hashApiKey, verifyApiKey } from './auth/api-credentials.js';
import { createStaticApiKeyAuthenticator, createStoredApiKeyAuthenticator } from './auth/authentication.js';
import { createReceiptSigner } from './crypto/receipt-signer.js';
import { createStaticSigningKeyRegistry, PostgresSigningKeyRegistry } from './crypto/signing-key-registry.js';
import { MemoryStore } from './store/memory-store.js';
import { ensurePostgresBootstrap } from './store/postgres-bootstrap.js';
import { createPostgresPool, PostgresStore } from './store/postgres-store.js';

function booleanValue(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('Boolean environment values must be true or false.');
}

function positiveInteger(value, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('Expected a positive integer.');
  return parsed;
}

function scopesFrom(value) {
  const scopes = (value ?? '*').split(',').map((scope) => scope.trim()).filter(Boolean);
  if (scopes.length === 0) throw new Error('MANDATE_API_SCOPES must contain at least one scope.');
  return [...new Set(scopes)];
}

function assertRuntimePosture({ mode, environment, apiKey, scopes, privateKeyPem, publicKeyPem, keyId }) {
  if (!['memory', 'postgres'].includes(mode)) throw new Error('MANDATE_STORE must be memory or postgres.');
  if (!['test', 'live'].includes(environment)) throw new Error('MANDATE_ENVIRONMENT must be test or live.');
  if (environment !== 'live') return;
  if (mode !== 'postgres') throw new Error('Live environments require MANDATE_STORE=postgres.');
  if (!apiKey || apiKey === 'local-development-only') throw new Error('MANDATE_API_KEY must be configured before starting a live environment.');
  if (scopes.includes('*')) throw new Error('Live credentials may not use the wildcard scope.');
  if (!privateKeyPem || !publicKeyPem) throw new Error('Live environments require persistent receipt signing keys.');
  if (!keyId || keyId === 'local-dev-ed25519') throw new Error('Live environments require an explicit persistent MANDATE_KEY_ID.');
}

export async function createRuntime({ env = process.env } = {}) {
  const apiKey = env.MANDATE_API_KEY ?? 'local-development-only';
  const tenantId = env.MANDATE_TENANT_ID ?? 'ten_local';
  const tenantName = env.MANDATE_TENANT_NAME ?? 'Local tenant';
  const environment = env.MANDATE_ENVIRONMENT ?? 'test';
  const scopes = scopesFrom(env.MANDATE_API_SCOPES);
  const mode = env.MANDATE_STORE ?? (env.DATABASE_URL ? 'postgres' : 'memory');
  const credentialId = env.MANDATE_API_CREDENTIAL_ID ?? 'key_runtime';
  const privateKeyPem = env.MANDATE_PRIVATE_KEY_PEM;
  const publicKeyPem = env.MANDATE_PUBLIC_KEY_PEM;
  const keyId = env.MANDATE_KEY_ID ?? 'key_local_dev_ed25519';

  assertRuntimePosture({ mode, environment, apiKey, scopes, privateKeyPem, publicKeyPem, keyId });
  const signer = createReceiptSigner({ privateKeyPem, publicKeyPem, keyId });
  const ownership = { tenantId, environment };

  if (mode === 'memory') {
    const store = new MemoryStore(ownership);
    const signingKeys = createStaticSigningKeyRegistry(signer);
    await signingKeys.registerActive(signer);
    return {
      mode, store, signer, signingKeys,
      authenticator: createStaticApiKeyAuthenticator({ apiKey, tenantId, environment, credentialId, scopes }),
      async close() {}
    };
  }

  const pool = await createPostgresPool({
    connectionString: env.DATABASE_URL,
    max: positiveInteger(env.MANDATE_DATABASE_POOL_MAX, 10),
    ssl: booleanValue(env.MANDATE_DATABASE_SSL, false)
  });
  const store = new PostgresStore(pool, { maximumTransactionAttempts: positiveInteger(env.MANDATE_TRANSACTION_ATTEMPTS, 4) });
  const signingKeys = new PostgresSigningKeyRegistry(pool, ownership);

  try {
    const credential = createApiCredentialRecord({
      id: credentialId, tenantId, environment,
      name: env.MANDATE_API_CREDENTIAL_NAME ?? 'Runtime bootstrap credential', scopes
    }, apiKey);
    await ensurePostgresBootstrap(store, { tenantId, tenantName, environment, credential });
    await signingKeys.registerActive({
      keyId: signer.keyId,
      algorithm: signer.algorithm,
      publicKeyPem: signer.publicKeyPem,
      activatedAt: new Date()
    });
  } catch (error) {
    await store.close();
    throw error;
  }

  return {
    mode, store, signer, signingKeys,
    authenticator: createStoredApiKeyAuthenticator({ store, hashApiKey, verifyApiKey, assertCredentialUsable }),
    close: () => store.close()
  };
}
