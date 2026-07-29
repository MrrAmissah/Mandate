import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { reserveActionAttempt } from '../src/application/action-attempt-service.js';
import { applyMigrations } from '../src/store/postgres-migrations.js';
import { createPostgresPool, PostgresStore } from '../src/store/postgres-store.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;

postgresTest('PostgreSQL permits exactly one reservation for an ALLOW decision', async () => {
  const pool = await createPostgresPool({ connectionString: databaseUrl });
  const store = new PostgresStore(pool);
  const suffix = randomUUID().replaceAll('-', '');
  const tenantId = `ten_attempt_${suffix}`;
  const environment = 'test';
  const ownership = { tenantId, environment };
  const credentialId = `key_attempt_${suffix}`;
  const mandateId = `mnd_attempt_${suffix}`;
  const decisionId = `dec_attempt_${suffix}`;
  const now = new Date('2026-07-29T12:00:00.000Z');

  try {
    await applyMigrations(pool, { logger: { log() {} } });
    await pool.query(
      `INSERT INTO mandate.tenants (id, name, status, created_at, updated_at)
       VALUES ($1, 'Action attempt tenant', 'ACTIVE', $2, $2)`,
      [tenantId, now.toISOString()]
    );
    await pool.query(
      `INSERT INTO mandate.api_credentials
        (tenant_id, environment, id, name, secret_hash, prefix, last_four, scopes, status, created_at)
       VALUES ($1,$2,$3,'Attempt credential',$4,'mnd_test_','0000',$5,'ACTIVE',$6)`,
      [tenantId, environment, credentialId, '0'.repeat(64),
        ['action_attempts:read', 'action_attempts:write'], now.toISOString()]
    );
    await pool.query(
      `INSERT INTO mandate.mandates
        (tenant_id, environment, id, status, principal_id, agent_id, purpose, resources,
         allowed_actions, denied_actions, approval_required_actions, constraints, valid_from,
         valid_until, max_uses, uses, version, created_at)
       VALUES ($1,$2,$3,'ACTIVE','principal_pg','agent_pg','One protected write',$4,$5,$6,$7,$8,$9,5,1,0,$8)`,
      [tenantId, environment, mandateId, JSON.stringify(['github:repo']),
        JSON.stringify(['repository.write']), JSON.stringify([]), JSON.stringify({}),
        now.toISOString(), '2030-01-01T00:00:00.000Z']
    );
    await pool.query(
      `INSERT INTO mandate.authorization_decisions
        (tenant_id, environment, id, mandate_id, agent_id, action, resource, context, outcome,
         reason_code, reason, approval_id, evaluated_at, request_id)
       VALUES ($1,$2,$3,$4,'agent_pg','repository.write','github:repo',$5,'ALLOW',
         'ACTION_ALLOWED','The action is allowed.',NULL,$6,'req_pg_authorize')`,
      [tenantId, environment, decisionId, mandateId, JSON.stringify({}), now.toISOString()]
    );

    const authentication = { tenantId, environment, credentialId, scopes: ['action_attempts:write'] };
    const reserve = (requestId) => store.transaction((transaction) => reserveActionAttempt({
      transaction,
      ownership,
      authentication,
      input: { decisionId, expiresInSeconds: 300 },
      requestId,
      now
    }));

    const results = await Promise.allSettled([reserve('req_attempt_a'), reserve('req_attempt_b')]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    const rejection = results.find((result) => result.status === 'rejected').reason;
    assert.equal(rejection.code, 'ACTION_ATTEMPT_ALREADY_RESERVED');

    const stored = await pool.query(
      `SELECT id, decision_id, status, reserved_by_credential_id
       FROM mandate.action_attempts
       WHERE tenant_id = $1 AND environment = $2`,
      [tenantId, environment]
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].decision_id, decisionId);
    assert.equal(stored.rows[0].status, 'RESERVED');
    assert.equal(stored.rows[0].reserved_by_credential_id, credentialId);
  } finally {
    await pool.query('DELETE FROM mandate.action_attempts WHERE tenant_id = $1', [tenantId]).catch(() => {});
    await pool.query('DELETE FROM mandate.authorization_decisions WHERE tenant_id = $1', [tenantId]).catch(() => {});
    await pool.query('DELETE FROM mandate.mandates WHERE tenant_id = $1', [tenantId]).catch(() => {});
    await pool.query('DELETE FROM mandate.api_credentials WHERE tenant_id = $1', [tenantId]).catch(() => {});
    await pool.query('DELETE FROM mandate.tenants WHERE id = $1', [tenantId]).catch(() => {});
    await store.close();
  }
});
