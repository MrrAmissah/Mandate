import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import {
  assertCredentialUsable,
  createApiCredentialRecord,
  hashApiKey,
  verifyApiKey
} from '../src/auth/api-credentials.js';
import { createStoredApiKeyAuthenticator } from '../src/auth/authentication.js';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import { ensurePostgresBootstrap } from '../src/store/postgres-bootstrap.js';
import { createPostgresPool, PostgresStore } from '../src/store/postgres-store.js';

const connectionString = process.env.DATABASE_URL;
const integration = connectionString ? test : test.skip;
const fixedNow = new Date('2026-07-29T09:30:00.000Z');
const signer = createReceiptSigner({ keyId: 'postgres-idempotency-http' });

function unique(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

async function createStore() {
  return new PostgresStore(await createPostgresPool({ connectionString, max: 6 }));
}

async function withServer(store, run) {
  const authenticator = createStoredApiKeyAuthenticator({
    store,
    hashApiKey,
    verifyApiKey,
    assertCredentialUsable,
    now: () => fixedNow
  });
  const server = createServer(createApp({ store, signer, authenticator, now: () => fixedNow }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function stableHeaders(response) {
  return {
    contentType: response.headers.get('content-type'),
    contentLength: response.headers.get('content-length'),
    cacheControl: response.headers.get('cache-control'),
    contentTypeOptions: response.headers.get('x-content-type-options')
  };
}

async function createMandate(baseUrl, secret, requestId, idempotencyKey) {
  const response = await fetch(`${baseUrl}/v1/mandates`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': secret,
      'x-request-id': requestId,
      'idempotency-key': idempotencyKey
    },
    body: JSON.stringify({
      purpose: 'PostgreSQL exact replay',
      allowedActions: ['repository.read'],
      principalId: 'principal_owner',
      resources: ['github:owner/repository'],
      agentId: 'agent_coder'
    })
  });
  return { response, text: await response.text() };
}

integration('PostgreSQL restart replay preserves bytes and records exact HTTP metadata', async () => {
  const tenantId = unique('ten_idem_http');
  const credentialId = unique('key_idem_http');
  const secret = `idempotency-http-${randomUUID()}`;
  const idempotencyKey = `idem_http_${randomUUID()}`;
  const credential = createApiCredentialRecord({
    id: credentialId,
    tenantId,
    environment: 'test',
    name: 'Idempotency HTTP integration credential',
    scopes: ['*']
  }, secret, fixedNow);
  let first;

  const initialStore = await createStore();
  try {
    await ensurePostgresBootstrap(initialStore, {
      tenantId,
      tenantName: 'Idempotency HTTP tenant',
      environment: 'test',
      credential
    });
    await withServer(initialStore, async (baseUrl) => {
      first = await createMandate(baseUrl, secret, 'req_postgres_first_001', idempotencyKey);
      assert.equal(first.response.status, 201);
      assert.equal(first.response.headers.get('x-request-id'), 'req_postgres_first_001');
    });
  } finally {
    await initialStore.close();
  }

  const restartedStore = await createStore();
  try {
    await withServer(restartedStore, async (baseUrl) => {
      const replay = await createMandate(baseUrl, secret, 'req_postgres_replay_002', idempotencyKey);
      assert.equal(replay.response.status, 201);
      assert.equal(replay.text, first.text);
      assert.deepEqual(stableHeaders(replay.response), stableHeaders(first.response));
      assert.equal(replay.response.headers.get('x-request-id'), 'req_postgres_replay_002');
    });

    const record = await restartedStore.pool.query(
      `SELECT response_status, response_headers
       FROM mandate.idempotency_records
       WHERE tenant_id = $1 AND environment = 'test'
         AND scope = 'create-mandate' AND idempotency_key = $2`,
      [tenantId, idempotencyKey]
    );
    assert.equal(record.rowCount, 1);
    assert.equal(record.rows[0].response_status, 201);
    assert.deepEqual(record.rows[0].response_headers, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff'
    });
  } finally {
    await restartedStore.close();
  }
});

integration('unknown idempotency scopes fail closed in PostgreSQL', async () => {
  const tenantId = unique('ten_idem_scope');
  const credentialId = unique('key_idem_scope');
  const secret = `idempotency-scope-${randomUUID()}`;
  const store = await createStore();
  try {
    const credential = createApiCredentialRecord({
      id: credentialId,
      tenantId,
      environment: 'test',
      name: 'Scope integration credential',
      scopes: ['*']
    }, secret, fixedNow);
    await ensurePostgresBootstrap(store, {
      tenantId,
      tenantName: 'Scope tenant',
      environment: 'test',
      credential
    });

    await assert.rejects(
      store.pool.query(
        `INSERT INTO mandate.idempotency_records
          (tenant_id, environment, scope, idempotency_key, request_fingerprint,
           response_status, response_headers, response_body, created_at, expires_at)
         VALUES ($1,'test','unknown-operation','unknown-key',
           $2,200,'{}'::jsonb,'{}'::jsonb,now(),now() + interval '1 day')`,
        [tenantId, `sha256:${'a'.repeat(64)}`]
      ),
      (error) => error.code === '22023'
    );
  } finally {
    await store.close();
  }
});
