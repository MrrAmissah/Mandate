import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../src/runtime.js';

const persistentKeys = {
  MANDATE_PRIVATE_KEY_PEM: 'placeholder',
  MANDATE_PUBLIC_KEY_PEM: 'placeholder'
};

test('memory is the safe default for test environments without DATABASE_URL', async () => {
  const runtime = await createRuntime({
    env: {
      MANDATE_API_KEY: 'local-development-only',
      MANDATE_TENANT_ID: 'ten_runtime',
      MANDATE_ENVIRONMENT: 'test'
    }
  });
  try {
    assert.equal(runtime.mode, 'memory');
    assert.ok(runtime.store);
  } finally {
    await runtime.close();
  }
});

test('live environments reject memory persistence', async () => {
  await assert.rejects(
    createRuntime({
      env: {
        MANDATE_STORE: 'memory',
        MANDATE_ENVIRONMENT: 'live',
        MANDATE_API_KEY: 'a-secure-live-api-key',
        MANDATE_API_SCOPES: 'mandates:read',
        ...persistentKeys
      }
    }),
    /require MANDATE_STORE=postgres/
  );
});

test('live environments reject wildcard credentials before database access', async () => {
  await assert.rejects(
    createRuntime({
      env: {
        MANDATE_STORE: 'postgres',
        DATABASE_URL: 'postgresql://unused',
        MANDATE_ENVIRONMENT: 'live',
        MANDATE_API_KEY: 'a-secure-live-api-key',
        MANDATE_API_SCOPES: '*',
        ...persistentKeys
      }
    }),
    /may not use the wildcard scope/
  );
});

test('live environments reject ephemeral receipt signing keys', async () => {
  await assert.rejects(
    createRuntime({
      env: {
        MANDATE_STORE: 'postgres',
        DATABASE_URL: 'postgresql://unused',
        MANDATE_ENVIRONMENT: 'live',
        MANDATE_API_KEY: 'a-secure-live-api-key',
        MANDATE_API_SCOPES: 'mandates:read'
      }
    }),
    /require persistent receipt signing keys/
  );
});
