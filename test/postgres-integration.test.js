import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { createApiCredentialRecord, assertCredentialUsable, hashApiKey, verifyApiKey } from '../src/auth/api-credentials.js';
import { createStoredApiKeyAuthenticator } from '../src/auth/authentication.js';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import { applyMigrations } from '../src/store/postgres-migrations.js';
import { createPostgresPool, PostgresStore } from '../src/store/postgres-store.js';

const connectionString = process.env.DATABASE_URL;
const integration = connectionString ? test : test.skip;
const fixedNow = new Date('2026-07-29T06:00:00.000Z');
const signer = createReceiptSigner({ keyId: 'integration-ed25519' });

function unique(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

async function makeStore() {
  const pool = await createPostgresPool({ connectionString, max: 8 });
  return new PostgresStore(pool);
}

async function bootstrap(store, { tenantId, secret, credentialId, scopes = ['*'] }) {
  const credential = createApiCredentialRecord({
    id: credentialId,
    tenantId,
    environment: 'test',
    name: 'Integration credential',
    scopes
  }, secret, fixedNow);
  await store.ensureBootstrap({
    tenantId,
    tenantName: `Tenant ${tenantId}`,
    environment: 'test',
    credential
  });
  return credential;
}

function authenticator(store) {
  return createStoredApiKeyAuthenticator({
    store,
    hashApiKey,
    verifyApiKey,
    assertCredentialUsable,
    now: () => fixedNow
  });
}

async function withServer(store, run) {
  const server = createServer(createApp({
    store,
    signer,
    authenticator: authenticator(store),
    now: () => fixedNow
  }));
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

function headers(secret, extra = {}) {
  return {
    'content-type': 'application/json',
    'x-api-key': secret,
    ...extra
  };
}

async function createMandate(baseUrl, secret, overrides = {}, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}/v1/mandates`, {
    method: 'POST',
    headers: headers(secret, extraHeaders),
    body: JSON.stringify({
      principalId: 'principal_owner',
      agentId: 'agent_coder',
      purpose: 'Inspect a repository',
      resources: ['github:owner/repository'],
      allowedActions: ['repository.read'],
      ...overrides
    })
  });
  return { response, body: await response.json() };
}

async function authorize(baseUrl, secret, mandateId, extra = {}) {
  const response = await fetch(`${baseUrl}/v1/authorize`, {
    method: 'POST',
    headers: headers(secret),
    body: JSON.stringify({
      mandateId,
      agentId: 'agent_coder',
      action: 'repository.read',
      resource: 'github:owner/repository',
      ...extra
    })
  });
  return { response, body: await response.json() };
}

integration('baseline migration applies to a real PostgreSQL database and is idempotent', async () => {
  const pool = await createPostgresPool({ connectionString });
  try {
    const first = await applyMigrations(pool, { logger: { log() {} } });
    const second = await applyMigrations(pool, { logger: { log() {} } });
    assert.ok(first.applied.length === 1 || first.applied.length === 0);
    assert.deepEqual(second.applied, []);
    const result = await pool.query("SELECT version FROM mandate.schema_migrations WHERE version = '001_durable_core'");
    assert.equal(result.rowCount, 1);
  } finally {
    await pool.end();
  }
});

integration('mandates and idempotency survive pool and application restarts', async () => {
  const tenantId = unique('ten_restart');
  const credentialId = unique('key_restart');
  const secret = `restart-secret-${randomUUID()}`;
  const idempotencyKey = `idem-${randomUUID()}`;
  let mandate;

  const firstStore = await makeStore();
  try {
    await bootstrap(firstStore, { tenantId, secret, credentialId });
    await withServer(firstStore, async (baseUrl) => {
      const created = await createMandate(baseUrl, secret, {}, { 'idempotency-key': idempotencyKey });
      assert.equal(created.response.status, 201);
      mandate = created.body;
    });
  } finally {
    await firstStore.close();
  }

  const restartedStore = await makeStore();
  try {
    await withServer(restartedStore, async (baseUrl) => {
      const read = await fetch(`${baseUrl}/v1/mandates/${mandate.id}`, { headers: headers(secret) });
      assert.equal(read.status, 200);
      assert.equal((await read.json()).id, mandate.id);

      const replay = await createMandate(baseUrl, secret, {}, { 'idempotency-key': idempotencyKey });
      assert.equal(replay.response.status, 201);
      assert.equal(replay.body.id, mandate.id);
    });

    const owner = { tenantId, environment: 'test' };
    assert.equal((await restartedStore.list('mandates', owner)).length, 1);
    assert.equal((await restartedStore.list('auditEvents', owner)).length, 1);
    assert.equal((await restartedStore.list('outboxMessages', owner)).length, 1);
  } finally {
    await restartedStore.close();
  }
});

integration('cross-tenant resources remain undiscoverable after restart', async () => {
  const tenantA = unique('ten_a');
  const tenantB = unique('ten_b');
  const secretA = `tenant-a-${randomUUID()}`;
  const secretB = `tenant-b-${randomUUID()}`;
  const store = await makeStore();
  try {
    await bootstrap(store, { tenantId: tenantA, secret: secretA, credentialId: unique('key_a') });
    await bootstrap(store, { tenantId: tenantB, secret: secretB, credentialId: unique('key_b') });
    await withServer(store, async (baseUrl) => {
      const created = await createMandate(baseUrl, secretA);
      const crossRead = await fetch(`${baseUrl}/v1/mandates/${created.body.id}`, { headers: headers(secretB) });
      assert.equal(crossRead.status, 404);
      assert.equal((await crossRead.json()).error.code, 'MANDATE_NOT_FOUND');
    });
  } finally {
    await store.close();
  }
});

integration('serializable authorization permits exactly one final mandate use', async () => {
  const tenantId = unique('ten_limit');
  const secret = `limit-secret-${randomUUID()}`;
  const store = await makeStore();
  try {
    await bootstrap(store, { tenantId, secret, credentialId: unique('key_limit') });
    await withServer(store, async (baseUrl) => {
      const created = await createMandate(baseUrl, secret, { maxUses: 1 });
      const results = await Promise.all([
        authorize(baseUrl, secret, created.body.id),
        authorize(baseUrl, secret, created.body.id)
      ]);
      assert.deepEqual(results.map(({ body }) => body.outcome).sort(), ['ALLOW', 'DENY']);
      assert.equal(results.find(({ body }) => body.outcome === 'DENY').body.reasonCode, 'USE_LIMIT_REACHED');
    });
  } finally {
    await store.close();
  }
});

integration('unknown mandate denials persist in PostgreSQL', async () => {
  const tenantId = unique('ten_missing');
  const secret = `missing-secret-${randomUUID()}`;
  const store = await makeStore();
  try {
    await bootstrap(store, { tenantId, secret, credentialId: unique('key_missing') });
    await withServer(store, async (baseUrl) => {
      const result = await authorize(baseUrl, secret, 'mnd_missing_reference');
      assert.equal(result.response.status, 200);
      assert.equal(result.body.outcome, 'DENY');
      assert.equal(result.body.reasonCode, 'MANDATE_NOT_FOUND');
    });
    const decisions = await store.list('decisions', { tenantId, environment: 'test' });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].mandateId, 'mnd_missing_reference');
  } finally {
    await store.close();
  }
});

integration('immutable PostgreSQL decisions reject updates', async () => {
  const tenantId = unique('ten_immutable');
  const secret = `immutable-secret-${randomUUID()}`;
  const store = await makeStore();
  try {
    await bootstrap(store, { tenantId, secret, credentialId: unique('key_immutable') });
    let decision;
    await withServer(store, async (baseUrl) => {
      const created = await createMandate(baseUrl, secret);
      decision = (await authorize(baseUrl, secret, created.body.id)).body;
    });

    await assert.rejects(
      store.pool.query(
        `UPDATE mandate.authorization_decisions SET reason = 'tampered'
         WHERE tenant_id = $1 AND environment = 'test' AND id = $2`,
        [tenantId, decision.id]
      ),
      (error) => error.code === '55000'
    );
  } finally {
    await store.close();
  }
});
