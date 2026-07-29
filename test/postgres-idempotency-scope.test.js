import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApiCredentialRecord } from '../src/auth/api-credentials.js';
import { ensurePostgresBootstrap } from '../src/store/postgres-bootstrap.js';
import { createPostgresPool, PostgresStore } from '../src/store/postgres-store.js';

const connectionString = process.env.DATABASE_URL;
const integration = connectionString ? test : test.skip;
const fixedNow = new Date('2026-07-29T09:30:00.000Z');

function unique(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

integration('transition idempotency scopes persist status 200 and stable headers', async () => {
  const tenantId = unique('ten_idem_transition');
  const credentialId = unique('key_idem_transition');
  const secret = `idempotency-transition-${randomUUID()}`;
  const store = new PostgresStore(await createPostgresPool({ connectionString, max: 4 }));

  try {
    const credential = createApiCredentialRecord({
      id: credentialId,
      tenantId,
      environment: 'test',
      name: 'Transition metadata credential',
      scopes: ['*']
    }, secret, fixedNow);
    await ensurePostgresBootstrap(store, {
      tenantId,
      tenantName: 'Transition metadata tenant',
      environment: 'test',
      credential
    });

    for (const [index, scope] of [
      'revoke-mandate:mnd_example',
      'decide-approval:apr_example',
      'authorize'
    ].entries()) {
      await store.pool.query(
        `INSERT INTO mandate.idempotency_records
          (tenant_id, environment, scope, idempotency_key, request_fingerprint,
           response_status, response_headers, response_body, created_at, expires_at)
         VALUES ($1,'test',$2,$3,$4,999,'{"wrong":"header"}'::jsonb,
           '{"ok":true}'::jsonb,now(),now() + interval '1 day')`,
        [tenantId, scope, `transition-key-${index}`, `sha256:${String(index).repeat(64)}`]
      );
    }

    const rows = await store.pool.query(
      `SELECT scope, response_status, response_headers
       FROM mandate.idempotency_records
       WHERE tenant_id = $1 AND environment = 'test'
       ORDER BY scope`,
      [tenantId]
    );
    assert.equal(rows.rowCount, 3);
    for (const row of rows.rows) {
      assert.equal(row.response_status, 200);
      assert.deepEqual(row.response_headers, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff'
      });
    }
  } finally {
    await store.close();
  }
});
